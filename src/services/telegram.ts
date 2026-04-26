import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger';
import type { ConversationService } from './conversation';

export class TelegramBotService {
  private bot: TelegramBot;
  private chatId: string;
  private conversation: ConversationService | null = null;
  private pendingApprovals: Map<number, {
    resolve: (approved: boolean) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  constructor(token: string, chatId: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.chatId = chatId;
    this.setupHandlers();
  }

  setConversation(conversation: ConversationService): void {
    this.conversation = conversation;
  }

  private setupHandlers(): void {
    // Handle text messages
    this.bot.on('message', async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) {
        logger.warn(`Received message from unauthorized chat: ${msg.chat.id}`);
        return;
      }

      const text = msg.text?.toLowerCase().trim();
      if (!text) return;

      logger.info(`Received Telegram message: ${text}`);

      // Emergency stop — intercept before AI, reject all pending approvals and shutdown
      if (text === '/stop' || text === '/parar' || text === '/detener' || text === '/emergency') {
        await this.handleEmergencyStop();
        return;
      }

      // Handle approval responses first
      if (text === 'si' || text === 'yes' || text === 'y' || text === 'sí') {
        this.handleApprovalResponse(msg.reply_to_message?.message_id, true);
        return;
      }

      if (text === 'no' || text === 'n') {
        this.handleApprovalResponse(msg.reply_to_message?.message_id, false);
        return;
      }

      // Everything else → conversational AI
      if (this.conversation) {
        try {
          await this.bot.sendChatAction(this.chatId, 'typing');
          const reply = await this.conversation.chat(msg.text || text);
          await this.send(reply);
        } catch (error) {
          logger.error({ error }, 'Conversation handler error');
        }
      }
    });

    // Handle callback queries (inline keyboard)
    this.bot.on('callback_query', async (query) => {
      const data = query.data;
      const messageId = query.message?.message_id;

      if (!data || !messageId) return;

      logger.info(`Received callback: ${data}`);

      if (data.startsWith('approve:')) {
        this.handleApprovalResponse(messageId, true);
        await this.bot.answerCallbackQuery(query.id, { text: '✅ Approved' });
        await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: this.chatId,
          message_id: messageId,
        });
      } else if (data.startsWith('reject:')) {
        this.handleApprovalResponse(messageId, false);
        await this.bot.answerCallbackQuery(query.id, { text: '❌ Rejected' });
        await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: this.chatId,
          message_id: messageId,
        });
      }
    });

    this.bot.on('polling_error', (error) => {
      logger.error({ error }, 'Telegram polling error');
    });
  }

  private async handleEmergencyStop(): Promise<void> {
    logger.error('🛑 EMERGENCY STOP triggered from Telegram');

    // Cancel all pending trade approvals immediately
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingApprovals.clear();

    await this.send(
      '🛑 *EMERGENCY STOP activado*\n\nTodos los trades pendientes: ❌ cancelados\nCircuit breaker: ✅ activado\nApagando sistema...',
      { parse_mode: 'Markdown' }
    );

    // Delay slightly so the message sends before shutdown
    setTimeout(() => {
      logger.error('Emitting SIGTERM for graceful shutdown');
      process.emit('SIGTERM');
    }, 800);
  }

  private handleApprovalResponse(messageId: number | undefined, approved: boolean): void {
    if (!messageId) return;

    const pending = this.pendingApprovals.get(messageId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(approved);
      this.pendingApprovals.delete(messageId);
      logger.info(`Approval ${approved ? 'granted' : 'denied'} for message ${messageId}`);
    }
  }

  async start(): Promise<void> {
    const me = await this.bot.getMe();
    logger.info(`Telegram bot started: @${me.username}`);
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling();
    logger.info('Telegram bot stopped');
  }

  async send(message: string, options?: { parse_mode?: 'Markdown' | 'HTML' }): Promise<number> {
    const msg = await this.bot.sendMessage(this.chatId, message, options);
    return msg.message_id;
  }

  async sendAlert(level: 'info' | 'warning' | 'critical', message: string): Promise<number> {
    const emoji = {
      info: 'ℹ️',
      warning: '⚠️',
      critical: '🚨',
    };

    return await this.send(`${emoji[level]} ${message}`);
  }

  async requestApproval(
    message: string,
    timeoutMs: number = 300000 // 5 minutes
  ): Promise<boolean> {
    // Send message with inline keyboard
    const msg = await this.bot.sendMessage(this.chatId, message, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${Date.now()}` },
          { text: '❌ Reject', callback_data: `reject:${Date.now()}` },
        ]],
      },
    });

    const messageId = msg.message_id;

    // Create promise that resolves when user responds
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(messageId);
        logger.warn(`Approval request timed out for message ${messageId}`);
        resolve(false); // Timeout = reject
      }, timeoutMs);

      this.pendingApprovals.set(messageId, { resolve, timeout });
    });
  }

  async sendTradeNotification(trade: {
    wallet: string;
    token: string;
    amountUsd: number;
    action: 'detected' | 'executed' | 'skipped' | 'failed';
    reason?: string;
  }): Promise<void> {
    const emoji = {
      detected: '👀',
      executed: '✅',
      skipped: '⏭️',
      failed: '❌',
    };

    let message = `${emoji[trade.action]} Trade ${trade.action.toUpperCase()}\n\n`;
    message += `Wallet: \`${trade.wallet.slice(0, 6)}...${trade.wallet.slice(-4)}\`\n`;
    message += `Token: \`${trade.token.slice(0, 6)}...${trade.token.slice(-4)}\`\n`;
    message += `Amount: $${trade.amountUsd.toFixed(2)}\n`;

    if (trade.reason) {
      message += `\nReason: ${trade.reason}`;
    }

    await this.send(message, { parse_mode: 'Markdown' });
  }

  async sendDailySummary(summary: {
    trades: number;
    wins: number;
    losses: number;
    pnl: number;
    winRate: number;
  }): Promise<void> {
    const pnlEmoji = summary.pnl >= 0 ? '📈' : '📉';

    const message = `
${pnlEmoji} *Daily Summary*

Trades: ${summary.trades}
Wins: ${summary.wins} | Losses: ${summary.losses}
Win Rate: ${(summary.winRate * 100).toFixed(1)}%
P&L: $${summary.pnl.toFixed(2)}
    `.trim();

    await this.send(message, { parse_mode: 'Markdown' });
  }
}

export { TelegramBotService as TelegramBot };
