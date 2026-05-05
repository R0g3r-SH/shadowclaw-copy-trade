import { callClaude, type Message } from '../utils/claude-client';
import { DatabaseService } from '../services/database';
import { getTokenMarketData, getEthPriceUsd } from '../utils/dexscreener';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { config } from '../config';

const TRAILING_ACTIVATION = 0.12;
const TRAILING_DROP       = 0.07;
const STOP_LOSS_PCT       = -0.10;
const TAKE_PROFIT_PCT     =  0.80;

const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);
const decimalsCache = new Map<string, number>();

const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(config.blockchain.alchemy.httpRpcUrl),
});

async function getTokenDecimals(tokenAddress: string): Promise<number> {
  const key = tokenAddress.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key)!;
  try {
    const d = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' });
    decimalsCache.set(key, d);
    return d;
  } catch { return 18; }
}

export class PortfolioAgent {
  constructor(private db: DatabaseService) {}

  async query(question: string): Promise<string> {
    const context = await this.buildContext();
    const messages: Message[] = [
      { role: 'user', content: `${question}\n\nCONTEXTO ACTUAL:\n${context}` },
    ];
    const response = await callClaude({
      system: `Eres el agente especialista en portafolio del copy trading bot en Arbitrum.
Tienes acceso a posiciones abiertas con P&L irealizado en tiempo real, posiciones cerradas, y resumen total.
Responde en español, conciso, con emojis. Solo responde sobre lo que te preguntan del portafolio.`,
      messages,
      max_tokens: 512,
      source: 'portfolio-agent',
    });
    const text = response.content.find(c => c.type === 'text');
    return text?.text || 'Sin información de portafolio.';
  }

  // Public so ConversationService can call it directly for the live positions tool
  async getLivePositions(): Promise<any[]> {
    const openTrades = await this.db.query(
      `SELECT ct.id, ct.token_out, ct.amount_out, ct.position_size_usd,
              ct.created_at, ct.peak_pnl_pct, w.label as wallet_label
       FROM copied_trades ct
       JOIN wallets w ON w.address = ct.wallet_address
       WHERE ct.status = 'filled'
       ORDER BY ct.created_at DESC`,
      []
    );

    const [ethPrice, marketDataArr, decimalsArr] = await Promise.all([
      getEthPriceUsd().catch(() => 2000),
      Promise.all(openTrades.rows.map(t => getTokenMarketData(t.token_out).catch(() => null))),
      Promise.all(openTrades.rows.map(t => getTokenDecimals(t.token_out))),
    ]);

    const positions = [];

    for (let idx = 0; idx < openTrades.rows.length; idx++) {
      const t        = openTrades.rows[idx];
      const entryUsd = parseFloat(t.position_size_usd || '0');
      const rawOut   = t.amount_out;
      const mkt      = marketDataArr[idx];
      const decimals = decimalsArr[idx];
      let currentUsd = 0;
      let priceChangeH1: number | null = null;

      if (rawOut && rawOut !== '0' && mkt && mkt.priceUsd > 0) {
        const tokenAmount = parseFloat(formatUnits(BigInt(String(rawOut).split('.')[0]), decimals));
        currentUsd        = tokenAmount * mkt.priceUsd;
        priceChangeH1     = mkt.priceChangeH1;
      }

      const pnlUsd    = currentUsd > 0 ? currentUsd - entryUsd : 0;
      const pnlPct    = entryUsd  > 0 ? pnlUsd / entryUsd      : 0;
      const peakPct   = Math.max(parseFloat(t.peak_pnl_pct || '0'), pnlPct);

      // Trailing stop status
      const trailingActive  = peakPct >= TRAILING_ACTIVATION;
      const trailingFloor   = trailingActive ? peakPct - TRAILING_DROP : null;
      const distToTrailing  = trailingFloor != null ? pnlPct - trailingFloor : null;

      positions.push({
        id:             t.id,
        token:          t.token_out,
        wallet:         t.wallet_label,
        entry_usd:      entryUsd.toFixed(2),
        current_usd:    currentUsd > 0 ? currentUsd.toFixed(2) : 'price unavailable',
        pnl_usd:        currentUsd > 0 ? (pnlUsd >= 0 ? '+' : '') + pnlUsd.toFixed(2) : 'N/A',
        pnl_pct:        currentUsd > 0 ? (pnlPct >= 0 ? '+' : '') + (pnlPct * 100).toFixed(1) + '%' : 'N/A',
        price_change_h1: priceChangeH1 != null ? (priceChangeH1 >= 0 ? '+' : '') + priceChangeH1.toFixed(2) + '%' : 'N/A',
        trailing_stop:  trailingActive
          ? `activo — pico ${(peakPct * 100).toFixed(1)}%, floor ${(trailingFloor! * 100).toFixed(1)}%, distancia ${distToTrailing! >= 0 ? '+' : ''}${(distToTrailing! * 100).toFixed(1)}%`
          : `inactivo (activa en +${(TRAILING_ACTIVATION * 100).toFixed(0)}%)`,
        sl_at:          (STOP_LOSS_PCT * 100).toFixed(0) + '%',
        tp_at:          '+' + (TAKE_PROFIT_PCT * 100).toFixed(0) + '%',
        open_since:     new Date(t.created_at).toLocaleString('es-MX'),
        eth_price:      ethPrice,
      });
    }

    return positions;
  }

