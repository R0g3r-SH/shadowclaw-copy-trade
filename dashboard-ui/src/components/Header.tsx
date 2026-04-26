import { useUptime } from '../hooks/useUptime'
import type { DashState } from '../types'
import type { StatusData } from '../hooks/useAPI'

type Props = {
  state: DashState
  statusData?: StatusData | null
  onToggleBot?: () => void
  botToggling?: boolean
}

export function Header({ state: s, statusData, onToggleBot, botToggling }: Props) {
  const uptime = useUptime()

  return (
    <header
      className="panel rounded flex items-center justify-between px-5"
      style={{
        flexShrink: 0, height: 44,
        background: 'linear-gradient(rgba(8,8,26,.97), rgba(8,8,26,.97)) padding-box, linear-gradient(90deg, rgba(0,212,255,.4) 0%, rgba(204,51,255,.2) 50%, rgba(0,212,255,.15) 100%) border-box',
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-4">
        <h1
          style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 14, fontWeight: 900, letterSpacing: '0.3em', color: '#00d4ff', animation: 'glitch 14s infinite' }}
          className="glow-i"
        >
          COPY<span style={{ color: '#cc33ff' }}>TRADER</span>
          <span style={{ color: 'rgba(0,212,255,.3)', fontSize: 9, marginLeft: 8, letterSpacing: '4px', fontWeight: 400 }}>ARB v2</span>
        </h1>
        <div style={{ width: 1, height: 16, background: 'rgba(0,212,255,.2)' }} />
        <span style={{ fontSize: 9, letterSpacing: '3px', color: 'rgba(180,200,255,.3)' }}>
          MAINNET · HYBRID MODE
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-1.5">
        <Chip label="UPTIME"  val={uptime}                  color="rgba(0,212,255,.9)" />
        <Chip label="BLK"     val={s.blk.toLocaleString()}  color="#00ff9f" glow="glow-g" />
        <Chip label="SIG"     val={String(s.sig)}           color="rgba(0,255,159,.7)" />
        <Chip label="TRADES"  val={String(s.trd)}           color="#00d4ff" glow="glow-i" />
        <Chip label="TOKENS"  val={(s.inTok+s.outTok).toLocaleString()} color="#cc33ff" glow="glow-v" />
        <BotToggle paused={statusData?.bot_paused ?? false} loading={botToggling ?? false} onToggle={onToggleBot} />
        <ConnDot connected={s.connected} />
      </div>
    </header>
  )
}

function Chip({ label, val, color, glow = '' }: { label: string; val: string; color: string; glow?: string }) {
  return (
    <div className="chip">
      <span className="chip-label">{label}</span>
      <span className={`chip-val ${glow}`} style={{ color }}>{val}</span>
    </div>
  )
}

function ConnDot({ connected }: { connected: boolean }) {
  const c = connected ? '#00ff9f' : '#ff2d55'
  return (
    <div className="chip" style={{ gap: 8 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}`, animation: 'pulse 1.8s infinite', color: c, flexShrink: 0 }} />
      <span className={`chip-val ${connected ? 'glow-g' : 'glow-r'}`} style={{ color: c, fontSize: 10 }}>
        {connected ? 'LIVE' : 'OFFLINE'}
      </span>
    </div>
  )
}

function BotToggle({ paused, loading, onToggle }: { paused: boolean; loading: boolean; onToggle?: () => void }) {
  const color  = paused ? '#00ff9f' : '#ff2d55'
  const label  = loading ? '...' : paused ? '▶ START' : '■ STOP'
  const shadow = paused ? '0 0 8px rgba(0,255,159,.5)' : '0 0 8px rgba(255,45,85,.5)'
  return (
    <button
      onClick={onToggle}
      disabled={loading}
      style={{
        fontFamily: 'Orbitron, sans-serif',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '1.5px',
        color,
        background: 'transparent',
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: '3px 8px',
        cursor: loading ? 'default' : 'pointer',
        boxShadow: shadow,
        opacity: loading ? 0.6 : 1,
        transition: 'all .2s',
      }}
    >
      {label}
    </button>
  )
}
