import { logger } from '../utils/logger';
import { config } from '../config';
import { callClaude, type Message, type ContentBlock, type Tool } from '../utils/claude-client';
import { dash } from '../dashboard/events';
import { DatabaseService } from './database';
import { RedisService } from './redis';
import { WalletDiscoveryService } from '../discovery/wallet-discovery';
import { PortfolioAgent } from '../agents/portfolio-agent';
import { DiscoveryAgent } from '../agents/discovery-agent';
import { createPublicClient, http, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';
import { getEthPriceUsd } from '../utils/dexscreener';

const MEMORY_KEY = 'conversation:history';
const MAX_HISTORY = 20;

const AGENT_TOOLS: Tool[] = [
  {
    name: 'get_wallet_balance',
    description: 'Balance actual de la wallet del bot en Arbitrum: ETH disponible en USD y ETH.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_status',
    description: 'Estado completo del bot: wallets, P&L, posiciones, circuit breaker y logs recientes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_wallets',
    description: 'Lista todas las wallets trackeadas: score, origen, cuándo se agregó, trades copiados.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_wallet_detail',
    description: 'Detalle completo de una wallet: por qué fue agregada, historial, trades copiados y performance.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Dirección 0x de la wallet' },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_recent_logs',
    description: 'Logs recientes del sistema: qué ha pasado, errores, trades detectados, decisiones tomadas.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Cuántos logs (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'add_wallet',
    description: 'Agrega una wallet para trackear.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Dirección 0x' },
        label: { type: 'string', description: 'Nombre' },
        reason: { type: 'string', description: 'Por qué la agregamos' },
      },
      required: ['address'],
    },
  },
  {
    name: 'remove_wallet',
    description: 'Elimina una wallet del tracking.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Dirección 0x' },
      },
      required: ['address'],
    },
  },
  {
    name: 'get_trades',
    description: 'Trades recientes ejecutados por el bot.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Cuántos (default 5)' },
      },
      required: [],
    },
  },
  {
    name: 'get_pnl',
    description: 'Reporte de ganancias y pérdidas.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Días a reportar (default 1)' },
      },
      required: [],
    },
  },
  {
    name: 'pause_trading',
    description: 'Pausa el trading activando el circuit breaker.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Minutos (default 60)' },
        reason: { type: 'string', description: 'Razón' },
      },
      required: [],
    },
  },
  {
    name: 'resume_trading',
    description: 'Reanuda el trading.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'trigger_discovery',
    description: 'Dispara el descubrimiento de wallets ahora mismo (incluye smart money via DexScreener).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'trigger_performance_review',
    description: 'Ejecuta la revisión de performance de wallets ahora mismo: actualiza scores y retira las que tienen mal historial.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_llm_stats',
    description: 'Muestra el uso de LLM de las últimas 24h: tokens por fuente, llamadas totales.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Horas hacia atrás (default 24)' },
      },
      required: [],
    },
  },
  {
    name: 'ask_portfolio_agent',
    description: 'Consulta al agente especialista en portafolio. Úsalo para preguntas sobre copies, posiciones abiertas/cerradas, si vendimos, P&L realizado/irealizado, historial de trades.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'La pregunta sobre el portafolio' },
      },
      required: ['question'],
    },
  },
  {
    name: 'ask_discovery_agent',
    description: 'Consulta al agente especialista en discovery de wallets. Úsalo para preguntas sobre wallets trackeadas, cuándo corre el próximo discovery, de dónde vienen las wallets, schedule.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'La pregunta sobre wallets o discovery' },
      },
      required: ['question'],
    },
  },
];

export class ConversationService {
  private discovery: WalletDiscoveryService | null = null;
  private portfolioAgent: PortfolioAgent;
  private discoveryAgent: DiscoveryAgent | null = null;

  constructor(
    private db: DatabaseService,
    private redis: RedisService
  ) {
    this.portfolioAgent = new PortfolioAgent(db);
  }

  setDiscovery(discovery: WalletDiscoveryService): void {
    this.discovery = discovery;
    this.discoveryAgent = new DiscoveryAgent(this.db, discovery);
  }

