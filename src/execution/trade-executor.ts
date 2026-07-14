import axios from 'axios';
import {
  createWalletClient,
  http,
  createPublicClient,
  encodeFunctionData,
  parseAbi,
  type WalletClient,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { logger } from '../utils/logger';
import { config } from '../config';
import { WETH_ADDRESS, ERC20_BALANCE_ABI } from '../constants/tokens';
import { DatabaseService } from '../services/database';

// ── Arbitrum contract addresses ───────────────────────────────────────────────
const SWAP_ROUTER_02  = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const;
const QUOTER_V2       = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const;
const ONEINCH_SPENDER = '0x111111125421cA6dc452d289314280a0f8842A65' as const;
const MAX_UINT256     = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
const FEE_TIERS       = [500, 3000, 10_000] as const; // 0.05%, 0.3%, 1%

// ── ABIs ──────────────────────────────────────────────────────────────────────
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) returns (uint256 amountOut)',
]);

const ALLOWANCE_ABI = parseAbi(['function allowance(address owner, address spender) view returns (uint256)']);
const APPROVE_ABI   = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

// Pack a Uniswap V3 path: token(20B) | fee(3B) | token(20B) | ...
function packPath(...segments: (string | number)[]): `0x${string}` {
  let hex = '';
  for (const s of segments) {
    hex += typeof s === 'string'
      ? s.slice(2).toLowerCase().padStart(40, '0')
      : s.toString(16).padStart(6, '0');
  }
  return `0x${hex}` as `0x${string}`;
}

interface SwapRoute {
  to:        `0x${string}`;
  data:      `0x${string}`;
  value:     bigint;
  dstAmount: string;
  spender:   `0x${string}`; // ERC20 spender that needs allowance
}

export interface TradeParams {
  tokenIn:     string;
  tokenOut:    string;
  amountIn:    bigint;
  amountUsd:   number;
  slippagePct: number;
}

export interface ExecutionResult {
  success:    boolean;
  txHash?:    Hash;
  amountOut?: bigint;
  gasCost?:   bigint;
  error?:     string;
}

export class TradeExecutor {
  private walletClient: WalletClient;
  private publicClient: ReturnType<typeof createPublicClient>;
  private account:      ReturnType<typeof privateKeyToAccount>;

  constructor(_db: DatabaseService) {
    this.account = privateKeyToAccount(config.wallet.privateKey as `0x${string}`);
    this.walletClient = createWalletClient({
      account:   this.account,
      chain:     arbitrum,
      transport: http(config.blockchain.alchemy.httpRpcUrl),
    });
    this.publicClient = createPublicClient({
      chain:     arbitrum,
      transport: http(config.blockchain.alchemy.httpRpcUrl),
    });
    logger.info(`Trade executor initialized: ${this.account.address}`);
  }

  async executeTrade(params: TradeParams): Promise<ExecutionResult> {
    try {
      logger.info(`Executing trade: $${params.amountUsd.toFixed(2)} | ${params.tokenIn.slice(0, 8)}… → ${params.tokenOut.slice(0, 8)}…`);

      // 1. Find best route (Uniswap V3 → 1inch fallback)
      const route = await this.buildSwap(params);
      if (!route) {
        return { success: false, error: 'No swap route found (tried Uniswap V3 direct, WETH hop, and 1inch)' };
      }
      logger.info(`Route via ${route.to.slice(0, 10)}… | min out: ${route.dstAmount}`);

      // 2. ERC20 approval for the chosen router (skip for native WETH)
      if (params.tokenIn.toLowerCase() !== WETH_ADDRESS) {
        const approved = await this.ensureApproved(params.tokenIn, params.amountIn, route.spender);
        if (!approved) return { success: false, error: 'Token approval failed' };
      }

      // 3. Snapshot tokenOut balance before swap — delta = exact amount received
      const outToken = params.tokenOut as `0x${string}`;
      let balanceBefore = 0n;
      try {
        balanceBefore = await this.publicClient.readContract({
          address: outToken, abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf', args: [this.account.address],
        });
      } catch { /* fallback to dstAmount */ }

      // 4. Send transaction (let viem estimate gas — router estimates are often too low)
      logger.info('Sending transaction…');
      const txHash = await this.walletClient.sendTransaction({
        account: this.account,
        to:      route.to,
        data:    route.data,
        value:   route.value,
        chain:   arbitrum,
      });
      logger.info(`TX sent: ${txHash}`);

      // 5. Wait for confirmation (90s timeout)
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });

