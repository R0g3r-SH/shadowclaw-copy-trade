import { Panel } from './Panel'
import type { PortfolioData, StatusData } from '../hooks/useAPI'

type Props = { portfolio: PortfolioData | null; status: StatusData | null }

export function KPIBar({ portfolio: p, status: s }: Props) {
  const pnlToday  = parseFloat(s?.pnl_today ?? '0')
  const pnlTotal  = parseFloat(p?.total_pnl ?? '0')
  const winRate   = p?.win_rate ?? 0

  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(5,1fr)', flexShrink: 0, height: 74 }}>

      {/* ETH Balance */}
      <Panel variant="i" className="">
        <div className="kpi">
          <div className="kpi-label" style={{ color: 'rgba(0,212,255,.5)' }}>ETH Balance</div>
          <div className="kpi-val glow-i" style={{ fontSize: 20, color: '#00d4ff' }}>
            {p?.eth_balance ?? '--'}
          </div>
          <div className="kpi-sub" style={{ color: 'rgba(0,212,255,.4)' }}>ARBITRUM ONE</div>
        </div>
      </Panel>

      {/* USDC Balance */}
      <Panel className="">
        <div className="kpi">
          <div className="kpi-label" style={{ color: 'rgba(0,255,159,.5)' }}>USDC Balance</div>
          <div className="kpi-val glow-g" style={{ fontSize: 20, color: '#00ff9f' }}>
            ${p?.usdc_balance ?? '--'}
          </div>
          <div className="kpi-sub" style={{ color: 'rgba(0,255,159,.4)' }}>DISPONIBLE</div>
        </div>
      </Panel>

      {/* P&L Hoy */}
      <Panel className="">
        <div className="kpi">
          <div className="kpi-label" style={{ color: 'rgba(180,200,255,.4)' }}>P&amp;L Hoy</div>
          <div
            className={`kpi-val ${pnlToday >= 0 ? 'glow-g' : 'glow-r'}`}
            style={{ fontSize: 20, color: pnlToday >= 0 ? '#00ff9f' : '#ff2d55' }}
          >
            {pnlToday >= 0 ? '+' : ''}{pnlToday.toFixed(2)}<span style={{ fontSize: 11, marginLeft: 3 }}>$</span>
          </div>
          <div className="kpi-sub">{s?.positions ?? '--'} posiciones</div>
        </div>
      </Panel>

      {/* P&L Total */}
      <Panel className="">
        <div className="kpi">
          <div className="kpi-label" style={{ color: 'rgba(180,200,255,.4)' }}>P&amp;L Total</div>
          <div
            className={`kpi-val ${pnlTotal >= 0 ? 'glow-g' : 'glow-r'}`}
            style={{ fontSize: 20, color: pnlTotal >= 0 ? '#00ff9f' : '#ff2d55' }}
          >
            {pnlTotal >= 0 ? '+' : ''}{pnlTotal.toFixed(2)}<span style={{ fontSize: 11, marginLeft: 3 }}>$</span>
          </div>
          <div className="kpi-sub">{p?.total_trades ?? '0'} trades · PF {p?.profit_factor ?? '0'}</div>
        </div>
      </Panel>

      {/* Win Rate */}
      <Panel variant="gold" className="">
        <div className="kpi">
          <div className="kpi-label" style={{ color: 'rgba(255,214,10,.5)' }}>Win Rate</div>
          <div className="kpi-val glow-gold" style={{ fontSize: 20, color: '#ffd60a' }}>
            {winRate}<span style={{ fontSize: 14, marginLeft: 1 }}>%</span>
          </div>
          <WinBar pct={winRate} />
        </div>
      </Panel>

    </div>
  )
}

function WinBar({ pct }: { pct: number }) {
  return (
    <div style={{ width: '100%', height: 3, background: 'rgba(255,214,10,.1)', borderRadius: 2, marginTop: 4 }}>
      <div style={{
        width: `${pct}%`, height: '100%',
        background: 'linear-gradient(90deg, #ff6b00, #ffd60a)',
        borderRadius: 2, boxShadow: '0 0 6px rgba(255,214,10,.5)',
        transition: 'width .6s ease',
      }} />
    </div>
  )
}
