import { Doughnut } from 'react-chartjs-2'
import { Chart as ChartJS, ArcElement } from 'chart.js'
import { Panel } from './Panel'

ChartJS.register(ArcElement)

type Props = { buyC: number; sellC: number }

export function SignalsChart({ buyC, sellC }: Props) {
  const total = buyC + sellC
  const buyPct = total ? Math.round((buyC / total) * 100) : 50

  return (
    <Panel className="p-3">
      <div className="sec">◈ BUY vs SELL</div>
      <div className="flex items-center justify-center gap-6" style={{ height: 'calc(100% - 32px)' }}>

        {/* Donut */}
        <div style={{ position: 'relative', width: 110, height: 110, flexShrink: 0 }}>
          <Doughnut
            data={{
              datasets: [{
                data: [buyC || 1, sellC || 0],
                backgroundColor: ['rgba(0,255,159,.8)', 'rgba(204,51,255,.8)'],
                borderColor: ['#00ff9f', '#cc33ff'],
                borderWidth: 2,
                hoverOffset: 4,
              }],
            }}
            options={{
              responsive: true,
              maintainAspectRatio: true,
              cutout: '65%',
              animation: { duration: 400 },
              plugins: { legend: { display: false }, tooltip: { enabled: false } },
            }}
          />
          {/* Center % */}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="glow-g" style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 14, fontWeight: 700, color: '#00ff9f', lineHeight: 1 }}>
              {buyPct}%
            </span>
            <span style={{ fontSize: 8, color: 'rgba(0,255,159,.4)', letterSpacing: '1px' }}>BUY</span>
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <StatRow color="#00ff9f" glow="glow-g" label="BUY" count={buyC} />
          <StatRow color="#cc33ff" glow="glow-v" label="SELL" count={sellC} />
          <div style={{ borderTop: '1px solid rgba(0,255,159,.08)', paddingTop: 8 }}>
            <div style={{ fontSize: 9, color: 'rgba(0,255,159,.4)', letterSpacing: '1px' }}>TOTAL</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'rgba(0,255,159,.7)', fontFamily: 'JetBrains Mono, monospace' }}>{total}</div>
          </div>
        </div>
      </div>
    </Panel>
  )
}

function StatRow({ color, glow, label, count }: { color: string; glow: string; label: string; count: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
      <span style={{ fontSize: 9, color: 'rgba(0,255,159,.5)', letterSpacing: '1px', width: 28 }}>{label}</span>
      <span className={glow} style={{ fontSize: 15, fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace' }}>{count}</span>
    </div>
  )
}
