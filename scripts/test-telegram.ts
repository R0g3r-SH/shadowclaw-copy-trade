#!/usr/bin/env tsx

/**
 * Test Telegram bot connectivity
 *
 * Usage:
 *   npm run test-telegram
 */

import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

async function testTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }

  try {
    console.log('🔄 Testing Telegram bot...');

    const bot = new TelegramBot(token, { polling: false });

    // Test 1: Get bot info
    const me = await bot.getMe();
    console.log(`✅ Bot connected: @${me.username}`);

    // Test 2: Send test message
    await bot.sendMessage(chatId, '🧪 Test message from Copy Trading Agent\n\nIf you see this, Telegram is working! ✅');
    console.log('✅ Test message sent successfully');

    // Test 3: Send message with buttons
    await bot.sendMessage(chatId, '🧪 Testing approval buttons...', {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: 'approve:test' },
          { text: '❌ Reject', callback_data: 'reject:test' },
        ]],
      },
    });
    console.log('✅ Approval buttons sent');

    console.log('\n✨ All tests passed!');
    console.log('\nCheck your Telegram to confirm you received the messages.');

    process.exit(0);

  } catch (error: any) {
    console.error('❌ Telegram test failed:', error.message);
    process.exit(1);
  }
}

testTelegram();
