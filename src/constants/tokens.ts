import { parseAbi } from 'viem';

export const USDC_ADDRESS = '0xaf88d065e77c8cc2239327c5edb3a432268e5831' as const;
export const WETH_ADDRESS = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' as const;
export const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

export function usdToUsdc(usd: number): bigint {
  return BigInt(Math.floor(usd * 1e6));
}
