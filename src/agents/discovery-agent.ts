import { callClaude, type Message, type Tool } from '../utils/claude-client';
import { DatabaseService } from '../services/database';
import { WalletDiscoveryService } from '../discovery/wallet-discovery';

const MAX_TRACKED_WALLETS = 20;

const DECIDE_TOOL: Tool = {
  name: 'discovery_decision',
  description: 'Submit the final wallet portfolio decisions for this discovery cycle',
  input_schema: {
    type: 'object',
    required: ['add', 'retire', 'reasoning'],
    properties: {
      add: {
        type: 'array',
        items: { type: 'string' },
        description: 'Wallet addresses from the candidate list to add to tracking (max 3 per cycle)',
      },
      retire: {
        type: 'array',
        items: { type: 'string' },
        description: 'Currently tracked wallet addresses to retire based on poor performance',
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of decisions in Spanish (2-4 sentences)',
      },
    },
  },
};

export interface WalletForDecision {
  address: string;
  swapCount: number;
  routers: string[];
  score: number;
  source: string;
  lastTxAt?: number;
}

export interface TrackedWalletPerf {
  address: string;
  label: string;
  score: number;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  lastTradeAt: string | null;
}

export class DiscoveryAgent {
  constructor(
    private db: DatabaseService,
    private discovery: WalletDiscoveryService
  ) {}

  async query(question: string): Promise<string> {
    const context = await this.buildContext();
    const messages: Message[] = [
      { role: 'user', content: `${question}\n\nCONTEXTO:\n${context}` },
    ];
    const response = await callClaude({
      system: `Eres el agente especialista en descubrimiento y gestión de wallets del copy trading bot.
Sabes exactamente qué wallets tenemos, de dónde vienen, cuándo se agregaron y por qué.
Sabes el schedule del discovery y cuándo corre la próxima búsqueda.
Responde en español, conciso, con emojis.`,
      messages,
      max_tokens: 512,
      source: 'discovery-agent',
    });
    const text = response.content.find(c => c.type === 'text');
    return text?.text || 'Sin información de discovery.';
  }

  async decide(
    candidates: WalletForDecision[],
    currentWallets: TrackedWalletPerf[],
  ): Promise<{ add: string[]; retire: string[]; reasoning: string }> {
    const trackedCount = currentWallets.length;

    const currentText = currentWallets.length > 0
      ? currentWallets.map(w => {
          const wr = w.totalTrades > 0 ? `wr:${(w.winRate * 100).toFixed(0)}%` : 'sin trades';
          const pnl = w.totalTrades > 0 ? ` pnl:$${w.totalPnl.toFixed(1)}` : '';
          const src = w.label?.startsWith('Auto:') ? '(arbiscan)' : w.label === 'Organic' ? '(orgánica)' : w.label?.startsWith('SmartMoney') ? '(smart-money)' : '(manual)';
          return `• ${w.address.slice(0,14)}… score:${w.score} ${wr}${pnl} ${src} trades:${w.totalTrades}`;
        }).join('\n')
      : '(ninguna aún)';

    const candidatesText = candidates.length > 0
      ? candidates.map(c => {
          const recency = c.lastTxAt ? `últimoSwap:${Math.round((Date.now() / 1000 - c.lastTxAt) / 3600)}h` : '';
          return `• ${c.address.slice(0,14)}… score:${c.score} swaps:${c.swapCount} DEXes:${c.routers.join('+')} ${recency} [${c.source}]`;
        }).join('\n')
      : '(ninguna candidata esta ronda)';

    const messages: Message[] = [{
      role: 'user',
      content:
        `Analiza las wallets y toma decisiones de portfolio.\n\n` +
        `TRACKEADAS ACTUALMENTE (${trackedCount}/${MAX_TRACKED_WALLETS}):\n${currentText}\n\n` +
        `CANDIDATAS DESCUBIERTAS:\n${candidatesText}\n\n` +
        `Usa la herramienta discovery_decision para dar tu respuesta.`,
    }];

    const response = await callClaude({
      system: `Eres el gestor de portafolio de wallets de un copy trading bot en Arbitrum.
Tu objetivo: trackear wallets de SMART MONEY que compran tokens mid-cap ANTES de que suban.

CRITERIOS DE CALIDAD (en orden de importancia):
1. Smart money wallets [source=smart-money]: compraron tokens ANTES de que pumpeen — máxima prioridad
2. Diversidad de DEXes: multi-DEX = estrategia sofisticada, no solo Uniswap
3. Recencia: swaps recientes (<24h) = wallet activa
4. Volumen de swaps: más swaps = más activa, pero no es el factor principal

SEÑALES DE ALERTA (evitar o retirar):
- Wallets con win rate < 35% Y ≥ 3 trades reales → considerar retirar
- Wallets con PnL total < -$15 Y ≥ 3 trades → retirar
- Wallets sin actividad (trades ni señales) que llevan >30 días trackeadas → evaluar si tienen signal

REGLAS:
- Máximo 3 candidatas por ciclo (no más)
- Si hay ${MAX_TRACKED_WALLETS} slots llenos, solo añade si hay candidata claramente superior a la peor actual
- No retires wallets sin historial real de trades aunque tengan score bajo — quizás simplemente no han hecho swaps en nuestros routers aún
- Wallets de smart-money source tienen score bonus implícito — favorécelas
- Responde con la herramienta discovery_decision`,
      messages,
      tools: [DECIDE_TOOL],
      max_tokens: 1024,
      source: 'discovery-agent-decide',
    });

    const toolUse = response.content.find(c => c.type === 'tool_use' && c.name === 'discovery_decision');
    if (toolUse?.input) {
      return toolUse.input as { add: string[]; retire: string[]; reasoning: string };
    }

    // Fallback: no decision
    const text = response.content.find(c => c.type === 'text');
    return { add: [], retire: [], reasoning: text?.text?.slice(0, 200) ?? 'Sin respuesta de herramienta' };
  }

