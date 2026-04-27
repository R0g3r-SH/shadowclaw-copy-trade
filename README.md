# 🤖 ARB Copy Trader — AI-Powered On-Chain Copy Trading Bot

An autonomous copy trading bot for **Arbitrum** that monitors smart money wallets in real time, analyzes each trade with Claude AI, and executes copy trades with full LLM-driven decision making.

---

## Architecture

```
Arbitrum Blocks (250ms/block)
         │
         ▼
  WebSocketMonitor          ← watchBlocks via Alchemy WS
  ├─ 10 DEX routers        ← Uniswap V3, 1inch, Camelot, Paraswap, Odos, Balancer…
  ├─ 8 swap decoders       ← exactInputSingle, multicall, 1inch swap, V2…
  ├─ Buy/Sell detection    ← stable-in = buy, stable-out = sell, token→token = buy
  └─ Organic discovery     ← observes untracked wallets, auto-adds at 15 swaps
         │
         ▼
  TradeOrchestrator
  ├─ Circuit breaker       ← daily -10%, hourly -5% P&L limits
  ├─ Max positions guard   ← 5 concurrent max
  ├─ TokenSafetyChecker    ← GoPlus API + DEXScreener liquidity
  └─ Max position size     ← 20% of ETH balance cap
         │
         ▼
  HybridDecisionEngine
  └─ AgentService (Claude)
     ├─ check_token_safety
     ├─ get_wallet_history
     ├─ get_dex_metrics
     ├─ get_portfolio_status
     ├─ execute_trade        ← agent auto-executes
     ├─ request_approval     ← sends to Telegram, waits 5min
     └─ skip_trade           ← agent rejects
         │
         ▼
  TradeExecutor (1inch API)
  ├─ Token approval check
  ├─ Quote + slippage
  └─ Submit → Alchemy RPC
         │
         ▼
  PositionMonitor (every 5min)
  ├─ Stop-loss: -10%
  └─ Take-profit: +30%
```

---

## Wallet Discovery

Two parallel sources feed the wallet portfolio, managed by a **DiscoveryAgent (Claude)**:

| Source | Method | Signal |
|--------|--------|--------|
| **Arbiscan** | Last 1000 txs per DEX router, every 2h | High-frequency traders, multi-DEX users |
| **Smart Money** | DEXScreener top gainers (+40% 24h) → early buyers | Bought *before* the pump |
| **Organic** | Live WebSocket observation | 15 swaps on monitored routers → auto-add |

The DiscoveryAgent uses a `discovery_decision` tool to add up to 3 wallets per cycle and retire underperformers. Portfolio capped at 20 wallets.

**Performance review every 6h:** Adjusts wallet scores based on win rate + P&L. Retires wallets with score ≤ 38 after ≥ 3 real trades.

---

## Decision Modes

| Mode | Behavior |
|------|----------|
| `hybrid` | Agent decides: auto-execute if confident + safe, request approval if uncertain |
| `claude-code` | Always sends to Telegram for approval — never auto-executes |
| `openclaw` | Full autonomy — agent executes everything it believes in |

Set via `AUTONOMY_MODE` environment variable.

---

## LLM Usage Tracking

Every Claude call is tracked by source in `system_events` and exposed via `/api/llm-stats`:

| Agent | Source tag | Triggered by |
|-------|-----------|-------------|
| Trade agent | `trade-agent (turn N)` | Every BUY/SELL signal |
| Conversation | `conversation (turn N)` | Telegram messages |
| Discovery decide | `discovery-agent-decide` | Every 2h discovery cycle |
| Discovery query | `discovery-agent` | Discovery Q&A via Telegram |
| Portfolio query | `portfolio-agent` | Portfolio Q&A via Telegram |

---

## Dashboard

React + Vite + Tailwind dashboard at port 3001:

