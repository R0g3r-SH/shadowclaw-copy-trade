# 🚀 Setup Guide - Copy Trading Agent

Complete step-by-step guide to get your copy trading agent running.

---

## ⚡ Quick Setup (15 minutes)

### Step 1: Create Telegram Bot (5 min)

1. Open Telegram and search for **@BotFather**
2. Send: `/newbot`
3. Choose a name: `My Copy Trading Bot`
4. Choose a username: `my_copy_bot` (must be unique)
5. **Copy the token** you receive (looks like: `123456:ABC-DEF1234...`)

6. Now search for **@userinfobot**
7. Send any message to it
8. **Copy your chat_id** (looks like: `123456789`)

✅ You now have your `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`

---

### Step 2: Get Alchemy API Key (3 min)

1. Go to https://www.alchemy.com
2. Sign up for free account
3. Create new app:
   - Chain: **Arbitrum**
   - Network: **Mainnet**
4. **Copy your API key**

✅ You now have your `ALCHEMY_API_KEY`

---

### Step 3: Configure Environment (2 min)

```bash
cd /Users/roger/Documents/sideAgent

# Copy template
cp .env.example .env

# Edit with your values
nano .env
```

**Fill in these values:**

```bash
# Telegram (from Step 1)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...  # From BotFather
TELEGRAM_CHAT_ID=123456789            # From userinfobot

# Alchemy (from Step 2)
ALCHEMY_API_KEY=your_key_here

# Wallet (we'll do this next)
PRIVATE_KEY=0x...
BOT_ADDRESS=0x...
```

---

### Step 4: Setup Wallet (5 min)

**Option A: Use Existing Wallet**

If you have a wallet with some ETH on Arbitrum:

1. Export private key from MetaMask:
   - Open MetaMask
   - Click ⋮ → Account details → Export Private Key
   - Enter password
   - **Copy private key**

2. Add to `.env`:
```bash
PRIVATE_KEY=0x_your_private_key_here
BOT_ADDRESS=0x_your_wallet_address_here
```

**Option B: Create New Wallet** (Recommended for testing)

```bash
# Generate new wallet
npm install
npm run generate-wallet  # TODO: Add this script
```

**Important:** 
- Keep private key SECRET
- Fund wallet with ~0.01 ETH on Arbitrum for gas
- Start with small amounts for testing

---

### Step 5: Add Wallets to Track (2 min)

Find profitable wallets to copy:

**Option A: Use Examples** (for testing)

```bash
# Edit db/init.sql
nano db/init.sql

# Replace example addresses with real ones:
INSERT INTO wallets (address, label, status, score) VALUES
('0x_REAL_WALLET_1', 'Smart Trader 1', 'active', 85.0),
('0x_REAL_WALLET_2', 'Smart Trader 2', 'active', 80.0);
```

**Option B: Find Wallets** (recommended)

- Use Nansen: https://nansen.ai
- Look for "Smart Money" wallets
- Check performance metrics
- Add top performers

**Option C: Add Later**

```bash
# After system is running, add wallets with:
npm run add-wallet 0x1234... "Whale Trader" 85
```

---

### Step 6: Install & Start (5 min)

```bash
# Install dependencies
npm install

# Build project
npm run build

# Test Telegram connection
npm run test-telegram

# Start with Docker
docker-compose up -d

# View logs
docker-compose logs -f agent
```

**You should see:**
```
🚀 Starting Copy Trading Agent...
Mode: HYBRID
✅ Database connected
✅ Redis connected
✅ Telegram bot started
✅ WebSocket monitor started
✨ System is ready!
```

**And receive in Telegram:**
```
🤖 Copy Trading Agent Started

Mode: HYBRID
Ready to copy trades! 🚀
```

---

## ✅ Verification Checklist

- [ ] Telegram bot sends test message
- [ ] Approval buttons work in Telegram
- [ ] Docker containers running (`docker ps`)
- [ ] Database accessible (`npm run db:shell`)
- [ ] Agent logs show "System is ready"
- [ ] At least 1 wallet added to track

---

## 🎮 Testing the System

### Test 1: Telegram Notifications

```bash
npm run test-telegram
```

Check Telegram for messages with buttons.

### Test 2: Check Database

```bash
npm run db:shell

# In PostgreSQL:
SELECT * FROM wallets;
SELECT * FROM system_events ORDER BY created_at DESC LIMIT 5;
\q
```

### Test 3: Manual Trade Simulation

```bash
# TODO: Add simulation script
npm run simulate-trade
```

---

## 🔧 Troubleshooting

### Telegram bot not responding

```bash
# Check token and chat_id
echo $TELEGRAM_BOT_TOKEN
echo $TELEGRAM_CHAT_ID

# Test manually
npm run test-telegram
```

### Database connection failed

```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# Restart database
docker-compose restart postgres

# Check logs
docker-compose logs postgres
```

### Agent crashes on startup

```bash
# Check environment variables
cat .env

# Validate .env has all required values
grep -E "ALCHEMY|TELEGRAM|PRIVATE" .env

# Check logs for specific error
docker-compose logs agent
```

### WebSocket not connecting

```bash
# Verify Alchemy API key
curl "https://arb-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Should return block number
```

---

## 🎯 Next Steps

Once system is running:

1. **Monitor for 24 hours** with small capital ($500)
2. **Verify safety checks** work (check logs for blocked tokens)
3. **Test approval flow** when risky trade detected
4. **Review trades** in database

```bash
# Check recent activity
npm run db:shell
SELECT * FROM copied_trades ORDER BY created_at DESC LIMIT 10;
```

5. **Scale up** if everything works well

---

## 📊 Monitoring

### Daily

- Check Telegram for trade notifications
- Review P&L: `SELECT SUM(pnl) FROM copied_trades WHERE created_at > NOW() - INTERVAL '24 hours';`

### Weekly

- Analyze wallet performance
- Adjust scores for underperforming wallets
- Add new wallets if needed

### As Needed

```bash
# View logs
docker-compose logs -f agent

# Restart agent
docker-compose restart agent

# Stop everything
docker-compose down

# Rebuild after code changes
docker-compose up -d --build
```

---

## 🆘 Support

If you encounter issues:

1. Check logs: `docker-compose logs agent`
2. Verify .env configuration
3. Test components individually (Telegram, Database, WebSocket)
4. Check GitHub issues (if open-sourced)

---

## 🎉 Success!

Once you see:
- ✅ Telegram notifications working
- ✅ Database tracking trades
- ✅ WebSocket monitoring active
- ✅ Safety checks running

**You're ready to start copy trading!** 🚀

Start with:
- Small capital ($500-1k)
- Conservative mode (claude-code or hybrid)
- 1-2 proven wallets
- Monitor closely first week

Then scale up gradually as you gain confidence.
