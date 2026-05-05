import { config, validateConfig } from './config';
import { logger } from './utils/logger';
import { initClaudeMonitoring } from './utils/claude-client';
import { DashboardServer } from './dashboard/server';
import { DatabaseService } from './services/database';
import { RedisService } from './services/redis';
import { TelegramBot } from './services/telegram';
import { WebSocketMonitor } from './monitors/websocket';
import { TradeOrchestrator } from './orchestrator';
import { WalletDiscoveryService } from './discovery/wallet-discovery';
import { DiscoveryAgent } from './agents/discovery-agent';
import { ConversationService } from './services/conversation';
import { PositionMonitor } from './monitors/position-monitor';
import { PortfolioAgent } from './agents/portfolio-agent';
import { MarketSentinelAgent } from './agents/market-sentinel-agent';
import { BriefingAgent } from './agents/briefing-agent';

async function main() {
  try {
    logger.info('🚀 Starting Copy Trading Agent...');
    logger.info(`Mode: ${config.trading.autonomyMode.toUpperCase()}`);
    logger.info(`Chain: ${config.blockchain.chainName} (${config.blockchain.chainId})`);

    // Validate configuration
    validateConfig();
    logger.info('✅ Configuration validated');

    // Initialize services
    logger.info('📡 Initializing services...');

    const db = new DatabaseService(config.database.url);
    await db.connect();
    logger.info('✅ Database connected');

    // Wire DB into callClaude() for persistent LLM usage tracking
    initClaudeMonitoring(db);

    const redis = new RedisService(config.redis.url);
    await redis.connect();
    logger.info('✅ Redis connected');

    const telegram = new TelegramBot(
      config.telegram.botToken,
      config.telegram.chatId
    );
    await telegram.start();
    logger.info('✅ Telegram bot started');

    // Connect conversational AI to Telegram
    const conversation = new ConversationService(db, redis);
    telegram.setConversation(conversation);
    logger.info('✅ Conversation AI connected');

    // Initialize trade orchestrator
    const orchestrator = new TradeOrchestrator(db, redis, telegram);
    logger.info('✅ Trade orchestrator initialized');

    // Start WebSocket monitor
    const wsMonitor = new WebSocketMonitor(orchestrator, db);
    await wsMonitor.start();
    logger.info('✅ WebSocket monitor started');

    // Start position monitor (stop-loss + take-profit)
    // Reuse orchestrator's executor — shared instance avoids nonce conflicts on concurrent sends
    const positionMonitor = new PositionMonitor(db, telegram, orchestrator.tradeExecutor);
    positionMonitor.start();
    logger.info('✅ Position monitor started (SL: -10% / TP: +80%)');

    // Start wallet discovery
    const discovery = new WalletDiscoveryService(db, telegram);
    discovery.setOnWalletAdded(() => wsMonitor.reloadWallets());
    wsMonitor.setDiscovery(discovery);
    conversation.setDiscovery(discovery);
    conversation.setOnWalletChanged(() => wsMonitor.reloadWallets());

    // Wire up DiscoveryAgent as active decision maker
    const discoveryAgent = new DiscoveryAgent(db, discovery);
    discovery.setDiscoveryAgent(discoveryAgent);

    await discovery.start();
    discovery.startPerformanceReview();
    logger.info('✅ Wallet discovery started (+ performance review every 6h)');

    // Start proactive agents
    const marketSentinel = new MarketSentinelAgent(redis, telegram, db);
    marketSentinel.start();
    logger.info('✅ MarketSentinelAgent started (Arbitrum market conditions every 15 min)');

    const briefingAgent = new BriefingAgent(db, telegram, redis);
    briefingAgent.start();
    logger.info('✅ BriefingAgent started (briefings 9am/9pm + inactivity alerts)');

    // Start web dashboard
    const portfolioAgent = new PortfolioAgent(db);
    const dashboard = new DashboardServer(db, redis);
    dashboard.setDiscoveryInfo(discovery);
    dashboard.setPortfolioAgent(portfolioAgent);
    dashboard.setBotControls({
      pause:  () => { wsMonitor.pause(); positionMonitor.pause(); },
      resume: () => { wsMonitor.resume(); positionMonitor.resume(); },
    });
    dashboard.start(3001);
    logger.info('✅ Dashboard started on port 3001');

    // Log system ready
    await db.logEvent('system', 'info', 'Copy trading agent started successfully', {
      mode: config.trading.autonomyMode,
      chainId: config.blockchain.chainId,
    });

    logger.info('✨ System is ready and monitoring trades!');

    // Notify about approvals that were pending when system went down
    try {
      const missed = await db.query(`
        SELECT id, wallet_address, token_address, amount_usd, created_at
        FROM approval_requests
        WHERE status = 'pending' AND expires_at > NOW() - INTERVAL '30 minutes'
      `);
      if (missed.rows.length > 0) {
        for (const r of missed.rows) {
          await db.query(`UPDATE approval_requests SET status = 'expired' WHERE id = $1`, [r.id]);
          await telegram.send(
            `⚠️ *Aprobación perdida por reinicio*\n\n` +
            `El sistema se reinició mientras esperaba tu respuesta.\n\n` +
            `Wallet: \`${r.wallet_address.slice(0,10)}...\`\n` +
            `Token: \`${r.token_address.slice(0,10)}...\`\n` +
            `Monto: $${parseFloat(r.amount_usd).toFixed(2)}\n\n` +
            `La señal ya expiró. Si el token sigue siendo válido, el bot evaluará la próxima vez que esa wallet opere.`,
            { parse_mode: 'Markdown' }
          );
        }
      }
    } catch (e) { logger.warn({ e }, 'Could not check missed approvals'); }


    await telegram.send(
      `🤖 *Copy Trading Agent iniciado*\n\nModo: ${config.trading.autonomyMode.toUpperCase()}\nRed: Arbitrum\nWallet: \`${config.wallet.address}\`\n\nMonitoreando trades... 🚀`,
      { parse_mode: 'Markdown' }
    );

    const gracefulShutdown = async (signal: string) => {
      logger.info(`⚠️  Received ${signal}, shutting down gracefully...`);

      positionMonitor.stop();
      marketSentinel.stop();
      briefingAgent.stop();
      await wsMonitor.stop();

      try { await telegram.send('⚠️ Agent apagado.'); } catch (_) {}
      await telegram.stop();
      await redis.disconnect();
      await db.disconnect();

      logger.info('👋 Shutdown complete');
      process.exit(0);
    };

    // Prevent duplicate shutdown if SIGTERM is emitted programmatically
    let shuttingDown = false;
    const onSignal = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      gracefulShutdown(signal).catch(err => {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      });
    };

    process.on('SIGINT',  () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

  } catch (error) {
    logger.error({ error }, '❌ Failed to start agent');
    console.error('Full error:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (reason) => {
  // Filter empty WebSocket close events from viem transport internals
  if (!reason || (typeof reason === 'object' && Object.keys(reason).length === 0)) return;
  logger.error({ reason }, 'Unhandled Rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught Exception');
  process.exit(1);
});

// Start the application
main();
