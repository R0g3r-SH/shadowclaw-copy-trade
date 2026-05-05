import { logger } from '../utils/logger';
import { config } from '../config';
import { callClaude, type Message, type ContentBlock } from '../utils/claude-client';
import { dash } from '../dashboard/events';
import { tools } from './tools';
import { getTokenMarketData, getEthPriceUsd } from '../utils/dexscreener';
import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { USDC_ADDRESS, ERC20_BALANCE_ABI, usdToUsdc } from '../constants/tokens';
import type { DatabaseService } from '../services/database';
import type { TokenSafetyChecker } from '../safety/token-safety';
import type { SafetyResult } from '../safety/token-safety';
import type { TradeExecutor } from '../execution/trade-executor';
import type { ConvergenceResult } from '../services/convergence-tracker';

function pairAgeMinutes(pairCreatedAt: number | null | undefined): number | null {
  return pairCreatedAt ? Math.floor((Date.now() - pairCreatedAt) / 60_000) : null;
}

function fmtPct(value: number | null | undefined): string {
  return value != null ? `${value > 0 ? '+' : ''}${value.toFixed(2)}%` : 'unavailable';
}

export interface TradeContext {
  walletAddress: string;
  walletScore: number;
  tokenAddress: string;
  maxAmountUsd: number;
  originalTxHash: string;
  tokenIn: string;
  safetyResult?: SafetyResult;
  convergence?: ConvergenceResult;
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
    transport: http(config.blockchain.alchemy.httpRpcUrl),
  });
  private _runMarketCache: { tokenAddress: string; data: Awaited<ReturnType<typeof getTokenMarketData>> } | null = null;

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

    this._runMarketCache = null;
    return { executedTrade, requestsApproval, skipped, reasoning, confidence, suggestedAmountUsd };
  }

  private buildSystemPrompt(mode: 'claude-code' | 'hybrid' | 'openclaw'): string {
    const base = `You are a crypto copy trading agent on Arbitrum. A tracked smart-money wallet just made a swap.
The initial analysis (safety check + market snapshot) is already included in the trade brief.
Use tools only when you need data not already provided.

## HARD SKIP RULES — skip immediately, no further analysis needed:
- is_honeypot: true
- risk_score >= 70
- liquidity_usd < 25000
- is_blacklisted: true
- Token age < 30 minutes AND liquidity < $100k (very new with low liquidity = rug risk)

## POSITION SIZING FORMULA:
base_amount = max_safe_position_usd
score_factor = wallet_score / 100           (higher trust → bigger size)
safety_factor = 1 - (risk_score / 150)     (higher risk → smaller size)
suggested_amount = base_amount × score_factor × safety_factor

Examples:
- wallet_score=90, risk=20 → 90% × 87% = ~78% of max
- wallet_score=70, risk=40 → 70% × 73% = ~51% of max
- wallet_score=50, risk=60 → 50% × 60% = ~30% of max
Minimum: $0.50 or 1% of USDC balance (whichever is higher). Never exceed max_safe_position_usd.

## SLIPPAGE — always use the recommended value from the brief, do not change it:
The recommended slippage is already calculated based on risk_score.

## DECISION GUIDE:
execute_trade → risk_score < 50 AND liquidity > $100k AND wallet_score >= 70 AND price_change_h1 > 0
request_approval → interesting trade but uncertain (new wallet with no history, moderate risk, large amount)
skip_trade → hard skip rules triggered OR risk too high OR liquidity too low OR already pumped >50% in 1h

## WORKFLOW (minimum tool calls):
1. If safety data in the brief is sufficient → skip check_token_safety
2. Always call get_wallet_history to verify actual copy performance
3. Call get_dex_metrics only if market snapshot in brief is missing or stale
4. Call get_portfolio_status only if you need to check position count
5. Decide with execute_trade / request_approval / skip_trade

NEVER end without calling one of the three decision tools.
Be concise — one sentence per key factor in your reasoning.`;

    const modes: Record<string, string> = {
      'claude-code': `\n\n## MODE: claude-code
Always use request_approval. Never execute_trade. Your role is analysis only.`,

      'hybrid': `\n\n## MODE: hybrid
Auto-execute when: risk_score < 40 AND wallet_score >= 75 AND liquidity > $100k AND price_change_h1 < 30%
Request approval when: risk_score 40-60 OR wallet_score 60-75 OR price already up 20-50% in 1h
Skip when: hard rules hit OR risk > 60 OR liquidity < $25k`,

      'openclaw': `\n\n## MODE: openclaw (full autonomy)
Bias strongly toward action. Execute unless a hard skip rule fires.
Request approval only for positions > 80% of max_safe_position_usd or risk_score > 55.
Skip only on hard rules or obvious rugs.`,
    };

    return base + modes[mode];
  }

  private async buildUserPrompt(context: TradeContext): Promise<string> {
    const [ethPrice, balanceWei, usdcRaw, marketData] = await Promise.all([
      getEthPriceUsd().catch(() => 2000),
      this.publicClient.getBalance({ address: config.wallet.address as `0x${string}` }).catch(() => 0n),
      this.publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [config.wallet.address as `0x${string}`] }).catch(() => 0n),
      getTokenMarketData(context.tokenAddress).catch(() => null),
    ]);

    this._runMarketCache = { tokenAddress: context.tokenAddress.toLowerCase(), data: marketData };

    const ethBalance = parseFloat(formatEther(BigInt(balanceWei))).toFixed(4);
    const ethUsd     = parseFloat(ethBalance) * ethPrice;
    const usdcBalance = parseFloat(formatUnits(BigInt(usdcRaw as bigint), 6));
    const totalUsd   = (ethUsd + usdcBalance).toFixed(2);
    const usdBalance = ethUsd.toFixed(2);

    const sr = context.safetyResult;
    const safetySection = sr
      ? `## Safety (pre-computed — skip check_token_safety unless you need more detail)
risk_score: ${sr.riskScore}/100
is_honeypot: ${sr.isHoneypot}
is_mintable: ${sr.isMintable}
is_blacklisted: ${sr.isBlacklisted}
is_verified: ${sr.isVerified}
liquidity_usd: $${sr.liquidityUsd.toLocaleString()}
flags: ${sr.reasons.length > 0 ? sr.reasons.join(', ') : 'none'}`
      : `## Safety: not pre-computed — call check_token_safety`;

    const mkt = marketData;
    const age = pairAgeMinutes(mkt?.pairCreatedAt);
    const marketSection = mkt
      ? `## Market snapshot (pre-computed — skip get_dex_metrics unless stale)
price_usd: $${mkt.priceUsd}
liquidity_usd: $${mkt.liquidityUsd.toLocaleString()}
volume_24h_usd: $${mkt.volume24h.toLocaleString()}
price_change_h1: ${fmtPct(mkt.priceChangeH1)}
price_change_h24: ${fmtPct(mkt.priceChangeH24)}
fdv_usd: ${mkt.fdv ? `$${mkt.fdv.toLocaleString()}` : 'unavailable'}
pair_age_minutes: ${age ?? 'unavailable'}`
      : `## Market snapshot: unavailable — call get_dex_metrics`;

    // Recommended slippage based on risk score (so agent uses correct value)
    const riskScore = sr?.riskScore ?? 50;
    const recommendedSlippage = this.tradeExecutor.calculateSlippage(context.tokenAddress, riskScore);

    const conv = context.convergence;
    const convergenceSection = conv && conv.isConverging
      ? `## ⚡ CONVERGENCE SIGNAL (${conv.count} wallets)
${conv.count} tracked smart-money wallets bought this token in the last 5 minutes:
${conv.wallets.map(w => `  - ${w.walletAddress.slice(0, 10)}... (score: ${w.walletScore})`).join('\n')}
Average wallet score: ${conv.avgWalletScore}/100
Position size already boosted to ${conv.isStrong ? '2×' : '1.5×'} base (max: $${context.maxAmountUsd.toFixed(2)}).
STRONG SIGNAL: Bias heavily toward execute_trade unless a hard skip rule fires.`
      : '';

    return `## Trade brief

Wallet: ${context.walletAddress}
Wallet trust score: ${context.walletScore}/100
Token bought: ${context.tokenAddress}
Original TX: ${context.originalTxHash}
${convergenceSection ? `\n${convergenceSection}\n` : ''}
## Bot portfolio
ETH balance: ${ethBalance} ETH (~$${usdBalance} USD) — para gas únicamente
USDC balance: $${usdcBalance.toFixed(2)} USDC — capital de trading
Total portfolio: $${totalUsd} USD
Max safe position: $${context.maxAmountUsd.toFixed(2)} USD (2% del USDC disponible)
Recommended slippage: ${recommendedSlippage}% (based on risk score — use this value)

${safetySection}

${marketSection}

## Next step
1. Call get_wallet_history for ${context.walletAddress}
2. Apply position sizing formula from your instructions
3. Decide: execute_trade / request_approval / skip_trade`;
  }

  private async handleExecuteTrade(input: any, context: TradeContext): Promise<any> {
    try {
      const ethPrice = await getEthPriceUsd();
      const amountIn = usdToUsdc(input.amount_usd);

      // Slippage is always derived from the safety risk score, not agent-supplied value —
      // prevents the agent from accepting excessive slippage on high-risk tokens.
      const riskScore = context.safetyResult?.riskScore ?? 50;
      const slippage = this.tradeExecutor.calculateSlippage(context.tokenAddress, riskScore);

      const result = await this.tradeExecutor.executeTrade({
        tokenIn: USDC_ADDRESS,
        tokenOut: input.token_out || context.tokenAddress,
        amountIn,
        amountUsd: input.amount_usd,
        slippagePct: slippage,
      });

      if (result.success && result.txHash) {
        const tradeId = await this.db.saveCopiedTrade({
          originalTxHash: context.originalTxHash,
          walletAddress: context.walletAddress,
          tokenIn: USDC_ADDRESS,
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
          // Use pre-computed result if the agent is asking about the same token
          const precomputed = context.safetyResult &&
            input.token_address?.toLowerCase() === context.tokenAddress.toLowerCase()
            ? context.safetyResult
            : await this.tokenSafety.checkToken(input.token_address);
          return {
            is_honeypot: precomputed.isHoneypot,
            is_mintable: precomputed.isMintable,
            is_blacklisted: precomputed.isBlacklisted,
            is_verified: precomputed.isVerified,
            liquidity_usd: precomputed.liquidityUsd,
            risk_score: precomputed.riskScore,
            flags: precomputed.reasons,
          };
        }
        case 'get_wallet_history': {
          const [recent, counts, perf] = await Promise.all([
            this.db.query(
              `SELECT token_in, token_out, dex, timestamp FROM tracked_transactions WHERE wallet_address = $1 ORDER BY timestamp DESC LIMIT $2`,
              [input.wallet_address, input.limit || 20]
            ),
            // Real total — not capped by query limit
            this.db.query(
              `SELECT COUNT(*) as total FROM tracked_transactions WHERE wallet_address = $1`,
              [input.wallet_address]
            ),
            // Win rate over CLOSED copies only (open trades have pnl=0, skews result)
            this.db.query(
              `SELECT COUNT(*) as total, COUNT(CASE WHEN pnl > 0 THEN 1 END) as wins,
                      ROUND(AVG(pnl_pct)*100, 1) as avg_pnl_pct
               FROM copied_trades WHERE wallet_address = $1 AND status = 'closed'`,
              [input.wallet_address]
            ),
          ]);
          const w = perf.rows[0];
          return {
            total_tracked_txs: parseInt(counts.rows[0].total),
            copies_closed: parseInt(w.total),
            win_rate: w.total > 0 ? `${Math.round((w.wins / w.total) * 100)}%` : 'no closed copies yet',
            avg_pnl_pct: w.total > 0 ? `${w.avg_pnl_pct}%` : 'n/a',
            recent_trades: recent.rows.slice(0, 10),
          };
        }
        case 'get_dex_metrics': {
          const cached = this._runMarketCache !== null &&
            this._runMarketCache.tokenAddress === input.token_address?.toLowerCase()
            ? this._runMarketCache.data
            : null;
          const mkt = cached ?? await getTokenMarketData(input.token_address);
          if (!mkt) return { error: 'DEXScreener data unavailable' };
          return {
            price_usd:        mkt.priceUsd,
            liquidity_usd:    mkt.liquidityUsd,
            volume_24h_usd:   mkt.volume24h,
            price_change_h1:  fmtPct(mkt.priceChangeH1),
            price_change_h24: fmtPct(mkt.priceChangeH24),
            fdv_usd:          mkt.fdv ?? 'unavailable',
            pair_age_minutes: pairAgeMinutes(mkt.pairCreatedAt) ?? 'unavailable',
          };
        }
        case 'get_portfolio_status': {
          const open = await this.db.getOpenPositions();
          const pnl = await this.db.getDailyPnL();
          const ethPrice = await getEthPriceUsd();
          const [balanceWei, usdcRaw] = await Promise.all([
            this.publicClient.getBalance({ address: config.wallet.address as `0x${string}` }).catch(() => 0n),
            this.publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [config.wallet.address as `0x${string}`] }).catch(() => 0n),
          ]);
          const ethBalance = parseFloat(formatEther(BigInt(balanceWei)));
          const usdcBalance = parseFloat(formatUnits(BigInt(usdcRaw as bigint), 6));
          return {
            open_positions: open,
            max_positions: config.trading.maxPositions,
            can_open_new: open < config.trading.maxPositions,
            daily_pnl_usd: pnl.toFixed(2),
            eth_balance: ethBalance.toFixed(4),
            eth_balance_usd: (ethBalance * ethPrice).toFixed(2),
            usdc_balance: usdcBalance.toFixed(2),
            total_portfolio_usd: (ethBalance * ethPrice + usdcBalance).toFixed(2),
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
