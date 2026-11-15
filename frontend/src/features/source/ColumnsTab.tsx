import clsx from 'clsx'
import { useMemo, useState } from 'react'

import type { ColumnInfo, Profile } from '../../api/types'
import { Card } from '../../components/ui'
import { Chart } from '../../lib/chart'
import { countsOption, histogramOption } from '../../lib/charts'
import { formatNumber, formatPercent, TYPE_LABELS } from '../../lib/format'
import { Findings } from './Findings'

/** 統計の 1 行 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-1 text-sm last:border-0">
      <span className="text-ink-3">{label}</span>
      <span className="tabular font-mono">{value}</span>
    </div>
  )
}

/** 1 つの列の詳細 (統計とグラフ) */
function ColumnDetail({
  name,
  info,
  profile,
}: {
  name: string
  info: ColumnInfo
  profile: Profile
}) {
  const findings = profile.findings.filter((item) => item.columns.includes(name))
  const stats: [string, string][] = [
    ['型', `${TYPE_LABELS[info.type] ?? info.type} (${info.dtype})`],
    ['件数', formatNumber(info.count)],
    ['欠損', `${formatNumber(info.missing)} (${formatPercent(info.missing_ratio)})`],
    ['異なる値', formatNumber(info.unique)],
  ]
  if (info.type === 'numeric') {
    stats.push(
      ['平均', formatNumber(info.mean)],
      ['標準偏差', formatNumber(info.std)],
      ['最小', formatNumber(info.min)],
      ['第 1 四分位', formatNumber(info.q1)],
      ['中央値', formatNumber(info.median)],
      ['第 3 四分位', formatNumber(info.q3)],
      ['最大', formatNumber(info.max)],
      ['歪度', formatNumber(info.skew)],
      ['0 の数', formatNumber(info.zeros)],
      ['外れ値', formatNumber(info.outliers)],
    )
  }
  if (info.type === 'text') {
    stats.push(
      ['平均の文字数', formatNumber(info.length_mean)],
      ['最短 / 最長', `${formatNumber(info.length_min)} / ${formatNumber(info.length_max)}`],
      ['平均の語の数', formatNumber(info.words_mean)],
      ['語彙', formatNumber(info.vocabulary)],
    )
  }
  if (info.type === 'datetime') {
    stats.push(['最初', String(info.min)], ['最後', String(info.max)])
  }
  return (
    <div className="space-y-4">
      <Card title={<span className="font-mono">{name}</span>}>
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <div>
            {stats.map(([label, value]) => (
              <Stat key={label} label={label} value={value} />
            ))}
          </div>
          <div className="min-w-0">
            {info.histogram && (
              <Chart
                label={`${name} のヒストグラム`}
                option={histogramOption(info.histogram, name)}
              />
            )}
            {info.top && info.top.length > 0 && (
              <Chart
                label={`${name} の値の頻度`}
                height={Math.max(160, Math.min(info.top.length, 20) * 22)}
                option={countsOption(info.top)}
              />
            )}
            {info.length_histogram && (
              <Chart
                label={`${name} の文字数のヒストグラム`}
                option={histogramOption(info.length_histogram, '文字数')}
              />
            )}
            {info.top_words && info.top_words.length > 0 && (
              <Chart
                label={`${name} の頻出語`}
                height={Math.min(info.top_words.length, 20) * 22}
                option={countsOption(info.top_words)}
              />
            )}
          </div>
        </div>
      </Card>
      {findings.length > 0 && (
        <Card title="この列の気付き">
          <Findings findings={findings} />
        </Card>
      )}
    </div>
  )
}

/** 列の一覧と, 選んだ列の詳細 */
export function ColumnsTab({
  profile,
  selected,
  onSelect,
}: {
  profile: Profile
  selected: string | null
  onSelect: (column: string) => void
}) {
  const [query, setQuery] = useState('')
  const names = Object.keys(profile.columns)
  const shown = useMemo(
    () => names.filter((name) => name.toLowerCase().includes(query.toLowerCase())),
    [names, query],
  )
  const current = selected && profile.columns[selected] ? selected : names[0]
  const flagged = new Set(profile.findings.flatMap((item) => item.columns))
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <div className="rounded-xl border border-line bg-surface">
        <label className="sr-only" htmlFor="column-filter">
          列を絞り込む
        </label>
        <input
          id="column-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="列を絞り込む"
          className="h-9 w-full rounded-t-xl border-b border-line bg-surface px-3 text-sm"
        />
        <ul aria-label="列" className="max-h-[70vh] overflow-auto">
          {shown.map((name) => {
            const info = profile.columns[name]!
            return (
              <li key={name}>
                <button
                  type="button"
                  aria-current={name === current}
                  onClick={() => onSelect(name)}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2',
                    name === current && 'bg-accent-soft',
                  )}
                >
                  <span className="flex-1 truncate font-mono">{name}</span>
                  {flagged.has(name) && (
                    <span className="size-1.5 rounded-full bg-warning" title="気付きあり" />
                  )}
                  <span className="text-xs text-ink-3">{TYPE_LABELS[info.type] ?? info.type}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      {current && profile.columns[current] && (
        <ColumnDetail name={current} info={profile.columns[current]} profile={profile} />
      )}
    </div>
  )
}
