export function buildTapPayload(ticker: string, amount: string): string {
  return JSON.stringify({ p: 'tap', op: 'token-transfer', tick: ticker, amt: amount })
}
