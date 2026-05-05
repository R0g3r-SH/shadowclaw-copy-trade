import axios from 'axios';
import { logger } from '../utils/logger';
import { RedisService } from '../services/redis';
import { TelegramBot } from '../services/telegram';
import { DatabaseService } from '../services/database';
import { dash } from '../dashboard/events';

export type MarketCondition = 'BULL' | 'NEUTRAL' | 'BEAR';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const CONDITION_TTL_S   = 20 * 60; // 20 min — slightly longer than check interval

export class MarketSentinelAgent {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private redis: RedisService,
    private telegram: TelegramBot,
    private db: DatabaseService,
  ) {}

  start(): void {
    logger.info('MarketSentinelAgent started (every 15 min)');
    this.runCheck().catch(e => logger.warn({ e }, 'Market sentinel initial check failed'));
    this.timer = setInterval(() => {
      this.runCheck().catch(e => logger.warn({ e }, 'Market sentinel check failed'));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runCheck(): Promise<void> {
    try {
      const condition = await this.analyzeMarket();
      const prev = await this.redis.get('market:condition') as MarketCondition | null;

      await this.redis.set('market:condition', condition, CONDITION_TTL_S);

      const multStr = condition === 'BULL' ? '1.2×' : condition === 'BEAR' ? '0.6×' : '1.0×';
      dash.emit('log', {
        severity: condition === 'BEAR' ? 'warning' : 'info',
        message: `🌡️ Mercado: ${condition} (posiciones ${multStr})${prev && prev !== condition ? ` — era ${prev}` : ''}`,
      });

      if (prev && prev !== condition) {
        const emoji = condition === 'BULL' ? '🟢' : condition === 'BEAR' ? '🔴' : '🟡';
        await this.telegram.send(
          `${emoji} *Condición de mercado: ${prev} → ${condition}*\n\n${this.description(condition)}`,
          { parse_mode: 'Markdown' },
        );
        await this.db.logEvent('system', 'info', `Market condition: ${prev} → ${condition}`);
      }
    } catch (error) {
      logger.warn({ error }, 'Market sentinel check failed');
    }
  }

  private async analyzeMarket(): Promise<MarketCondition> {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/search', {
      params: { q: 'arbitrum' },
      timeout: 10_000,
    });

    const pairs: any[] = res.data?.pairs ?? [];
    const qualified = pairs.filter(p =>
      p.chainId === 'arbitrum' &&
      parseFloat(p.liquidity?.usd ?? '0') > 100_000 &&
      parseFloat(p.volume?.h24 ?? '0') > 50_000,
    ).slice(0, 30);

    if (qualified.length < 5) return 'NEUTRAL';

    const changes = qualified.map(p => parseFloat(p.priceChange?.h1 ?? '0'));
    const positive  = changes.filter(c => c > 0).length;
    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
    const posPct    = positive / changes.length;

    if (posPct > 0.65 && avgChange > 3)  return 'BULL';
    if (posPct < 0.35 && avgChange < -3) return 'BEAR';
    return 'NEUTRAL';
  }

  private description(c: MarketCondition): string {
    if (c === 'BULL') return 'Mercado bullish — posiciones escaladas a 1.2× del tamaño normal';
    if (c === 'BEAR') return 'Mercado bearish — posiciones reducidas a 0.6×, umbrales más altos';
    return 'Mercado neutral — operación normal';
  }
}
