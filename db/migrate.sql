-- Migration: add peak_pnl_pct + closing status + NUMERIC columns
-- Run this ONCE on existing databases: psql $DATABASE_URL -f db/migrate.sql

-- Fix numeric overflow: DECIMAL(38,18) only allows 20 digits before decimal point.
-- Tokens with 18 decimals in large amounts exceed this limit. NUMERIC has no limit.
ALTER TABLE tracked_transactions ALTER COLUMN amount_in TYPE NUMERIC;
ALTER TABLE tracked_transactions ALTER COLUMN amount_out TYPE NUMERIC;
ALTER TABLE copied_trades ALTER COLUMN amount_in TYPE NUMERIC;
ALTER TABLE copied_trades ALTER COLUMN amount_out TYPE NUMERIC;

ALTER TABLE copied_trades ADD COLUMN IF NOT EXISTS peak_pnl_pct DECIMAL(10,4) DEFAULT 0.0;

ALTER TABLE copied_trades DROP CONSTRAINT IF EXISTS copied_trades_status_check;
ALTER TABLE copied_trades ADD CONSTRAINT copied_trades_status_check
  CHECK (status IN ('pending', 'executing', 'filled', 'partial', 'failed', 'closed', 'closing'));

-- Prevent duplicate copy-trades for the same original wallet tx
ALTER TABLE copied_trades ADD CONSTRAINT IF NOT EXISTS copied_trades_original_tx_hash_unique
  UNIQUE (original_tx_hash);
