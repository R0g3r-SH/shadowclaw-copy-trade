import dotenv from 'dotenv';
dotenv.config();

import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';

const HTTP_RPC   = process.env.ARBITRUM_HTTP_RPC || 'https://arbitrum.publicnode.com';
const WETH       = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as const;
const USDC       = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
const ROUTER_V3  = '0xE592427A0AEce92De3Edee1F18E0157C05861564' as const;
const ETH_RESERVE = parseEther('0.003'); // keep for gas

const ROUTER_ABI = [{
  name: 'exactInputSingle',
  type: 'function',
  stateMutability: 'payable',
  inputs: [{
    name: 'params', type: 'tuple',
    components: [
      { name: 'tokenIn',           type: 'address' },
      { name: 'tokenOut',          type: 'address' },
      { name: 'fee',               type: 'uint24'  },
      { name: 'recipient',         type: 'address' },
      { name: 'deadline',          type: 'uint256' },
      { name: 'amountIn',          type: 'uint256' },
      { name: 'amountOutMinimum',  type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}] as const;

const USDC_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

async function main() {
  const account       = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const publicClient  = createPublicClient({ chain: arbitrum, transport: http(HTTP_RPC) });
  const walletClient  = createWalletClient({ account, chain: arbitrum, transport: http(HTTP_RPC) });

  const ethBalance = await publicClient.getBalance({ address: account.address });
  const swapAmount = ethBalance - ETH_RESERVE;

  if (swapAmount <= 0n) {
    console.error(`Balance insuficiente: ${formatEther(ethBalance)} ETH`);
    process.exit(1);
  }

  // Get ETH price from CryptoCompare for display only
  let ethPrice = 2400;
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD');
    const d = await r.json() as { USD: number };
    ethPrice = d.USD;
  } catch { /* use default */ }

  const estimatedUsdc = parseFloat(formatEther(swapAmount)) * ethPrice;
  const minUsdc       = Math.floor(estimatedUsdc * 0.97 * 1e6); // 3% slippage

  console.log(`\nWallet:   ${account.address}`);
  console.log(`ETH:      ${formatEther(ethBalance)} ETH (precio ~$${ethPrice.toFixed(0)})`);
  console.log(`Reserva:  0.003 ETH para gas`);
  console.log(`Swap:     ${formatEther(swapAmount)} ETH → ~$${estimatedUsdc.toFixed(2)} USDC`);
  console.log(`Min out:  $${(minUsdc / 1e6).toFixed(2)} USDC (3% slippage)\n`);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  console.log('Enviando transacción...');
  const hash = await walletClient.writeContract({
    address: ROUTER_V3,
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn:           WETH,
      tokenOut:          USDC,
      fee:               500,           // 0.05% pool
      recipient:         account.address,
      deadline,
      amountIn:          swapAmount,
      amountOutMinimum:  BigInt(minUsdc),
      sqrtPriceLimitX96: 0n,
    }],
    value: swapAmount,
  });

  console.log(`Tx enviada: ${hash}`);
  console.log('Esperando confirmación...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status === 'success') {
    const usdcBalance = await publicClient.readContract({
      address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address],
    });
    console.log(`\n✅ Swap exitoso!`);
    console.log(`USDC balance: $${formatUnits(usdcBalance, 6)}`);
    console.log(`Tx: https://arbiscan.io/tx/${hash}`);
  } else {
    console.error('❌ Transacción falló');
    process.exit(1);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
