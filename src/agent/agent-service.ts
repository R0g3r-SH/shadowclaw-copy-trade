import { logger } from '../utils/logger';
import { config } from '../config';
import { callClaude, type Message, type ContentBlock } from '../utils/claude-client';
import { dash } from '../dashboard/events';
import { tools } from './tools';
import { getTokenMarketData, getEthPriceUsd } from '../utils/dexscreener';
import { createPublicClient, http, formatEther } from 'viem';
import { arbitrum } from 'viem/chains';
import type { DatabaseService } from '../services/database';
import type { TokenSafetyChecker } from '../safety/token-safety';
import type { TradeExecutor } from '../execution/trade-executor';

export interface TradeContext {
  walletAddress: string;
  walletScore: number;
  tokenAddress: string;
  maxAmountUsd: number;   // orchestrator passes the max safe position
  originalTxHash: string;
  tokenIn: string;        // needed for execute_trade
}

export interface AgentDecision {
  executedTrade: boolean;
  requestsApproval: boolean;
  skipped: boolean;
  reasoning: string;
  confidence: number;
  suggestedAmountUsd: number;
}

export class AgentService {
  private publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(`https://arb-mainnet.g.alchemy.com/v2/${config.blockchain.alchemy.apiKey}`),
  });

  constructor(
    private db: DatabaseService,
    private tokenSafety: TokenSafetyChecker,
    private tradeExecutor: TradeExecutor
  ) {}

  async analyzeAndDecide(context: TradeContext, mode: 'claude-code' | 'hybrid' | 'openclaw'): Promise<AgentDecision> {
    logger.info(`Agent analyzing trade in ${mode} mode`);

    const messages: Message[] = [
      { role: 'user', content: await this.buildUserPrompt(context) },
    ];

    let executedTrade = false;
    let requestsApproval = false;
    let skipped = false;
    let reasoning = '';
    let confidence = 0;
    let suggestedAmountUsd = 0;

    for (let i = 0; i < 6; i++) {
      const response = await callClaude({
        system: this.buildSystemPrompt(mode),
        messages,
        tools,
        max_tokens: 4096,
        source: `trade-agent (turn ${i + 1})`,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        // Agent finished without using a decision tool — treat as skip
        const textBlock = response.content.find(c => c.type === 'text');
        reasoning = textBlock?.text || 'No decision made';
        skipped = true;
        break;
      }

      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        const toolResults: ContentBlock[] = [];

        for (const toolUse of toolUses) {
          if (toolUse.type !== 'tool_use') continue;
          dash.emit('log', { severity: 'claude', message: `🔧 tool: ${toolUse.name} ${JSON.stringify(toolUse.input).slice(0, 80)}` });

          // Decision tools — validate inputs before acting
          if (toolUse.name === 'execute_trade') {
            const rawAmt = Number(toolUse.input.amount_usd);
            const clampedAmt = Math.min(Math.max(isNaN(rawAmt) ? 0 : rawAmt, 0.5), context.maxAmountUsd);
            if (clampedAmt < 0.5) {
              skipped = true;
              reasoning = `Agent requested amount too small ($${rawAmt}) — skipped`;
              toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ error: 'amount too small' }) });
              continue;
            }
            const validatedInput = { ...toolUse.input, amount_usd: clampedAmt };
            const result = await Promise.race([
              this.handleExecuteTrade(validatedInput, context),
              new Promise<{ success: false; error: string }>(r => setTimeout(() => r({ success: false, error: 'execute_trade timeout (30s)' }), 30_000)),
            ]);
            if (result.success) {
              executedTrade = true;
              reasoning = toolUse.input.reasoning || 'Agent executed trade';
              suggestedAmountUsd = clampedAmt;
            } else {
              skipped = true;
              reasoning = `Execute failed: ${result.error}`;
            }
            toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
            continue;
          }

          if (toolUse.name === 'request_approval') {
            requestsApproval = true;
            reasoning = toolUse.input.reasoning ?? '';
            const rawConf = Number(toolUse.input.confidence);
            confidence = Math.min(Math.max(isNaN(rawConf) ? 0 : rawConf, 0), 100);
            const rawSug = Number(toolUse.input.suggested_amount_usd);
            suggestedAmountUsd = Math.min(Math.max(isNaN(rawSug) ? context.maxAmountUsd : rawSug, 0.5), context.maxAmountUsd);
            toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ status: 'approval_requested' }) });
            continue;
          }

          if (toolUse.name === 'skip_trade') {
            skipped = true;
            reasoning = toolUse.input.reason;
            toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ status: 'skipped' }) });
            continue;
          }

          // Data tools — with 15s timeout to prevent agent stalling
          const result = await Promise.race([
            this.executeDataTool(toolUse.name!, toolUse.input, context),
            new Promise<{ error: string }>(r => setTimeout(() => r({ error: `${toolUse.name} timeout (15s)` }), 15_000)),
          ]);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
        }

        messages.push({ role: 'user', content: toolResults });

        // Terminal decision was made — exit loop
        if (executedTrade || requestsApproval || skipped) break;
        continue;
      }

      break;
    }

    // Fallback if loop ended without decision
    if (!executedTrade && !requestsApproval && !skipped) {
      skipped = true;
      reasoning = 'Agent loop ended without decision';
    }

    return { executedTrade, requestsApproval, skipped, reasoning, confidence, suggestedAmountUsd };
  }

  private buildSystemPrompt(mode: 'claude-code' | 'hybrid' | 'openclaw'): string {
    const base = `You are a crypto copy trading agent on Arbitrum. A tracked wallet just made a trade.
Your job: analyze the trade opportunity and make a decision using the available tools.

Workflow:
1. Call check_token_safety to assess the token
2. Call get_wallet_history to understand the wallet's track record
3. Call get_dex_metrics to check liquidity and market conditions
4. Call get_portfolio_status to know available capital and current exposure
5. Make your decision using ONE of: execute_trade, request_approval, or skip_trade

NEVER end without calling execute_trade, request_approval, or skip_trade.
Be concise in your reasoning — focus on what matters most for the decision.`;

    const modes: Record<string, string> = {
      'claude-code': `\nMODE: Analysis-only. Always use request_approval. Never execute_trade directly.`,
      'hybrid':      `\nMODE: Use your judgment. Auto-execute if you are highly confident and the trade is safe. Request approval if you want human input. Skip if the trade is not worth it.`,
      'openclaw':    `\nMODE: Full autonomy. Execute if you think it's a good trade. Only request_approval for very large or unusual trades. Bias toward action.`,
    };

    return base + modes[mode];
  }

  private async buildUserPrompt(context: TradeContext): Promise<string> {
    const ethPrice = await getEthPriceUsd().catch(() => 2000);
    const balanceWei = await this.publicClient.getBalance({ address: config.wallet.address as `0x${string}` }).catch(() => 0n);
    const ethBalance = parseFloat(formatEther(BigInt(balanceWei))).toFixed(4);
    const usdBalance = (parseFloat(ethBalance) * ethPrice).toFixed(2);

    return `Wallet ${context.walletAddress} (trust score: ${context.walletScore}/100) just bought token ${context.tokenAddress}.

Original TX: ${context.originalTxHash}
Bot wallet balance: ${ethBalance} ETH (~$${usdBalance} USD)
Max safe position: $${context.maxAmountUsd.toFixed(2)} USD

Analyze and decide.`;
  }

  private async handleExecuteTrade(input: any, context: TradeContext): Promise<any> {
    try {
      const ethPrice = await getEthPriceUsd();
      const amountIn = BigInt(Math.floor((input.amount_usd / ethPrice) * 1e18));

      const result = await this.tradeExecutor.executeTrade({
        tokenIn: input.token_in || context.tokenIn,
        tokenOut: input.token_out || context.tokenAddress,
        amountIn,
        amountUsd: input.amount_usd,
        slippagePct: input.slippage_pct || 1,
      });

      if (result.success && result.txHash) {
        const tradeId = await this.db.saveCopiedTrade({
          originalTxHash: context.originalTxHash,
          walletAddress: context.walletAddress,
          tokenIn: input.token_in || context.tokenIn,
          tokenOut: input.token_out || context.tokenAddress,
          amountIn: amountIn.toString(),
          positionSizeUsd: input.amount_usd,
        });
        await this.db.updateCopiedTrade(tradeId, {
          ourTxHash: result.txHash,
          status: 'filled',
          executedAt: new Date(),
          amountOut: result.amountOut?.toString(),
          gasCostUsd: result.gasCost ? parseFloat(formatEther(result.gasCost)) * ethPrice : 0,
        });
      }

      return { success: result.success, tx_hash: result.txHash, error: result.error };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  private async executeDataTool(name: string, input: any, context: TradeContext): Promise<any> {
    try {
      switch (name) {
        case 'check_token_safety': {
          const result = await this.tokenSafety.checkToken(input.token_address);
          return {
            is_honeypot: result.isHoneypot,
            is_mintable: result.isMintable,
            is_blacklisted: result.isBlacklisted,
            is_verified: result.isVerified,
            liquidity_usd: result.liquidityUsd,
            risk_score: result.riskScore,
            flags: result.reasons,
          };
        }
        case 'get_wallet_history': {
          const result = await this.db.query(
            `SELECT token_in, token_out, dex, timestamp FROM tracked_transactions WHERE wallet_address = $1 ORDER BY timestamp DESC LIMIT $2`,
            [input.wallet_address, input.limit || 20]
          );
          const wins = await this.db.query(
            `SELECT COUNT(*) as total, COUNT(CASE WHEN pnl > 0 THEN 1 END) as wins FROM copied_trades WHERE wallet_address = $1`,
            [input.wallet_address]
          );
          const w = wins.rows[0];
          return {
            total_tracked_txs: result.rows.length,
            win_rate: w.total > 0 ? `${Math.round((w.wins / w.total) * 100)}%` : 'no copies yet',
            recent_trades: result.rows.slice(0, 10),
          };
        }
        case 'get_dex_metrics': {
          const mkt = await getTokenMarketData(input.token_address);
          if (!mkt) return { error: 'DEXScreener data unavailable' };
          return {
            liquidity_usd: mkt.liquidityUsd,
            volume_24h_usd: mkt.volume24h,
            price_usd: mkt.priceUsd,
          };
        }
        case 'get_portfolio_status': {
          const open = await this.db.getOpenPositions();
          const pnl = await this.db.getDailyPnL();
          const ethPrice = await getEthPriceUsd();
          const publicClient = createPublicClient({ chain: arbitrum, transport: http(`https://arb-mainnet.g.alchemy.com/v2/${config.blockchain.alchemy.apiKey}`) });
          const balanceWei = await publicClient.getBalance({ address: config.wallet.address as `0x${string}` }).catch(() => 0n);
          const ethBalance = parseFloat(formatEther(BigInt(balanceWei)));
          return {
            open_positions: open,
            max_positions: config.trading.maxPositions,
            can_open_new: open < config.trading.maxPositions,
            daily_pnl_usd: pnl.toFixed(2),
            eth_balance: ethBalance.toFixed(4),
            eth_balance_usd: (ethBalance * ethPrice).toFixed(2),
            max_safe_position_usd: context.maxAmountUsd.toFixed(2),
          };
        }
        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (error: any) {
      return { error: error.message };
    }
  }
}
