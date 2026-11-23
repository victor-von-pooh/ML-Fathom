import type { EChartsOption } from 'echarts'

import type { Histogram, ValueCount } from '../api/types'
import { formatNumber } from './format'

/**
 * ヒストグラムの棒グラフの設定. values を渡すと, 区間の見出しを範囲でなくその値にして
 * 軸に出す (1 つの整数ごとの区間)
 */
export function histogramOption(
  histogram: Histogram,
  name: string,
  values?: string[],
): EChartsOption {
  const labels =
    values ??
    histogram.counts.map(
      (_, index) =>
        `${formatNumber(histogram.edges[index])} – ${formatNumber(histogram.edges[index + 1])}`,
    )
  return {
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, axisLabel: { show: values !== undefined }, name },
    yAxis: { type: 'value', name: '件数' },
    series: [{ type: 'bar', data: histogram.counts, barCategoryGap: '4%' }],
  }
}

/** 頻度の上位の横棒グラフの設定 */
export function countsOption(values: ValueCount[]): EChartsOption {
  const shown = [...values].reverse()
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value' },
    yAxis: {
      type: 'category',
      data: shown.map((item) => item.value),
      axisLabel: { width: 160, overflow: 'truncate' },
    },
    series: [{ type: 'bar', data: shown.map((item) => item.count) }],
  }
}
