export function formatSats(sats: number | undefined | null): string {
  if (sats == null) return 'N/A'
  if (sats >= 1e8) {
    return `${(sats / 1e8).toFixed(8)} BTC`
  }
  return `${sats.toLocaleString()} sats`
}
