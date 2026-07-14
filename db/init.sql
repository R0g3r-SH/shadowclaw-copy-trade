-- Copy Trading Agent Database Schema
-- PostgreSQL 16+

-- Tracked Wallets
CREATE TABLE IF NOT EXISTS wallets (
    address VARCHAR(42) PRIMARY KEY,
    label VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    score DECIMAL(5,2) DEFAULT 0.0,
    win_rate DECIMAL(5,4),
    profit_factor DECIMAL(10,2),
    total_trades INTEGER DEFAULT 0,
    total_pnl DECIMAL(20,8) DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_trade_at TIMESTAMP,

    CHECK (status IN ('candidate', 'active', 'monitoring', 'paused', 'stopped', 'retired'))
);

CREATE INDEX idx_wallets_status ON wallets(status);
CREATE INDEX idx_wallets_score ON wallets(score DESC);

-- Tracked Transactions (from wallets we monitor)
CREATE TABLE IF NOT EXISTS tracked_transactions (
    tx_hash VARCHAR(66) PRIMARY KEY,
    wallet_address VARCHAR(42) NOT NULL REFERENCES wallets(address),
    token_in VARCHAR(42) NOT NULL,
    token_out VARCHAR(42) NOT NULL,
    amount_in NUMERIC NOT NULL,
    amount_out NUMERIC,
    dex VARCHAR(50),
    block_number BIGINT,
    timestamp TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'detected',

    CHECK (status IN ('detected', 'analyzed', 'copied', 'skipped', 'failed'))
);

CREATE INDEX idx_tracked_tx_wallet ON tracked_transactions(wallet_address);
CREATE INDEX idx_tracked_tx_timestamp ON tracked_transactions(timestamp DESC);
CREATE INDEX idx_tracked_tx_status ON tracked_transactions(status);

-- Our Copied Trades
CREATE TABLE IF NOT EXISTS copied_trades (
    id SERIAL PRIMARY KEY,
    original_tx_hash VARCHAR(66) REFERENCES tracked_transactions(tx_hash),
    our_tx_hash VARCHAR(66),
    wallet_address VARCHAR(42) NOT NULL REFERENCES wallets(address),
    token_in VARCHAR(42) NOT NULL,
    token_out VARCHAR(42) NOT NULL,
    amount_in NUMERIC NOT NULL,
    amount_out NUMERIC,
    position_size_usd DECIMAL(20,2),
    execution_price DECIMAL(38,18),
    gas_used DECIMAL(18,0),
    gas_price DECIMAL(18,0),
    gas_cost_usd DECIMAL(20,8),
    slippage_pct DECIMAL(5,4),
    pnl DECIMAL(20,8) DEFAULT 0.0,
    pnl_pct DECIMAL(10,4) DEFAULT 0.0,
    pnl_eth DECIMAL(20,8),
    peak_pnl_pct DECIMAL(10,4) DEFAULT 0.0,
    sell_reason VARCHAR(100),
    entry_price DECIMAL(38,18),
    exit_price DECIMAL(38,18),
    exit_tx_hash VARCHAR(66),
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    executed_at TIMESTAMP,
    closed_at TIMESTAMP,

    CHECK (status IN ('pending', 'executing', 'filled', 'partial', 'failed', 'closed', 'closing'))
);

CREATE INDEX idx_copied_trades_wallet ON copied_trades(wallet_address);
CREATE INDEX idx_copied_trades_status ON copied_trades(status);
CREATE INDEX idx_copied_trades_created ON copied_trades(created_at DESC);

-- Token Safety Checks (cache)
CREATE TABLE IF NOT EXISTS safety_checks (
    token_address VARCHAR(42) PRIMARY KEY,
    is_honeypot BOOLEAN,
    is_mintable BOOLEAN,
    is_blacklisted BOOLEAN,
    is_verified BOOLEAN,
    liquidity_usd DECIMAL(20,2),
    risk_score DECIMAL(5,2),
    checked_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '1 hour'
);

CREATE INDEX idx_safety_expires ON safety_checks(expires_at);

-- Wallet Performance (daily aggregates)
CREATE TABLE IF NOT EXISTS wallet_performance (
    wallet_address VARCHAR(42) REFERENCES wallets(address),
    date DATE NOT NULL,
    trades_count INTEGER DEFAULT 0,
    win_count INTEGER DEFAULT 0,
    loss_count INTEGER DEFAULT 0,
    total_pnl DECIMAL(20,8) DEFAULT 0.0,
    total_volume_usd DECIMAL(20,2) DEFAULT 0.0,
    avg_position_size DECIMAL(20,2),

    PRIMARY KEY (wallet_address, date)
);

CREATE INDEX idx_wallet_perf_date ON wallet_performance(date DESC);

-- System Events Log
CREATE TABLE IF NOT EXISTS system_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),

    CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical'))
);

CREATE INDEX idx_events_type ON system_events(event_type);
CREATE INDEX idx_events_severity ON system_events(severity);
CREATE INDEX idx_events_created ON system_events(created_at DESC);

-- Approval Requests (for Telegram)
CREATE TABLE IF NOT EXISTS approval_requests (
    id SERIAL PRIMARY KEY,
    request_type VARCHAR(50) NOT NULL,
    trade_signal_id INTEGER,
    wallet_address VARCHAR(42),
    token_address VARCHAR(42),
    amount_usd DECIMAL(20,2),
    risk_score DECIMAL(5,2),
    message_id BIGINT,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    responded_at TIMESTAMP,
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes',

    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'timeout'))
);

CREATE INDEX idx_approvals_status ON approval_requests(status);
CREATE INDEX idx_approvals_expires ON approval_requests(expires_at);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to wallets table
CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert some example tracked wallets (replace with real addresses)
INSERT INTO wallets (address, label, status, score) VALUES
('0x0000000000000000000000000000000000000001', 'Example Whale 1', 'candidate', 75.0),
('0x0000000000000000000000000000000000000002', 'Example Whale 2', 'candidate', 80.0)
ON CONFLICT (address) DO NOTHING;

-- Wallet observations for organic discovery
CREATE TABLE IF NOT EXISTS wallet_observations (
    address VARCHAR(42) PRIMARY KEY,
    swap_count INTEGER DEFAULT 0,
    first_seen TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_observations_count ON wallet_observations(swap_count DESC);

-- Log initialization
INSERT INTO system_events (event_type, severity, message) VALUES
('database', 'info', 'Database initialized successfully');
