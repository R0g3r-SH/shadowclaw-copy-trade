import { useState, useEffect, useRef } from 'react'

function pad(n: number) { return String(n).padStart(2, '0') }

export function useUptime() {
  const start = useRef(Date.now())
  const [uptime, setUptime] = useState('00:00:00')

  useEffect(() => {
    const id = setInterval(() => {
      const ms = Date.now() - start.current
      const h = Math.floor(ms / 3600000)
      const m = Math.floor((ms % 3600000) / 60000)
      const s = Math.floor((ms % 60000) / 1000)
      setUptime(`${pad(h)}:${pad(m)}:${pad(s)}`)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return uptime
}
