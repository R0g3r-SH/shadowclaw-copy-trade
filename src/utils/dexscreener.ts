import axios from 'axios';
import { logger } from './logger';

export interface TokenMarketData {
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
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
      priceUsd: parseFloat(best.priceUsd || '0') || 0,
      liquidityUsd: best.liquidity?.usd || 0,
      volume24h: best.volume?.h24 || 0,
    };

    cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
    return data;
  } catch {
    logger.debug({ tokenAddress }, 'DEXScreener fetch failed');
    return null;
  }
}

const WETH_ARBITRUM = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';

export async function getEthPriceUsd(): Promise<number> {
  const data = await getTokenMarketData(WETH_ARBITRUM);
  return data?.priceUsd || 2000;
}