  async buildContext(): Promise<string> {
    const [livePositions, closedTrades, summary] = await Promise.all([
      this.getLivePositions(),
      this.db.query(`
        SELECT ct.token_out, ct.position_size_usd, ct.pnl, ct.executed_at, w.label as wallet_label
        FROM copied_trades ct
        JOIN wallets w ON w.address = ct.wallet_address
        WHERE ct.status = 'closed'
        ORDER BY ct.executed_at DESC LIMIT 10
      `),
      this.db.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'filled'  THEN 1 ELSE 0 END) as abiertos,
          SUM(CASE WHEN status = 'closed'  THEN 1 ELSE 0 END) as cerrados,
          SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) as fallidos,
          SUM(CASE WHEN pnl > 0            THEN 1 ELSE 0 END) as ganadores,
          SUM(CASE WHEN pnl < 0            THEN 1 ELSE 0 END) as perdedores,
          COALESCE(SUM(pnl), 0)                               as pnl_total,
          COALESCE(AVG(CASE WHEN pnl IS NOT NULL THEN pnl END), 0) as pnl_promedio
        FROM copied_trades
      `),
    ]);

    const stats = summary.rows[0];

    const openText = livePositions.length > 0
      ? livePositions.map(p =>
          `  • ${p.token.slice(0, 10)}... | wallet: ${p.wallet}\n` +
          `    Entrada: $${p.entry_usd} → Actual: $${p.current_usd} (${p.pnl_pct}, ${p.pnl_usd} USD)\n` +
          `    Cambio 1h: ${p.price_change_h1} | Trailing: ${p.trailing_stop}\n` +
          `    SL: ${p.sl_at} | TP: ${p.tp_at} | Abierta: ${p.open_since}`
        ).join('\n')
      : '  (ninguna)';

    const closedText = closedTrades.rows.length > 0
      ? closedTrades.rows.map((t: any) =>
          `  • ${t.token_out.slice(0, 10)}... P&L: $${parseFloat(t.pnl || 0).toFixed(2)} | ` +
          `Cerrada: ${t.executed_at ? new Date(t.executed_at).toLocaleString('es-MX') : 'N/A'}`
        ).join('\n')
      : '  (ninguna)';

    return `
POSICIONES ABIERTAS CON P&L EN TIEMPO REAL (${livePositions.length}):
${openText}

ÚLTIMAS POSICIONES CERRADAS:
${closedText}

RESUMEN GENERAL:
• Abiertos: ${stats.abiertos} | Cerrados: ${stats.cerrados} | Fallidos: ${stats.fallidos}
• Ganadores: ${stats.ganadores} | Perdedores: ${stats.perdedores}
• P&L total acumulado: $${parseFloat(stats.pnl_total).toFixed(2)}
• P&L promedio por trade: $${parseFloat(stats.pnl_promedio).toFixed(2)}
    `.trim();
  }
}
