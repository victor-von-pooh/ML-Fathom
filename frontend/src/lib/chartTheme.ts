import type * as echarts from 'echarts'

/** CSS の変数の値 (グラフの色を画面の色にそろえる) */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 系列の色 (固定の順) */
export function seriesColors(): string[] {
  return Array.from({ length: 8 }, (_, index) => cssVar(`--series-${index + 1}`))
}

/** 軸と文字の色をそろえた, グラフの共通の設定 */
export function baseOption(): echarts.EChartsOption {
  const text = cssVar('--text-2')
  const line = cssVar('--border')
  return {
    color: seriesColors(),
    textStyle: { color: text, fontFamily: 'inherit' },
    grid: { left: 48, right: 16, top: 24, bottom: 36, containLabel: true },
    tooltip: { trigger: 'axis', confine: true },
    xAxis: { axisLine: { lineStyle: { color: line } }, splitLine: { show: false } },
    yAxis: { axisLine: { lineStyle: { color: line } }, splitLine: { lineStyle: { color: line } } },
  }
}
