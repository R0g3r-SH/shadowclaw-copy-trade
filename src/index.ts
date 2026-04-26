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
import { TradeExecutor } from './execution/trade-executor';

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
    const tradeExecutor = new TradeExecutor(db);
    const positionMonitor = new PositionMonitor(db, telegram, tradeExecutor);
    positionMonitor.start();
    logger.info('✅ Position monitor started (SL: -10% / TP: +30%)');

    // Start wallet discovery
    const discovery = new WalletDiscoveryService(db, telegram);
    discovery.setOnWalletAdded(() => wsMonitor.reloadWallets());
    wsMonitor.setDiscovery(discovery);
    conversation.setDiscovery(discovery);

    // Wire up DiscoveryAgent as active decision maker
    const discoveryAgent = new DiscoveryAgent(db, discovery);
    discovery.setDiscoveryAgent(discoveryAgent);

    await discovery.start();
    discovery.startPerformanceReview();
    logger.info('✅ Wallet discovery started (+ performance review every 6h)');

    // Start web dashboard
    const dashboard = new DashboardServer(db, redis);
    dashboard.setDiscoveryInfo(discovery);
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

    await telegram.send(
      `🤖 *Copy Trading Agent iniciado*\n\nModo: ${config.trading.autonomyMode.toUpperCase()}\nRed: Arbitrum\nWallet: \`${config.wallet.address}\`\n\nMonitoreando trades... 🚀`,
      { parse_mode: 'Markdown' }
    );

    const gracefulShutdown = async (signal: string) => {
      logger.info(`⚠️  Received ${signal}, shutting down gracefully...`);

      positionMonitor.stop();
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
  logger.error({ reason }, 'Unhandled Rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught Exception');
  process.exit(1);
});

// Start the application
main();
