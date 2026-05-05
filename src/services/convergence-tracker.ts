import { RedisService } from './redis';

const WINDOW_MS   = 5 * 60 * 1000; // 5-minute convergence window
const WINDOW_SECS = 300;

export interface ConvergenceSignal {
  walletAddress: string;
  walletScore: number;
  timestamp: number; // unix ms
}

export interface ConvergenceResult {
  count: number;
  wallets: ConvergenceSignal[];
  avgWalletScore: number;
  isConverging: boolean; // 2+ wallets
  isStrong: boolean;     // 3+ wallets → bypass agent, auto-execute
}

export class ConvergenceTracker {
  constructor(private redis: RedisService) {}

  /**
   * Record that a tracked wallet bought `tokenAddress`.
   * Returns the current convergence state for that token across all wallets
   * that have bought it within the last 5 minutes.
   */
  async addSignal(
    tokenAddress: string,
    walletAddress: string,
    walletScore: number,
  ): Promise<ConvergenceResult> {
    const key = `conv:${tokenAddress.toLowerCase()}`;
    const now = Date.now();

    const existing = await this.redis.getJSON<ConvergenceSignal[]>(key) ?? [];

    // Drop stale signals and deduplicate — same wallet can only count once
    const fresh = existing.filter(
      s => now - s.timestamp < WINDOW_MS &&
           s.walletAddress.toLowerCase() !== walletAddress.toLowerCase()
    );

    const updated: ConvergenceSignal[] = [
      ...fresh,
      { walletAddress, walletScore, timestamp: now },
    ];

    await this.redis.setJSON(key, updated, WINDOW_SECS);
    return this.buildResult(updated);
  }

  private buildResult(signals: ConvergenceSignal[]): ConvergenceResult {
    const avgWalletScore = signals.length > 0
      ? Math.round(signals.reduce((s, x) => s + x.walletScore, 0) / signals.length)
      : 0;
    return {
      count:          signals.length,
      wallets:        signals,
      avgWalletScore,
      isConverging:   signals.length >= 2,
      isStrong:       signals.length >= 3,
    };
  }
}
