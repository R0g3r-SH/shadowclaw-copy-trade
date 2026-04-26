import {
  createPublicClient,
  webSocket,
  type PublicClient,
  type Transaction,
  decodeAbiParameters,
  parseAbiParameters,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { TradeOrchestrator, type TradeSignal } from '../orchestrator';
import { logger } from '../utils/logger';
import { config, ROUTERS, SWAP_SELECTORS } from '../config';
import { DatabaseService } from '../services/database';
import type { WalletDiscoveryService } from '../discovery/wallet-discovery';
import { dash } from '../dashboard/events';

export class WebSocketMonitor {
  private client: PublicClient | null = null;
  private isRunning = false;
  private isConnecting = false; // prevent concurrent reconnects
  private paused = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private trackedWallets: Set<string> = new Set();
  private discovery: WalletDiscoveryService | null = null;

  constructor(
    private orchestrator: TradeOrchestrator,
    private db: DatabaseService
  ) {}

  setDiscovery(discovery: WalletDiscoveryService): void {
    this.discovery = discovery;
  }

  pause(): void  { this.paused = true;  logger.info('Bot paused — trade monitoring suspended'); }
  resume(): void { this.paused = false; logger.info('Bot resumed — trade monitoring active'); }

  async start(): Promise<void> {
    this.isRunning = true;

    // Load tracked wallets from database
    await this.loadTrackedWallets();

    logger.info(`Tracking ${this.trackedWallets.size} wallets`);

    // Connect to WebSocket
    await this.connect();
  }

  private async loadTrackedWallets(): Promise<void> {
    const wallets = await this.db.getActiveWallets();
    this.trackedWallets = new Set(
      wallets.map(w => w.address.toLowerCase())
    );

    logger.info(`Loaded ${this.trackedWallets.size} tracked wallets`);
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) return; // already in progress
    this.isConnecting = true;
    try {
      logger.info('Connecting to Alchemy WebSocket...');

      this.client = createPublicClient({
        chain: arbitrum,
        transport: webSocket(config.blockchain.alchemy.rpcUrl, {
          keepAlive: true,
          reconnect: {
            attempts: this.maxReconnectAttempts,
            delay: 1000,
          },
        }),
      });

      // Arbitrum usa secuenciador centralizado: sin mempool tradicional.
      // watchBlocks con includeTransactions es más confiable (~250ms por bloque).
      this.client.watchBlocks({
        includeTransactions: true,
        onBlock: async (block) => {
          if (!block.transactions || block.transactions.length === 0) return;
          dash.emit('block', { number: block.number?.toString(), txCount: block.transactions.length });
          const txs = block.transactions.filter(
            (tx): tx is NonNullable<typeof tx> & Transaction => typeof tx === 'object' && tx !== null && 'input' in tx
          ) as Transaction[];
          await this.processBlockTransactions(txs);
        },
        onError: (error) => {
          logger.error({ error }, 'WebSocket error');
          this.handleReconnect();
        },
      });

      logger.info('✅ WebSocket conectado — monitoreando bloques de Arbitrum');
      this.reconnectAttempts = 0;

    } catch (error) {
      logger.error({ error }, 'Failed to connect to WebSocket');
      await this.handleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  private async handleReconnect(): Promise<void> {
    if (!this.isRunning) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached, stopping monitor');
      this.isRunning = false;
      // Critical: notify user the WebSocket died
      try {
        const { TelegramBot } = await import('../services/telegram');
        const { config } = await import('../config');
        const t = new TelegramBot(config.telegram.botToken, config.telegram.chatId);
        await t.start();
        await t.send('🚨 *CRÍTICO: WebSocket desconectado*\n\nEl monitor de Arbitrum se cayó después de 10 intentos.\nReinicia el bot: `docker compose restart agent`', { parse_mode: 'Markdown' });
      } catch (e) { logger.error(e, 'Could not send WebSocket death alert'); }
      return;
    }

    const delay = Math.min(this.reconnectAttempts * 1000, 30000);
    logger.warn(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    await new Promise(resolve => setTimeout(resolve, delay));
    await this.connect();
  }

  private async processBlockTransactions(txs: Transaction[]): Promise<void> {
    if (this.paused) return;
    await Promise.all(
      txs.map(tx => this.processTransaction(tx).catch(err => {
        logger.error({ hash: tx.hash, err }, 'Error processing tx');
      }))
    );
  }

  private async processTransaction(tx: Transaction): Promise<void> {
    try {
      // Filter 1: Is it to a known DEX router?
      if (!this.isDexTransaction(tx.to)) {
        return;
      }

      // Organic discovery: observe every wallet that trades on DEXes (before tracked filter)
      if (this.discovery && !this.isTrackedWallet(tx.from)) {
        this.discovery.observeSwap(tx.from).catch(() => {});
        return; // Not tracked yet — observe only, don't copy
      }

      // Filter 2: Is it from a tracked wallet?
      if (!this.isTrackedWallet(tx.from)) {
        return;
      }

      // Filter 3: Is it a swap function?
      const swapDetails = this.decodeSwap(tx);
      if (!swapDetails) {
        return;
      }

      // Tokens base (ETH/stables) — used to detect buy vs sell direction
      const STABLE_TOKENS = new Set([
        '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
        '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
        '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
        '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
        '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
      ]);

      // Blue-chip defensive tokens — skip BUY signals (not alpha, just DCA)
      // Sells from these are still copied (stop-loss / position close)
      const SKIP_BUY_TOKENS = new Set([
        '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC — defensive BTC DCA
      ]);

      const tokenIn  = swapDetails.tokenIn.toLowerCase();
      const tokenOut = swapDetails.tokenOut.toLowerCase();

      const isSell = STABLE_TOKENS.has(tokenOut);
      const isBuy  = STABLE_TOKENS.has(tokenIn) || (!STABLE_TOKENS.has(tokenIn) && !STABLE_TOKENS.has(tokenOut));

      // Skip boring blue-chip BUY signals — not the alpha we're looking for
      if (isBuy && SKIP_BUY_TOKENS.has(tokenOut)) {
        logger.debug(`Skipping blue-chip DCA: ${tokenOut.slice(0, 8)}... from ${tx.from.slice(0, 8)}...`);
        dash.emit('log', { severity: 'info', message: `⏭ SKIP DCA defensivo (WBTC) — ${tx.from.slice(0, 10)}…` });
        return;
      }

      const signal: TradeSignal = {
        txHash: tx.hash,
        walletAddress: tx.from.toLowerCase(),
        tokenIn,
        tokenOut,
        amountIn: swapDetails.amountIn,
        dex: this.getDexName(tx.to!),
        timestamp: new Date(),
        isSell,
      };

      logger.info(`${isSell ? '📤 SELL' : '📥 BUY'} detected from ${signal.walletAddress.slice(0, 8)}...`);
      logger.info(`   ${tokenIn.slice(0, 8)}... → ${tokenOut.slice(0, 8)}...`);
      dash.emit('signal', { type: isSell ? 'sell' : 'buy', wallet: signal.walletAddress, tokenOut, dex: signal.dex });

      if (isSell) {
        await this.orchestrator.handleSellSignal(signal);
      } else if (isBuy) {
        await this.orchestrator.handleTradeSignal(signal);
      }

    } catch (error) {
      logger.debug({ hash: tx.hash, error }, 'Skipped transaction');
    }
  }

  private isTrackedWallet(address: string | undefined): boolean {
    if (!address) return false;
    return this.trackedWallets.has(address.toLowerCase());
  }

  private isDexTransaction(to: string | null | undefined): boolean {
    if (!to) return false;
    const toLower = to.toLowerCase();
    return Object.values(ROUTERS).some(router => router.toLowerCase() === toLower);
  }

  private getDexName(to: string): string {
    const toLower = to.toLowerCase();
    if (toLower === ROUTERS.uniswapV3.toLowerCase())    return 'Uniswap V3';
    if (toLower === ROUTERS.swapRouter02.toLowerCase()) return 'Uniswap V3';
    if (toLower === ROUTERS.sushiswap.toLowerCase())    return 'SushiSwap';
    if (toLower === ROUTERS.oneInch.toLowerCase())      return '1inch';
    if (toLower === ROUTERS.camelot.toLowerCase())      return 'Camelot';
    if (toLower === ROUTERS.paraswap.toLowerCase())     return 'Paraswap';
    if (toLower === ROUTERS.odos.toLowerCase())         return 'Odos';
    if (toLower === ROUTERS.balancer.toLowerCase())     return 'Balancer';
    if (toLower === ROUTERS.traderJoe.toLowerCase())    return 'TraderJoe';
    if (toLower === ROUTERS.ramses.toLowerCase())       return 'Ramses';
    return 'Unknown DEX';
  }

  private decodeSwap(tx: Transaction): { tokenIn: string; tokenOut: string; amountIn: bigint } | null {
    if (!tx.input || tx.input.length < 10) return null;
    return this.decodeBySelector(tx.input.slice(0, 10), tx.input, tx.to ?? '', tx.value);
  }

  private decodeBySelector(selector: string, input: string, txTo: string, value: bigint | undefined): { tokenIn: string; tokenOut: string; amountIn: bigint } | null {
    try {
      switch (selector) {
        case SWAP_SELECTORS.exactInputSingle:        return this.decodeExactInputSingle(input, txTo);
        case SWAP_SELECTORS.exactInput:              return this.decodeExactInput(input, txTo);
        case SWAP_SELECTORS.swapExactTokensForTokens:return this.decodeSwapExactTokens(input);
        case SWAP_SELECTORS.swapExactETHForTokens:   return this.decodeSwapExactETH(input, value);
        case SWAP_SELECTORS.multicall:               return this.decodeMulticall(input, txTo, value);
        case SWAP_SELECTORS.multicallWithDeadline:   return this.decodeMulticallWithDeadline(input, txTo, value);
        case SWAP_SELECTORS.oneInchSwap:             return this.decode1inchSwap(input);
        default: return null;
      }
    } catch {
      return null;
    }
  }

  private decodeMulticall(input: string, txTo: string, value: bigint | undefined): { tokenIn: string; tokenOut: string; amountIn: bigint } | null {
    try {
      const params = `0x${input.slice(10)}` as `0x${string}`;
      const [calls] = decodeAbiParameters(parseAbiParameters('bytes[]'), params);
      for (const call of calls as `0x${string}`[]) {
        const c = call as string;
        if (c.length < 10) continue;
        const result = this.decodeBySelector(c.slice(0, 10), c, txTo, value);
        if (result) return result;
      }
      return null;
    } catch { return null; }
  }

  private decodeMulticallWithDeadline(input: string, txTo: string, value: bigint | undefined): { tokenIn: string; tokenOut: string; amountIn: bigint } | null {
    try {
      const params = `0x${input.slice(10)}` as `0x${string}`;
      const [, calls] = decodeAbiParameters(parseAbiParameters('uint256, bytes[]'), params);
      for (const call of calls as `0x${string}`[]) {
        const c = call as string;
        if (c.length < 10) continue;
        const result = this.decodeBySelector(c.slice(0, 10), c, txTo, value);
        if (result) return result;
      }
      return null;
    } catch { return null; }
  }

  private decode1inchSwap(input: string): { tokenIn: string; tokenOut: string; amountIn: bigint } | null {
    try {
      const params = `0x${input.slice(10)}` as `0x${string}`;
      const decoded = decodeAbiParameters(
        parseAbiParameters('address, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags), bytes, bytes'),
        params
      );
      const desc = decoded[1] as any;
      return { tokenIn: desc.srcToken, tokenOut: desc.dstToken, amountIn: desc.amount };
    } catch { return null; }
  }

  private decodeExactInputSingle(input: string, txTo: string): {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
  } | null {
    try {
      const params = `0x${input.slice(10)}` as `0x${string}`;
      const isOldRouter = txTo.toLowerCase() === ROUTERS.uniswapV3.toLowerCase();

      if (isOldRouter) {
        // SwapRouter viejo: struct incluye deadline entre recipient y amountIn
        const decoded = decodeAbiParameters(
          parseAbiParameters('(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)'),
          params
        );
        const [p] = decoded;
        return { tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn };
      } else {
        // SwapRouter02: sin deadline
        const decoded = decodeAbiParameters(
          parseAbiParameters('(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)'),
          params
        );
        const [p] = decoded;
        return { tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn };
      }
    } catch (error) {
      return null;
    }
  }

  private decodeExactInput(input: string, txTo: string): {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
  } | null {
    try {
      const params = `0x${input.slice(10)}` as `0x${string}`;
      const isOldRouter = txTo.toLowerCase() === ROUTERS.uniswapV3.toLowerCase();

      let path: `0x${string}`;
      let amountIn: bigint;

      if (isOldRouter) {
        // SwapRouter viejo: (bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)
        const decoded = decodeAbiParameters(
          parseAbiParameters('bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum'),
          params
        );
        path = decoded[0] as `0x${string}`;
        amountIn = decoded[3];
      } else {
        // SwapRouter02: (bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)
        const decoded = decodeAbiParameters(
          parseAbiParameters('bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum'),
          params
        );
        path = decoded[0] as `0x${string}`;
        amountIn = decoded[2];
      }

      // Path encoding: tokenA(20 bytes) + fee(3 bytes) + tokenB(20 bytes) + ...
      // Strip 0x, cada token = 40 hex chars, cada fee = 6 hex chars
      const pathHex = (path as string).slice(2);
      if (pathHex.length < 86) return null; // mínimo tokenA(40) + fee(6) + tokenB(40)

      const tokenIn = `0x${pathHex.slice(0, 40)}`;
      const tokenOut = `0x${pathHex.slice(pathHex.length - 40)}`;

      return { tokenIn, tokenOut, amountIn };
    } catch (error) {
      return null;
    }
  }

  private decodeSwapExactTokens(input: string): {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
  } | null {
    try {
      const params = `0x${input.slice(10)}` as `0x${string}`;

      // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
      const decoded = decodeAbiParameters(
        parseAbiParameters('uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline'),
        params
      );

      const [amountIn, , path] = decoded;

      if (path.length < 2) return null;

      return {
        tokenIn: path[0],
        tokenOut: path[path.length - 1],
        amountIn,
      };
    } catch (error) {
      return null;
    }
  }

  private decodeSwapExactETH(input: string, value: bigint | undefined): {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
  } | null {
    try {
      const params = `0x${input.slice(10)}` as `0x${string}`;

      // swapExactETHForTokens(uint256,address[],address,uint256)
      const decoded = decodeAbiParameters(
        parseAbiParameters('uint256 amountOutMin, address[] path, address to, uint256 deadline'),
        params
      );

      const [, path] = decoded;

      if (path.length < 2 || !value) return null;

      // First token should be WETH
      const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'; // Arbitrum WETH

      return {
        tokenIn: WETH,
        tokenOut: path[path.length - 1],
        amountIn: value,
      };
    } catch (error) {
      return null;
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.client) {
      // Viem will automatically close WebSocket connection
      this.client = null;
    }

    logger.info('WebSocket monitor stopped');
  }

  // Reload tracked wallets (call this when wallets are added/removed)
  async reloadWallets(): Promise<void> {
    await this.loadTrackedWallets();
    logger.info(`Reloaded tracked wallets: ${this.trackedWallets.size} active`);
  }
}
