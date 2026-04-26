import { Panel } from './Panel'
import type { StatusData } from '../hooks/useAPI'
import { useDiscovery, useLLMStats } from '../hooks/useAPI'

type Props = { data: StatusData | null }

export function SystemPanel({ data }: Props) {
  const cb = data?.circuit_breaker ?? false
  const { data: disc } = useDiscovery()
  const { data: llm }  = useLLMStats()

  const totalTok = llm?.totals
    ? ((llm.totals.total_input ?? 0) + (llm.totals.total_output ?? 0)).toLocaleString()
    : '--'

  return (
    <Panel className="p-3" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div className="sec">⬡ Sistema</div>

      <Row label="MODO">
        <span className="sv" style={{ fontFamily: 'Orbitron, sans-serif', fontSize: 11 }}>
          {(data?.mode ?? '--').toUpperCase()}
        </span>
      </Row>
      <Row label="WALLETS">
        <span className="sv glow-g">
          {disc
            ? `${disc.active_wallets} activas`
            : `${data?.wallets ?? '--'}`}
        </span>
      </Row>
      {disc && disc.smart_money_wallets > 0 && (
        <Row label="SMART-MONEY">
          <span style={{ color: '#ffd60a', fontSize: 10, fontWeight: 700 }}>
            🎯 {disc.smart_money_wallets}
          </span>
        </Row>
      )}
      <Row label="POSICIONES">
        <span className="sv">{data?.positions ?? '--'}</span>
      </Row>
      <Row label="CIRCUIT BKR">
        <span
          className={cb ? 'glow-r' : 'glow-g'}
          style={{ color: cb ? '#ff2d55' : '#00ff9f', fontSize: 11, fontWeight: 700 }}
        >
          {cb ? '⚠ ACTIVO' : '✓ OK'}
        </span>
      </Row>

      {/* Discovery schedule */}
      <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(0,212,255,.07)' }}>
        <div style={{ fontSize: 8, color: 'rgba(0,212,255,.35)', letterSpacing: '2px', marginBottom: 3 }}>DISCOVERY</div>
        <Row label="PRÓXIMA">
          <span style={{ color: 'rgba(0,212,255,.6)', fontSize: 9 }}>
            {disc?.tiempo_para_proxima ?? '--'}
          </span>
        </Row>
        <Row label="CICLOS">
          <span style={{ color: 'rgba(0,255,159,.55)', fontSize: 9 }}>
            {disc?.busquedas_completadas ?? '--'}
          </span>
        </Row>
        {(disc?.pending_promotion ?? 0) > 0 && (
          <Row label="EN COLA">
            <span style={{ color: '#ffd60a', fontSize: 9 }}>
              {disc!.pending_promotion} wallets
            </span>
          </Row>
        )}
      </div>

      {/* LLM usage today */}
      <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(204,51,255,.1)' }}>
        <div style={{ fontSize: 8, color: 'rgba(204,51,255,.4)', letterSpacing: '2px', marginBottom: 3 }}>LLM HOY</div>
        <Row label="TOKENS">
          <span style={{ color: 'rgba(204,51,255,.7)', fontSize: 9 }}>{totalTok}</span>
        </Row>
        {llm?.totals && (
          <Row label="LLAMADAS">
            <span style={{ color: 'rgba(204,51,255,.55)', fontSize: 9 }}>
              {llm.totals.total_calls ?? '--'}
            </span>
          </Row>
        )}
      </div>
    </Panel>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sr">
      <span className="sk">{label}</span>
      {children}
    </div>
  )
}
