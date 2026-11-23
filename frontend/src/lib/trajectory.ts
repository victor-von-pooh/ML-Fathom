import type { Histogram, TrajectoryEnd, TrajectorySummary } from '../api/types'

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

/** ヒストグラムの区間の数の上限 */
const MAX_BINS = 20

/**
 * 値の並びを, 同じ幅の区間に分けて数える (エピソードごとの長さと報酬の和の分布)
 *
 * 区間の数は値の数の平方根 (20 まで). 全て同じ値なら, ML-EDA の分析と同じく範囲を ±0.5 に広げる.
 * 整数の値で異なる値が少なければ, 1 つの値を 1 つの区間にする
 */
export function binValues(values: number[]): Histogram | null {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return null
  let low = Math.min(...finite)
  let high = Math.max(...finite)
  let bins = Math.min(MAX_BINS, Math.max(1, Math.ceil(Math.sqrt(finite.length))))
  const integers = finite.every((value) => Number.isInteger(value))
  if (integers && high - low + 1 <= MAX_BINS) {
    // 整数は値の真ん中に区間を置く
    bins = high - low + 1
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
  return { counts, edges }
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
