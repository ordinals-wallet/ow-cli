export function buildBrc20Payload(ticker: string, amount: string): string {
  return JSON.stringify({ p: 'brc-20', op: 'transfer', tick: ticker, amt: amount })
}

export function splitAmount(total: string, splits: number): string[] {
  const totalNum = parseFloat(total)
  const perSplit = Math.floor((totalNum / splits) * 1e8) / 1e8
  const amounts: string[] = []
  let remaining = totalNum
  for (let i = 0; i < splits - 1; i++) {
    amounts.push(String(perSplit))
    remaining -= perSplit
  }
  amounts.push(String(Math.round(remaining * 1e8) / 1e8))
  return amounts
}
