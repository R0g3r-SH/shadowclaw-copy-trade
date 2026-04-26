import { Panel } from './Panel'
import type { TradeRow } from '../hooks/useAPI'

type Props = { trades: TradeRow[] }

export function TradesPanel({ trades }: Props) {
  return (
    <Panel variant="i" className="p-3">
      <div className="sec" style={{ color: 'rgba(0,212,255,.95)' }}>
        ◈ Trades Ejecutados · <span style={{ color: '#00d4ff' }}>{trades.length}</span>
      </div>
      <div className="feed" style={{ height: 'calc(100% - 32px)' }}>
        {trades.length === 0 ? (
          <div style={{ color: 'rgba(0,255,159,.3)', fontSize: 11, padding: '20px 0', textAlign: 'center' }}>
            // sin trades aún
          </div>
        ) : trades.map((t, i) => {
          const pnl = parseFloat(t.pnl ?? '0')
          const usd = parseFloat(t.position_size_usd ?? '0')
          const pnlUp = pnl >= 0

          return (
            <div
              key={i}
              style={{
                padding: '6px 8px',
                borderBottom: '1px solid rgba(0,212,255,.08)',
                background: i % 2 === 0 ? 'rgba(0,212,255,.02)' : 'transparent',
                borderRadius: 2,
                marginBottom: 2,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#00d4ff', fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>
                  {t.token_out?.slice(0, 14) ?? '--'}
                </span>
                <span style={{ color: '#ffd60a', fontSize: 11, fontWeight: 700 }}>
                  ${usd.toFixed(2)}
                </span>
                <span
                  className={pnlUp ? 'glow-g' : 'glow-r'}
                  style={{ color: pnlUp ? '#00ff9f' : '#ff2d55', fontSize: 12, fontWeight: 700, minWidth: 60, textAlign: 'right' }}
                >
                  {pnlUp ? '+' : ''}{pnl.toFixed(4)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                <span style={{ color: 'rgba(0,212,255,.45)', fontSize: 9 }}>
                  {new Date(t.created_at).toLocaleTimeString('es-MX')}
                </span>
                <span style={{
                  fontSize: 8, fontWeight: 700, letterSpacing: '1px', padding: '1px 5px', borderRadius: 2,
                  background: t.status === 'closed' ? 'rgba(0,255,159,.1)' : 'rgba(255,214,10,.1)',
                  color: t.status === 'closed' ? '#00ff9f' : '#ffd60a',
                  border: `1px solid ${t.status === 'closed' ? 'rgba(0,255,159,.2)' : 'rgba(255,214,10,.2)'}`,
                }}>
                  {t.status?.toUpperCase()}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
