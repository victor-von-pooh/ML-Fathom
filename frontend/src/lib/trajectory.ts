import type { Histogram, TrajectoryEnd, TrajectorySummary } from '../api/types'

/** 区間に分けた値. 整数を 1 つの値ごとに分けた場合は, 区間の見出しを値にする */
export interface Binned extends Histogram {
  labels?: string[]
}

/** エピソードの終わり方の日本語の名前 (ML-EDA の describe_trajectory の ends) */
export const END_LABELS: Record<TrajectoryEnd, string> = {
  terminated: '終了',
  truncated: '打ち切り',
  stop: '守りで止めた',
  handover: '守りで引き継いだ',
  open: '終わりの印なし',
}

/** 終わり方の並び (ML-EDA の ends の順) */
export const END_ORDER: TrajectoryEnd[] = ['terminated', 'truncated', 'stop', 'handover', 'open']

/** 守りの結果の日本語の名前 (ML-Found の guard の値) */
export const GUARD_LABELS: Record<string, string> = {
  ok: 'そのまま通した',
  clipped: '範囲に収めた',
  fallback: '代わりの行動にした',
  stop: '止めた',
  handover: '引き継いだ',
  missing: '空',
}

/** 軌跡の出どころの日本語の名前 (ML-Found の説明の source) */
export const SOURCE_LABELS: Record<string, string> = {
  evaluation_loader: '評価の loader (学習中の検証)',
  evaluate_policy: '守り付きの評価',
}

/** 守りの結果を日本語にする (知らない結果は「その他」を添える) */
export function guardLabel(result: string): string {
  return GUARD_LABELS[result] ?? `その他 (${result})`
}

/** ヒストグラムの区間の数の上限 */
const MAX_BINS = 20

/**
 * 値の並びを, 同じ幅の区間に分けて数える (エピソードごとの長さと報酬の和の分布)
 *
 * 区間の数は値の数の平方根 (20 まで). 全て同じ値なら, ML-EDA の分析と同じく範囲を ±0.5 に広げる.
 * 値の範囲 (最大 - 最小 + 1) が 20 以下の整数は, 1 つの値を 1 つの区間にし, 見出しを値にする
 */
export function binValues(values: number[]): Binned | null {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return null
  let low = Math.min(...finite)
  let high = Math.max(...finite)
  let bins = Math.min(MAX_BINS, Math.max(1, Math.ceil(Math.sqrt(finite.length))))
  const integers = finite.every((value) => Number.isInteger(value))
  let labels: string[] | undefined
  if (integers && high - low + 1 <= MAX_BINS) {
    // 整数は値の真ん中に区間を置き, 見出しは値
    bins = high - low + 1
    labels = Array.from({ length: bins }, (_, index) => String(low + index))
    low -= 0.5
    high += 0.5
  } else if (low === high) {
    low -= 0.5
    high += 0.5
  }
  const width = (high - low) / bins
  const edges = Array.from({ length: bins + 1 }, (_, index) => low + width * index)
  const counts = new Array<number>(bins).fill(0)
  for (const value of finite) {
    const index = Math.min(bins - 1, Math.floor((value - low) / width))
    counts[index]! += 1
  }
  return labels ? { counts, edges, labels } : { counts, edges }
}

/** 書き出す分析のファイルの名前 (軌跡の名前から) */
export function analysisFileName(summary: TrajectorySummary): string {
  const base = summary.name.replace(/[\\/:*?"<>|]/g, '_') || 'trajectory'
  return `${base}.analysis.json`
}

/** 分析の結果を JSON のファイルとして保存させる */
export function downloadAnalysis(summary: TrajectorySummary): void {
  const blob = new Blob([`${JSON.stringify(summary, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = analysisFileName(summary)
  document.body.append(link)
  link.click()
  link.remove()
  // 保存が始まってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
