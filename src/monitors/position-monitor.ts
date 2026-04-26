import { logger } from '../utils/logger';
import { DatabaseService } from '../services/database';
import { TelegramBot } from '../services/telegram';
import { TradeExecutor } from '../execution/trade-executor';
import { getTokenMarketData } from '../utils/dexscreener';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { config } from '../config';

const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const STOP_LOSS_PCT  = -0.10;
const TAKE_PROFIT_PCT = 0.30;

const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);
const decimalsCache = new Map<string, number>();

const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(`https://arb-mainnet.g.alchemy.com/v2/${config.blockchain.alchemy.apiKey}`),
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
        `SELECT id, token_out, amount_in, amount_out, position_size_usd, created_at
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
      const decimals = await getTokenDecimals(trade.token_out);
      const tokenAmount = parseFloat(formatUnits(BigInt(rawAmountOut), decimals));
      const currentValueUsd = tokenAmount * marketData.priceUsd;

      const pnlPct = (currentValueUsd - entryValueUsd) / entryValueUsd;

      logger.debug(
        { token: trade.token_out.slice(0, 8), pnlPct: (pnlPct * 100).toFixed(1), decimals },
        'Position check'
      );

      const shouldSell =
        pnlPct <= STOP_LOSS_PCT ||
        pnlPct >= TAKE_PROFIT_PCT;

      if (!shouldSell) return;

      const reason = pnlPct <= STOP_LOSS_PCT
        ? `🛑 Stop-loss: ${(pnlPct * 100).toFixed(1)}%`
        : `🎯 Take-profit: +${(pnlPct * 100).toFixed(1)}%`;

      logger.info(`${reason} — selling ${trade.token_out.slice(0, 8)}...`);

      await this.telegram.send(
        `${reason}\n\nToken: \`${trade.token_out.slice(0, 10)}...\`\nVendiendo posición...`,
        { parse_mode: 'Markdown' }
      );

      // Execute sell — use amount_out (tokens we hold) as amountIn for the sell
      const result = await this.executor.executeTrade({
        tokenIn: trade.token_out,
        tokenOut: WETH,
        amountIn: BigInt(rawAmountOut),
        amountUsd: currentValueUsd,
        slippagePct: 1,
      });

      if (result.success) {
        const pnlUsd = currentValueUsd - entryValueUsd;

        await this.db.updateCopiedTrade(trade.id, {
          status: 'closed',
          ourTxHash: result.txHash,
          executedAt: new Date(),
          amountOut: result.amountOut?.toString(),
          gasCostUsd: 0,
          pnl: pnlUsd,
        });

        await this.telegram.send(
          `✅ *Posición cerrada*\n\n${reason}\nP&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} USD\n[Ver TX](https://arbiscan.io/tx/${result.txHash})`,
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      logger.debug({ error }, 'Position check skipped');
    }
  }
}
