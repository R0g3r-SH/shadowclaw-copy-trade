import { useEffect, useRef, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { Chart as ChartJS, LineElement, PointElement, LinearScale, CategoryScale, Filler } from 'chart.js'
import { Panel } from './Panel'

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Filler)

type Props = { blockCount: number }

export function BlocksChart({ blockCount }: Props) {
  const [history, setHistory] = useState<number[]>(Array(40).fill(0))
  const last = useRef({ count: 0, ts: Date.now() })

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      const rate = (blockCount - last.current.count) / ((now - last.current.ts) / 1000)
      last.current = { count: blockCount, ts: now }
      setHistory(h => [...h.slice(1), Math.round(rate * 10) / 10])
    }, 2000)
    return () => clearInterval(id)
  }, [blockCount])

  return (
    <Panel className="p-3">
      <div className="sec">◈ Bloques / seg</div>
      <div style={{ height: 'calc(100% - 32px)' }}>
        <Line
          data={{
            labels: Array(40).fill(''),
            datasets: [{
              data: history,
              borderColor: '#00ff9f',
              borderWidth: 1.5,
              pointRadius: 0,
              fill: true,
              backgroundColor: (ctx: any) => {
                const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height)
                g.addColorStop(0, 'rgba(0,255,159,.35)')
                g.addColorStop(1, 'rgba(0,255,159,0)')
                return g
              },
              tension: 0.4,
            }],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 200 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
              x: { display: false },
              y: {
                display: true,
                min: 0,
                grid: { color: 'rgba(0,255,159,.05)' },
                ticks: { color: 'rgba(0,255,159,.45)', maxTicksLimit: 3, font: { family: 'JetBrains Mono', size: 9 } },
                border: { display: false },
              },
            },
          }}
        />
      </div>
    </Panel>
  )
}
