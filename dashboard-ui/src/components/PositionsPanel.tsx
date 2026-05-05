import { Panel } from './Panel'
import type { LivePosition } from '../hooks/useAPI'

type Props = { positions: LivePosition[] }

function pnlColor(pct: string) {
  if (pct === 'N/A') return 'rgba(0,212,255,.4)'
  return pct.startsWith('+') ? '#00ff9f' : '#ff2d55'
}

function trailingColor(trailing: string) {
  if (trailing.startsWith('activo')) return '#ffd60a'
  return 'rgba(0,255,159,.3)'
}

export function PositionsPanel({ positions }: Props) {
  return (
    <Panel variant="i" className="p-3">
      <div className="sec" style={{ color: 'rgba(0,255,159,.95)' }}>
        ◈ Posiciones Abiertas · <span style={{ color: '#00ff9f' }}>{positions.length}</span>
      </div>
      <div className="feed" style={{ height: 'calc(100% - 32px)' }}>
        {positions.length === 0 ? (
          <div style={{ color: 'rgba(0,255,159,.3)', fontSize: 11, padding: '20px 0', textAlign: 'center' }}>
            // sin posiciones abiertas
          </div>
        ) : positions.map((p) => {
          const trailingActive = p.trailing_stop.startsWith('activo')

          return (
            <div
              key={p.id}
              style={{
                padding: '7px 8px',
                borderBottom: '1px solid rgba(0,212,255,.08)',
                borderLeft: `2px solid ${trailingActive ? 'rgba(255,214,10,.5)' : 'rgba(0,255,159,.2)'}`,
                marginBottom: 3,
                borderRadius: 2,
              }}
            >
              {/* Row 1: token + entry + current PnL */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#00d4ff', fontSize: 11, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
                  {p.token.slice(0, 10)}...
                </span>
                <span style={{ color: 'rgba(0,212,255,.5)', fontSize: 10 }}>
                  ${p.entry_usd} → ${p.current_usd}
                </span>
                <span style={{ color: pnlColor(p.pnl_pct), fontSize: 13, fontWeight: 700, minWidth: 64, textAlign: 'right' }}>
                  {p.pnl_pct}
                </span>
              </div>

              {/* Row 2: wallet + 1h change + PnL USD */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                <span style={{ color: 'rgba(0,255,159,.45)', fontSize: 9 }}>
                  {p.wallet}
                </span>
                <span style={{ color: 'rgba(180,200,255,.5)', fontSize: 9 }}>
                  1h: {p.price_change_h1}
                </span>
                <span style={{ color: pnlColor(p.pnl_pct), fontSize: 10, fontWeight: 600 }}>
                  {p.pnl_usd} USD
                </span>
              </div>

              {/* Row 3: trailing stop status */}
              <div style={{ marginTop: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  color: trailingColor(p.trailing_stop),
                  fontSize: 9,
                  fontFamily: 'JetBrains Mono, monospace',
                }}>
                  {trailingActive ? '⚡' : '◌'} trailing: {p.trailing_stop.slice(0, 50)}
                </span>
                <span style={{ color: 'rgba(255,45,85,.5)', fontSize: 8 }}>
                  SL {p.sl_at}
                </span>
                <span style={{ color: 'rgba(0,255,159,.4)', fontSize: 8 }}>
                  TP {p.tp_at}
                </span>
              </div>

              {/* Row 4: open since */}
              <div style={{ marginTop: 2 }}>
                <span style={{ color: 'rgba(0,212,255,.25)', fontSize: 8 }}>
                  abierta: {p.open_since}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
