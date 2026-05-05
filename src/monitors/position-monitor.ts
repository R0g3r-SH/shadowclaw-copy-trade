import { logger } from '../utils/logger';
import { DatabaseService } from '../services/database';
import { TelegramBot } from '../services/telegram';
import { TradeExecutor } from '../execution/trade-executor';
import { getTokenMarketData } from '../utils/dexscreener';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { config } from '../config';
import { USDC_ADDRESS, ERC20_BALANCE_ABI } from '../constants/tokens';

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute — catch take-profit windows faster

const STOP_LOSS_PCT        = -0.10; // hard floor: -10%
const TAKE_PROFIT_PCT      =  0.80; // hard ceiling: +80% (trailing stop handles sub-80% exits)
const TRAILING_ACTIVATION  =  0.12; // trailing stop activates once position is up +12%
const TRAILING_DROP        =  0.07; // sell if price drops 7% from the all-time peak

const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);
const decimalsCache = new Map<string, number>();

const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(config.blockchain.alchemy.httpRpcUrl),
});

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const key = tokenAddress.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const decimals = await publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    decimalsCache.set(key, decimals);
    return decimals;
  } catch {
    return 18;
  }
}

export class PositionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;

  constructor(
    private db: DatabaseService,
    private telegram: TelegramBot,
    private executor: TradeExecutor
  ) {}

  pause(): void  { this.paused = true;  logger.info('Position monitor paused'); }
  resume(): void { this.paused = false; logger.info('Position monitor resumed'); }

  // Trigger an immediate check on a specific token (e.g. after large external sell detected)
  async checkNow(tokenAddress?: string): Promise<void> {
    if (this.paused) return;
    try {
      if (tokenAddress) {
        const res = await this.db.query(
          `SELECT id, token_out, amount_in, amount_out, position_size_usd, created_at, peak_pnl_pct
           FROM copied_trades WHERE status = 'filled' AND LOWER(token_out) = $1 LIMIT 1`,
          [tokenAddress.toLowerCase()]
        );
        for (const row of res.rows) await this.checkPosition(row);
      } else {
        await this.checkPositions();
      }
    } catch (error) {
      logger.error({ error }, 'Immediate position check error');
    }
  }

  start(): void {
    logger.info('📊 Position monitor started (stop-loss/take-profit active)');
    this.timer = setInterval(() => this.checkPositions(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async checkPositions(): Promise<void> {
    if (this.paused) return;
    try {
      const openTrades = await this.db.query(
        `SELECT id, token_out, amount_in, amount_out, position_size_usd, created_at, peak_pnl_pct
         FROM copied_trades
         WHERE status = 'filled'
         ORDER BY created_at ASC`,
        []
      );

      if (openTrades.rows.length === 0) return;

      logger.info(`📊 Checking ${openTrades.rows.length} open positions...`);

      for (const trade of openTrades.rows) {
        await this.checkPosition(trade);
      }
    } catch (error) {
      logger.error({ error }, 'Position monitor error');
    }
  }

  private async checkPosition(trade: any): Promise<void> {
    try {
      const rawAmountOut = trade.amount_out;
      if (!rawAmountOut || rawAmountOut === '0') {
        logger.debug({ id: trade.id }, 'Skipping position: amount_out not recorded');
        return;
      }

      const entryValueUsd = parseFloat(trade.position_size_usd || '0');
      if (entryValueUsd === 0) return;

      // Get current price from DEXScreener
      const marketData = await getTokenMarketData(trade.token_out);
      if (!marketData || marketData.priceUsd === 0) return;

      // Calculate token amount using on-chain decimals (cached)
      // Safe-parse: NUMERIC column may return "1234.000000000000000000" which BigInt() rejects
      const decimals = await getTokenDecimals(trade.token_out);
      const tokenAmount = parseFloat(formatUnits(BigInt(String(rawAmountOut).split('.')[0]), decimals));
      const currentValueUsd = tokenAmount * marketData.priceUsd;

      const pnlPct = (currentValueUsd - entryValueUsd) / entryValueUsd;

      // Update trailing high water mark — persisted in DB so it survives restarts
      const dbPeak = parseFloat(trade.peak_pnl_pct || '0');
      const peakPnlPct = Math.max(dbPeak, pnlPct);
      if (peakPnlPct > dbPeak) {
        await this.db.updatePeakPnlPct(trade.id, peakPnlPct);
      }

      // Trailing stop: fires when position drops TRAILING_DROP% from its peak,
      // but only if the peak was at least TRAILING_ACTIVATION above entry.
      const trailingTriggered =
        peakPnlPct >= TRAILING_ACTIVATION &&
        pnlPct <= peakPnlPct - TRAILING_DROP;

      logger.debug(
        {
          token: trade.token_out.slice(0, 8),
          pnlPct: (pnlPct * 100).toFixed(1),
          peakPct: (peakPnlPct * 100).toFixed(1),
          trailing: trailingTriggered,
        },
        'Position check'
      );

      const shouldSell =
        pnlPct <= STOP_LOSS_PCT ||
        pnlPct >= TAKE_PROFIT_PCT ||
        trailingTriggered;

      if (!shouldSell) return;

      const reason = pnlPct <= STOP_LOSS_PCT
        ? `🛑 Stop-loss: ${(pnlPct * 100).toFixed(1)}%`
        : trailingTriggered
          ? `📉 Trailing stop: pico +${(peakPnlPct * 100).toFixed(1)}% → actual ${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%`
          : `🎯 Take-profit: +${(pnlPct * 100).toFixed(1)}%`;

      const sellReasonCode = pnlPct <= STOP_LOSS_PCT ? 'stop_loss' : trailingTriggered ? 'trailing_stop' : 'take_profit';

      // Atomic lock: only proceed if we successfully claimed the 'closing' status.
      // Prevents a race with handleSellSignal (wallet-triggered sell) on the same position.
      const locked = await this.db.query(
        `UPDATE copied_trades SET status = 'closing' WHERE id = $1 AND status = 'filled'`,
        [trade.id]
      );
      if (locked.rowCount === 0) {
        logger.debug({ id: trade.id }, 'Position already being closed — skipping SL/TP sell');
        return;
      }

      logger.info(`${reason} — selling ${trade.token_out.slice(0, 8)}...`);

      await this.telegram.send(
        `${reason}\n\nToken: \`${trade.token_out.slice(0, 10)}...\`\nVendiendo posición...`,
        { parse_mode: 'Markdown' }
      );

      // Dynamic slippage based on cached risk score — meme tokens need 10-20%, not 1%
      const safetyCache = await this.db.getSafetyCheck(trade.token_out);
      const riskScore = safetyCache?.risk_score ?? 50;
      const slippage = this.executor.calculateSlippage(trade.token_out, riskScore);

      // Use on-chain balance — handles fee-on-transfer tokens where DB amount_out may be stale
      let sellAmount: bigint;
      try {
        sellAmount = await publicClient.readContract({
          address: trade.token_out as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [config.wallet.address as `0x${string}`],
        });
        if (sellAmount === 0n) {
          // Already sold or zero balance — close the position and move on
          await this.db.updateCopiedTrade(trade.id, { status: 'closed', sellReason: sellReasonCode, closedAt: new Date(), pnl: 0, pnlPct: 0 });
          return;
        }
      } catch {
        // Safe-parse: NUMERIC column may return "1234.000000000000000000"
        sellAmount = BigInt(String(rawAmountOut).split('.')[0]);
      }

      const result = await this.executor.executeTrade({
        tokenIn: trade.token_out,
        tokenOut: USDC_ADDRESS,
        amountIn: sellAmount,
        amountUsd: currentValueUsd,
        slippagePct: slippage,
      });

      if (result.success) {
        // Use actual USDC received (executeTrade returns balance delta, not total wallet balance).
        // Fall back to market estimate only if amountOut is unavailable.
        const proceedsUsdc = result.amountOut
          ? parseFloat(formatUnits(result.amountOut, 6))
          : currentValueUsd;
        const pnlUsd = proceedsUsdc - entryValueUsd;
        const pnlPctFinal = entryValueUsd > 0 ? pnlUsd / entryValueUsd : 0;

        await this.db.updateCopiedTrade(trade.id, {
          status: 'closed',
          ourTxHash: result.txHash,
          executedAt: new Date(),
          amountOut: result.amountOut?.toString(),
          gasCostUsd: 0,
          pnl: pnlUsd,
          pnlPct: pnlPctFinal,
          sellReason: sellReasonCode,
          closedAt: new Date(),
        });

        // Only reset peak after a confirmed close — do not reset on failure
        await this.db.updatePeakPnlPct(trade.id, 0);

        await this.telegram.send(
          `✅ *Posición cerrada*\n\n${reason}\nP&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} USD (${pnlPctFinal >= 0 ? '+' : ''}${(pnlPctFinal * 100).toFixed(1)}%)\n[Ver TX](https://arbiscan.io/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
      } else {
        // Sell failed — restore status AND original peak so trailing stop stays intact
        await this.db.query(
          `UPDATE copied_trades SET status = 'filled', peak_pnl_pct = $1 WHERE id = $2`,
          [peakPnlPct, trade.id]
        );
        logger.error({ id: trade.id, error: result.error }, 'SL/TP sell failed — restored to filled');
      }

    } catch (error) {
      logger.error({ error }, 'Position check failed');
      // Restore status in case lock was acquired but execution threw
      await this.db.query(
        `UPDATE copied_trades SET status = 'filled' WHERE id = $1 AND status = 'closing'`,
        [trade.id]
      ).catch(() => {});
    }
  }
}