  private async buildContext(): Promise<string> {
    const [wallets, observations, recentDiscoveries] = await Promise.all([
      this.db.query(`
        SELECT w.*, COUNT(ct.id) as copies_made
        FROM wallets w
        LEFT JOIN copied_trades ct ON ct.wallet_address = w.address
        GROUP BY w.address
        ORDER BY w.score DESC
      `),
      this.db.query(`
        SELECT address, swap_count, first_seen, last_seen
        FROM wallet_observations
        ORDER BY swap_count DESC
        LIMIT 10
      `),
      this.db.query(`
        SELECT message, created_at
        FROM system_events
        WHERE message LIKE '%wallet%' OR message LIKE '%Wallet%'
        ORDER BY created_at DESC
        LIMIT 10
      `),
    ]);

    const schedule = this.discovery.getScheduleInfo();

    const walletsText = wallets.rows.map((w: any) => `
  • ${w.label} | ${w.address.slice(0, 10)}...
    Score: ${w.score}/100 | Status: ${w.status}
    Origen: ${w.label?.startsWith('Auto:') ? 'Etherscan discovery' : w.label === 'Organic' ? 'Mempool orgánico' : w.label?.startsWith('SmartMoney') ? 'Smart money (gainer early buyer)' : 'Manual'}
    Agregada: ${new Date(w.created_at).toLocaleDateString('es-MX')}
    Copies hechos: ${w.copies_made}`).join('\n');

    const obsText = observations.rows.map((o: any) =>
      `  • ${o.address.slice(0, 10)}... — ${o.swap_count} swaps observados`
    ).join('\n');

    return `
SCHEDULE DE DISCOVERY:
• Uptime del bot: ${schedule.uptime}
• Última búsqueda: ${schedule.ultima_busqueda}
• Próxima búsqueda: ${schedule.proxima_busqueda} (en ${schedule.tiempo_para_proxima})
• Búsquedas completadas: ${schedule.busquedas_completadas}
• Intervalo: ${schedule.intervalo}

WALLETS TRACKEADAS (${wallets.rows.length}):
${walletsText}

TOP WALLETS OBSERVADAS (no trackeadas aún):
${obsText || '  (ninguna observada aún)'}

EVENTOS RECIENTES DE DISCOVERY:
${recentDiscoveries.rows.map((e: any) => `  • ${new Date(e.created_at).toLocaleString('es-MX')}: ${e.message}`).join('\n') || '  (ninguno)'}
    `.trim();
  }
}
