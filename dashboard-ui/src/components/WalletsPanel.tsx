import { Panel } from './Panel'
import type { WalletRow } from '../hooks/useAPI'

type Props = { wallets: WalletRow[] }

export function WalletsPanel({ wallets }: Props) {
  return (
    <Panel className="p-3">
      <div className="sec">◈ Wallets · <span style={{ color: '#00ff9f' }}>{wallets.length}</span></div>
      <div className="feed" style={{ height: 'calc(100% - 32px)' }}>
        {wallets.length === 0 && (
          <div style={{ color: 'rgba(0,255,159,.3)', fontSize: 10, padding: '12px 0', textAlign: 'center' }}>
            Cargando wallets...
          </div>
        )}
        {wallets.map((w, i) => {
          const sc = Math.round(w.score ?? 0)
          const rank = i + 1
          return (
            <div
              key={w.address}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 0', borderBottom: '1px solid rgba(0,255,159,.06)',
                fontSize: 11,
              }}
            >
              {/* Rank */}
              <span style={{ width: 16, color: 'rgba(0,255,159,.3)', fontSize: 9, flexShrink: 0, textAlign: 'right' }}>
                {rank}
              </span>
              {/* Address */}
              <span style={{ flex: 1, color: '#00ff9f', fontFamily: 'JetBrains Mono, monospace' }}>
                {w.address.slice(0, 6)}
                <span style={{ color: 'rgba(0,255,159,.4)' }}>…{w.address.slice(-4)}</span>
              </span>
              {/* Label */}
              {w.label && (
                <span style={{ color: 'rgba(0,255,159,.45)', fontSize: 9, maxWidth: 55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {w.label}
                </span>
              )}
              {/* Score */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span style={{ color: '#00d4ff', fontSize: 10, fontWeight: 600, width: 22, textAlign: 'right' }}>{sc}</span>
                <span className="sbar"><span className="sfill" style={{ width: `${sc}%` }} /></span>
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
