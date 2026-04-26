import axios from 'axios';
import { logger } from '../utils/logger';
import { config } from '../config';
import { DatabaseService } from '../services/database';
import { getTokenMarketData } from '../utils/dexscreener';

export interface SafetyResult {
  tokenAddress: string;
  isHoneypot: boolean;
  isMintable: boolean;
  isBlacklisted: boolean;
  isVerified: boolean;
  liquidityUsd: number;
  riskScore: number;
  shouldBlock: boolean;
  reasons: string[];
}

// Blue-chip tokens on Arbitrum — skip GoPlus, always safe
const WHITELIST = new Set([
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC (native)
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e (bridged)
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
  '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  '0x5979d7b546e38e414f7e9822514be443a4800529', // wstETH
]);

function whitelistResult(tokenAddress: string): SafetyResult {
  return {
    tokenAddress,
    isHoneypot: false, isMintable: false, isBlacklisted: false, isVerified: true,
    liquidityUsd: 999_000_000, riskScore: 5, shouldBlock: false,
    reasons: ['Whitelisted blue-chip token'],
  };
}

export class TokenSafetyChecker {
  private readonly goPlusBaseUrl = config.apis.goPlus.baseUrl;
  private readonly chainId = config.apis.goPlus.chainId;

  constructor(private db: DatabaseService) {}

  async checkToken(tokenAddress: string): Promise<SafetyResult> {
    const addr = tokenAddress.toLowerCase();

    // Whitelist bypass — no API call needed
    if (WHITELIST.has(addr)) {
      logger.info(`Token ${addr.slice(0,10)} is whitelisted — skipping safety check`);
      return whitelistResult(tokenAddress);
    }

    try {
      // Check cache first
      const cached = await this.db.getSafetyCheck(tokenAddress);
      if (cached) {
        logger.debug(`Using cached safety check for ${tokenAddress}`);
        return this.formatCachedResult(cached);
      }

      // Fetch from GoPlus API
      logger.info(`Checking token safety: ${tokenAddress}`);
      const goPlusData = await this.fetchGoPlus(tokenAddress);

      // Get real USD liquidity from DEXScreener (GoPlus doesn't provide it reliably)
      const marketData = await getTokenMarketData(tokenAddress);
      const liquidityUsd = marketData?.liquidityUsd || 0;

      // Calculate risk score
      const result = this.analyzeToken(tokenAddress, goPlusData, liquidityUsd);

      // Save to cache
      await this.db.saveSafetyCheck({
        tokenAddress: result.tokenAddress,
        isHoneypot: result.isHoneypot,
        isMintable: result.isMintable,
        isBlacklisted: result.isBlacklisted,
        isVerified: result.isVerified,
        liquidityUsd: result.liquidityUsd,
        riskScore: result.riskScore,
      });

      logger.info(`Safety check complete: ${tokenAddress} - Risk: ${result.riskScore}/100`);

      return result;

    } catch (error) {
      logger.warn({ tokenAddress, error }, 'GoPlus check failed — falling back to DEXScreener only');

      // GoPlus failed: use DEXScreener liquidity as the only signal
      // Don't hard-block — assign moderate risk and let the agent decide
      try {
        const marketData = await getTokenMarketData(tokenAddress);
        const liquidityUsd = marketData?.liquidityUsd ?? 0;

        if (liquidityUsd < config.risk.minLiquidityUsd) {
          return {
            tokenAddress, isHoneypot: false, isMintable: false,
            isBlacklisted: false, isVerified: false, liquidityUsd,
            riskScore: 65, shouldBlock: true,
            reasons: [`GoPlus unavailable + low liquidity $${liquidityUsd.toFixed(0)} — blocked`],
          };
        }

        // Has enough liquidity — moderate risk, don't block
        return {
          tokenAddress, isHoneypot: false, isMintable: false,
          isBlacklisted: false, isVerified: false, liquidityUsd,
          riskScore: 40, shouldBlock: false,
          reasons: ['GoPlus unavailable — moderate risk assigned, liquidity OK'],
        };
      } catch {
        // Both APIs failed — block to be safe
        return {
          tokenAddress, isHoneypot: true, isMintable: true,
          isBlacklisted: false, isVerified: false, liquidityUsd: 0,
          riskScore: 100, shouldBlock: true,
          reasons: ['All safety APIs failed — blocked'],
        };
      }
    }
  }

  private async fetchGoPlus(tokenAddress: string): Promise<any> {
    const url = `${this.goPlusBaseUrl}/token_security/${this.chainId}`;
    const params = { contract_addresses: tokenAddress.toLowerCase() };

    const response = await axios.get(url, {
      params,
      timeout: 10000,
    });

    if (response.data.code !== 1) {
      throw new Error(`GoPlus API error: ${response.data.message}`);
    }

    const tokenData = response.data.result[tokenAddress.toLowerCase()];

    if (!tokenData) {
      throw new Error('Token not found in GoPlus response');
    }

    return tokenData;
  }

