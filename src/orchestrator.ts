import { DatabaseService } from './services/database';
import { RedisService } from './services/redis';
import { TelegramBot } from './services/telegram';
import { TokenSafetyChecker } from './safety/token-safety';
import { HybridDecisionEngine } from './decision/hybrid-engine';
import { TradeExecutor } from './execution/trade-executor';
import { AgentService } from './agent/agent-service';
import { ConvergenceTracker } from './services/convergence-tracker';
import { logger } from './utils/logger';
import { config } from './config';
import { getEthPriceUsd } from './utils/dexscreener';
import { dash } from './dashboard/events';
import { createPublicClient, http, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { USDC_ADDRESS, ERC20_BALANCE_ABI, usdToUsdc } from './constants/tokens';

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

// Singleton client — reused across all trade signals to avoid new TCP connections per call
const publicClientSingleton = createPublicClient({
  chain: arbitrum,
  transport: http(config.blockchain.alchemy.httpRpcUrl),
});

// Convergence position-size multipliers
const CONVERGENCE_2X = 1.5; // 2 wallets → 1.5× base size
const CONVERGENCE_3X = 2.0; // 3+ wallets → 2× base size (bypass agent entirely)

export class TradeOrchestrator {
  private safetyChecker: TokenSafetyChecker;
  private decisionEngine: HybridDecisionEngine;
  readonly tradeExecutor: TradeExecutor;
  private agent: AgentService;
  private convergenceTracker: ConvergenceTracker;
  private lastCircuitBreakerAlert = 0;
  private activeTradeCount = 0;
  private portfolioValueUsd = 0;

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private telegram: TelegramBot
  ) {
    this.safetyChecker = new TokenSafetyChecker(db);
    this.tradeExecutor = new TradeExecutor(db);
    this.agent = new AgentService(db, this.safetyChecker, this.tradeExecutor);
    this.decisionEngine = new HybridDecisionEngine(telegram, db, this.agent);
    this.convergenceTracker = new ConvergenceTracker(redis);
  }

  async handleTradeSignal(signal: TradeSignal): Promise<void> {
    // Prevent concurrent execution for same wallet
    if (this.activeTradeCount >= 3) {
      logger.warn('Too many concurrent trades, dropping signal');
      return;
    }
    this.activeTradeCount++;
    let tokenLockAcquired = false;
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

      // 2. Get portfolio value early — needed for circuit breaker percentage math
      const [ethPrice, maxPositionUsdc] = await Promise.all([
        getEthPriceUsd().catch(() => 2500),
        this.calculateMaxPosition(),
      ]);
      this.portfolioValueUsd = parseFloat(formatUnits(maxPositionUsdc, 6)) / config.trading.positionSizePct;

      // 3. Check circuit breaker (debounced — only alert once per 10 min)
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

      // 4. Guard: don't exceed max positions with concurrent signals
      const openPositions = await this.db.getOpenPositions();
      if (openPositions >= config.trading.maxPositions) {
        logger.warn(`Max positions reached (${openPositions}/${config.trading.maxPositions}), skipping`);
        await this.telegram.send(
          `⚠️ *Señal ignorada — máximo de posiciones*\n\nWallet: \`${signal.walletAddress.slice(0, 10)}...\`\nPosiciones abiertas: ${openPositions}/${config.trading.maxPositions}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // 5. Safety check on token
      logger.info('Running safety checks...');
      const safetyResult = await this.safetyChecker.checkToken(signal.tokenOut);

      logger.info(`Safety check complete: Risk ${safetyResult.riskScore}/100`);

      const safetyMsg = `🔒 Safety ${signal.tokenOut.slice(0,8)}: ${safetyResult.riskScore}/100 ${safetyResult.shouldBlock ? `🚫 ${safetyResult.reasons[0]}` : '✅ OK'}`;
      dash.emit('log', { severity: safetyResult.shouldBlock ? 'warning' : 'info', message: safetyMsg });
      await this.db.logEvent('trade', safetyResult.shouldBlock ? 'warning' : 'info', safetyMsg);

      if (safetyResult.shouldBlock) {
        logger.warn(`🚫 Trade blocked: ${safetyResult.reasons[0]}`);
        await this.telegram.sendTradeNotification({
          wallet: signal.walletAddress, token: signal.tokenOut,
          amountUsd: 0, action: 'skipped', reason: safetyResult.reasons[0],
        });
        return;
      }

      // Hard block on riskScore threshold — enforced here so no code path bypasses it.
      // shouldBlock only catches honeypot/blacklist; high-score tokens need an explicit gate.
      if (safetyResult.riskScore >= config.risk.maxRiskScore) {
        const reason = `Risk score ${safetyResult.riskScore}/100 ≥ limit ${config.risk.maxRiskScore}`;
        logger.warn(`🚫 Trade blocked: ${reason}`);
        dash.emit('log', { severity: 'warning', message: `🚫 ${signal.tokenOut.slice(0,8)}: ${reason}` });
        await this.db.logEvent('trade', 'warning', `Trade blocked: ${reason}`, { token: signal.tokenOut });
        await this.telegram.sendTradeNotification({
          wallet: signal.walletAddress, token: signal.tokenOut,
          amountUsd: 0, action: 'skipped', reason,
        });
        return;
      }

      // 6. Get wallet score
      const walletScore = await this.getWalletScore(signal.walletAddress);

      // 6b. Acquire per-token lock to prevent race condition where two concurrent signals
      // for the same token both pass the alreadyHeld check before either inserts a trade
      tokenLockAcquired = await this.redis.acquireTokenLock(signal.tokenOut, 90);
      if (!tokenLockAcquired) {
        logger.info(`Token ${signal.tokenOut.slice(0, 8)} already being evaluated — dropping concurrent signal`);
        return;
      }

      // Guard: skip if we already hold this token (don't double-buy)
      const alreadyHeld = await this.db.query(
        `SELECT id FROM copied_trades WHERE token_out = $1 AND status IN ('filled','closing') LIMIT 1`,
        [signal.tokenOut]
      );
      if (alreadyHeld.rows.length > 0) {
        logger.info(`Already holding ${signal.tokenOut.slice(0, 8)} — skipping duplicate buy`);
        return;
      }

      // 7. Convergence tracking — record this wallet's signal and get current state
      const convergence = await this.convergenceTracker.addSignal(
        signal.tokenOut,
        signal.walletAddress,
        walletScore,
      );

      // Mark signal activity for BriefingAgent inactivity watch
      await this.redis.setLastSignalTime();

      // Boost position size based on convergence: 2 wallets → 1.5×, 3+ → 2×
      const baseMaxUsd = parseFloat(formatUnits(maxPositionUsdc, 6));
      const convergenceMultiplier = convergence.isStrong
        ? CONVERGENCE_3X
        : convergence.isConverging
          ? CONVERGENCE_2X
          : 1.0;

      // Scale by market condition (BULL=1.2×, NEUTRAL=1.0×, BEAR=0.6×)
      const marketCondition = await this.redis.get('market:condition') as 'BULL' | 'NEUTRAL' | 'BEAR' | null;
      const marketMultiplier = marketCondition === 'BULL' ? 1.2 : marketCondition === 'BEAR' ? 0.6 : 1.0;
      if (marketCondition && marketCondition !== 'NEUTRAL') {
        logger.info(`Market condition: ${marketCondition} (${marketMultiplier}× position multiplier)`);
      }

      const maxAmountUsd = baseMaxUsd * convergenceMultiplier * marketMultiplier;

      if (convergence.isConverging) {
        const convMsg = convergence.isStrong
          ? `⚡ CONVERGENCIA FUERTE: ${convergence.count} wallets compraron ${signal.tokenOut.slice(0, 8)}... · score prom: ${convergence.avgWalletScore} · size: ${convergenceMultiplier}× ($${maxAmountUsd.toFixed(2)})`
          : `⚡ Convergencia: ${convergence.count} wallets → ${signal.tokenOut.slice(0, 8)}... · size: ${convergenceMultiplier}× ($${maxAmountUsd.toFixed(2)})`;
        logger.info(convMsg);
        dash.emit('log', { severity: 'claude', message: convMsg });
        await this.db.logEvent('trade', 'info', convMsg, { convergence: convergence.count, avgScore: convergence.avgWalletScore });
      }

      // 7b. STRONG CONVERGENCE BYPASS — skip agent when signal is unambiguous:
      //     3+ top wallets + clean safety + good liquidity → execute immediately
      const safetyClean = !safetyResult.isHoneypot && !safetyResult.isBlacklisted &&
                          safetyResult.riskScore < config.risk.maxRiskScore && safetyResult.liquidityUsd >= 25000;

      if (convergence.isStrong && convergence.avgWalletScore >= 70 && safetyClean) {
        logger.info(`⚡ Strong convergence bypass — auto-executing without agent`);
        const slippage = this.tradeExecutor.calculateSlippage(signal.tokenOut, safetyResult.riskScore);
        const amountIn = usdToUsdc(maxAmountUsd);

        const result = await this.tradeExecutor.executeTrade({
          tokenIn: USDC_ADDRESS,
          tokenOut: signal.tokenOut,
          amountIn,
          amountUsd: maxAmountUsd,
          slippagePct: slippage,
        });

        const walletList = convergence.wallets.map(w => `\`${w.walletAddress.slice(0, 6)}…\` (${w.walletScore})`).join(', ');
        if (result.success) {
          const tradeId = await this.db.saveCopiedTrade({
            originalTxHash: signal.txHash,
            walletAddress: signal.walletAddress,
            tokenIn: USDC_ADDRESS,
            tokenOut: signal.tokenOut,
            amountIn: amountIn.toString(),
            positionSizeUsd: maxAmountUsd,
          });
          await this.db.updateCopiedTrade(tradeId, {
            ourTxHash: result.txHash,
            status: 'filled',
            executedAt: new Date(),
            amountOut: result.amountOut?.toString(),
            gasCostUsd: result.gasCost ? parseFloat(formatUnits(result.gasCost, 18)) * ethPrice : 0,
          });
          dash.emit('trade', { action: 'executed', token: signal.tokenOut, amountUsd: maxAmountUsd, convergence: convergence.count });
          await this.telegram.send(
            `⚡ *Convergencia fuerte — auto-ejecutado*\n\n` +
            `Token: \`${signal.tokenOut.slice(0, 10)}...\`\n` +
            `Wallets: ${walletList}\n` +
            `Monto: $${maxAmountUsd.toFixed(2)} (${convergenceMultiplier}× base)\n` +
            `[Ver TX](https://arbiscan.io/tx/${result.txHash})`,
            { parse_mode: 'Markdown' }
          );
        } else {
          logger.error(`❌ Convergence bypass trade failed: ${result.error}`);
          await this.telegram.send(`❌ Convergencia fallida: ${result.error?.slice(0, 100)}`);
        }
        return;
      }

      logger.info(`Max position: $${maxAmountUsd.toFixed(2)} (wallet score: ${walletScore}, risk: ${safetyResult.riskScore}/100${convergence.isConverging ? `, convergencia: ${convergence.count}×` : ''})`);
      dash.emit('log', { severity: 'info', message: `📐 Max posición: $${maxAmountUsd.toFixed(2)} · wallet score ${walletScore} · risk ${safetyResult.riskScore}/100` });

      // 8. Agent decides (with convergence context)
      logger.info('Agent analyzing...');

      const decision = await this.decisionEngine.makeDecision({
        walletAddress: signal.walletAddress,
        walletScore,
        tokenAddress: signal.tokenOut,
        tokenIn: signal.tokenIn,
        maxAmountUsd,
        safetyResult,
        originalTxHash: signal.txHash,
        convergence,
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
      const approvedAmountIn = usdToUsdc(approvedAmountUsd);
      const slippage = this.tradeExecutor.calculateSlippage(signal.tokenOut, safetyResult.riskScore);

      const result = await this.tradeExecutor.executeTrade({
        tokenIn: USDC_ADDRESS,
        tokenOut: signal.tokenOut,
        amountIn: approvedAmountIn,
        amountUsd: approvedAmountUsd,
        slippagePct: slippage,
      });

      if (result.success) {
        logger.info(`🎉 Trade executed successfully! TX: ${result.txHash}`);

        const tradeId = await this.db.saveCopiedTrade({
          originalTxHash: signal.txHash,
          walletAddress: signal.walletAddress,
          tokenIn: USDC_ADDRESS,
          tokenOut: signal.tokenOut,
          amountIn: approvedAmountIn.toString(),
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
      dash.emit('log', { severity: 'error', message: `❌ Error procesando trade: ${String(error).slice(0, 120)}` });
      await this.telegram.sendAlert('critical', `Error processing trade: ${error}`);
    } finally {
      this.activeTradeCount--;
      if (tokenLockAcquired) {
        await this.redis.releaseTokenLock(signal.tokenOut).catch(() => {});
      }
    }
  }

  async handleSellSignal(signal: TradeSignal): Promise<void> {
    let lockedTradeId: number | undefined;
    try {
      // Find our open position and atomically lock it to prevent double-sell race
      const position = await this.db.query(
        `UPDATE copied_trades SET status = 'closing'
         WHERE id = (
           SELECT id FROM copied_trades
           WHERE wallet_address = $1
             AND token_out = $2
             AND status = 'filled'
           ORDER BY created_at DESC
           LIMIT 1
         ) AND status = 'filled'
         RETURNING id, token_out, amount_in, amount_out, our_tx_hash, position_size_usd`,
        [signal.walletAddress, signal.tokenIn]
      );

      if (position.rows.length === 0) {
        logger.debug(`No open position for ${signal.tokenIn} from ${signal.walletAddress.slice(0, 8)} (or already closing)`);
        return;
      }

      const trade = position.rows[0];
      lockedTradeId = trade.id;
      logger.info(`📤 Wallet sold ${signal.tokenIn.slice(0, 8)}... — copying sell`);
      await this.db.logEvent('trade', 'info',
        `SELL copiado: ${signal.walletAddress.slice(0, 10)} vendió ${signal.tokenIn.slice(0, 10)}`,
        { wallet: signal.walletAddress, tokenIn: signal.tokenIn, dex: signal.dex }
      );

      // Circuit breaker intentionally NOT checked here — exits should always proceed.
      // CB only blocks opening new positions (buys). Blocking sells would trap us in losing positions.

      // Execute sell: swap tokens back to USDC (trading capital, not ETH/gas)
      // Prefer on-chain balance over DB amount_out — handles fee-on-transfer tokens
      let tokenBalance: bigint;
      try {
        tokenBalance = await publicClientSingleton.readContract({
          address: signal.tokenIn as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [config.wallet.address as `0x${string}`],
        });
      } catch {
        // Fallback to DB-stored amount — safe-parse NUMERIC column (may have decimal points)
        const raw = String(trade.amount_out || '0').split('.')[0];
        tokenBalance = BigInt(raw || '0');
      }

      if (tokenBalance === 0n) {
        logger.warn('Token balance is 0, skipping sell');
        await this.db.query(`UPDATE copied_trades SET status = 'filled' WHERE id = $1`, [trade.id]);
        return;
      }

      const safetyCache = await this.db.getSafetyCheck(signal.tokenIn);
      const riskScore = safetyCache?.risk_score ?? 50;
      const slippage = this.tradeExecutor.calculateSlippage(signal.tokenIn, riskScore);

      const result = await this.tradeExecutor.executeTrade({
        tokenIn: signal.tokenIn,
        tokenOut: USDC_ADDRESS,
        amountIn: tokenBalance,
        amountUsd: 0,
        slippagePct: slippage,
      });

      if (result.success) {
        // P&L in USDC (6 decimals): proceeds minus original position size
        const proceedsUsdc = result.amountOut
          ? parseFloat(formatUnits(result.amountOut, 6))
          : 0;
        const positionCost = parseFloat(trade.position_size_usd || '0');
        const pnlUsd = proceedsUsdc - positionCost;
        const pnlPct = positionCost > 0 ? pnlUsd / positionCost : 0;

        // Close the copied trade
        await this.db.updateCopiedTrade(trade.id, {
          status: 'closed',
          ourTxHash: result.txHash,
          executedAt: new Date(),
          amountOut: result.amountOut?.toString(),
          pnl: pnlUsd,
          pnlPct,
          sellReason: 'wallet_copy',
          closedAt: new Date(),
        });

        logger.info(`✅ Sell executed! TX: ${result.txHash}`);

        await this.telegram.send(
          `📤 *Venta ejecutada*\n\nToken: \`${signal.tokenIn.slice(0, 10)}...\`\nP&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%)\nTX: [Ver en Arbiscan](https://arbiscan.io/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
      } else {
        // Sell failed — restore status so PositionMonitor can retry via SL/TP
        await this.db.query(
          `UPDATE copied_trades SET status = 'filled' WHERE id = $1`,
          [trade.id]
        );
        logger.error(`❌ Sell failed: ${result.error}`);
        await this.telegram.sendAlert('warning', `❌ No se pudo vender ${signal.tokenIn.slice(0, 10)}...\nError: ${result.error}`);
      }

    } catch (error) {
      logger.error({ error }, 'Error handling sell signal');
      // Restore status if lock was acquired but execution threw
      if (lockedTradeId !== undefined) {
        await this.db.query(
          `UPDATE copied_trades SET status = 'filled' WHERE id = $1 AND status = 'closing'`,
          [lockedTradeId]
        ).catch(() => {});
      }
    }
  }

  private async checkCircuitBreaker(): Promise<boolean> {
    if (await this.redis.isCircuitBreakerTriggered()) return true;

    // Convert fractional limits (e.g. 0.10 = 10%) to USD using cached portfolio value
    // portfolioValueUsd is set before this is called in handleTradeSignal
    const portfolio = this.portfolioValueUsd;

    // Skip P&L-based checks if portfolio value is unknown — avoids triggering on $0.10 phantom limit
    if (portfolio > 0) {
      const dailyPnL = await this.db.getDailyPnL();
      const dailyLossLimitUsd = config.trading.dailyLossLimit * portfolio;
      if (dailyPnL < -dailyLossLimitUsd) {
        await this.redis.triggerCircuitBreaker('daily_loss_limit', 3600);
        await this.telegram.sendAlert(
          'critical',
          `🚨 CIRCUIT BREAKER: Pérdida diaria excedida ($${Math.abs(dailyPnL).toFixed(2)} / límite $${dailyLossLimitUsd.toFixed(2)})`
        );
        return true;
      }

      const hourlyPnL = await this.db.getHourlyPnL();
      const hourlyLossLimitUsd = config.trading.hourlyLossLimit * portfolio;
      if (hourlyPnL < -hourlyLossLimitUsd) {
        await this.redis.triggerCircuitBreaker('hourly_loss_limit', 1800);
        await this.telegram.sendAlert(
          'warning',
          `⚠️ CIRCUIT BREAKER: Pérdida horaria excedida ($${Math.abs(hourlyPnL).toFixed(2)} / límite $${hourlyLossLimitUsd.toFixed(2)})`
        );
        return true;
      }
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
    const usdcRaw = await publicClientSingleton.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [config.wallet.address as `0x${string}`],
    });
    const sizePct = BigInt(Math.floor(config.trading.positionSizePct * 10000));
    return (usdcRaw * sizePct) / 10000n;
  }
}
