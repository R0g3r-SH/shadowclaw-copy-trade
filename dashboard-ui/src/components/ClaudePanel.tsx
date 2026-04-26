import { Doughnut } from 'react-chartjs-2'
import { Chart as ChartJS, ArcElement, Tooltip } from 'chart.js'
import { Panel } from './Panel'
import { useLLMStats } from '../hooks/useAPI'
import type { DashState } from '../types'

ChartJS.register(ArcElement, Tooltip)

type Props = { state: DashState }

const SOURCE_COLORS: Record<string, string> = {
  'trade-agent':    '#00d4ff',
  'conversation':   '#cc33ff',
  'discovery-agent-decide': '#00ff9f',
  'discovery-agent':'#ffd60a',
  'portfolio-agent':'#ff6b35',
}

function shortSource(src: string): string {
  if (src.startsWith('trade-agent'))    return 'TRADE'
  if (src.startsWith('conversation'))   return 'CONV'
  if (src === 'discovery-agent-decide') return 'DISC-LLM'
  if (src.startsWith('discovery'))      return 'DISC'
  if (src.startsWith('portfolio'))      return 'PORT'
  return src.slice(0, 8).toUpperCase()
}

function color(src: string): string {
  return SOURCE_COLORS[src] ?? 'rgba(180,200,255,.6)'
}

export function ClaudePanel({ state: s }: Props) {
  const { data: stats } = useLLMStats(30000)

  const dbIn    = stats?.totals?.total_input  ?? 0
  const dbOut   = stats?.totals?.total_output ?? 0
  const dbCalls = stats?.totals?.total_calls  ?? 0
  const dbTotal = dbIn + dbOut

  // Cost estimate (claude-sonnet pricing)
  const cost = (dbIn / 1e6 * 3) + (dbOut / 1e6 * 15)

  const sources = stats?.by_source ?? []
  const chartData = sources.length > 0 ? sources : [{ source: 'idle', total_input: 1, total_output: 0 }]

  return (
    <Panel variant="v" className="p-3" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="sec sec-v">◈ Claude AI · 24h</div>

      {/* Tokens totales */}
      <div style={{ textAlign: 'center', marginBottom: 2 }}>
        <div className="glow-v" style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 20, fontWeight: 700, color: '#cc33ff', lineHeight: 1 }}>
          {dbTotal > 0 ? dbTotal.toLocaleString() : s.inTok + s.outTok > 0 ? (s.inTok + s.outTok).toLocaleString() : '—'}
        </div>
        <div style={{ fontSize: 8, color: 'rgba(204,51,255,.4)', letterSpacing: '2px', marginTop: 2 }}>TOKENS · 24h</div>
      </div>

      {/* Stats row */}
      <div className="sr"><span className="sk">LLAMADAS</span><span className="sv glow-g">{dbCalls || s.calls}</span></div>
      <div className="sr">
        <span className="sk">IN</span>
        <span style={{ color: '#00d4ff', fontSize: 10, fontWeight: 600 }}>{(dbIn || s.inTok).toLocaleString()}</span>
      </div>
      <div className="sr">
        <span className="sk">OUT</span>
        <span style={{ color: '#cc33ff', fontSize: 10, fontWeight: 600 }}>{(dbOut || s.outTok).toLocaleString()}</span>
      </div>
      <div className="sr">
        <span className="sk">COSTO</span>
        <span className="glow-gold" style={{ color: '#ffd60a', fontSize: 11, fontWeight: 700 }}>${cost.toFixed(4)}</span>
      </div>

      {/* Por fuente */}
      {sources.length > 0 && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 7, letterSpacing: '2px', color: 'rgba(180,200,255,.3)', marginBottom: 2 }}>POR AGENTE</div>
          {sources.slice(0, 4).map(s => {
            const total = s.total_input + s.total_output
            const pct   = dbTotal > 0 ? Math.round(total / dbTotal * 100) : 0
            return (
              <div key={s.source} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 7, color: color(s.source), width: 50, flexShrink: 0, letterSpacing: '0.5px' }}>
                  {shortSource(s.source)}
                </span>
                <div style={{ flex: 1, height: 3, background: 'rgba(255,255,255,.06)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: color(s.source), borderRadius: 2 }} />
                </div>
                <span style={{ fontSize: 7, color: 'rgba(180,200,255,.4)', width: 22, textAlign: 'right' }}>{pct}%</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Doughnut chart */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, paddingTop: 4 }}>
        <div style={{ width: 60, height: 60, overflow: 'visible' }}>
          <Doughnut
            data={{
              datasets: [{
                data: chartData.map(s => s.total_input + s.total_output),
                backgroundColor: chartData.map(s => color(s.source) + 'bb'),
                borderColor:     chartData.map(s => color(s.source)),
                borderWidth: 1.5,
              }],
            }}
            options={{
              responsive: false,
              maintainAspectRatio: false,
              cutout: '62%',
              animation: { duration: 400 },
              plugins: { legend: { display: false }, tooltip: { enabled: false } },
            }}
            width={60}
            height={60}
          />
        </div>
      </div>
    </Panel>
  )
}
