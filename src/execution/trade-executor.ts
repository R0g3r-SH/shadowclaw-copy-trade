import axios from 'axios';
import {
  createWalletClient,
  http,
  createPublicClient,
  type WalletClient,
  type Hash,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { logger } from '../utils/logger';
import { config } from '../config';
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

const WETH_ARBITRUM = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const ALCHEMY_RPC = `https://arb-mainnet.g.alchemy.com/v2/${config.blockchain.alchemy.apiKey}`;

export class TradeExecutor {
  private walletClient: WalletClient;
  private publicClient: ReturnType<typeof createPublicClient>;
  private account: ReturnType<typeof privateKeyToAccount>;

  constructor(_db: DatabaseService) {
    this.account = privateKeyToAccount(config.wallet.privateKey as `0x${string}`);

    // Flashbots doesn't support Arbitrum — use Alchemy directly
    this.walletClient = createWalletClient({
      account: this.account,
      chain: arbitrum,
      transport: http(ALCHEMY_RPC),
    });

    this.publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(ALCHEMY_RPC),
    });

    logger.info(`Trade executor initialized with address: ${this.account.address}`);
  }

  async executeTrade(params: TradeParams): Promise<ExecutionResult> {
    try {
      logger.info(`Executing trade: ${params.amountUsd.toFixed(2)} USD`);
      logger.info(`  ${params.tokenIn.slice(0, 8)}... → ${params.tokenOut.slice(0, 8)}...`);

      // Step 1: Ensure ERC20 approval if tokenIn is not native WETH (buys use ETH value)
      if (params.tokenIn.toLowerCase() !== WETH_ARBITRUM.toLowerCase()) {
        const approved = await this.ensureApproved(params.tokenIn, params.amountIn);
        if (!approved) {
          return { success: false, error: 'Token approval failed' };
        }
      }

      // Step 2: Get quote from 1inch
      const quote = await this.get1InchQuote(params);
      if (!quote) {
        return { success: false, error: '1inch quote failed' };
      }

      logger.info(`Quote received: ${formatUnits(BigInt(quote.toAmount), 18)} tokens out`);

      // Step 3: Build transaction
      const tx = await this.build1InchSwap(params);
      if (!tx) {
        return { success: false, error: '1inch swap build failed' };
      }

      // Step 4: Execute transaction
      logger.info('Sending transaction...');
      const txHash = await this.walletClient.sendTransaction({
        account: this.account,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value ? BigInt(tx.value) : 0n,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        chain: arbitrum,
      });

      logger.info(`Transaction sent: ${txHash}`);

      // Step 5: Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === 'success') {
        logger.info(`✅ Trade executed successfully: ${txHash}`);
        const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
        return {
          success: true,
          txHash: receipt.transactionHash,
          amountOut: BigInt(quote.toAmount),
          gasCost,
        };
      } else {
        logger.error(`Transaction failed: ${txHash}`);
        return { success: false, error: 'Transaction reverted' };
      }

    } catch (error: any) {
      logger.error({ error }, 'Trade execution failed');
      return { success: false, error: error.message || 'Unknown error' };
    }
  }

  private async ensureApproved(tokenAddress: string, amount: bigint): Promise<boolean> {
    try {
      const allowanceUrl = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/approve/allowance`;
      const allowanceRes = await axios.get(allowanceUrl, {
        params: { tokenAddress, walletAddress: this.account.address },
        headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
        timeout: 8000,
      });

      const allowance = BigInt(allowanceRes.data.allowance || '0');
      if (allowance >= amount) return true;

      logger.info(`Approving ${tokenAddress.slice(0, 8)}... for 1inch`);
      const approveUrl = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/approve/transaction`;
      const approveRes = await axios.get(approveUrl, {
        params: { tokenAddress, amount: amount.toString() },
        headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
        timeout: 8000,
      });

      const approveTx = approveRes.data;
      const txHash = await this.walletClient.sendTransaction({
        account: this.account,
        to: approveTx.to as `0x${string}`,
        data: approveTx.data as `0x${string}`,
        value: 0n,
        chain: arbitrum,
      });

      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      logger.info(`Token approved: ${txHash}`);
      return true;

    } catch (error: any) {
      logger.error({ error: error.response?.data || error.message }, 'Token approval failed');
      return false;
    }
  }

  private async get1InchQuote(params: TradeParams): Promise<any> {
    try {
      const url = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/quote`;
      const response = await axios.get(url, {
        params: {
          src: params.tokenIn,
          dst: params.tokenOut,
          amount: params.amountIn.toString(),
        },
        headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
        timeout: 10000,
      });
      return response.data;
    } catch (error: any) {
      logger.error({ error: error.response?.data || error.message }, '1inch quote failed');
      return null;
    }
  }

  private async build1InchSwap(params: TradeParams): Promise<any> {
    try {
      const url = `${config.apis.oneInch.baseUrl}/${config.apis.oneInch.chainId}/swap`;
      const response = await axios.get(url, {
        params: {
          src: params.tokenIn,
          dst: params.tokenOut,
          amount: params.amountIn.toString(),
          from: this.account.address,
          slippage: params.slippagePct,
          disableEstimate: true,
        },
        headers: { 'Authorization': `Bearer ${config.apis.oneInch.apiKey}` },
        timeout: 10000,
      });
      return response.data.tx;
    } catch (error: any) {
      logger.error({ error: error.response?.data || error.message }, '1inch swap build failed');
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