- **Header:** Uptime, blocks, signals, trades, tokens, BOT STOP/START toggle
- **KPI Bar:** ETH balance, USDC balance, daily P&L, total P&L, win rate
- **Live Feed:** Real-time signal stream (`SIG ↑` = detected, `EXEC` = bot executed)
- **Claude AI Panel:** 24h token usage, cost estimate, per-agent breakdown with bars
- **System Logs:** Full pipeline observability — safety checks, agent decisions, approvals

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript |
| Blockchain | viem (WebSocket + RPC on Arbitrum) |
| AI | Claude Sonnet 4.6 via Azure AI Foundry |
| Swap routing | 1inch API v6 |
| Token safety | GoPlus API + DEXScreener |
| Wallet discovery | Arbiscan API |
| Database | PostgreSQL 16 |
| Cache / State | Redis 7 |
| Notifications | Telegram Bot API |
| Dashboard | React + Vite + Tailwind v4 + Chart.js |
| Infrastructure | Docker + docker-compose |

---

## Setup

### 1. Clone and configure

```bash
git clone <repo> && cd <repo>
cp .env.example .env   # fill in all required values
```

Required environment variables:

```env
# LLM API KEYs

# Arbitrum
ALCHEMY_API_KEY=
PRIVATE_KEY=0x...
BOT_ADDRESS=0x...

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# External APIs
ARBISCAN_API_KEY=
ONEINCH_API_KEY=

# Trading config
AUTONOMY_MODE=hybrid        # claude-code | hybrid | openclaw
MAX_POSITIONS=5
DAILY_LOSS_LIMIT=0.10
```

### 2. Launch

```bash
docker-compose up -d
```

Dashboard available at **http://localhost:3001**.

### 3. Operate

```bash
docker logs copy-trading-agent -f        # tail logs
docker-compose restart agent             # deploy changes
docker-compose down                      # stop everything
```

---

## Telegram Interface

The bot responds to natural language in Spanish:

| Message | Action |
|---------|--------|
| `qué pasó?` | Full system status + portfolio |
| `cuántas wallets seguimos?` | Wallet list with scores |
| `dispara discovery` | Run wallet discovery now |
| `pausa 60 minutos` | Activate circuit breaker |
| `cuánto hemos gastado en Claude hoy?` | LLM usage stats |

---

## Risk Controls

| Control | Default |
|---------|---------|
| Daily loss limit | -10% → circuit breaker |
| Hourly loss limit | -5% → circuit breaker (30min) |
| Max concurrent positions | 5 |
| Max single position | 20% of ETH balance |
| Stop-loss per position | -10% |
| Take-profit per position | +30% |
| Hard safety block | Honeypot + zero liquidity only |
| Blue-chip filter | Skips WBTC defensive DCA signals |

---

## Project Structure

```
src/
├── index.ts                   # Bootstrap + graceful shutdown
├── orchestrator.ts            # Trade signal router
├── config/index.ts            # Config + DEX router + selector constants
├── monitors/
│   ├── websocket.ts           # Alchemy WS block monitor + swap decoder
│   └── position-monitor.ts   # SL/TP checker (every 5min)
├── decision/
│   └── hybrid-engine.ts      # Routes to agent, handles approval flow
├── agent/
│   ├── agent-service.ts      # Claude agent loop (max 6 turns)
│   └── tools.ts              # 7 tool definitions
├── agents/
│   ├── discovery-agent.ts    # Portfolio add/retire decisions
│   └── portfolio-agent.ts    # Portfolio Q&A
├── safety/
│   └── token-safety.ts       # GoPlus + DEXScreener safety checker
├── execution/
│   └── trade-executor.ts     # 1inch swap executor
├── discovery/
│   └── wallet-discovery.ts   # Arbiscan + smart money + organic
├── services/
│   ├── database.ts
│   ├── redis.ts
│   ├── telegram.ts
│   └── conversation.ts       # Telegram NLP handler
├── dashboard/
│   ├── server.ts             # HTTP + SSE + REST API server
│   └── events.ts             # EventEmitter singleton
└── utils/
    ├── claude-client.ts      # Azure Foundry wrapper + LLM tracking
    ├── dexscreener.ts        # Market data
    └── logger.ts

dashboard-ui/                  # React + Vite frontend
```
# -shadowclaw-copy-trade
