import type { EChartsOption } from 'echarts'
import { useState } from 'react'

import type { Profile } from '../../api/types'
import { Card, EmptyState } from '../../components/ui'
import { Chart } from '../../lib/chart'
import { cssVar } from '../../lib/chartTheme'
import { TASK_LABELS } from '../../lib/format'
import { countsOption } from '../../lib/charts'
import { Link2 } from 'lucide-react'

/** 正方行列のヒートマップの設定 (-1 から 1 か 0 から 1) */
function heatmapOption(
  names: string[],
  matrix: (number | null)[][],
  signed: boolean,
): EChartsOption {
  const data: [number, number, number | null][] = []
  matrix.forEach((row, i) =>
    row.forEach((value, j) => data.push([j, i, value === null ? null : Number(value.toFixed(3))])),
  )
  const low = cssVar('--series-2')
  const high = cssVar('--series-1')
  const middle = cssVar('--surface-2')
  return {
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const value = (params as { value: [number, number, number | null] }).value
        return `${names[value[1]]} × ${names[value[0]]}: ${value[2] ?? '–'}`
      },
    },
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: names,
      axisLabel: { rotate: 60, width: 90, overflow: 'truncate' },
    },
    yAxis: { type: 'category', data: names, axisLabel: { width: 110, overflow: 'truncate' } },
    visualMap: {
      min: signed ? -1 : 0,
      max: 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      inRange: { color: signed ? [low, middle, high] : [middle, high] },
      show: false,
    },
    series: [
      {
        type: 'heatmap',
        data,
        // 列が少ない場合はマスに値を書く
        label: {
          show: names.length <= 12,
          formatter: (p: unknown) => {
            const value = (p as { value: [number, number, number | null] }).value[2]
            return value === null ? '' : value.toFixed(2)
          },
        },
        emphasis: { itemStyle: { borderColor: cssVar('--text') } },
      },
    ],
  }
}

/** 目的の列との関係と, 列の間の相関 */
export function RelationsTab({ profile }: { profile: Profile }) {
  const [method, setMethod] = useState<'pearson' | 'spearman'>('spearman')
  const target = profile.target
  const correlations = profile.correlations
  const associations = profile.associations
  const size = (count: number) => Math.min(640, Math.max(240, count * 26 + 120))
  return (
    <div className="space-y-4">
      {target ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title={`目的の列 ${target.column} (${TASK_LABELS[target.task] ?? target.task})`}>
            {target.classes ? (
              <Chart
                label="クラスの件数"
                height={Math.max(160, target.classes.length * 24)}
                option={countsOption(target.classes.slice(0, 30))}
              />
            ) : (
              <p className="text-sm text-ink-3">回帰の目的の列の分布は「列」で見られます.</p>
            )}
          </Card>
          <Card title="目的の列との関連の強さ (強い順)">
            <Chart
              label="目的の列との関連の強さ"
              height={Math.max(160, Math.min(target.associations.length, 25) * 22)}
              option={countsOption(
                target.associations.slice(0, 25).map((item) => ({
                  value: item.column,
                  count: Number(item.strength.toFixed(3)),
                })),
              )}
            />
            <p className="mt-2 text-xs text-ink-3">
              数値どうしは順位の相関, 数値とカテゴリは相関比, カテゴリどうしは Cramér の V (どれも 0
              から 1). 関係が強すぎる列はリークの疑いがあります.
            </p>
          </Card>
        </div>
      ) : (
        <EmptyState icon={Link2} title="目的の列が決まっていません">
          上の「目的の列」で予測したい列を選ぶと, その列と各列の関係が出ます.
        </EmptyState>
      )}
      {correlations.columns.length >= 2 && (
        <Card
          title="数値の列の相関"
          actions={
            <select
              aria-label="相関の種類"
              value={method}
              onChange={(event) => setMethod(event.target.value as 'pearson' | 'spearman')}
              className="h-7 rounded border border-line bg-surface px-1 text-xs"
            >
              <option value="spearman">Spearman (順位)</option>
              <option value="pearson">Pearson (直線)</option>
            </select>
          }
        >
          <Chart
            label="相関のヒートマップ"
            height={size(correlations.columns.length)}
            option={heatmapOption(correlations.columns, correlations[method], true)}
          />
        </Card>
      )}
      {associations.columns.length >= 2 && (
        <Card title="カテゴリの列の関連 (Cramér の V)">
          <Chart
            label="カテゴリの列の関連のヒートマップ"
            height={size(associations.columns.length)}
            option={heatmapOption(associations.columns, associations.cramers_v, false)}
          />
        </Card>
      )}
    </div>
  )
}
