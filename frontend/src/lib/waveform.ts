/** 波形の図の大きさ (viewBox の単位) */
export const WAVE = { width: 1000, height: 160 }

/**
 * 区間ごとの振幅の最小と最大 (-1 から 1) を, 上を最大, 下を最小でつないだ閉じた道筋にする.
 * 1 を超える値は図の端に収める
 */
export function waveformPath(low: number[], high: number[]): string {
  const count = Math.min(low.length, high.length)
  if (count === 0) return ''
  const middle = WAVE.height / 2
  const step = WAVE.width / count
  const y = (value: number) => middle - Math.max(-1, Math.min(1, value)) * middle
  const top: string[] = []
  const bottom: string[] = []
  for (let at = 0; at < count; at++) {
    // 区間の中ほどに置き, 最小と最大が同じでも線が見えるよう少し広げる
    const x = ((at + 0.5) * step).toFixed(1)
    const upper = y(high[at]!)
    const lower = y(low[at]!)
    const gap = Math.max(0, 1 - (lower - upper)) / 2
    top.push(`${x} ${(upper - gap).toFixed(1)}`)
    bottom.push(`${x} ${(lower + gap).toFixed(1)}`)
  }
  return `M ${top.join(' L ')} L ${bottom.reverse().join(' L ')} Z`
}

/** 秒を, 60 秒未満は「1.25 秒」, それ以上は「2 分 5 秒」の形にする */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–'
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} 秒`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`
}
