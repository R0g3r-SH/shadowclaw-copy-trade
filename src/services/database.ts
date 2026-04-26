import { Pool, PoolClient, QueryResult } from 'pg';
import { logger } from '../utils/logger';

export class DatabaseService {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected database error');
    });
  }

  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      logger.info('Database connection successful');
    } catch (error) {
      logger.error({ error }, 'Database connection failed');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    logger.info('Database disconnected');
  }

  async query(text: string, params?: any[]): Promise<QueryResult> {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      logger.debug({ query: text, duration, rows: result.rowCount }, 'Database query');
      return result;
    } catch (error) {
      logger.error({ query: text, error }, 'Database query failed');
      throw error;
    }
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // System Events
  async logEvent(
    eventType: string,
    severity: 'debug' | 'info' | 'warning' | 'error' | 'critical',
    message: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    await this.query(
      `INSERT INTO system_events (event_type, severity, message, metadata) VALUES ($1, $2, $3, $4)`,
      [eventType, severity, message, metadata ? JSON.stringify(metadata) : null]
    );
  }

  // Wallets
  async getActiveWallets(): Promise<any[]> {
    const result = await this.query(
      `SELECT * FROM wallets WHERE status IN ('active', 'monitoring') ORDER BY score DESC`
    );
    return result.rows;
  }

  async updateWalletScore(address: string, score: number): Promise<void> {
    await this.query(
      `UPDATE wallets SET score = $1, updated_at = NOW() WHERE address = $2`,
      [score, address]
    );
  }

  // Transactions
  async saveTrackedTransaction(tx: {
    txHash: string;
    walletAddress: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    dex: string;
    timestamp: Date;
  }): Promise<void> {
    await this.query(
      `INSERT INTO tracked_transactions
       (tx_hash, wallet_address, token_in, token_out, amount_in, dex, timestamp, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'detected')
       ON CONFLICT (tx_hash) DO NOTHING`,
      [tx.txHash, tx.walletAddress, tx.tokenIn, tx.tokenOut, tx.amountIn, tx.dex, tx.timestamp]
    );
  }

  // Copied Trades
  async saveCopiedTrade(trade: {
    originalTxHash: string;
    walletAddress: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    positionSizeUsd: number;
  }): Promise<number> {
    const result = await this.query(
      `INSERT INTO copied_trades
       (original_tx_hash, wallet_address, token_in, token_out, amount_in, position_size_usd, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [
        trade.originalTxHash,
        trade.walletAddress,
        trade.tokenIn,
        trade.tokenOut,
        trade.amountIn,
        trade.positionSizeUsd,
      ]
    );
    return result.rows[0].id;
  }

  async updateCopiedTrade(
    id: number,
    updates: {
      ourTxHash?: string;
      status?: string;
      executedAt?: Date;
      amountOut?: string;
      gasCostUsd?: number;
      pnl?: number;
    }
  ): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.ourTxHash) {
      sets.push(`our_tx_hash = $${paramIndex++}`);
      values.push(updates.ourTxHash);
    }
    if (updates.status) {
      sets.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.executedAt) {
      sets.push(`executed_at = $${paramIndex++}`);
      values.push(updates.executedAt);
    }
    if (updates.amountOut) {
      sets.push(`amount_out = $${paramIndex++}`);
      values.push(updates.amountOut);
    }
    if (updates.gasCostUsd !== undefined) {
      sets.push(`gas_cost_usd = $${paramIndex++}`);
      values.push(updates.gasCostUsd);
    }
    if (updates.pnl !== undefined) {
      sets.push(`pnl = $${paramIndex++}`);
      values.push(updates.pnl);
    }

    if (sets.length === 0) return;
    values.push(id);

    await this.query(
      `UPDATE copied_trades SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  // Safety Checks
  async getSafetyCheck(tokenAddress: string): Promise<any | null> {
    const result = await this.query(
      `SELECT * FROM safety_checks WHERE token_address = $1 AND expires_at > NOW()`,
      [tokenAddress]
    );
    return result.rows[0] || null;
  }

  async saveSafetyCheck(check: {
    tokenAddress: string;
    isHoneypot: boolean;
    isMintable: boolean;
    isBlacklisted: boolean;
    isVerified: boolean;
    liquidityUsd: number;
    riskScore: number;
  }): Promise<void> {
    await this.query(
      `INSERT INTO safety_checks
       (token_address, is_honeypot, is_mintable, is_blacklisted, is_verified, liquidity_usd, risk_score, checked_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + INTERVAL '1 hour')
       ON CONFLICT (token_address) DO UPDATE SET
         is_honeypot = EXCLUDED.is_honeypot,
         is_mintable = EXCLUDED.is_mintable,
         is_blacklisted = EXCLUDED.is_blacklisted,
         is_verified = EXCLUDED.is_verified,
         liquidity_usd = EXCLUDED.liquidity_usd,
         risk_score = EXCLUDED.risk_score,
         checked_at = NOW(),
         expires_at = NOW() + INTERVAL '1 hour'`,
      [
        check.tokenAddress,
        check.isHoneypot,
        check.isMintable,
        check.isBlacklisted,
        check.isVerified,
        check.liquidityUsd,
        check.riskScore,
      ]
    );
  }

  // Approval Requests
  async createApprovalRequest(request: {
    requestType: string;
    walletAddress: string;
    tokenAddress: string;
    amountUsd: number;
    riskScore: number;
  }): Promise<number> {
    const result = await this.query(
      `INSERT INTO approval_requests
       (request_type, wallet_address, token_address, amount_usd, risk_score, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [
        request.requestType,
        request.walletAddress,
        request.tokenAddress,
        request.amountUsd,
        request.riskScore,
      ]
    );
    return result.rows[0].id;
  }

  async updateApprovalRequest(
    id: number,
    status: 'approved' | 'rejected' | 'expired' | 'timeout',
    messageId?: number
  ): Promise<void> {
    await this.query(
      `UPDATE approval_requests
       SET status = $1, responded_at = NOW(), message_id = $2
       WHERE id = $3`,
      [status, messageId, id]
    );
  }

  // Analytics
  async getDailyPnL(): Promise<number> {
    const result = await this.query(
      `SELECT COALESCE(SUM(pnl), 0) as total_pnl
       FROM copied_trades
       WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    return parseFloat(result.rows[0].total_pnl);
  }

  async getHourlyPnL(): Promise<number> {
    const result = await this.query(
      `SELECT COALESCE(SUM(pnl), 0) as total_pnl
       FROM copied_trades
       WHERE created_at > NOW() - INTERVAL '1 hour'`
    );
    return parseFloat(result.rows[0].total_pnl);
  }

  async getOpenPositions(): Promise<number> {
    const result = await this.query(
      `SELECT COUNT(*) as count
       FROM copied_trades
       WHERE status IN ('filled', 'partial')`
    );
    return parseInt(result.rows[0].count);
  }
}