      if (receipt.status !== 'success') {
        logger.error(`TX reverted: ${txHash}`);
        return { success: false, error: 'Transaction reverted on-chain' };
      }

      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
      let amountOut: bigint;
      try {
        const balanceAfter = await this.publicClient.readContract({
          address: outToken, abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf', args: [this.account.address],
        });
        amountOut = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : BigInt(route.dstAmount);
        logger.info(`Received: ${amountOut} (before: ${balanceBefore}, after: ${balanceAfter})`);
      } catch {
        amountOut = BigInt(route.dstAmount);
      }

      logger.info(`✅ Trade executed: ${txHash}`);
      return { success: true, txHash: receipt.transactionHash, amountOut, gasCost };

    } catch (error: any) {
      logger.error({ error }, 'Trade execution failed');
      return { success: false, error: error.message || 'Unknown error' };
    }
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  private async buildSwap(params: TradeParams): Promise<SwapRoute | null> {
    // Primary: Uniswap V3 — fully on-chain, no API key required
    const uniRoute = await this.buildUniswapV3Swap(params);
    if (uniRoute) return uniRoute;

    // Fallback: 1inch — better multi-DEX aggregation, requires API key
    if (config.apis.oneInch.apiKey) {
      return this.build1InchSwap(params);
    }

    logger.warn('No swap route available. Set ONEINCH_API_KEY for broader token support.');
    return null;
  }

  private async buildUniswapV3Swap(params: TradeParams): Promise<SwapRoute | null> {
    const slippageBps = BigInt(Math.floor(params.slippagePct * 100)); // 2% → 200 bps

    // ── Single-hop: find the best fee tier ────────────────────────────────────
    let bestOut = 0n;
    let bestFee = 0;
    for (const fee of FEE_TIERS) {
      try {
        const result = await this.publicClient.readContract({
          address: QUOTER_V2, abi: QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{
            tokenIn:          params.tokenIn  as `0x${string}`,
            tokenOut:         params.tokenOut as `0x${string}`,
            amountIn:         params.amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          }],
        }) as [bigint, bigint, number, bigint];
        const out = result[0];
        if (out > bestOut) { bestOut = out; bestFee = fee; }
      } catch { /* pool doesn't exist at this fee tier */ }
    }

    if (bestOut > 0n) {
      const minOut = (bestOut * (10_000n - slippageBps)) / 10_000n;
      const data = encodeFunctionData({
        abi: ROUTER_ABI, functionName: 'exactInputSingle',
        args: [{
          tokenIn:          params.tokenIn  as `0x${string}`,
          tokenOut:         params.tokenOut as `0x${string}`,
          fee:              bestFee,
          recipient:        this.account.address,
          amountIn:         params.amountIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        }],
      });
      logger.info(`Uniswap V3 single-hop: fee=${bestFee} out≈${bestOut}`);
      return { to: SWAP_ROUTER_02, data, value: 0n, dstAmount: minOut.toString(), spender: SWAP_ROUTER_02 };
    }

    // ── Two-hop via WETH (e.g. USDC → WETH → altcoin) ────────────────────────
    const weth = WETH_ADDRESS.toLowerCase();
    if (params.tokenIn.toLowerCase() !== weth && params.tokenOut.toLowerCase() !== weth) {
      for (const fee1 of FEE_TIERS) {
        for (const fee2 of FEE_TIERS) {
          try {
            const path = packPath(params.tokenIn, fee1, WETH_ADDRESS, fee2, params.tokenOut);
            const result = await this.publicClient.readContract({
              address: QUOTER_V2, abi: QUOTER_ABI,
              functionName: 'quoteExactInput',
              args: [path, params.amountIn],
            }) as [bigint, bigint[], number[], bigint];
            const out = result[0];
            if (out > 0n) {
              const minOut = (out * (10_000n - slippageBps)) / 10_000n;
              const data = encodeFunctionData({
                abi: ROUTER_ABI, functionName: 'exactInput',
                args: [{
                  path,
                  recipient:        this.account.address,
                  amountIn:         params.amountIn,
                  amountOutMinimum: minOut,
                }],
              });
              logger.info(`Uniswap V3 two-hop via WETH: fee1=${fee1} fee2=${fee2} out≈${out}`);
              return { to: SWAP_ROUTER_02, data, value: 0n, dstAmount: minOut.toString(), spender: SWAP_ROUTER_02 };
            }
          } catch { /* no route for this fee combination */ }
        }
      }
    }

    return null;
  }

  private async build1InchSwap(params: TradeParams): Promise<SwapRoute | null> {
    try {
      const url = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/swap`;
      logger.info(`1inch swap: ${params.tokenIn.slice(0, 8)}… → ${params.tokenOut.slice(0, 8)}…`);
      const response = await axios.get(url, {
        params: {
          src:             params.tokenIn,
          dst:             params.tokenOut,
          amount:          params.amountIn.toString(),
          from:            this.account.address,
          slippage:        params.slippagePct,
          disableEstimate: true,
        },
        headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
        timeout: 10_000,
      });
      const { tx, dstAmount } = response.data;
      if (!tx || !dstAmount) {
        logger.error({ keys: Object.keys(response.data) }, '1inch response missing tx/dstAmount');
        return null;
      }
      logger.info(`1inch route OK: out≈${dstAmount}`);
      return {
        to:        tx.to        as `0x${string}`,
        data:      tx.data      as `0x${string}`,
        value:     tx.value ? BigInt(tx.value) : 0n,
        dstAmount: dstAmount.toString(),
        spender:   ONEINCH_SPENDER,
      };
    } catch (error: any) {
      logger.error({ status: error.response?.status, detail: error.response?.data ?? error.message }, '1inch swap API error');
      return null;
    }
  }

  // ── Approval ─────────────────────────────────────────────────────────────

  private async ensureApproved(tokenAddress: string, amount: bigint, spender: `0x${string}`): Promise<boolean> {
    // 1. Check existing on-chain allowance (no API key needed)
    try {
      const allowance = await this.publicClient.readContract({
        address: tokenAddress as `0x${string}`, abi: ALLOWANCE_ABI,
        functionName: 'allowance', args: [this.account.address, spender],
      });
      if (allowance >= amount) {
        logger.debug(`${tokenAddress.slice(0, 8)} already approved for ${spender.slice(0, 10)}`);
        return true;
      }
    } catch {
      logger.debug(`Allowance check failed for ${tokenAddress.slice(0, 8)}`);
    }

    logger.info(`Approving ${tokenAddress.slice(0, 8)}… for ${spender.slice(0, 10)}… (MaxUint256)`);

    // 2. 1inch approval API (only for 1inch spender — provides exact current router tx)
    if (config.apis.oneInch.apiKey && spender === ONEINCH_SPENDER) {
      try {
        const approveUrl = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/approve/transaction`;
        const res = await axios.get(approveUrl, {
          params: { tokenAddress },
          headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
          timeout: 8_000,
        });
        const approveTx = res.data;
        if (approveTx?.to && approveTx?.data) {
          const txHash = await this.walletClient.sendTransaction({
            account: this.account,
            to: approveTx.to as `0x${string}`,
            data: approveTx.data as `0x${string}`,
            value: 0n, chain: arbitrum,
          });
          const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
          if (receipt.status === 'success') { logger.info(`Approved via 1inch API: ${txHash}`); return true; }
        }
      } catch (err: any) {
        logger.warn({ status: err.response?.status }, '1inch approval API failed — using direct approve');
      }
    }

    // 3. Direct on-chain approve(spender, MaxUint256) — works without any API key
    try {
      const data = encodeFunctionData({
        abi: APPROVE_ABI, functionName: 'approve', args: [spender, MAX_UINT256],
      });
      const txHash = await this.walletClient.sendTransaction({
        account: this.account,
        to: tokenAddress as `0x${string}`,
        data, value: 0n, chain: arbitrum,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status === 'success') { logger.info(`Approved on-chain: ${txHash}`); return true; }
      logger.error(`Approval tx reverted: ${txHash}`);
      return false;
    } catch (error: any) {
      logger.error({ error: error.message }, 'On-chain approval failed');
      return false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  calculateSlippage(_tokenAddress: string, riskScore: number): number {
    // Returns percentage integer that Uniswap V3 and 1inch both understand (2 = 2%)
    const s = config.risk.maxSlippage;
    if (riskScore > 70) return s.meme         * 100;
    if (riskScore > 50) return s.volatile     * 100;
    if (riskScore > 30) return s.established  * 100;
    return s.stable * 100;
  }

  async estimateGasCost(): Promise<bigint> {
    return 200_000n * 100_000_000n; // 200k gas × 0.1 gwei
  }
}
