#!/usr/bin/env tsx

/**
 * Utility script to add a wallet to track
 *
 * Usage:
 *   npm run add-wallet 0x1234... "Whale Trader" 85
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function addWallet(address: string, label: string, score: number = 75) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://trader:changeme123@localhost:5432/copy_trading',
  });

  try {
    // Validate address
    if (!address.startsWith('0x') || address.length !== 42) {
      console.error('❌ Invalid Ethereum address');
      process.exit(1);
    }

    // Validate score
    if (score < 0 || score > 100) {
      console.error('❌ Score must be between 0 and 100');
      process.exit(1);
    }

    // Insert wallet
    await pool.query(
      `INSERT INTO wallets (address, label, status, score)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT (address) DO UPDATE SET
         label = EXCLUDED.label,
         score = EXCLUDED.score,
         status = 'active',
         updated_at = NOW()`,
      [address.toLowerCase(), label, score]
    );

    console.log('✅ Wallet added successfully!');
    console.log(`   Address: ${address}`);
    console.log(`   Label: ${label}`);
    console.log(`   Score: ${score}/100`);
    console.log(`   Status: active`);

  } catch (error) {
    console.error('❌ Error adding wallet:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Parse command line arguments
const [,, address, label, scoreStr] = process.argv;

if (!address || !label) {
  console.log('Usage: npm run add-wallet <address> <label> [score]');
  console.log('');
  console.log('Example:');
  console.log('  npm run add-wallet 0x1234... "Smart Trader" 85');
  process.exit(1);
}

const score = scoreStr ? parseInt(scoreStr) : 75;

addWallet(address, label, score);
