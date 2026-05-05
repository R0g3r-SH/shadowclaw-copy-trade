import axios from 'axios';
import {
  createWalletClient,
  http,
  createPublicClient,
  type WalletClient,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { logger } from '../utils/logger';
import { config } from '../config';
import { WETH_ADDRESS, ERC20_BALANCE_ABI } from '../constants/tokens';
import { DatabaseService } from '../services/database';

export interface TradeParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountUsd: number;
  slippagePct: number;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: Hash;
  amountOut?: bigint;
  gasCost?: bigint;
  error?: string;
}


export class TradeExecutor {
  private walletClient: WalletClient;
  private publicClient: ReturnType<typeof createPublicClient>;
  private account: ReturnType<typeof privateKeyToAccount>;

  constructor(_db: DatabaseService) {
    this.account = privateKeyToAccount(config.wallet.privateKey as `0x${string}`);

    this.walletClient = createWalletClient({
      account: this.account,
      chain: arbitrum,
      transport: http(config.blockchain.alchemy.httpRpcUrl),
    });

    this.publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(config.blockchain.alchemy.httpRpcUrl),
    });

    logger.info(`Trade executor initialized with address: ${this.account.address}`);
  }

  async executeTrade(params: TradeParams): Promise<ExecutionResult> {
    try {
      logger.info(`Executing trade: ${params.amountUsd.toFixed(2)} USD`);
      logger.info(`  ${params.tokenIn.slice(0, 8)}... → ${params.tokenOut.slice(0, 8)}...`);

      // Step 1: Ensure ERC20 approval if tokenIn is not native WETH (buys use ETH value)
      if (params.tokenIn.toLowerCase() !== WETH_ADDRESS) {
        const approved = await this.ensureApproved(params.tokenIn, params.amountIn);
        if (!approved) {
          return { success: false, error: 'Token approval failed' };
        }
      }

      // Step 2: Build swap tx via 1inch
      const swapData = await this.build1InchSwap(params);
      if (!swapData) {
        return { success: false, error: '1inch swap build failed' };
      }

      const { tx, dstAmount } = swapData;
      logger.info(`Swap quote: ${dstAmount} tokens out (minimum, raw)`);

      // Step 3: Read outToken balance BEFORE the swap so we can compute the exact delta.
      // Reading total balance after is wrong — the wallet may already hold some of tokenOut
      // (especially USDC on sells), which inflates amountOut and corrupts P&L tracking.
      const outToken = params.tokenOut as `0x${string}`;
      let balanceBefore = 0n;
      try {
        balanceBefore = await this.publicClient.readContract({
          address: outToken,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [this.account.address],
        });
      } catch { /* treat as 0; delta will fall back to dstAmount */ }

      // Step 4: Execute transaction
      // Do NOT pass gas from 1inch when disableEstimate=true — their estimate is often too low.
      // Let viem estimate gas properly via eth_estimateGas.
      logger.info('Sending transaction...');
      const txHash = await this.walletClient.sendTransaction({
        account: this.account,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value ? BigInt(tx.value) : 0n,
        chain: arbitrum,
      });

      logger.info(`Transaction sent: ${txHash}`);

      // Step 5: Wait for confirmation — 90s timeout prevents indefinite hang on stuck txs
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 90_000,
      });

      if (receipt.status === 'success') {
        logger.info(`✅ Trade executed successfully: ${txHash}`);
        const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

        let amountOut: bigint;
        try {
          const balanceAfter = await this.publicClient.readContract({
            address: outToken,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [this.account.address],
          });
          // Delta = exactly what the swap produced, regardless of pre-existing balance
          amountOut = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : BigInt(dstAmount);
          logger.info(`Received: ${amountOut} (before: ${balanceBefore}, after: ${balanceAfter}, quote min: ${dstAmount})`);
        } catch {
          amountOut = BigInt(dstAmount);
        }

        return { success: true, txHash: receipt.transactionHash, amountOut, gasCost };
      } else {
        logger.error(`Transaction reverted: ${txHash}`);
        return { success: false, error: 'Transaction reverted on-chain' };
      }

    } catch (error: any) {
      logger.error({ error }, 'Trade execution failed');
      return { success: false, error: error.message || 'Unknown error' };
    }
  }

  private async ensureApproved(tokenAddress: string, amount: bigint): Promise<boolean> {
    const approveUrl = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/approve/transaction`;

    try {
      // Try to check current allowance first — skip approve if already sufficient
      try {
        const allowanceUrl = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/approve/allowance`;
        const allowanceRes = await axios.get(allowanceUrl, {
          params: { tokenAddress, walletAddress: this.account.address },
          headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
          timeout: 6000,
        });
        const allowance = BigInt(String(allowanceRes.data?.allowance || '0').split('.')[0]);
        if (allowance >= amount) {
          logger.debug(`${tokenAddress.slice(0, 8)} already approved (allowance sufficient)`);
          return true;
        }
      } catch {
        // Allowance check failed — proceed to approve anyway; idempotent on-chain
        logger.debug(`Allowance check failed for ${tokenAddress.slice(0, 8)} — approving anyway`);
      }

      logger.info(`Approving ${tokenAddress.slice(0, 8)}... for 1inch (MaxUint256)`);
      const approveRes = await axios.get(approveUrl, {
        params: { tokenAddress }, // no amount = MaxUint256
        headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
        timeout: 8000,
      });

      const approveTx = approveRes.data;
      if (!approveTx?.to || !approveTx?.data) {
        logger.error({ approveTx, status: approveRes.status }, 'Invalid approve transaction from 1inch — missing to/data fields');
        return false;
      }

      const txHash = await this.walletClient.sendTransaction({
        account: this.account,
        to: approveTx.to as `0x${string}`,
        data: approveTx.data as `0x${string}`,
        value: 0n,
        chain: arbitrum,
      });

      const approveReceipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (approveReceipt.status !== 'success') {
        logger.error(`Approval tx reverted on-chain: ${txHash}`);
        return false;
      }
      logger.info(`Token approved: ${txHash}`);
      return true;

    } catch (error: any) {
      const detail = error.response?.data ?? error.message;
      const status = error.response?.status;
      logger.error({ status, detail }, 'Token approval failed');
      if (status === 401 || status === 403) {
        logger.error('1inch API key is missing or invalid — check ONEINCH_API_KEY env var');
      }
      return false;
    }
  }

  private async build1InchSwap(params: TradeParams): Promise<{ tx: any; dstAmount: string } | null> {
    try {
      const url = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/swap`;
      const reqParams = {
        src: params.tokenIn,
        dst: params.tokenOut,
        amount: params.amountIn.toString(),
        from: this.account.address,
        slippage: params.slippagePct,
        disableEstimate: true,
      };
      logger.info({ url, params: reqParams }, '1inch swap request');
      const response = await axios.get(url, {
        params: reqParams,
        headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
        timeout: 10000,
      });
      const { tx, dstAmount, error, description } = response.data;
      if (!tx || !dstAmount) {
        logger.error({ status: response.status, error, description, keys: Object.keys(response.data) }, '1inch response missing tx/dstAmount');
        return null;
      }
      logger.info({ dstAmount, to: tx.to, gas: tx.gas }, '1inch swap OK');
      return { tx, dstAmount };
    } catch (error: any) {
      const detail = error.response?.data ?? error.message;
      logger.error({ status: error.response?.status, detail }, '1inch swap API error');
      return null;
    }
  }

  calculateSlippage(_tokenAddress: string, riskScore: number): number {
    // Config stores fractions (0.01 = 1%); 1inch API expects integers (1 = 1%)
    const maxSlippage = config.risk.maxSlippage;
    if (riskScore > 70) return maxSlippage.meme * 100;
    if (riskScore > 50) return maxSlippage.volatile * 100;
    if (riskScore > 30) return maxSlippage.established * 100;
    return maxSlippage.stable * 100;
  }

  async estimateGasCost(): Promise<bigint> {
    const gasLimit = 200000n;
    const gasPrice = 100000000n; // 0.1 gwei in wei
    return gasLimit * gasPrice;
  }
}