  async chat(userMessage: string): Promise<string> {
    try {
      return await this.chatInternal(userMessage);
    } catch (error: any) {
      // Corrupt history: tool_result without matching tool_use → clear and retry once
      if (error.message?.includes('tool_use_id') || error.message?.includes('tool_result')) {
        logger.warn('Corrupt conversation history — clearing and retrying');
        await this.clearHistory();
        try {
          return await this.chatInternal(userMessage);
        } catch (retryErr: any) {
          logger.error({ retryErr }, 'Conversation error after history reset');
          return '❌ Error al procesar. Intenta de nuevo.';
        }
      }
      logger.error({ error }, 'Conversation error');
      return '❌ Error al procesar. Intenta de nuevo.';
    }
  }

  private readonly SYSTEM_PROMPT = `Eres el agente orquestador del sistema de copy trading en Arbitrum.
Coordinas un equipo de agentes especializados y tienes memoria de la conversación.

NOVEDADES DEL SISTEMA:
- Discovery ahora tiene 2 fuentes: (1) Arbiscan router activity — 10 DEXes monitoreados, (2) Smart money — DexScreener busca tokens con +40% en 24h → Arbiscan encuentra quién los compró ANTES del pump. Wallets smart money tienen label "SmartMoney:..."
- Performance review corre cada 6h: ajusta scores según win rate y PnL real de nuestras copies. Retira wallets con score ≤ 38 con ≥ 3 trades
- Filtro WBTC activo: las señales USDC→WBTC son ignoradas (DCA defensivo, no alpha)
- Bot puede pausarse/reanudarse desde el dashboard (botón STOP/START en el header)
- Todos los routers: Uniswap V3, SwapRouter02, SushiSwap, 1inch, Camelot, Paraswap, Odos, Balancer, TraderJoe, Ramses
- Multicall de SwapRouter02 ahora decodificado correctamente (muchos más trades capturados)

ARQUITECTURA TÉCNICA — LEE ESTO ANTES DE DIAGNOSTICAR:
- El bot monitorea Arbitrum via WebSocket (watchBlocks de viem). Ya está activo. NO necesita webhooks, NO necesita Tenderly, NO necesita Alchemy webhooks. NO necesita "activar polling". El WebSocket ya ES el modo polling.
- Cada bloque de Arbitrum (~250ms) el bot escanea TODAS las transacciones buscando swaps de wallets trackeadas. Esto corre desde que arranca.
- Si no ves eventos en get_recent_logs: significa que ninguna wallet trackeada hizo un swap en ese período, o que el tamaño fue menor al mínimo. NO significa que el sistema no esté monitoreando.
- Si 0 trades ejecutados: puede ser (1) wallets no han operado, (2) balance del bot muy bajo para el tamaño mínimo ($0.50 USD), (3) circuit breaker activo, (4) el bot se reinició frecuentemente y perdió trades durante el downtime.
- Si el bot se reinicia frecuentemente: usa get_recent_logs para ver el error exacto. Los reinicios son causados por excepciones no capturadas → Docker lo resucita automáticamente.
- Position sizing es DINÁMICO: se calcula en cada trade según score de wallet × seguridad del token. No hay un % fijo.

PROHIBIDO DECIR (son incorrectos para este sistema):
- "Sin webhook configurado" — el bot NO usa webhooks, usa WebSocket
- "Sin modo polling activo" — el WebSocket ya ES el polling, siempre activo
- "Activa el modo polling" — no existe tal modo, ya está activo
- "Configura un webhook" — no aplica a esta arquitectura

AGENTES DISPONIBLES:
- ask_portfolio_agent: Todo sobre copies, posiciones abiertas/cerradas, si vendimos, P&L realizado/irealizado
- ask_discovery_agent: Wallets trackeadas, schedule de discovery, cuándo corre el próximo, de dónde vienen las wallets

CUÁNDO DELEGAR:
- Preguntas sobre trades, copies, posiciones, ventas, P&L → ask_portfolio_agent
- Preguntas sobre wallets, discovery, schedules, próxima búsqueda, smart money → ask_discovery_agent
- Acción manual de revisión de scores → trigger_performance_review
- Uso de LLM → get_llm_stats
- Estado general, circuit breaker, logs → get_status + get_recent_logs
- Acciones (pausar, agregar wallet, etc.) → tools directas

Personalidad:
- Responde en español, conciso y directo con emojis
- Cuando delegues a un sub-agente, integra su respuesta naturalmente
- Siempre confirma acciones ejecutadas
- Si preguntan "cómo vas" o "qué pasó" usa get_status + ask_portfolio_agent + ask_discovery_agent`;

