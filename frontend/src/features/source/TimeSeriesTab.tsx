import type { EChartsOption } from 'echarts'
import { useState } from 'react'

import type { TimeSeriesInfo } from '../../api/types'
import { Card, StatTile } from '../../components/common'
import { Chart } from '../../lib/chart'
import { cssVar } from '../../lib/chartTheme'
import { formatInterval } from '../../lib/format'

/** 時系列の間隔, 抜け, 系列のグラフと自己相関 */
export function TimeSeriesTab({ series }: { series: TimeSeriesInfo }) {
  const names = Object.keys(series.series.values)
  const [selected, setSelected] = useState<string[]>(names.slice(0, 3))
  const [acfColumn, setAcfColumn] = useState(names[0] ?? '')
  const lineOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 48, right: 16, top: 32, bottom: 56, containLabel: true },
    // 時刻の軸 (抜けた時刻は空いて見える)
    xAxis: { type: 'time' },
    yAxis: { type: 'value', scale: true },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
    series: selected.map((name) => ({
      name,
      type: 'line',
      showSymbol: false,
      data: series.series.values[name]!.map((value, index) => [series.series.time[index], value]),
    })),
  }
  const acf = series.columns[acfColumn]
  // 周期の棒の色を CSS の変数から読むので, 描く時に呼ぶ関数で渡す
  const acfOption: (() => EChartsOption) | null = acf
    ? () => ({
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: acf.acf.map((_, index) => index + 1), name: 'ずらし幅' },
        yAxis: { type: 'value', min: -1, max: 1 },
        series: [
          {
            type: 'bar',
            data: acf.acf.map((value, index) => ({
              value: Number(value.toFixed(3)),
              itemStyle: acf.period === index + 1 ? { color: cssVar('--series-2') } : undefined,
            })),
          },
        ],
      })
    : null
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="時刻の間隔" value={formatInterval(series.interval_seconds)} />
        <StatTile label="抜け" value={series.gaps} hint="間隔の 1.5 倍より長く空いた所" />
        <StatTile label="同じ時刻" value={series.duplicates} />
        <StatTile
          label="期間"
          value={series.start?.slice(0, 10) ?? '–'}
          hint={`〜 ${series.end?.slice(0, 10) ?? '–'} まで`}
        />
      </div>
      <Card
        title="系列"
        actions={
          <div className="flex flex-wrap gap-2 text-xs">
            {names.map((name) => (
              <label key={name} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={selected.includes(name)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, name]
                        : current.filter((item) => item !== name),
                    )
                  }
                />
                <span className="font-mono">{name}</span>
              </label>
            ))}
          </div>
        }
      >
        <Chart label="時系列のグラフ" height={320} option={lineOption} />
        <p className="mt-1 text-xs text-ink-3">
          点が多い場合は間引いて描いています. ホイールと下のつまみで範囲を変えられます.
        </p>
      </Card>
      {acfOption && (
        <Card
          title="自己相関 (周期の手がかり)"
          actions={
            <select
              aria-label="自己相関を見る列"
              value={acfColumn}
              onChange={(event) => setAcfColumn(event.target.value)}
              className="h-7 rounded border border-line bg-surface px-1 font-mono text-xs"
            >
              {Object.keys(series.columns).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          }
        >
          <Chart label="自己相関のグラフ" option={acfOption} />
          <p className="mt-1 text-xs text-ink-3">
            {acf?.period
              ? `ずらし幅 ${acf.period} に山があり, 周期の候補です (色の違う棒). 過去の値の列 (lag) や移動平均の幅の目安になります.`
              : 'はっきりした周期は見つかりませんでした.'}
          </p>
        </Card>
      )}
    </div>
  )
}
