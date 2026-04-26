import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export const config = {
  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgresql://trader:changeme123@localhost:5432/copy_trading',
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Blockchain
  blockchain: {
    alchemy: {
      apiKey: process.env.ALCHEMY_API_KEY || '',
      rpcUrl: process.env.ARBITRUM_RPC || `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
    },
    chainId: 42161, // Arbitrum
    chainName: 'arbitrum',
  },

  // Wallet
  wallet: {
    privateKey: process.env.PRIVATE_KEY || '',
    address: process.env.BOT_ADDRESS || '',
  },

  // External APIs
  apis: {
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    },
    azure: {
      resource: process.env.ANTHROPIC_FOUNDRY_RESOURCE || '',
      apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY || '',
      model: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
      foundryEndpoint: process.env.AZURE_FOUNDRY_ENDPOINT || 'https://bnt-openai.services.ai.azure.com/api/projects/opencode',
      apiVersion: '2024-12-01-preview',
    },
    nansen: {
      apiKey: process.env.NANSEN_API_KEY || '',
      baseUrl: 'https://api.nansen.ai/api/beta',
      rateLimit: 20, // requests per second
    },
    oneInch: {
      apiKey: process.env.ONEINCH_API_KEY || '',
      baseUrl: 'https://api.1inch.io/v6.0',
      chainId: 42161, // Arbitrum
    },
    goPlus: {
      baseUrl: 'https://api.gopluslabs.io/api/v1',
      chainId: '42161', // String for GoPlus
    },
    arbiscan: {
      apiKey: process.env.ARBISCAN_API_KEY || '',
      baseUrl: 'https://api.arbiscan.io/api',
    },
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    approvalTimeout: 5 * 60 * 1000, // 5 minutes
  },

  // Trading Configuration
  trading: {
    autonomyMode: (process.env.AUTONOMY_MODE || 'hybrid') as 'claude-code' | 'hybrid' | 'openclaw',
    positionSizePct: parseFloat(process.env.POSITION_SIZE_PCT || '0.02'), // 2%
    maxPositions: parseInt(process.env.MAX_POSITIONS || '5'),
    maxSinglePosition: 0.20, // 20%
    maxTotalExposure: 0.70, // 70%
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '0.10'), // 10%
    hourlyLossLimit: 0.05, // 5%
  },

  // Risk Management
  risk: {
    maxRiskScore: 50, // Block if higher
    minLiquidityUsd: 50000, // $50k minimum
    maxSlippage: {
      stable: 0.01,      // 1% for stablecoins
      established: 0.02, // 2% for established tokens
      volatile: 0.10,    // 10% for volatile
      meme: 0.20,        // 20% for meme coins
    },
  },

  // Hybrid Decision Rules
  hybrid: {
    autoExecuteIf: {
      riskScore: 30,     // Below 30 is safe
      walletScore: 80,   // Above 80 is trusted
      positionSize: 0.02, // Below 2% is small
    },
    requireApprovalIf: {
      riskScore: 30,     // Above 30 needs review
      newWallet: true,   // New wallets need approval
      largePosition: 0.05, // Above 5% needs approval
    },
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },
} as const;

// Validation
export function validateConfig(): void {
  const required = [
    { key: 'ANTHROPIC_FOUNDRY_API_KEY', value: config.apis.azure.apiKey },
    { key: 'ALCHEMY_API_KEY', value: config.blockchain.alchemy.apiKey },
    { key: 'PRIVATE_KEY', value: config.wallet.privateKey },
    { key: 'TELEGRAM_BOT_TOKEN', value: config.telegram.botToken },
    { key: 'TELEGRAM_CHAT_ID', value: config.telegram.chatId },
  ];

  const missing = required.filter(r => !r.value);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map(m => `  - ${m.key}`).join('\n')}`
    );
  }
}

// DEX Router Addresses on Arbitrum
export const ROUTERS = {
  uniswapV3:    '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  sushiswap:    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  oneInch:      '0x1111111254EEB25477B68fb85Ed929f73A960582',
  camelot:      '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
  paraswap:     '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57', // Augustus V5
  odos:         '0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13', // Odos Router V2
  balancer:     '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer Vault
  traderJoe:    '0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB04', // LBRouter
  ramses:       '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
} as const;

// Function Selectors for DEX swaps (used for decode; new routers use observe-only fallback)
export const SWAP_SELECTORS = {
  exactInputSingle:        '0x414bf389', // Uniswap V3
  exactInput:              '0xc04b8d59', // Uniswap V3 multi-hop
  swapExactTokensForTokens:'0x38ed1739', // Uniswap V2
  swapExactETHForTokens:   '0x7ff36ab5', // Uniswap V2
  swapTokensForExactETH:   '0x4a25d94a', // Uniswap V2
  // Paraswap
  paraswapSimpleSwap:      '0x54e3f31b',
  paraswapMultiSwap:       '0xa94e78ef',
  paraswapMegaSwap:        '0x46c67b6d',
  // Odos
  odosSwap:                '0x83bd37f9',
  // Uniswap V3 multicall (SwapRouter02 — most common method)
  multicall:               '0xac9650d8',
  multicallWithDeadline:   '0x5ae401dc',
  // 1inch v5
  oneInchSwap:             '0x12aa3caf',
  oneInchUnoswap:          '0x0502b1c5',
  oneInchUniV3:            '0xe449022e',
} as const;
