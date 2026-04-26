import { useReducer, useCallback, useRef } from 'react'
import { useSSE } from './hooks/useSSE'
import { useStatus, usePortfolio, useWallets, useTrades, useBotToggle } from './hooks/useAPI'
import { Header } from './components/Header'
import { Panel } from './components/Panel'
import { KPIBar } from './components/KPIBar'
import { SystemPanel } from './components/SystemPanel'
import { ClaudePanel } from './components/ClaudePanel'
import { BlocksChart } from './components/BlocksChart'
import { SignalsChart } from './components/SignalsChart'
import { WalletsPanel } from './components/WalletsPanel'
import { TradesPanel } from './components/TradesPanel'
import { Feed } from './components/Feed'
import type { DashState, FeedItem } from './types'

const MAX_FEED = 80

type FeedState = { sigFeed: FeedItem[]; logFeed: FeedItem[] }
type FeedAction = { feed: 'sig' | 'log'; item: Omit<FeedItem, 'id'> }

let feedId = 0

function feedReducer(state: FeedState, action: FeedAction): FeedState {
  const item: FeedItem = { ...action.item, id: ++feedId }
  if (action.feed === 'sig') return { ...state, sigFeed: [item, ...state.sigFeed].slice(0, MAX_FEED) }
  return { ...state, logFeed: [item, ...state.logFeed].slice(0, MAX_FEED) }
}

const initState: DashState = {
  blk: 0, sig: 0, trd: 0, inTok: 0, outTok: 0, calls: 0,
  buyC: 0, sellC: 0, connected: false, tradeReload: 0,
}

function now() { return new Date().toLocaleTimeString('es-MX', { hour12: false }) }
function bdg(cls: string, label: string) { return `<span class="bdg bdg-${cls}">${label}</span>` }
function ts(html: string) { return `<span style="color:rgba(0,255,159,.55);margin-right:6px;font-size:10px">${now()}</span>${html}` }

