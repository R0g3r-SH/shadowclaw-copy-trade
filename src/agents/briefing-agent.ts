import { logger } from '../utils/logger';
import { DatabaseService } from '../services/database';
import { TelegramBot } from '../services/telegram';
import { RedisService } from '../services/redis';
import { dash } from '../dashboard/events';

const NO_SIGNAL_THRESHOLD_MIN = 120;
const INACTIVITY_CHECK_MS     = 30 * 60 * 1000;
const BRIEFING_CHECK_MS       = 30 * 60 * 1000;

export class BriefingAgent {
  private briefingTimer:    NodeJS.Timeout | null = null;
  private noSignalTimer:    NodeJS.Timeout | null = null;
  private morningFired     = false;
  private eveningFired     = false;
  private lastFiredDate    = '';

  constructor(
    private db: DatabaseService,
    private telegram: TelegramBot,
    private redis: RedisService,
  ) {}

  start(): void {
    this.briefingTimer = setInterval(
      () => this.checkAndFireBriefing().catch(e => logger.warn({ e }, 'Briefing check failed')),
      BRIEFING_CHECK_MS,
    );
    this.noSignalTimer = setInterval(
      () => this.checkInactivity().catch(e => logger.warn({ e }, 'Inactivity check failed')),
      INACTIVITY_CHECK_MS,
    );
    logger.info('BriefingAgent started (briefings 9am/9pm, inactivity watch)');
  }

  stop(): void {
    if (this.briefingTimer) clearInterval(this.briefingTimer);
    if (this.noSignalTimer)  clearInterval(this.noSignalTimer);
  }

  private async checkAndFireBriefing(): Promise<void> {
    const now     = new Date();
    const dateKey = now.toDateString();
    const hour    = now.getHours();
    const minute  = now.getMinutes();

    if (this.lastFiredDate !== dateKey) {
      this.lastFiredDate = dateKey;
      this.morningFired  = false;
      this.eveningFired  = false;
    }

    if (!this.morningFired && hour === 9 && minute < 30) {
      this.morningFired = true;
      await this.sendBriefing('morning');
    } else if (!this.eveningFired && hour === 21 && minute < 30) {
      this.eveningFired = true;
      await this.sendBriefing('evening');
    }
  }

  private async checkInactivity(): Promise<void> {
    const hour = new Date().getHours();
    if (hour < 7 || hour > 23) return; // don't alert overnight

    const lastSignal = await this.redis.getLastSignalTime();
    const minutesSince = (Date.now() - lastSignal) / 60_000;

    if (minutesSince > NO_SIGNAL_THRESHOLD_MIN) {
      logger.warn(`No trade signals in ${minutesSince.toFixed(0)} min`);
      dash.emit('log', { severity: 'warning', message: `⚠️ Sin señales de trading ${minutesSince.toFixed(0)} min` });
      await this.telegram.send(
        `⚠️ *Sin señales de trading*\n\n` +
        `${minutesSince.toFixed(0)} minutos sin actividad detectada.\n\n` +
        `Verifica que el WebSocket esté conectado y las wallets activas estén haciendo swaps.`,
        { parse_mode: 'Markdown' },
      );
      // Reset so we don't spam — next alert in another 2h
      await this.redis.setLastSignalTime();
    }
  }

  private async sendBriefing(type: 'morning' | 'evening'): Promise<void> {
    try {
      const [pnl, tradesRes, positionsRes, walletsRes, marketCond] = await Promise.all([
        this.db.getDailyPnL(),
        this.db.query(`
          SELECT
            COUNT(*)::int                                        AS total,
            COUNT(CASE WHEN pnl > 0 THEN 1 END)::int            AS wins,
            COUNT(CASE WHEN pnl < 0 THEN 1 END)::int            AS losses,
            COALESCE(MAX(pnl), 0)::float                        AS best_trade,
            COALESCE(MIN(pnl), 0)::float                        AS worst_trade
          FROM copied_trades
          WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '24 hours'
        `),
        this.db.query(`
          SELECT token_out, position_size_usd, peak_pnl_pct, created_at
          FROM copied_trades WHERE status = 'filled'
          ORDER BY created_at ASC
        `),
        this.db.query(`
          SELECT w.address, w.score, COUNT(ct.id)::int AS signals_today
          FROM wallets w
          LEFT JOIN tracked_transactions ct
            ON ct.wallet_address = w.address AND ct.timestamp > NOW() - INTERVAL '24 hours'
          WHERE w.status = 'active'
          GROUP BY w.address, w.score
          ORDER BY signals_today DESC, w.score DESC
          LIMIT 3
        `),
        this.redis.get('market:condition'),
      ]);

      const s       = tradesRes.rows[0];
      const total   = s.total;
      const wins    = s.wins;
      const losses  = s.losses;
      const wr      = total > 0 ? ((wins / total) * 100).toFixed(0) : '0';
      const best    = parseFloat(s.best_trade).toFixed(2);
      const worst   = parseFloat(s.worst_trade).toFixed(2);
      const pnlEmoji = pnl >= 0 ? '📈' : '📉';
      const condEmoji = marketCond === 'BULL' ? '🟢' : marketCond === 'BEAR' ? '🔴' : '🟡';

      const openLines = positionsRes.rows.length > 0
        ? positionsRes.rows.map((p: any) => {
            const peak = p.peak_pnl_pct > 0
              ? ` — pico +${(parseFloat(p.peak_pnl_pct) * 100).toFixed(0)}%`
              : '';
            return `• \`${String(p.token_out).slice(0, 10)}...\` $${parseFloat(p.position_size_usd).toFixed(2)}${peak}`;
          }).join('\n')
        : '_Ninguna_';

      const topWallets = walletsRes.rows.length > 0
        ? walletsRes.rows.map((w: any) =>
            `• \`${String(w.address).slice(0, 8)}...\` score:${w.score} | ${w.signals_today} señales`
          ).join('\n')
        : '_Sin actividad_';

      const header = type === 'morning' ? '☀️ *Buenos días — Briefing del sistema*' : '🌙 *Resumen nocturno*';

      await this.telegram.send(
        `${header}\n\n` +
        `${pnlEmoji} *P&L 24h:* ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n` +
        `📊 *Trades:* ${total} (${wins} ✅ / ${losses} ❌) — WR ${wr}%\n` +
        `💎 *Mejor trade:* +$${best}\n` +
        `📉 *Peor trade:* $${worst}\n` +
        `${condEmoji} *Mercado:* ${marketCond ?? 'NEUTRAL'}\n\n` +
        `*Posiciones abiertas (${positionsRes.rows.length}):*\n${openLines}\n\n` +
        `*Wallets más activas:*\n${topWallets}`,
        { parse_mode: 'Markdown' },
      );

      dash.emit('log', { severity: 'info', message: `📋 Briefing ${type} enviado` });
    } catch (error) {
      logger.error({ error }, `Failed to send ${type} briefing`);
    }
  }
}
