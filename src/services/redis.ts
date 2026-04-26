import Redis from 'ioredis';
import { logger } from '../utils/logger';

export class RedisService {
  private client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    this.client.on('error', (err) => {
      logger.error({ err }, 'Redis error');
    });

    this.client.on('connect', () => {
      logger.info('Redis connected');
    });
  }

  async connect(): Promise<void> {
    await this.client.ping();
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    logger.info('Redis disconnected');
  }

  // Basic operations
  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  // JSON operations
  async getJSON<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    return value ? JSON.parse(value) : null;
  }

  async setJSON(key: string, value: any, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  // Hash operations
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return await this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return await this.client.hgetall(key);
  }

  // Circuit breaker
  async isCircuitBreakerTriggered(): Promise<boolean> {
    return await this.exists('circuit_breaker:triggered');
  }

  async triggerCircuitBreaker(reason: string, durationSeconds: number = 3600): Promise<void> {
    await this.set('circuit_breaker:triggered', reason, durationSeconds);
    logger.error({ reason }, 'Circuit breaker triggered');
  }

  async resetCircuitBreaker(): Promise<void> {
    await this.del('circuit_breaker:triggered');
    logger.info('Circuit breaker reset');
  }

  async clearCircuitBreaker(): Promise<void> {
    await this.del('circuit_breaker:triggered');
    logger.info('Circuit breaker cleared manually');
  }

  // Bot pause control
  async isBotPaused(): Promise<boolean> {
    return await this.exists('bot:paused');
  }

  async setBotPaused(paused: boolean): Promise<void> {
    if (paused) {
      await this.set('bot:paused', '1');
    } else {
      await this.del('bot:paused');
    }
  }

  // Rate limiting
  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const current = await this.client.incr(key);
    if (current === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return current <= limit;
  }

  // txHash deduplication — prevents processing the same swap twice on WS reconnect
  async markTxProcessed(txHash: string): Promise<boolean> {
    // SET NX (only set if not exists) with 2h TTL — returns 1 if set, 0 if already existed
    const result = await this.client.set(`tx:${txHash}`, '1', 'EX', 7200, 'NX');
    return result === 'OK'; // true = first time seen, false = duplicate
  }

  // Pending approvals
  async setPendingApproval(requestId: number, data: any, ttlSeconds: number = 300): Promise<void> {
    await this.setJSON(`approval:${requestId}`, data, ttlSeconds);
  }

  async getPendingApproval(requestId: number): Promise<any | null> {
    return await this.getJSON(`approval:${requestId}`);
  }

  async resolvePendingApproval(requestId: number): Promise<void> {
    await this.del(`approval:${requestId}`);
  }
}