  private analyzeToken(tokenAddress: string, data: any, liquidityUsd: number): SafetyResult {
    const reasons: string[] = [];
    let riskScore = 0;

    // Critical flags (+30 each)
    const isHoneypot = data.is_honeypot === '1';
    if (isHoneypot) {
      riskScore += 30;
      reasons.push('Honeypot detected');
    }

    const isMintable = data.is_mintable === '1';
    if (isMintable) {
      riskScore += 30;
      reasons.push('Unlimited minting possible');
    }

    const isBlacklisted = data.is_blacklisted === '1';
    if (isBlacklisted) {
      riskScore += 30;
      reasons.push('Blacklist function detected');
    }

    // High-risk flags (+15 each)
    if (data.is_proxy === '1') {
      riskScore += 15;
      reasons.push('Proxy contract (upgradeable)');
    }

    if (data.owner_change_balance === '1') {
      riskScore += 15;
      reasons.push('Owner can change balances');
    }

    if (data.hidden_owner === '1') {
      riskScore += 10;
      reasons.push('Hidden owner');
    }

    if (data.selfdestruct === '1') {
      riskScore += 20;
      reasons.push('Self-destruct function present');
    }

    // Medium-risk flags (+5-10 each)
    const isVerified = data.is_open_source === '1';
    if (!isVerified) {
      riskScore += 10;
      reasons.push('Contract not verified');
    }

    if (data.trading_cooldown === '1') {
      riskScore += 5;
      reasons.push('Trading cooldown present');
    }

    if (data.transfer_pausable === '1') {
      riskScore += 10;
      reasons.push('Transfers can be paused');
    }

    // Liquidity check (liquidityUsd comes from DEXScreener)
    if (liquidityUsd < config.risk.minLiquidityUsd) {
      riskScore += 15;
      reasons.push(`Low liquidity: $${liquidityUsd.toFixed(0)}`);
    }

    // Tax analysis
    const buyTax = parseFloat(data.buy_tax || '0');
    const sellTax = parseFloat(data.sell_tax || '0');

    if (buyTax > 0.10) {
      riskScore += 10;
      reasons.push(`High buy tax: ${(buyTax * 100).toFixed(1)}%`);
    }

    if (sellTax > 0.10) {
      riskScore += 10;
      reasons.push(`High sell tax: ${(sellTax * 100).toFixed(1)}%`);
    }

    // Cap risk score at 100
    riskScore = Math.min(riskScore, 100);

    // Hard block only for absolute technical constraints — agent decides everything else
    const shouldBlock = isHoneypot && liquidityUsd === 0;

    if (shouldBlock) {
      reasons.unshift(`BLOCKED: Honeypot + zero liquidity — cannot trade`);
    }

    return {
      tokenAddress,
      isHoneypot,
      isMintable,
      isBlacklisted,
      isVerified,
      liquidityUsd,
      riskScore,
      shouldBlock,
      reasons,
    };
  }

  private formatCachedResult(cached: any): SafetyResult {
    const shouldBlock = cached.is_honeypot && cached.liquidity_usd === 0;
    const reasons: string[] = [];

    if (cached.is_honeypot) reasons.push('Honeypot detected');
    if (cached.is_mintable) reasons.push('Unlimited minting possible');
    if (cached.is_blacklisted) reasons.push('Blacklist function detected');
    if (!cached.is_verified) reasons.push('Contract not verified');
    if (cached.liquidity_usd < config.risk.minLiquidityUsd) {
      reasons.push(`Low liquidity: $${cached.liquidity_usd.toFixed(0)}`);
    }

    if (shouldBlock) {
      reasons.unshift(`BLOCKED: Risk score ${cached.risk_score}/100 (cached)`);
    }

    return {
      tokenAddress: cached.token_address,
      isHoneypot: cached.is_honeypot,
      isMintable: cached.is_mintable,
      isBlacklisted: cached.is_blacklisted,
      isVerified: cached.is_verified,
      liquidityUsd: cached.liquidity_usd,
      riskScore: cached.risk_score,
      shouldBlock,
      reasons,
    };
  }

  // Batch check multiple tokens
  async checkMultipleTokens(tokenAddresses: string[]): Promise<Map<string, SafetyResult>> {
    const results = new Map<string, SafetyResult>();

    // Process in batches to respect API limits
    const batchSize = 5;
    for (let i = 0; i < tokenAddresses.length; i += batchSize) {
      const batch = tokenAddresses.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(addr => this.checkToken(addr))
      );

      batchResults.forEach(result => {
        results.set(result.tokenAddress, result);
      });

      // Small delay between batches
      if (i + batchSize < tokenAddresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return results;
  }
}
