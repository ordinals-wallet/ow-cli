import type { RuneEdict } from '@ow-cli/api'

export function buildSplitEdicts(
  runeId: string,
  totalAmount: string,
  splits: number,
  divisibility: number,
  address: string,
): RuneEdict[] {
  const total = BigInt(Math.round(parseFloat(totalAmount) * Math.pow(10, divisibility)))
  const perSplit = total / BigInt(splits)
  const remainder = total - perSplit * BigInt(splits)

  const edicts: RuneEdict[] = []
  for (let i = 0; i < splits; i++) {
    const amt = i === splits - 1 ? perSplit + remainder : perSplit
    edicts.push({
      rune_id: runeId,
      amount: amt.toString(),
      divisibility,
      destination: address,
    })
  }
  return edicts
}