export default function App() {
  const [feeds, dispatchFeed] = useReducer(feedReducer, { sigFeed: [], logFeed: [] })
  const sRef = useRef<DashState>(initState)
  const [, tick] = useReducer(x => x + 1, 0)

  function set(patch: Partial<DashState>) {
    sRef.current = { ...sRef.current, ...patch }
    tick()
  }

  const addFeed = useCallback((feed: 'sig' | 'log', cls: string, html: string) => {
    dispatchFeed({ feed, item: { ts: now(), cls, html: ts(html) } })
  }, [])

  const onConnect    = useCallback(() => { set({ connected: true });  addFeed('log', 'fi-log', 'Dashboard conectado — SSE activo') }, [addFeed])
  const onDisconnect = useCallback(() => set({ connected: false }), [])

  const onEvent = useCallback((e: { type: string; data: unknown }) => {
    const d = e.data as Record<string, unknown>
    const s = sRef.current

    switch (e.type) {
      case 'block':
        set({ blk: s.blk + 1 })
        // bloques solo actualizan el contador — no se meten al feed (4 bloques/seg = feed que salta)
        break

      case 'signal': {
        const buy = d.type === 'buy'
        set({ sig: s.sig + 1, buyC: buy ? s.buyC + 1 : s.buyC, sellC: buy ? s.sellC : s.sellC + 1 })
        const wallet = (d.wallet as string) ?? ''
        const tokenOut = (d.tokenOut as string) ?? ''
        const sigLbl = buy ? 'SIG ↑' : 'SIG ↓'
        const sigCls = buy ? 'sig-buy' : 'sig-sell'
        addFeed('sig', buy ? 'fi-buy' : 'fi-sell',
          `${bdg(sigCls, sigLbl)} <span style="color:rgba(0,255,159,.5)">${wallet.slice(0,8)}...</span> <span style="color:rgba(0,255,159,.2)">→</span> ${tokenOut.slice(0,8)}... <span style="color:rgba(0,255,159,.25);font-size:9px">${d.dex}</span><span style="color:rgba(180,200,255,.3);font-size:9px;margin-left:6px">· detectado</span>`)
        addFeed('log', 'fi-log', `Señal ${buy ? '↑' : '↓'} detectada — ${wallet.slice(0,10)} en ${d.dex}`)
        break
      }

      case 'trade':
        if (d.action === 'executed') {
          set({ trd: s.trd + 1, tradeReload: s.tradeReload + 1 })
          const usd = parseFloat((d.amountUsd as string) || '0').toFixed(2)
          addFeed('sig', 'fi-exec', `${bdg('exec','EXEC')} <span style="color:#ffd60a">$${usd}</span> · <span style="color:rgba(0,255,159,.5)">${d.source || ''}</span>`)
          addFeed('log', 'fi-trade', `✓ Trade ejecutado $${usd}`)
        } else if (d.action === 'skipped') {
          addFeed('sig', 'fi-skip', `${bdg('skip','SKIP')} ${d.reason || 'descartado'}`)
        }
        break

      case 'tokens': {
        const inp = (d.input as number) || 0
        const out = (d.output as number) || 0
        set({ inTok: s.inTok + inp, outTok: s.outTok + out, calls: s.calls + 1 })
        addFeed('log', 'fi-claude',
          `${bdg('claude','CLAUDE')} <span style="color:rgba(191,0,255,.8)">${d.source || 'unknown'}</span> · in:${inp.toLocaleString()} out:${out.toLocaleString()}`)
        break
      }

      case 'log': {
        const sev = d.severity as string
        const cls = sev === 'error' ? 'fi-error' : sev === 'warning' ? 'fi-warn'
                  : sev === 'trade' ? 'fi-trade' : sev === 'claude' ? 'fi-claude' : 'fi-log'
        addFeed('log', cls, d.message as string)
        break
      }
    }
  }, [addFeed])

  useSSE(onEvent as Parameters<typeof useSSE>[0], onConnect, onDisconnect)

  const { data: statusData, reload: reloadStatus } = useStatus()
  const { toggle: toggleBot, loading: botToggling } = useBotToggle(reloadStatus)
  const { data: portfolio }  = usePortfolio()
  const wallets = useWallets()
  const trades  = useTrades(sRef.current.tradeReload)
  const s = sRef.current

  return (
    <div className="flex flex-col h-screen gap-1.5 p-2" style={{ zIndex: 1, position: 'relative' }}>

      {/* HEADER */}
      <Header state={s} statusData={statusData} onToggleBot={toggleBot} botToggling={botToggling} />

      {/* KPI BAR */}
      <KPIBar portfolio={portfolio} status={statusData} />

      {/* ROW 1: Sistema | Live Feed | Claude AI */}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: '190px 1fr 215px', flexShrink: 0, height: 195 }}>
        <SystemPanel data={statusData} />
        <Panel className="p-3">
          <div className="sec" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>◈ Live Feed</span>
            <span style={{ fontSize: 8, letterSpacing: '1px', color: 'rgba(180,200,255,.35)', fontWeight: 400 }}>
              SIG = detectado &nbsp;·&nbsp; EXEC = bot ejecutó
            </span>
          </div>
          <Feed items={feeds.sigFeed} style={{ height: 'calc(100% - 36px)' }} />
        </Panel>
        <ClaudePanel state={s} />
      </div>

      {/* ROW 2: Bloques | BUY/SELL | Wallets */}
      <div className="grid grid-cols-3 gap-1.5" style={{ flexShrink: 0, height: 155 }}>
        <BlocksChart blockCount={s.blk} />
        <SignalsChart buyC={s.buyC} sellC={s.sellC} />
        <WalletsPanel wallets={wallets} />
      </div>

      {/* ROW 3: Trades | Logs */}
      <div className="grid grid-cols-2 gap-1.5 flex-1 min-h-0">
        <TradesPanel trades={trades} />
        <Panel className="p-3">
          <div className="sec">◈ System Logs</div>
          <Feed items={feeds.logFeed} style={{ height: 'calc(100% - 36px)' }} />
        </Panel>
      </div>

    </div>
  )
}
