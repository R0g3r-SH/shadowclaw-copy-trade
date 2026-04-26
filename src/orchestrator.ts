import { DatabaseService } from './services/database';
import { RedisService } from './services/redis';
import { TelegramBot } from './services/telegram';
import { TokenSafetyChecker } from './safety/token-safety';
import { HybridDecisionEngine } from './decision/hybrid-engine';
import { TradeExecutor } from './execution/trade-executor';
import { AgentService } from './agent/agent-service';
import { logger } from './utils/logger';
import { config } from './config';
import { getEthPriceUsd } from './utils/dexscreener';
import { dash } from './dashboard/events';
import { createPublicClient, http, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';

export interface TradeSignal {
  txHash: string;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  dex: string;
  timestamp: Date;
  isSell?: boolean;
}

export class TradeOrchestrator {
  private safetyChecker: TokenSafetyChecker;
  private decisionEngine: HybridDecisionEngine;
  private tradeExecutor: TradeExecutor;
  private agent: AgentService;
  private lastCircuitBreakerAlert = 0; // debounce circuit breaker notifications
  private activeTradeCount = 0; // prevent concurrent position overflow

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private telegram: TelegramBot
  ) {
    this.safetyChecker = new TokenSafetyChecker(db);
    this.tradeExecutor = new TradeExecutor(db);
    this.agent = new AgentService(db, this.safetyChecker, this.tradeExecutor);
    this.decisionEngine = new HybridDecisionEngine(telegram, db, this.agent);
  }

  async handleTradeSignal(signal: TradeSignal): Promise<void> {
    // Prevent concurrent execution for same wallet
    if (this.activeTradeCount >= 3) {
      logger.warn('Too many concurrent trades, dropping signal');
      return;
    }
    this.activeTradeCount++;
    try {
      // Deduplicate: skip if this txHash was already processed (WS reconnect protection)
      const isNew = await this.redis.markTxProcessed(signal.txHash);
      if (!isNew) {
        logger.debug(`Duplicate txHash skipped: ${signal.txHash.slice(0, 12)}`);
        return;
      }

      logger.info(`🎯 Processing trade signal from ${signal.walletAddress.slice(0, 8)}...`);

      await this.db.logEvent('trade', 'info',
        `BUY detectado: ${signal.walletAddress.slice(0, 10)} → ${signal.tokenOut.slice(0, 10)} en ${signal.dex}`,
        { wallet: signal.walletAddress, tokenOut: signal.tokenOut, dex: signal.dex, txHash: signal.txHash }
      );

      // 1. Save to database
      await this.db.saveTrackedTransaction({
        txHash: signal.txHash,
        walletAddress: signal.walletAddress,
        tokenIn: signal.tokenIn,
        tokenOut: signal.tokenOut,
        amountIn: signal.amountIn.toString(),
        dex: signal.dex,
        timestamp: signal.timestamp,
      });

      // 2. Check circuit breaker (debounced — only alert once per 10 min)
      const circuitBreakerTriggered = await this.checkCircuitBreaker();
      if (circuitBreakerTriggered) {
        logger.warn('⚠️ Circuit breaker active - skipping trade');
        const now = Date.now();
        if (now - this.lastCircuitBreakerAlert > 10 * 60 * 1000) {
          this.lastCircuitBreakerAlert = now;
          await this.telegram.send('⚠️ Circuit breaker activo — trades pausados');
        }
        return;
      }

      // 3. Guard: don't exceed max positions with concurrent signals
      const openPositions = await this.db.getOpenPositions();
      if (openPositions >= config.trading.maxPositions) {
        logger.warn(`Max positions reached (${openPositions}/${config.trading.maxPositions}), skipping`);
        await this.telegram.send(
          `⚠️ *Señal ignorada — máximo de posiciones*\n\nWallet: \`${signal.walletAddress.slice(0, 10)}...\`\nPosiciones abiertas: ${openPositions}/${config.trading.maxPositions}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // 3. Safety check on token
      logger.info('Running safety checks...');
      const safetyResult = await this.safetyChecker.checkToken(signal.tokenOut);

      logger.info(`Safety check complete: Risk ${safetyResult.riskScore}/100`);

      const safetyMsg = `🔒 Safety ${signal.tokenOut.slice(0,8)}: ${safetyResult.riskScore}/100 ${safetyResult.shouldBlock ? `🚫 ${safetyResult.reasons[0]}` : '✅ OK'}`;
      dash.emit('log', { severity: safetyResult.shouldBlock ? 'warning' : 'info', message: safetyMsg });
      await this.db.logEvent('trade', safetyResult.shouldBlock ? 'warning' : 'info', safetyMsg);

      if (safetyResult.shouldBlock) {
        logger.warn(`🚫 Trade blocked: ${safetyResult.reasons[0]}`);
        await this.telegram.sendTradeNotification({
          wallet: signal.walletAddress,
          token: signal.tokenOut,
          amountUsd: 0,
          action: 'skipped',
          reason: safetyResult.reasons[0],
        });
        return;
      }

      // 4. Get wallet score
      const walletScore = await this.getWalletScore(signal.walletAddress);

      // 5. Calculate max safe position — agent will decide actual amount within this cap
      const ethPrice = await getEthPriceUsd();
      const maxPositionWei = await this.calculateMaxPosition();
      const maxAmountUsd = parseFloat(formatUnits(maxPositionWei, 18)) * ethPrice;

      logger.info(`Max position: $${maxAmountUsd.toFixed(2)} (wallet score: ${walletScore}, risk data: ${safetyResult.riskScore}/100)`);

      const posMsg = `📐 Max posición: $${maxAmountUsd.toFixed(2)} · wallet score ${walletScore} · risk ${safetyResult.riskScore}/100 · agente decide monto`;
      dash.emit('log', { severity: 'info', message: posMsg });
      await this.db.logEvent('trade', 'info', posMsg);

      // 6. Agent decides everything
      logger.info('Agent analyzing...');

      const decision = await this.decisionEngine.makeDecision({
        walletAddress: signal.walletAddress,
        walletScore,
        tokenAddress: signal.tokenOut,
        tokenIn: signal.tokenIn,
        maxAmountUsd,
        safetyResult,
        originalTxHash: signal.txHash,
      });

      // Agent already executed via tool — do not execute again
      if (decision.alreadyExecuted) {
        logger.info('✅ Trade already executed by agent — skipping orchestrator execution');
        dash.emit('log', { severity: 'claude', message: `🤖 Agente auto-ejecutó — conf: ${decision.agentConfidence ?? '?'}%` });
        return;
      }

      const decisionMsg = `🤖 Decisión: ${decision.reason}${decision.agentConfidence != null ? ` (conf: ${decision.agentConfidence}%)` : ''}`;
      dash.emit('log', { severity: decision.shouldExecute ? 'claude' : 'info', message: decisionMsg });
      await this.db.logEvent('trade', decision.shouldExecute ? 'info' : 'warning', decisionMsg,
        { wallet: signal.walletAddress, confidence: decision.agentConfidence, alreadyExecuted: decision.alreadyExecuted });

      if (!decision.shouldExecute) {
        logger.info(`❌ Trade not executed: ${decision.reason}`);
        dash.emit('trade', { action: 'skipped', token: signal.tokenOut, reason: decision.reason });
        await this.telegram.sendTradeNotification({
          wallet: signal.walletAddress,
          token: signal.tokenOut,
          amountUsd: decision.suggestedAmountUsd ?? 0,
          action: 'skipped',
          reason: decision.reason,
        });
        return;
      }

      // 7. Execute trade (user approved agent's recommendation)
      logger.info('✅ Executing trade after user approval...');

      const approvedAmountUsd = decision.suggestedAmountUsd ?? maxAmountUsd;
      const approvedAmountWei = BigInt(Math.floor((approvedAmountUsd / ethPrice) * 1e18));
      const slippage = this.tradeExecutor.calculateSlippage(signal.tokenOut, safetyResult.riskScore);

      const result = await this.tradeExecutor.executeTrade({
        tokenIn: signal.tokenIn,
        tokenOut: signal.tokenOut,
        amountIn: approvedAmountWei,
        amountUsd: approvedAmountUsd,
        slippagePct: slippage,
      });

      if (result.success) {
        logger.info(`🎉 Trade executed successfully! TX: ${result.txHash}`);

        const tradeId = await this.db.saveCopiedTrade({
          originalTxHash: signal.txHash,
          walletAddress: signal.walletAddress,
          tokenIn: signal.tokenIn,
          tokenOut: signal.tokenOut,
          amountIn: approvedAmountWei.toString(),
          positionSizeUsd: approvedAmountUsd,
        });

        await this.db.updateCopiedTrade(tradeId, {
          ourTxHash: result.txHash,
          status: 'filled',
          executedAt: new Date(),
          amountOut: result.amountOut?.toString(),
          gasCostUsd: result.gasCost ? parseFloat(formatUnits(result.gasCost, 18)) * ethPrice : 0,
        });

        dash.emit('trade', { action: 'executed', token: signal.tokenOut, amountUsd: approvedAmountUsd, wallet: signal.walletAddress });
        await this.telegram.sendTradeNotification({
          wallet: signal.walletAddress,
          token: signal.tokenOut,
          amountUsd: approvedAmountUsd,
          action: 'executed',
        });

        // Send transaction link
        await this.telegram.send(
          `🔗 [View on Arbiscan](https://arbiscan.io/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );

      } else {
        logger.error(`❌ Trade execution failed: ${result.error}`);

        await this.telegram.sendTradeNotification({
          wallet: signal.walletAddress,
          token: signal.tokenOut,
          amountUsd: approvedAmountUsd,
          action: 'failed',
          reason: result.error,
        });
      }

    } catch (error) {
      logger.error({ error }, 'Error handling trade signal');
      await this.telegram.sendAlert('critical', `Error processing trade: ${error}`);
    } finally {
      this.activeTradeCount--;
    }
  }

  async handleSellSignal(signal: TradeSignal): Promise<void> {
    try {
      // Find our open position for this token from this wallet
      const position = await this.db.query(
        `SELECT ct.id, ct.token_out, ct.amount_in, ct.our_tx_hash
         FROM copied_trades ct
         WHERE ct.wallet_address = $1
           AND ct.token_out = $2
           AND ct.status = 'filled'
         ORDER BY ct.created_at DESC
         LIMIT 1`,
        [signal.walletAddress, signal.tokenIn]
      );

      if (position.rows.length === 0) {
        logger.debug(`No open position for ${signal.tokenIn} from ${signal.walletAddress.slice(0, 8)}`);
        return;
      }

      const trade = position.rows[0];
      logger.info(`📤 Wallet sold ${signal.tokenIn.slice(0, 8)}... — copying sell`);
      await this.db.logEvent('trade', 'info',
        `SELL copiado: ${signal.walletAddress.slice(0, 10)} vendió ${signal.tokenIn.slice(0, 10)}`,
        { wallet: signal.walletAddress, tokenIn: signal.tokenIn, dex: signal.dex }
      );

      // Check circuit breaker
      if (await this.redis.isCircuitBreakerTriggered()) {
        logger.warn('Circuit breaker active — skipping sell');
        return;
      }

      // Execute sell: swap our token back to ETH
      const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
      const tokenBalance = BigInt(trade.amount_in || '0');

      if (tokenBalance === 0n) {
        logger.warn('Token balance is 0, skipping sell');
        return;
      }

      const result = await this.tradeExecutor.executeTrade({
        tokenIn: signal.tokenIn,  // the token we hold
        tokenOut: WETH,           // sell back to ETH
        amountIn: tokenBalance,
        amountUsd: 0,             // unknown, calculated post-trade
        slippagePct: 1,
      });

      if (result.success) {
        // Calculate rough P&L (in ETH, simplified)
        const pnlEth = result.amountOut
          ? parseFloat(formatUnits(result.amountOut - tokenBalance, 18))
          : 0;

        // Close the copied trade
        await this.db.updateCopiedTrade(trade.id, {
          status: 'closed',
          ourTxHash: result.txHash,
          executedAt: new Date(),
          amountOut: result.amountOut?.toString(),
          pnl: pnlEth,
        });

        logger.info(`✅ Sell executed! TX: ${result.txHash}`);

        await this.telegram.send(
          `📤 *Venta ejecutada*\n\nToken: \`${signal.tokenIn.slice(0, 10)}...\`\nTX: [Ver en Arbiscan](https://arbiscan.io/tx/${result.txHash})\n\nLa wallet copiada vendió y nosotros también 🎯`,
          { parse_mode: 'Markdown' }
        );
      } else {
        logger.error(`❌ Sell failed: ${result.error}`);
        await this.telegram.sendAlert('warning', `❌ No se pudo vender ${signal.tokenIn.slice(0, 10)}...\nError: ${result.error}`);
      }

    } catch (error) {
      logger.error({ error }, 'Error handling sell signal');
    }
  }

  private async checkCircuitBreaker(): Promise<boolean> {
    // Check if circuit breaker is already triggered
    if (await this.redis.isCircuitBreakerTriggered()) {
      return true;
    }

    // Check daily loss limit
    const dailyPnL = await this.db.getDailyPnL();
    const dailyLossLimit = -config.trading.dailyLossLimit;

    if (dailyPnL < dailyLossLimit) {
      await this.redis.triggerCircuitBreaker('daily_loss_limit', 3600);
      await this.telegram.sendAlert(
        'critical',
        `🚨 CIRCUIT BREAKER: Daily loss limit exceeded ($${dailyPnL.toFixed(2)})`
      );
      return true;
    }

    // Check hourly loss limit
    const hourlyPnL = await this.db.getHourlyPnL();
    const hourlyLossLimit = -config.trading.hourlyLossLimit;

    if (hourlyPnL < hourlyLossLimit) {
      await this.redis.triggerCircuitBreaker('hourly_loss_limit', 1800);
      await this.telegram.sendAlert(
        'warning',
        `⚠️ CIRCUIT BREAKER: Hourly loss limit exceeded ($${hourlyPnL.toFixed(2)})`
      );
      return true;
    }

    return false;
  }

  private async getWalletScore(address: string): Promise<number> {
    const result = await this.db.query(
      'SELECT score FROM wallets WHERE address = $1',
      [address.toLowerCase()]
    );

    return result.rows[0]?.score || 50; // Default score if not found
  }

  private async calculateMaxPosition(): Promise<bigint> {
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(`https://arb-mainnet.g.alchemy.com/v2/${config.blockchain.alchemy.apiKey}`),
    });

    const balanceWei = await publicClient.getBalance({
      address: config.wallet.address as `0x${string}`,
    });

    // Max single position cap — agent decides actual size within this
    const maxPct = config.trading.maxSinglePosition; // 20%
    return (balanceWei * BigInt(Math.floor(maxPct * 10000))) / 10000n;
  }
}
