import type { ReactionCounts, ReactionsSummary } from '../api/types'
import { formatNumber } from './format'

/** 反応の数の区切りの見出し (1, 3–5, 101 以上) */
export function binLabel(bin: ReactionCounts['bins'][number]): string {
  if (bin.to === null) return `${bin.from} 以上`
  if (bin.from === bin.to) return String(bin.from)
  return `${bin.from}–${bin.to}`
}

/** 区切りごとの数を, 数の棒の値にする (少ない区切りから) */
export function binCounts(counts: ReactionCounts): { value: string; count: number }[] {
  return counts.bins.map((bin) => ({ value: binLabel(bin), count: bin.count }))
}

/** 時刻の値を短い文にする (日時は ISO 8601 の T を空白に) */
export function timeText(value: ReactionsSummary['time']['min']): string {
  if (value === null) return '–'
  if (typeof value === 'number') return formatNumber(value)
  return value.replace('T', ' ')
}

/** 時刻の種類の日本語の名前 */
export const TIME_KIND_LABELS: Record<ReactionsSummary['time']['kind'], string> = {
  number: '数',
  datetime: '日時',
}
