export type FeedItem = {
  id: number
  ts: string
  cls: string
  html: string
}

export type DashState = {
  blk: number
  sig: number
  trd: number
  inTok: number
  outTok: number
  calls: number
  buyC: number
  sellC: number
  connected: boolean
  tradeReload: number
}