  private async chatInternal(userMessage: string): Promise<string> {
    const history = await this.loadHistory();
    history.push({ role: 'user', content: userMessage });

    const messages: Message[] = [...history];
    let finalResponse = '';

    for (let i = 0; i < 5; i++) {
      const response = await callClaude({
        system: this.SYSTEM_PROMPT,
        messages,
        tools: AGENT_TOOLS,
        max_tokens: 1024,
        source: `conversation (turn ${i + 1})`,
      });

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(c => c.type === 'text');
        finalResponse = textBlock?.text || '';
        messages.push({ role: 'assistant', content: response.content });
        break;
      }

      if (response.stop_reason === 'tool_use') {
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: ContentBlock[] = [];
        for (const toolUse of toolUses) {
          if (toolUse.type !== 'tool_use') continue;
          dash.emit('log', { severity: 'claude', message: `🔧 [conversation] tool: ${toolUse.name}` });
          const result = await this.executeTool(toolUse.name!, toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }
    }

    await this.saveHistory(this.sanitizeHistory(messages as Message[]));
    return finalResponse || 'No pude generar respuesta.';
  }

  private async executeTool(name: string, args: any): Promise<any> {
    logger.info({ tool: name }, 'Conversation tool');

    switch (name) {
      case 'get_wallet_balance': return await this.getWalletBalance();
      case 'get_status':        return await this.getStatus();
      case 'get_wallets':       return await this.getWallets();
      case 'get_wallet_detail': return await this.getWalletDetail(args.address);
      case 'get_recent_logs':   return await this.getRecentLogs(args.limit || 20);
      case 'add_wallet':        return await this.addWallet(args.address, args.label, args.reason);
      case 'remove_wallet':     return await this.removeWallet(args.address);
      case 'get_trades':        return await this.getTrades(args.limit || 5);
      case 'get_pnl':           return await this.getPnl(args.days || 1);
      case 'pause_trading':     return await this.pauseTrading(args.minutes || 60, args.reason);
      case 'resume_trading':    return await this.resumeTrading();
      case 'trigger_discovery':          return await this.triggerDiscovery();
      case 'trigger_performance_review': return await this.triggerPerformanceReview();
      case 'get_llm_stats':              return await this.getLLMStats(args.hours || 24);
      case 'ask_portfolio_agent':        return { response: await this.portfolioAgent.query(args.question) };
      case 'ask_discovery_agent':   return { response: await this.discoveryAgent?.query(args.question) || 'Discovery agent no disponible.' };
      default: return { error: `Tool desconocida: ${name}` };
    }
  }

  // ── TOOLS ───────────────────────────────────────────────────────────────

  private async getWalletBalance(): Promise<any> {
    try {
      const client = createPublicClient({
        chain: arbitrum,
        transport: http(`https://arb-mainnet.g.alchemy.com/v2/${config.blockchain.alchemy.apiKey}`),
      });

      const [balanceWei, ethPrice] = await Promise.all([
        client.getBalance({ address: config.wallet.address as `0x${string}` }),
        getEthPriceUsd(),
      ]);

      const ethBalance = parseFloat(formatUnits(balanceWei, 18));
      const usdBalance = ethBalance * ethPrice;
      const positionSizeEth = ethBalance * config.trading.positionSizePct;
      const positionSizeUsd = positionSizeEth * ethPrice;

      return {
        address: config.wallet.address,
        eth: ethBalance.toFixed(6),
        usd: usdBalance.toFixed(2),
        eth_price: ethPrice.toFixed(2),
        por_trade_eth: positionSizeEth.toFixed(6),
        por_trade_usd: positionSizeUsd.toFixed(2),
        position_size_pct: `${config.trading.positionSizePct * 100}%`,
      };
    } catch (error: any) {
      return { error: `No se pudo obtener balance: ${error.message}` };
    }
  }

  private async getStatus(): Promise<any> {
    const [openPositions, dailyPnL, hourlyPnL, walletStats, circuitBreaker, botPaused] = await Promise.all([
      this.db.getOpenPositions(),
      this.db.getDailyPnL(),
      this.db.getHourlyPnL(),
      this.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('active','monitoring'))  AS active,
          COUNT(*) FILTER (WHERE label LIKE 'SmartMoney%')          AS smart_money,
          COUNT(*) FILTER (WHERE label = 'Organic')                  AS organic
        FROM wallets
      `),
      this.redis.isCircuitBreakerTriggered(),
      this.redis.isBotPaused(),
    ]);

    const ws       = walletStats.rows[0];
    const schedule = this.discovery ? this.discovery.getScheduleInfo() : null;

    return {
      modo: config.trading.autonomyMode,
      red: 'Arbitrum One',
      bot_estado: botPaused ? '⏸ PAUSADO (STOP manual)' : '▶ ACTIVO',
      wallets_activas: parseInt(ws.active),
      wallets_smart_money: parseInt(ws.smart_money),
      wallets_organicas: parseInt(ws.organic),
      posiciones_abiertas: `${openPositions}/${config.trading.maxPositions}`,
      pnl_hoy: `$${dailyPnL.toFixed(2)} USD`,
      pnl_ultima_hora: `$${hourlyPnL.toFixed(2)} USD`,
      circuit_breaker: circuitBreaker ? 'ACTIVO — trading pausado' : 'OK',
      filtro_wbtc: 'ACTIVO — señales USDC→WBTC ignoradas',
      position_size: `Dinámico: base ${config.trading.positionSizePct * 100}% × score wallet × seguridad token`,
      limite_perdida_diaria: `${config.trading.dailyLossLimit * 100}%`,
      schedule: schedule || 'Discovery no disponible',
    };
  }

  private async getWallets(): Promise<any> {
    const result = await this.db.query(
      `SELECT w.address, w.label, w.score, w.status, w.created_at,
              COUNT(ct.id) as trades_copiados,
              COALESCE(SUM(ct.pnl), 0) as pnl_total
       FROM wallets w
       LEFT JOIN copied_trades ct ON ct.wallet_address = w.address
       GROUP BY w.address, w.label, w.score, w.status, w.created_at
       ORDER BY w.score DESC`
    );

    return {
      total: result.rows.length,
      wallets: result.rows.map((w: any) => ({
        address: w.address,
        label: w.label,
        score: w.score,
        status: w.status,
        origen: w.label?.startsWith('SmartMoney:') ? `🎯 Smart money — compró gainer antes del pump (${w.label.replace('SmartMoney: ', '')})` :
                w.label?.startsWith('Auto:') ? `Arbiscan discovery (${w.label.replace('Auto: ', '')})` :
                w.label === 'Organic' ? 'Detectada del mempool orgánicamente' :
                w.label === 'Manual' ? 'Agregada manualmente' : w.label,
        agregada: new Date(w.created_at).toLocaleDateString('es-MX'),
        trades_copiados: parseInt(w.trades_copiados) || 0,
        pnl_total: `$${parseFloat(w.pnl_total).toFixed(2)}`,
      })),
    };
  }

  private async getWalletDetail(address: string): Promise<any> {
    const wallet = await this.db.query(`SELECT * FROM wallets WHERE address = $1`, [address.toLowerCase()]);
    if (wallet.rows.length === 0) return { error: 'Wallet no encontrada.' };

    const [trades, observations] = await Promise.all([
      this.db.query(
        `SELECT token_in, token_out, position_size_usd, pnl, status, created_at
         FROM copied_trades WHERE wallet_address = $1 ORDER BY created_at DESC LIMIT 10`,
        [address.toLowerCase()]
      ),
      this.db.query(
        `SELECT swap_count, first_seen, last_seen FROM wallet_observations WHERE address = $1`,
        [address.toLowerCase()]
      ),
    ]);

    const w = wallet.rows[0];
    const obs = observations.rows[0];

    return {
      address: w.address,
      label: w.label,
      score: w.score,
      status: w.status,
      origen: w.label?.startsWith('Auto:') ? `Etherscan discovery — operó en ${w.label.replace('Auto: ', '')}` :
              w.label === 'Organic' ? 'Detectada orgánicamente desde el mempool' :
              w.label === 'Manual' ? 'Agregada manualmente' : w.label,
      agregada_el: new Date(w.created_at).toLocaleString('es-MX'),
      swaps_observados_antes_de_agregar: obs?.swap_count || 'N/A',
      primera_vez_vista: obs ? new Date(obs.first_seen).toLocaleString('es-MX') : 'N/A',
      trades_copiados: trades.rows.length,
      ultimos_trades: trades.rows.map((t: any) => ({
        fecha: new Date(t.created_at).toLocaleString('es-MX'),
        monto: `$${t.position_size_usd}`,
        pnl: `$${parseFloat(t.pnl || 0).toFixed(2)}`,
        status: t.status,
      })),
    };
  }

  private async getRecentLogs(limit: number): Promise<any> {
    const result = await this.db.query(
      `SELECT event_type, severity, message, metadata, created_at
       FROM system_events ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    return {
      logs: result.rows.map((r: any) => ({
        tiempo: new Date(r.created_at).toLocaleString('es-MX'),
        tipo: r.event_type,
        severidad: r.severity,
        mensaje: r.message,
        detalle: r.metadata,
      })),
    };
  }

  private async addWallet(address: string, label?: string, reason?: string): Promise<any> {
    if (!address.startsWith('0x') || address.length !== 42) {
      return { error: 'Dirección inválida.' };
    }
    const finalLabel = label || 'Manual';
    await this.db.query(
      `INSERT INTO wallets (address, label, status, score)
       VALUES ($1, $2, 'active', 75)
       ON CONFLICT (address) DO UPDATE SET status = 'active', label = $2`,
      [address.toLowerCase(), finalLabel]
    );
    if (reason) {
      await this.db.logEvent('system', 'info', `Wallet agregada: ${address} — ${reason}`);
    }
    return { success: true, address, label: finalLabel, reason };
  }

  private async removeWallet(address: string): Promise<any> {
    const result = await this.db.query(
      `UPDATE wallets SET status = 'stopped' WHERE address = $1 RETURNING label`,
      [address.toLowerCase()]
    );
    if (result.rows.length === 0) return { error: 'Wallet no encontrada.' };
    await this.db.logEvent('system', 'info', `Wallet removida: ${address}`);
    return { success: true, address, label: result.rows[0].label };
  }

  private async getTrades(limit: number): Promise<any> {
    const result = await this.db.query(
      `SELECT ct.token_out, ct.position_size_usd, ct.pnl, ct.status, ct.created_at, w.label
       FROM copied_trades ct
       JOIN wallets w ON w.address = ct.wallet_address
       ORDER BY ct.created_at DESC LIMIT $1`,
      [limit]
    );
    return { trades: result.rows, total: result.rows.length };
  }

  private async getPnl(days: number): Promise<any> {
    const safeDays = Math.max(1, Math.min(Math.floor(Number(days) || 1), 365));
    const result = await this.db.query(
      `SELECT COUNT(*) as total_trades,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
              COALESCE(SUM(pnl), 0) as total_pnl,
              COALESCE(AVG(pnl), 0) as avg_pnl
       FROM copied_trades
       WHERE created_at >= NOW() - make_interval(days => $1) AND status = 'filled'`,
      [safeDays]
    );
    return { days: safeDays, ...result.rows[0] };
  }

  private async pauseTrading(minutes: number, reason?: string): Promise<any> {
    await this.redis.triggerCircuitBreaker(reason || 'manual_pause', minutes * 60);
    await this.db.logEvent('system', 'warning', `Trading pausado manualmente por ${minutes} min`, { reason });
    return { success: true, pausado_por: `${minutes} minutos` };
  }

  private async resumeTrading(): Promise<any> {
    await this.redis.clearCircuitBreaker();
    await this.db.logEvent('system', 'info', 'Trading reanudado manualmente');
    return { success: true };
  }

  private async triggerDiscovery(): Promise<any> {
    if (!this.discovery) return { error: 'Discovery no disponible.' };
    this.discovery.runDiscovery().catch((e: any) => logger.error(e));
    return { success: true, mensaje: 'Discovery iniciado (Arbiscan + smart money DexScreener) — resultados en ~2 min por Telegram.' };
  }

  private async triggerPerformanceReview(): Promise<any> {
    if (!this.discovery) return { error: 'Discovery no disponible.' };
    this.discovery.reviewWalletPerformance().catch((e: any) => logger.error(e));
    return { success: true, mensaje: 'Revisión de performance iniciada — scores actualizados y wallets malas retiradas. Verás el reporte en Telegram.' };
  }

  private async getLLMStats(hours: number): Promise<any> {
    const safeHours = Math.max(1, Math.min(Math.floor(Number(hours) || 24), 720));
    try {
      const [bySource, totals] = await Promise.all([
        this.db.query(`
          SELECT
            metadata->>'source'                       AS fuente,
            SUM((metadata->>'input_tokens')::int)     AS tokens_entrada,
            SUM((metadata->>'output_tokens')::int)    AS tokens_salida,
            COUNT(*)::int                             AS llamadas
          FROM system_events
          WHERE event_type = 'llm_usage'
            AND created_at >= NOW() - make_interval(hours => $1)
          GROUP BY metadata->>'source'
          ORDER BY 2 + 3 DESC
        `, [safeHours]),
        this.db.query(`
          SELECT
            SUM((metadata->>'input_tokens')::int)  AS total_entrada,
            SUM((metadata->>'output_tokens')::int) AS total_salida,
            COUNT(*)::int                          AS total_llamadas
          FROM system_events
          WHERE event_type = 'llm_usage'
            AND created_at >= NOW() - make_interval(hours => $1)
        `, [safeHours]),
      ]);
      return {
        periodo: `Últimas ${safeHours}h`,
        total_tokens: (totals.rows[0]?.total_entrada ?? 0) + (totals.rows[0]?.total_salida ?? 0),
        total_llamadas: totals.rows[0]?.total_llamadas ?? 0,
        por_fuente: bySource.rows,
      };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  // ── MEMORY ──────────────────────────────────────────────────────────────

  // Removes orphaned tool_result messages at the start of a sliced history
  private sanitizeHistory(messages: Message[]): Message[] {
    const sliced = messages.slice(-MAX_HISTORY);
    // Find first message that is NOT an orphaned tool_result-only user message
    for (let i = 0; i < sliced.length; i++) {
      const msg = sliced[i];
      const isOrphanedToolResult =
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        (msg.content as any[]).every((c: any) => c.type === 'tool_result');
      if (!isOrphanedToolResult) return sliced.slice(i);
    }
    return [];
  }

  private async loadHistory(): Promise<Message[]> {
    try {
      const raw = await this.redis.get(MEMORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  private async saveHistory(history: Message[]): Promise<void> {
    try {
      await this.redis.set(MEMORY_KEY, JSON.stringify(history), 24 * 60 * 60);
    } catch { logger.warn('No se pudo guardar historial'); }
  }

  private async clearHistory(): Promise<void> {
    try {
      await this.redis.del(MEMORY_KEY);
      logger.info('Conversation history cleared');
    } catch { logger.warn('No se pudo limpiar historial'); }
  }
}
