import { useEffect, useRef, useCallback } from 'react'

export type SSEEvent = {
  type: 'block' | 'signal' | 'trade' | 'tokens' | 'log' | 'status'
  data: unknown
}

export function useSSE(
  onEvent: (e: SSEEvent) => void,
  onConnect: () => void,
  onDisconnect: () => void
) {
  const esRef = useRef<EventSource | null>(null)
  const onEventRef = useRef(onEvent)
  const onConnectRef = useRef(onConnect)
  const onDisconnectRef = useRef(onDisconnect)

  useEffect(() => { onEventRef.current = onEvent }, [onEvent])
  useEffect(() => { onConnectRef.current = onConnect }, [onConnect])
  useEffect(() => { onDisconnectRef.current = onDisconnect }, [onDisconnect])

  const connect = useCallback(() => {
    const es = new EventSource('/events')
    esRef.current = es

    es.onopen = () => onConnectRef.current()
    es.onerror = () => {
      onDisconnectRef.current()
      es.close()
      setTimeout(connect, 3000)
    }

    const events: SSEEvent['type'][] = ['block', 'signal', 'trade', 'tokens', 'log', 'status']
    events.forEach(type => {
      es.addEventListener(type, (e: MessageEvent) => {
        try {
          onEventRef.current({ type, data: JSON.parse(e.data) })
        } catch { /* ignore bad JSON */ }
      })
    })
  }, [])

  useEffect(() => {
    connect()
    return () => esRef.current?.close()
  }, [connect])
}
