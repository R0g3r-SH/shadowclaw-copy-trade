import Anthropic from '@anthropic-ai/sdk';

export const tools: Anthropic.Tool[] = [
  {
    name: 'check_token_safety',
    description: 'Check token security via GoPlus: honeypot, mintable, blacklist, taxes, liquidity. Skip if safety data is already in the trade brief.',
    input_schema: {
      type: 'object',
      properties: {
        token_address: { type: 'string', description: 'Token contract address (0x...)' },
      },
      required: ['token_address'],
    },
  },
  {
    name: 'get_wallet_history',
    description: 'Get the tracked wallet trading history: past trades, win rate, what tokens it has traded.',
    input_schema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string', description: 'Wallet address (0x...)' },
        limit: { type: 'number', description: 'Number of recent trades (default 20)' },
      },
      required: ['wallet_address'],
    },
  },
  {
    name: 'get_dex_metrics',
    description: 'Get real-time DEX market data: price, liquidity, 24h volume, 1h/24h price change %, FDV, and pair age in minutes. Call only if market snapshot in the brief is missing.',
    input_schema: {
      type: 'object',
      properties: {
        token_address: { type: 'string', description: 'Token contract address (0x...)' },
      },
      required: ['token_address'],
    },
  },
  {
    name: 'get_portfolio_status',
    description: 'Get current bot portfolio: open positions, daily P&L, USDC balance (trading capital), ETH balance (gas only), max safe position size.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'execute_trade',
    description: 'Execute the copy trade immediately. Use when you are confident this is a good trade. token_in is always USDC; slippage is derived from risk_score automatically.',
    input_schema: {
      type: 'object',
      properties: {
        token_out:  { type: 'string', description: 'Output token address (0x...) — the token to buy' },
        amount_usd: { type: 'number', description: 'Amount in USD to trade. Must not exceed max_safe_position_usd from portfolio status.' },
        reasoning:  { type: 'string', description: 'Why you are executing this trade' },
      },
      required: ['token_out', 'amount_usd', 'reasoning'],
    },
  },
  {
    name: 'request_approval',
    description: 'Send a trade proposal to the human for approval via Telegram. Use when you think the trade is interesting but want human confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning:          { type: 'string', description: 'Full analysis: why this trade is worth considering, risks, upside' },
        suggested_amount_usd: { type: 'number', description: 'Amount you recommend trading if approved' },
        confidence:         { type: 'number', description: 'Your confidence level 0-100' },
      },
      required: ['reasoning', 'suggested_amount_usd', 'confidence'],
    },
  },
  {
    name: 'skip_trade',
    description: 'Explicitly skip this trade. Use when the trade does not meet your criteria.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Clear reason why you are skipping this trade' },
      },
      required: ['reason'],
    },
  },
];
