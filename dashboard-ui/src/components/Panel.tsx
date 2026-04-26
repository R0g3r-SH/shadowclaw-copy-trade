type PanelProps = {
  children: React.ReactNode
  variant?: 'default' | 'v' | 'i' | 'gold'
  className?: string
  style?: React.CSSProperties
}

export function Panel({ children, variant = 'default', className = '', style }: PanelProps) {
  const cls = variant === 'v' ? 'panel panel-v' : variant === 'i' ? 'panel panel-i' : variant === 'gold' ? 'panel panel-gold' : 'panel'
  return (
    <div className={`${cls} rounded ${className}`} style={style}>
      <span className="corner c-tl" />
      <span className="corner c-tr" />
      <span className="corner c-bl" />
      <span className="corner c-br" />
      {children}
    </div>
  )
}
