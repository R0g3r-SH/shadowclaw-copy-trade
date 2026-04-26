import axios from 'axios';
import { logger } from '../utils/logger';
import { config } from '../config';
import { DatabaseService } from '../services/database';
import { TelegramBot } from '../services/telegram';
import { dash } from '../dashboard/events';
import type { DiscoveryAgent, WalletForDecision, TrackedWalletPerf } from '../agents/discovery-agent';

const DEX_ROUTERS = [
  { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', name: 'Uniswap V3' },
  { address: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', name: 'Uniswap V3' },
  { address: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', name: 'SushiSwap' },
  { address: '0x1111111254EEB25477B68fb85Ed929f73A960582', name: '1inch' },
  { address: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d', name: 'Camelot' },
  { address: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', name: 'Paraswap' },
  { address: '0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13', name: 'Odos' },
  { address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', name: 'Balancer' },
  { address: '0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB04', name: 'TraderJoe' },
  { address: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e', name: 'Ramses' },
];

const KNOWN_CONTRACTS = new Set([
  ...DEX_ROUTERS.map(r => r.address.toLowerCase()),
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

const ARBISCAN_BASE         = 'https://api.etherscan.io/v2/api';
const DISCOVERY_INTERVAL_MS = 2 * 60 * 60 * 1000;
const PERF_REVIEW_INTERVAL  = 6 * 60 * 60 * 1000;
const MIN_SWAPS_TO_TRACK    = 5;
const MIN_SCORE_TO_ADD      = 60;
const MAX_WALLETS_TO_ADD    = 3;
const MAX_TRACKED_WALLETS   = 20;
const OBSERVE_DEBOUNCE_MS   = 5 * 60 * 1000;
const RETIRE_SCORE_THRESHOLD = 38;
const MIN_TRADES_FOR_PERF    = 3;

interface WalletCandidate {
  address:   string;
  swapCount: number;
  routers:   Set<string>;
  lastTxAt:  number;
  source:    'arbiscan' | 'smart-money';
}

export class WalletDiscoveryService {
  private isRunning  = false;
  private timer:     NodeJS.Timeout | null = null;
  private perfTimer: NodeJS.Timeout | null = null;
  private lastRun:   Date | null = null;
  private nextRun:   Date | null = null;
  private startedAt: Date = new Date();
  private runsCompleted = 0;
  private onWalletAdded: (() => Promise<void>) | null = null;
  private recentlyObserved = new Map<string, number>();
  private discoveryAgent: DiscoveryAgent | null = null;

  constructor(private db: DatabaseService, private telegram: TelegramBot) {}

  setOnWalletAdded(cb: () => Promise<void>): void { this.onWalletAdded = cb; }
  setDiscoveryAgent(agent: DiscoveryAgent): void   { this.discoveryAgent = agent; }

  getScheduleInfo() {
    const now = new Date();
    return {
      iniciado:              this.startedAt.toLocaleString('es-MX'),
      uptime:                this.formatUptime(now.getTime() - this.startedAt.getTime()),
      ultima_busqueda:       this.lastRun ? this.lastRun.toLocaleString('es-MX') : 'Aun no ha corrido',
      proxima_busqueda:      this.nextRun ? this.nextRun.toLocaleString('es-MX') : 'En ~2 minutos',
      tiempo_para_proxima:   this.nextRun ? this.formatUptime(this.nextRun.getTime() - now.getTime()) : 'Pronto',
      busquedas_completadas: this.runsCompleted,
      intervalo:             'Cada 2 horas',
    };
  }

  private formatUptime(ms: number): string {
    if (ms < 0) return 'Ahora';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info('Discovery service started');
    this.nextRun = new Date(Date.now() + 2 * 60 * 1000);
    const safeRun = () => this.runDiscovery().catch(e => logger.error({ e }, 'Discovery run failed'));
    setTimeout(safeRun, 2 * 60 * 1000);
    this.timer = setInterval(safeRun, DISCOVERY_INTERVAL_MS);
  }

  startPerformanceReview(): void {
    const safeReview = () => this.reviewWalletPerformance().catch(e => logger.error({ e }, 'Perf review failed'));
    setTimeout(safeReview, 15 * 60 * 1000);
    this.perfTimer = setInterval(safeReview, PERF_REVIEW_INTERVAL);
    logger.info('Wallet performance review scheduled (every 6h)');
  }

  async reviewWalletPerformance(): Promise<void> {
    logger.info('Running wallet performance review...');
    dash.emit('log', { severity: 'info', message: 'Revision de performance iniciada' });
    try {
      const res = await this.db.query(`
        SELECT w.address, w.score, w.label,
          COUNT(ct.id)::int                            AS total_trades,
          COUNT(CASE WHEN ct.pnl > 0 THEN 1 END)::int AS winning_trades,
          COALESCE(SUM(ct.pnl), 0)::float              AS total_pnl
        FROM wallets w
        LEFT JOIN copied_trades ct ON ct.wallet_address = w.address AND ct.status = 'closed'
        WHERE w.status IN ('active', 'monitoring')
        GROUP BY w.address, w.score, w.label
        HAVING COUNT(ct.id) >= $1
      `, [MIN_TRADES_FOR_PERF]);

      const updates: Array<{ addr: string; old: number; newScore: number; info: string }> = [];
      const retired: string[] = [];

      for (const row of res.rows) {
        const winRate  = row.winning_trades / row.total_trades;
        const totalPnl = row.total_pnl as number;
        const winDelta = Math.round((winRate - 0.5) * 30);
        const pnlDelta = Math.max(-10, Math.min(10, Math.round(totalPnl / 5)));
        const newScore = Math.max(10, Math.min(100, row.score + winDelta + pnlDelta));
        if (Math.abs(newScore - row.score) < 3) continue;
        await this.db.query(`UPDATE wallets SET score = $1 WHERE address = $2`, [newScore, row.address]);
        const info = `wr:${(winRate * 100).toFixed(0)}%(${winDelta > 0 ? '+' : ''}${winDelta}) pnl:$${totalPnl.toFixed(1)}(${pnlDelta > 0 ? '+' : ''}${pnlDelta})`;
        updates.push({ addr: row.address, old: row.score, newScore, info });
        if (newScore <= RETIRE_SCORE_THRESHOLD) {
          await this.db.query(`UPDATE wallets SET status = 'retired' WHERE address = $1`, [row.address]);
          retired.push(row.address);
          dash.emit('log', { severity: 'warning', message: `Retirada: ${row.address.slice(0, 10)}... score ${newScore} (${info})` });
        }
      }

      if (updates.length > 0) {
        const lines = updates.map(u => {
          const arrow = u.newScore > u.old ? 'sube' : 'baja';
          const mark  = retired.includes(u.addr) ? ' RETIRADA' : '';
          return `${arrow} ${u.addr.slice(0, 12)}... ${u.old}->${u.newScore}${mark} (${u.info})`;
        }).join('\n');
        await this.telegram.send(
          `Revision de performance wallets\n\n${lines}\n\n${updates.length} actualizadas, ${retired.length} retiradas`,
        );
      }
      dash.emit('log', {
        severity: 'info',
        message: `Review: ${res.rows.length} evaluadas, ${updates.length} actualizadas, ${retired.length} retiradas`,
      });
    } catch (error) {
      logger.error({ error }, 'Performance review failed');
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer)     clearInterval(this.timer);
    if (this.perfTimer) clearInterval(this.perfTimer);
  }

  async runDiscovery(): Promise<void> {
    if (!this.isRunning) return;
    this.lastRun = new Date();
    this.nextRun = new Date(Date.now() + DISCOVERY_INTERVAL_MS);
    this.runsCompleted++;
    const runTime = new Date().toLocaleTimeString('es-MX');
    logger.info(`Running discovery #${this.runsCompleted}...`);
    dash.emit('log', { severity: 'info', message: `Discovery #${this.runsCompleted} iniciado` });

    try {
      const arbiscanCandidates   = await this.collectFromArbiscan();
      const smartMoneyCandidates = await this.discoverViaGainers();

      const allMap = new Map<string, WalletCandidate>();
      for (const c of arbiscanCandidates) allMap.set(c.address, c);
      for (const c of smartMoneyCandidates) {
        const existing = allMap.get(c.address);
        if (existing) {
          existing.routers = new Set([...existing.routers, ...c.routers]);
          existing.source  = 'smart-money';
          existing.swapCount += c.swapCount;
        } else {
          allMap.set(c.address, c);
        }
      }

      const allCandidates  = Array.from(allMap.values());
      const alreadyTracked = await this.getTrackedAddresses();
      const newCandidates  = allCandidates.filter(c => !alreadyTracked.has(c.address));
      const scored         = newCandidates
        .map(c => ({ ...c, score: this.scoreCandidate(c) }))
        .sort((a, b) => b.score - a.score);

      logger.info(`Discovery: ${allCandidates.length} total, ${newCandidates.length} new, ${smartMoneyCandidates.length} smart-money`);

      if (this.discoveryAgent) {
        await this.runAgentDecision(scored, runTime);
      } else {
        await this.runNumericDecision(scored, alreadyTracked.size, runTime);
      }
    } catch (error: any) {
      logger.error({ error }, 'Discovery failed');
      this.telegram.send(
        `Discovery #${this.runsCompleted} fallo\n\nError: ${error.message || 'desconocido'}\n\nReintentara en 2 horas`,
      ).catch(() => {});
    }
  }

  private async runAgentDecision(
    candidates: Array<WalletCandidate & { score: number }>,
    runTime: string,
  ): Promise<void> {
    const currentWallets = await this.getCurrentWalletsWithPerf();
    const candidatesForAgent: WalletForDecision[] = candidates.slice(0, 15).map(c => ({
      address: c.address, swapCount: c.swapCount, routers: Array.from(c.routers),
      score: c.score, source: c.source, lastTxAt: c.lastTxAt,
    }));

    let decision: { add: string[]; retire: string[]; reasoning: string };
    try {
      decision = await this.discoveryAgent!.decide(candidatesForAgent, currentWallets);
    } catch (err) {
      logger.error({ err }, 'DiscoveryAgent.decide() failed, falling back to numeric');
      await this.runNumericDecision(candidates, currentWallets.length, runTime);
      return;
    }

    const addedEntries: Array<{ address: string; score: number; replaced?: string }> = [];
    for (const addr of (decision.retire ?? [])) {
      const norm = addr.toLowerCase();
      await this.db.query(`UPDATE wallets SET status = 'retired' WHERE address = $1`, [norm]);
      dash.emit('log', { severity: 'warning', message: `Agente retiro: ${norm.slice(0, 10)}...` });
    }
    for (const addr of (decision.add ?? []).slice(0, MAX_WALLETS_TO_ADD)) {
      const norm      = addr.toLowerCase();
      const candidate = candidates.find(c => c.address === norm);
      const score     = candidate?.score ?? MIN_SCORE_TO_ADD;
      const label     = candidate?.source === 'smart-money'
        ? `SmartMoney: ${Array.from(candidate.routers).join(',')}`
        : `Auto: ${Array.from(candidate?.routers ?? []).join(',')}`;
      const entry = await this.addWallet(norm, score, label);
      if (entry) addedEntries.push(entry);
    }

    const addedList = addedEntries.map(e => {
      const c     = candidates.find(c => c.address === e.address);
      const emoji = e.score >= 85 ? 'A' : e.score >= 70 ? 'B' : 'C';
      const sm    = c?.source === 'smart-money' ? ' [SMART-MONEY]' : '';
      return `[${emoji}] ${e.address} ${sm} score:${e.score}/100 swaps:${c?.swapCount ?? '?'} dexes:${Array.from(c?.routers ?? []).join(',')}`;
    }).join('\n');

    const retiredNote = decision.retire?.length ? `\nRetiradas: ${decision.retire.length}` : '';
    await this.telegram.send(
      `Discovery #${this.runsCompleted} - ${runTime}\n\n` +
      `Candidatas: ${candidates.length} | Smart-money: ${candidates.filter(c => c.source === 'smart-money').length}\n` +
      `Agregadas: ${addedEntries.length}${retiredNote}\n\n` +
      (addedEntries.length > 0 ? `Wallets agregadas:\n${addedList}\n\n` : '') +
      `Razonamiento: ${decision.reasoning}\n\nProxima busqueda en 2 horas`,
    );
    dash.emit('log', {
      severity: 'info',
      message: `Discovery #${this.runsCompleted}: +${addedEntries.length} agregadas, ${decision.retire?.length ?? 0} retiradas (Claude)`,
    });
  }

  private async runNumericDecision(
    scored: Array<WalletCandidate & { score: number }>,
    _trackedCount: number,
    runTime: string,
  ): Promise<void> {
    const passing = scored.filter(c => c.score >= MIN_SCORE_TO_ADD).slice(0, MAX_WALLETS_TO_ADD);
    if (passing.length === 0) {
      await this.telegram.send(
        `Discovery #${this.runsCompleted} - ${runTime}\n\nCandidatas: ${scored.length}, ninguna alcanzo score minimo (${MIN_SCORE_TO_ADD})\n\nProxima busqueda en 2 horas`,
      );
      return;
    }
    const addedEntries: Array<{ address: string; score: number; replaced?: string }> = [];
    for (const c of passing) {
      const label = c.source === 'smart-money'
        ? `SmartMoney: ${Array.from(c.routers).join(',')}`
        : `Auto: ${Array.from(c.routers).join(',')}`;
      const entry = await this.addWallet(c.address, c.score, label);
      if (entry) addedEntries.push(entry);
    }
    const list = passing.map(c =>
      `${c.source === 'smart-money' ? '[SMART]' : ''} ${c.address} score:${c.score}/100`
    ).join('\n');
    await this.telegram.send(
      `Discovery #${this.runsCompleted} - ${runTime}\n\nCandidatas: ${scored.length} | Agregadas: ${addedEntries.length}\n\n${list}\n\nProxima en 2 horas`,
    );
  }

  private async collectFromArbiscan(): Promise<WalletCandidate[]> {
    const traderMap = new Map<string, WalletCandidate>();
    for (const router of DEX_ROUTERS) {
      try {
        const txs = await this.fetchRecentTransactions(router.address);
        for (const tx of txs) {
          const addr = tx.from.toLowerCase();
          if (addr === '0x0000000000000000000000000000000000000000') continue;
          const existing = traderMap.get(addr) ?? {
            address: addr, swapCount: 0, routers: new Set<string>(), lastTxAt: 0, source: 'arbiscan' as const,
          };
          existing.swapCount++;
          existing.routers.add(router.name);
          const ts = parseInt(tx.timeStamp ?? '0');
          if (ts > existing.lastTxAt) existing.lastTxAt = ts;
          traderMap.set(addr, existing);
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (error) {
        logger.warn({ router: router.name, error }, 'Failed to fetch from router');
      }
    }
    return Array.from(traderMap.values())
      .filter(c => c.swapCount >= MIN_SWAPS_TO_TRACK)
      .sort((a, b) => b.swapCount - a.swapCount);
  }

  private async discoverViaGainers(): Promise<WalletCandidate[]> {
    logger.info('Smart money scan: early buyers of top Arbitrum gainers...');
    const candidates = new Map<string, WalletCandidate>();
    try {
      const res = await axios.get('https://api.dexscreener.com/latest/dex/search', {
        params: { q: 'arbitrum' }, timeout: 12000,
      });
      const pairs: any[] = res.data?.pairs ?? [];
      const gainers = pairs
        .filter(p =>
          p.chainId === 'arbitrum' &&
          parseFloat(p.priceChange?.h24 ?? '0') > 40 &&
          parseFloat(p.liquidity?.usd ?? '0') > 75_000 &&
          parseFloat(p.liquidity?.usd ?? '0') < 30_000_000,
        )
        .sort((a, b) => parseFloat(b.priceChange?.h24 ?? '0') - parseFloat(a.priceChange?.h24 ?? '0'))
        .slice(0, 5);

      if (gainers.length === 0) { logger.info('No significant gainers found'); return []; }

      const desc = gainers.map(g =>
        `${g.baseToken?.symbol ?? '?'}+${parseFloat(g.priceChange?.h24 ?? '0').toFixed(0)}%`
      ).join(', ');
      logger.info(`Gainers: ${desc}`);
      dash.emit('log', { severity: 'info', message: `Smart money: ${gainers.length} gainers - ${desc}` });

      for (const pair of gainers) {
        const tokenAddr = pair.baseToken?.address?.toLowerCase();
        if (!tokenAddr) continue;
        const earlyBuyers = await this.fetchEarlyTokenBuyers(tokenAddr);
        for (const addr of earlyBuyers) {
          const existing = candidates.get(addr) ?? {
            address: addr, swapCount: 0, routers: new Set<string>(),
            lastTxAt: Math.floor(Date.now() / 1000) - 3600, source: 'smart-money' as const,
          };
          existing.swapCount++;
          existing.routers.add('SmartMoney');
          candidates.set(addr, existing);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (error) {
      logger.warn({ error }, 'Smart money scan failed');
    }
    return Array.from(candidates.values()).filter(c => c.swapCount >= 2);
  }

  private async fetchEarlyTokenBuyers(tokenAddress: string): Promise<string[]> {
    const now         = Math.floor(Date.now() / 1000);
    const windowStart = now - 96 * 3600;
    const windowEnd   = now - 12 * 3600;
    try {
      const response = await axios.get(ARBISCAN_BASE, {
        params: {
          chainid: 42161, module: 'account', action: 'tokentx',
          contractaddress: tokenAddress, page: 1, offset: 300, sort: 'asc',
          apikey: config.apis.arbiscan.apiKey || 'YourApiKeyToken',
        },
        timeout: 12000,
      });
      if (response.data.status !== '1') return [];
      const buyers = new Set<string>();
      for (const tx of (response.data.result ?? []) as any[]) {
        const ts = parseInt(tx.timeStamp);
        const to = tx.to?.toLowerCase();
        if (ts < windowStart || ts > windowEnd) continue;
        if (!to || KNOWN_CONTRACTS.has(to))      continue;
        buyers.add(to);
      }
      return Array.from(buyers).slice(0, 40);
    } catch {
      return [];
    }
  }

  private scoreCandidate(candidate: WalletCandidate): number {
    let score = 50;
    if (candidate.swapCount >= 50)       score += 20;
    else if (candidate.swapCount >= 20)  score += 12;
    else if (candidate.swapCount >= 10)  score += 6;
    if (candidate.routers.size >= 3)     score += 15;
    else if (candidate.routers.size === 2) score += 8;
    const ageHours = candidate.lastTxAt > 0
      ? (Date.now() / 1000 - candidate.lastTxAt) / 3600 : 999;
    if (ageHours < 6)       score += 10;
    else if (ageHours < 24) score += 5;
    else if (ageHours > 72) score -= 8;
    if (candidate.source === 'smart-money') score += 15;
    return Math.min(score, 100);
  }

  private async fetchRecentTransactions(routerAddress: string): Promise<any[]> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.get(ARBISCAN_BASE, {
          params: {
            chainid: 42161, module: 'account', action: 'txlist',
            address: routerAddress, startblock: 0, endblock: 99999999,
            page: 1, offset: 1000, sort: 'desc',
            apikey: config.apis.arbiscan.apiKey || 'YourApiKeyToken',
          },
          timeout: 15000,
        });
        if (response.data.status !== '1') {
          logger.warn({ router: routerAddress.slice(0, 8), msg: response.data.message }, 'Arbiscan non-success');
          return [];
        }
        return response.data.result || [];
      } catch (err: any) {
        if (attempt < 3) {
          logger.warn({ router: routerAddress.slice(0, 8), attempt }, 'Arbiscan timeout, retrying...');
          await new Promise(r => setTimeout(r, 3000 * attempt));
        } else {
          throw err;
        }
      }
    }
    return [];
  }

  private async getTrackedAddresses(): Promise<Set<string>> {
    const result = await this.db.query('SELECT address FROM wallets', []);
    return new Set(result.rows.map((r: any) => r.address.toLowerCase()));
  }

  private async getCurrentWalletsWithPerf(): Promise<TrackedWalletPerf[]> {
    const res = await this.db.query(`
      SELECT w.address, w.label, w.score,
        COUNT(ct.id)::int                                        AS total_trades,
        COALESCE(COUNT(CASE WHEN ct.pnl > 0 THEN 1 END)::float
          / NULLIF(COUNT(ct.id), 0), 0)                         AS win_rate,
        COALESCE(SUM(ct.pnl), 0)::float                         AS total_pnl,
        MAX(ct.created_at)                                       AS last_trade_at
      FROM wallets w
      LEFT JOIN copied_trades ct ON ct.wallet_address = w.address AND ct.status = 'closed'
      WHERE w.status IN ('active', 'monitoring')
      GROUP BY w.address, w.label, w.score ORDER BY w.score DESC
    `);
    return res.rows.map((r: any) => ({
      address: r.address, label: r.label, score: r.score,
      totalTrades: r.total_trades, winRate: r.win_rate,
      totalPnl: r.total_pnl, lastTradeAt: r.last_trade_at,
    }));
  }

  private async addWallet(address: string, score: number, label: string):
    Promise<{ address: string; score: number; replaced?: string } | null> {
    const addr = address.toLowerCase();
    const countRes = await this.db.query(
      `SELECT COUNT(*) as c FROM wallets WHERE status IN ('active','monitoring')`, [],
    );
    const currentCount = parseInt(countRes.rows[0].c);
    let replacedAddress: string | undefined;

    if (currentCount >= MAX_TRACKED_WALLETS) {
      const lowestRes = await this.db.query(
        `SELECT address, score FROM wallets WHERE status IN ('active','monitoring') ORDER BY score ASC LIMIT 1`, [],
      );
      const lowest = lowestRes.rows[0];
      if (!lowest || score <= lowest.score) {
        dash.emit('log', { severity: 'info', message: `Descartada ${addr.slice(0, 8)}... score ${score} no supera minimo ${lowest?.score ?? '?'}` });
        return null;
      }
      replacedAddress = lowest.address;
      await this.db.query(`UPDATE wallets SET status = 'retired' WHERE address = $1`, [lowest.address]);
      dash.emit('log', { severity: 'warning', message: `Retirada ${lowest.address.slice(0, 8)}... (score ${lowest.score}) por score ${score}` });
    }

    const result = await this.db.query(
      `INSERT INTO wallets (address, label, status, score) VALUES ($1, $2, 'active', $3)
       ON CONFLICT (address) DO NOTHING RETURNING address`,
      [addr, label, score],
    );
    if (result.rows.length > 0) {
      logger.info(`Added wallet ${addr.slice(0, 10)}... (score: ${score})`);
      dash.emit('log', { severity: 'info', message: `Nueva wallet: ${addr.slice(0, 8)}... score ${score}` });
      this.onWalletAdded?.().catch(e => logger.warn({ e }, 'reloadWallets callback failed'));
      return { address: addr, score, replaced: replacedAddress };
    }
    return null;
  }

  async observeSwap(walletAddress: string): Promise<void> {
    const key = walletAddress.toLowerCase();
    const lastSeen = this.recentlyObserved.get(key);
    if (lastSeen && Date.now() - lastSeen < OBSERVE_DEBOUNCE_MS) return;
    this.recentlyObserved.set(key, Date.now());
    try {
      await this.db.query(
        `INSERT INTO wallet_observations (address, swap_count, last_seen) VALUES ($1, 1, NOW())
         ON CONFLICT (address) DO UPDATE SET swap_count = wallet_observations.swap_count + 1, last_seen = NOW()`,
        [key],
      );
      const result = await this.db.query(
        `SELECT swap_count FROM wallet_observations WHERE address = $1`, [key],
      );
      const swapCount = result.rows[0]?.swap_count || 0;
      if (swapCount === 15) {
        const existing = await this.db.query('SELECT address FROM wallets WHERE address = $1', [key]);
        if (existing.rows.length === 0) {
          dash.emit('log', { severity: 'info', message: `Wallet organica: ${walletAddress.slice(0, 10)}... (${swapCount} swaps)` });
          await this.addWallet(walletAddress, 75, 'Organic');
          await this.telegram.send(
            `Wallet detectada organicamente\n\n${walletAddress}\n\nScore: 75/100\nSwaps: ${swapCount}\nFuente: Mempool en vivo`,
          );
        }
      }
    } catch { /* Non-critical */ }
  }
}
