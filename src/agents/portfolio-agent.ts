import { callClaude, type Message } from '../utils/claude-client';
import { DatabaseService } from '../services/database';

export class PortfolioAgent {
  constructor(private db: DatabaseService) {}

  async query(question: string): Promise<string> {
    const context = await this.buildContext();

    const messages: Message[] = [
      { role: 'user', content: `${question}\n\nCONTEXTO ACTUAL:\n${context}` },
    ];

    const response = await callClaude({
      system: `Eres el agente especialista en portafolio y trades del copy trading bot.
Tienes toda la información sobre posiciones abiertas, cerradas, P&L realizado e irealizado.
Responde en español, conciso, con emojis apropiados.
Solo responde sobre lo que te preguntan del portafolio.`,
      messages,
      max_tokens: 512,
      source: 'portfolio-agent',
    });

    const text = response.content.find(c => c.type === 'text');
    return text?.text || 'Sin información de portafolio.';
  }

  async buildContext(): Promise<string> {
    const [openTrades, closedTrades, summary, dailyPnL] = await Promise.all([
      this.db.query(`
        SELECT ct.token_out, ct.position_size_usd, ct.pnl, ct.pnl_pct,
               ct.created_at, ct.executed_at, w.label as wallet_label
        FROM copied_trades ct
        JOIN wallets w ON w.address = ct.wallet_address
        WHERE ct.status = 'filled'
        ORDER BY ct.created_at DESC
      `),
      this.db.query(`
        SELECT ct.token_out, ct.position_size_usd, ct.pnl, ct.pnl_pct,
               ct.created_at, ct.executed_at, w.label as wallet_label
        FROM copied_trades ct
        JOIN wallets w ON w.address = ct.wallet_address
        WHERE ct.status = 'closed'
        ORDER BY ct.executed_at DESC
        LIMIT 10
      `),
      this.db.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) as abiertos,
          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as cerrados,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as fallidos,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as ganadores,
          SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as perdedores,
          COALESCE(SUM(pnl), 0) as pnl_total,
          COALESCE(AVG(CASE WHEN pnl IS NOT NULL THEN pnl END), 0) as pnl_promedio
        FROM copied_trades
      `),
      this.db.getDailyPnL(),
    ]);

    const stats = summary.rows[0];

    const openText = openTrades.rows.length > 0
      ? openTrades.rows.map((t: any) => `
  • Token: ${t.token_out.slice(0, 10)}...
    Wallet: ${t.wallet_label} | Entrada: $${parseFloat(t.position_size_usd || 0).toFixed(2)}
    P&L actual: $${parseFloat(t.pnl || 0).toFixed(2)}
    Abierta: ${new Date(t.created_at).toLocaleString('es-MX')}`).join('\n')
      : '  (ninguna)';

    const closedText = closedTrades.rows.length > 0
      ? closedTrades.rows.map((t: any) => `
  • Token: ${t.token_out.slice(0, 10)}...
    P&L: $${parseFloat(t.pnl || 0).toFixed(2)}
    Cerrada: ${t.executed_at ? new Date(t.executed_at).toLocaleString('es-MX') : 'N/A'}`).join('\n')
      : '  (ninguna)';

    return `
POSICIONES ABIERTAS (${openTrades.rows.length}):
${openText}

ÚLTIMAS POSICIONES CERRADAS:
${closedText}

RESUMEN GENERAL:
• Total ejecutados: ${stats.abiertos} abiertos | ${stats.cerrados} cerrados | ${stats.fallidos} fallidos
• Ganadores: ${stats.ganadores} | Perdedores: ${stats.perdedores}
• P&L total acumulado: $${parseFloat(stats.pnl_total).toFixed(2)}
• P&L promedio por trade: $${parseFloat(stats.pnl_promedio).toFixed(2)}
• P&L hoy: $${dailyPnL.toFixed(2)}
    `.trim();
  }
}
