import { useState, useEffect, useCallback } from 'react'

export type StatusData = {
  mode: string
  wallets: number
  positions: string
  circuit_breaker: boolean
  pnl_today: string
  bot_paused: boolean
}

export type PortfolioData = {
  wallet:        string
  eth_balance:   string
  usdc_balance:  string
  total_pnl:     string
  total_trades:  number
  win_rate:      number
  profit_factor: string
}

export type WalletRow = { address: string; label: string; score: number }
export type TradeRow  = { token_out: string; position_size_usd: string; pnl: string; status: string; created_at: string }

function useFetch<T>(url: string, initial: T, refreshMs: number) {
  const [data, setData] = useState<T>(initial)
  const load = useCallback(async () => {
    try { setData(await (await fetch(url)).json()) } catch { /* ignore */ }
  }, [url])
  useEffect(() => { load(); const id = setInterval(load, refreshMs); return () => clearInterval(id) }, [load, refreshMs])
  return { data, reload: load }
}

export function useStatus(refreshMs = 20000)    { return useFetch<StatusData | null>('/api/status', null, refreshMs) }

export type DiscoveryData = {
  uptime: string
  ultima_busqueda: string
  proxima_busqueda: string
  tiempo_para_proxima: string
  busquedas_completadas: number
  active_wallets: number
  retired_wallets: number
  smart_money_wallets: number
  organic_wallets: number
  pending_promotion: number
}

export type LLMStats = {
  by_source: Array<{ source: string; total_input: number; total_output: number; calls: number }>
  totals: { total_input: number; total_output: number; total_calls: number } | null
}

export function useDiscovery(refreshMs = 30000) { return useFetch<DiscoveryData | null>('/api/discovery', null, refreshMs) }
export function useLLMStats(refreshMs = 60000)   { return useFetch<LLMStats | null>('/api/llm-stats', null, refreshMs) }

export function useBotToggle(onSuccess: () => void) {
  const [loading, setLoading] = useState(false)
  const toggle = useCallback(async () => {
    setLoading(true)
    try { await fetch('/api/bot/toggle', { method: 'POST' }); onSuccess() }
    catch { /* ignore */ }
    finally { setLoading(false) }
  }, [onSuccess])
  return { toggle, loading }
}
export function usePortfolio(refreshMs = 30000) { return useFetch<PortfolioData | null>('/api/portfolio', null, refreshMs) }

export function useWallets(refreshMs = 30000) {
  const [wallets, setWallets] = useState<WalletRow[]>([])
  const load = useCallback(async () => {
    try { setWallets((await (await fetch('/api/wallets')).json()).wallets ?? []) } catch { /* ignore */ }
  }, [])
  useEffect(() => { load(); const id = setInterval(load, refreshMs); return () => clearInterval(id) }, [load, refreshMs])
  return wallets
}

export function useTrades(trigger: number) {
  const [trades, setTrades] = useState<TradeRow[]>([])
  useEffect(() => {
    fetch('/api/trades').then(r => r.json()).then(d => setTrades(d.trades ?? [])).catch(() => {})
  }, [trigger])
  return trades
}
