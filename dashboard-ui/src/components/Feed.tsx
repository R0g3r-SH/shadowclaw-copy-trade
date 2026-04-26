import type { FeedItem } from '../types'

type Props = { items: FeedItem[]; style?: React.CSSProperties }

export function Feed({ items, style }: Props) {
  return (
    <div className="feed" style={style}>
      {items.length === 0 && (
        <div style={{ color: 'rgba(0,255,159,.25)', fontSize: 10, padding: '14px 8px', textAlign: 'center', letterSpacing: '2px' }}>
          ESPERANDO SEÑALES...
        </div>
      )}
      {items.map(item => (
        <div
          key={item.id}
          className={`fi ${item.cls}`}
          dangerouslySetInnerHTML={{ __html: item.html }}
        />
      ))}
    </div>
  )
}
