// Shared TypeScript interfaces and types

export interface Wallet {
  address: string;
  label: string;
  status: 'candidate' | 'active' | 'monitoring' | 'paused' | 'stopped';
  score: number;
  winRate?: number;
  profitFactor?: number;
  totalTrades: number;
  totalPnL: number;
  createdAt: Date;
  updatedAt: Date;
  lastTradeAt?: Date;
}

export interface TrackedTransaction {
  txHash: string;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut?: string;
  dex: string;
  blockNumber?: number;
  timestamp: Date;
  status: 'detected' | 'analyzed' | 'copied' | 'skipped' | 'failed';
}

export interface CopiedTrade {
  id: number;
  originalTxHash: string;
  ourTxHash?: string;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut?: string;
  positionSizeUsd: number;
  executionPrice?: number;
  gasUsed?: number;
  gasPrice?: number;
  gasCostUsd?: number;
  slippagePct?: number;
  pnl: number;
  pnlPct: number;
  status: 'pending' | 'executing' | 'filled' | 'partial' | 'failed' | 'closed';
  createdAt: Date;
  executedAt?: Date;
  closedAt?: Date;
}

export interface SystemEvent {
  id: number;
  eventType: string;
  severity: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  message: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface ApprovalRequest {
  id: number;
  requestType: string;
  tradeSignalId?: number;
  walletAddress?: string;
  tokenAddress?: string;
  amountUsd?: number;
  riskScore?: number;
  messageId?: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'timeout';
  createdAt: Date;
  respondedAt?: Date;
  expiresAt: Date;
}

export interface PortfolioState {
  totalValueUsd: number;
  openPositions: number;
  dailyPnL: number;
  weeklyPnL: number;
  monthlyPnL: number;
  totalPnL: number;
}

export type AutonomyMode = 'claude-code' | 'hybrid' | 'openclaw';

export type ChainId = 1 | 42161 | 10 | 8453; // Ethereum, Arbitrum, Optimism, Base
