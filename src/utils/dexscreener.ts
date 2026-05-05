import axios from 'axios';
import { logger } from './logger';

export interface TokenMarketData {
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
  priceChangeH1: number | null;
  priceChangeH24: number | null;
  fdv: number | null;
  pairCreatedAt: number | null; // unix ms — to detect very new tokens
}

const cache = new Map<string, { data: TokenMarketData; expiry: number }>();
const CACHE_TTL = 60_000; // 1 minute

export async function getTokenMarketData(tokenAddress: string): Promise<TokenMarketData | null> {
  const key = tokenAddress.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${key}`,
      { timeout: 5000 }
    );
    const pairs: any[] = res.data?.pairs;
    if (!pairs?.length) return null;

    const best = pairs.sort((a: any, b: any) =>
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    const data: TokenMarketData = {
      priceUsd:       parseFloat(best.priceUsd || '0') || 0,
      liquidityUsd:   best.liquidity?.usd || 0,
      volume24h:      best.volume?.h24 || 0,
      priceChangeH1:  best.priceChange?.h1  != null ? parseFloat(best.priceChange.h1)  : null,
      priceChangeH24: best.priceChange?.h24 != null ? parseFloat(best.priceChange.h24) : null,
      fdv:            best.fdv ?? null,
      pairCreatedAt:  best.pairCreatedAt ?? null,
    };

    cache.set(key, { data, expiry: Date.now() + CACHE_TTL });

    // Evict expired entries periodically to prevent unbounded growth
    if (cache.size > 200) {
      const now = Date.now();
      for (const [k, v] of cache) { if (v.expiry < now) cache.delete(k); }
    }

    return data;
  } catch {
    logger.debug({ tokenAddress }, 'DEXScreener fetch failed');
    return null;
  }
}

import { WETH_ADDRESS } from '../constants/tokens';

export async function getEthPriceUsd(): Promise<number> {
  const data = await getTokenMarketData(WETH_ADDRESS);
  return data?.priceUsd || 2000;
}
