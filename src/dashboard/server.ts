import http from 'http';
import fs from 'fs';
import path_mod from 'path';
import { createPublicClient, http as viemHttp, formatEther, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { dash } from './events';
import { DatabaseService } from '../services/database';
import { RedisService } from '../services/redis';
import { config } from '../config';
import { logger } from '../utils/logger';

const DIST = path_mod.resolve(__dirname, '../../dist/dashboard');
const ALCHEMY_RPC = `https://arb-mainnet.g.alchemy.com/v2/${config.blockchain.alchemy.apiKey}`;
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
const ERC20_ABI = [{
  name: 'balanceOf', type: 'function' as const,
  inputs: [{ name: 'account', type: 'address' as const }],
  outputs: [{ name: '', type: 'uint256' as const }],
  stateMutability: 'view' as const,
}];

const publicClient = createPublicClient({ chain: arbitrum, transport: viemHttp(ALCHEMY_RPC) });
const walletAddress = privateKeyToAccount(config.wallet.privateKey as `0x${string}`).address;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function serveStatic(res: http.ServerResponse, filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const ext = path_mod.extname(filePath);
  const mime = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=31536000',
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

type SSEClient = { res: http.ServerResponse; id: number };
type BotControl = { pause: () => void; resume: () => void };
type DiscoveryInfo = { getScheduleInfo: () => Record<string, string | number> };

export class DashboardServer {
  private clients = new Set<SSEClient>();
  private clientId = 0;
  private server: http.Server | null = null;
  private botPaused = false;
  private botControl: BotControl | null = null;
  private discoveryInfo: DiscoveryInfo | null = null;

  constructor(private db: DatabaseService, private redis: RedisService) {
    this.bindDashEvents();
  }

  setDiscoveryInfo(info: DiscoveryInfo): void { this.discoveryInfo = info; }

  setBotControls(control: BotControl): void {
    this.botControl = control;
    this.redis.isBotPaused().then(paused => {
      this.botPaused = paused;
      if (paused) this.botControl?.pause();
    }).catch(() => {});
  }

  start(port = 3001): void {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(port, () => {
      logger.info(`🖥️  Dashboard disponible en http://localhost:${port}`);
    });
  }

  private bindDashEvents(): void {
    dash.on('block',   d => this.broadcast('block',   d));
    dash.on('signal',  d => this.broadcast('signal',  d));
    dash.on('trade',   d => this.broadcast('trade',   d));
    dash.on('tokens',  d => this.broadcast('tokens',  d));
    dash.on('log',     d => this.broadcast('log',     d));
    dash.on('status',  d => this.broadcast('status',  d));
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try { client.res.write(payload); } catch { this.clients.delete(client); }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = req.url?.split('?')[0] ?? '/';

    if (urlPath.startsWith('/assets/')) {
      if (serveStatic(res, path_mod.join(DIST, urlPath))) return;
    }

    if (urlPath === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':connected\n\n');
      const client: SSEClient = { res, id: ++this.clientId };
      this.clients.add(client);
      this.sendCurrentStatus(res);
      req.on('close', () => this.clients.delete(client));
      return;
    }

    if (urlPath === '/api/bot/toggle' && req.method === 'POST') {
      this.botPaused = !this.botPaused;
      if (this.botPaused) {
        this.botControl?.pause();
        await this.redis.setBotPaused(true);
        logger.info('Bot paused via dashboard');
      } else {
        this.botControl?.resume();
        await this.redis.setBotPaused(false);
        logger.info('Bot resumed via dashboard');
      }
      this.json(res, { paused: this.botPaused });
      return;
    }

    if (urlPath === '/api/status') {
      try {
        const [open, daily, wallets, cb] = await Promise.all([
          this.db.getOpenPositions(),
          this.db.getDailyPnL(),
          this.db.query(`SELECT COUNT(*) as c FROM wallets WHERE status IN ('active','monitoring')`),
          this.redis.isCircuitBreakerTriggered(),
        ]);
        this.json(res, {
          mode: config.trading.autonomyMode,
          wallets: parseInt(wallets.rows[0].c),
          positions: `${open}/${config.trading.maxPositions}`,
          circuit_breaker: cb,
          pnl_today: daily.toFixed(2),
          bot_paused: this.botPaused,
        });
      } catch { this.json(res, { error: 'db error' }); }
      return;
    }

    if (urlPath === '/api/portfolio') {
      try {
        const [ethBal, usdcBal, statsRes] = await Promise.all([
          publicClient.getBalance({ address: walletAddress }),
          publicClient.readContract({
            address: USDC_ARB,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [walletAddress],
          }),
          this.db.query(`
            SELECT
              COALESCE(SUM(pnl), 0)                                           AS total_pnl,
              COUNT(*)                                                          AS total_trades,
              COUNT(CASE WHEN pnl > 0 THEN 1 END)                             AS winning_trades,
              COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0)        AS gross_profit,
              COALESCE(ABS(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END)), 0)   AS gross_loss
            FROM copied_trades
          `),
        ]);

        const row = statsRes.rows[0];
        const totalTrades = parseInt(row.total_trades);
        const winRate = totalTrades > 0
          ? Math.round((parseInt(row.winning_trades) / totalTrades) * 100)
          : 0;
        const profitFactor = parseFloat(row.gross_loss) > 0
          ? parseFloat(row.gross_profit) / parseFloat(row.gross_loss)
          : 0;

        this.json(res, {
          wallet:       walletAddress,
          eth_balance:  parseFloat(formatEther(ethBal as bigint)).toFixed(4),
          usdc_balance: parseFloat(formatUnits(usdcBal as bigint, 6)).toFixed(2),
          total_pnl:    parseFloat(row.total_pnl).toFixed(2),
          total_trades: totalTrades,
          win_rate:     winRate,
          profit_factor: profitFactor.toFixed(2),
        });
      } catch (e) {
        this.json(res, { error: String(e) });
      }
      return;
    }

    if (urlPath === '/api/wallets') {
      try {
        const r = await this.db.query(
          `SELECT address, label, score FROM wallets WHERE status IN ('active','monitoring') ORDER BY score DESC LIMIT 50`
        );
        this.json(res, { wallets: r.rows });
      } catch { this.json(res, { wallets: [] }); }
      return;
    }

    if (urlPath === '/api/trades') {
      try {
        const r = await this.db.query(
          `SELECT token_out, position_size_usd, pnl, status, created_at FROM copied_trades ORDER BY created_at DESC LIMIT 20`
        );
        this.json(res, { trades: r.rows });
      } catch { this.json(res, { trades: [] }); }
      return;
    }

    if (urlPath === '/api/discovery') {
      try {
        const schedule = this.discoveryInfo?.getScheduleInfo() ?? {};
        const [walletStats, smartMoney] = await Promise.all([
          this.db.query(`
            SELECT
              COUNT(*) FILTER (WHERE status IN ('active','monitoring'))   AS active,
              COUNT(*) FILTER (WHERE status = 'retired')                  AS retired,
              COUNT(*) FILTER (WHERE label LIKE 'SmartMoney%')            AS smart_money,
              COUNT(*) FILTER (WHERE label = 'Organic')                   AS organic
            FROM wallets
          `),
          this.db.query(`
            SELECT COUNT(*) AS pending
            FROM wallet_observations
            WHERE swap_count >= 10
              AND address NOT IN (SELECT address FROM wallets)
          `),
        ]);
        const ws = walletStats.rows[0];
        this.json(res, {
          ...schedule,
          active_wallets:      parseInt(ws.active),
          retired_wallets:     parseInt(ws.retired),
          smart_money_wallets: parseInt(ws.smart_money),
          organic_wallets:     parseInt(ws.organic),
          pending_promotion:   parseInt(smartMoney.rows[0].pending),
        });
      } catch (e) { this.json(res, { error: String(e) }); }
      return;
    }

    if (urlPath === '/api/llm-stats') {
      try {
        const r = await this.db.query(`
          SELECT
            metadata->>'source'                       AS source,
            SUM((metadata->>'input_tokens')::int)     AS total_input,
            SUM((metadata->>'output_tokens')::int)    AS total_output,
            COUNT(*)::int                             AS calls
          FROM system_events
          WHERE event_type = 'llm_usage'
            AND created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY metadata->>'source'
          ORDER BY 2 + 3 DESC
        `);
        const totals = await this.db.query(`
          SELECT
            SUM((metadata->>'input_tokens')::int)  AS total_input,
            SUM((metadata->>'output_tokens')::int) AS total_output,
            COUNT(*)::int                          AS total_calls
          FROM system_events
          WHERE event_type = 'llm_usage'
            AND created_at >= NOW() - INTERVAL '24 hours'
        `);
        this.json(res, { by_source: r.rows, totals: totals.rows[0] });
      } catch (e) { this.json(res, { by_source: [], totals: null }); }
      return;
    }

    const index = path_mod.join(DIST, 'index.html');
    if (serveStatic(res, index)) return;
    res.writeHead(503);
    res.end('Dashboard not built. Run: cd dashboard-ui && npm run build');
  }

  private async sendCurrentStatus(res: http.ServerResponse): Promise<void> {
    try {
      const [open, daily, wallets, cb] = await Promise.all([
        this.db.getOpenPositions(),
        this.db.getDailyPnL(),
        this.db.query(`SELECT COUNT(*) as c FROM wallets WHERE status IN ('active','monitoring')`),
        this.redis.isCircuitBreakerTriggered(),
      ]);
      res.write(`event: status\ndata: ${JSON.stringify({
        wallets: parseInt(wallets.rows[0].c),
        positions: `${open}/${config.trading.maxPositions}`,
        circuit_breaker: cb,
        pnl: daily.toFixed(2),
      })}\n\n`);
    } catch { /* ignore */ }
  }

  private json(res: http.ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  }

  stop(): void { this.server?.close(); }
}
