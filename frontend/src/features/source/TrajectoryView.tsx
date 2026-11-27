import { useQuery } from '@tanstack/react-query'
import { Download, Info } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'

import { useApi } from '../../api/client'
import type {
  Source,
  TrajectoryElement,
  TrajectoryEpisode,
  TrajectoryStats,
  TrajectorySummary,
} from '../../api/types'
import {
  Button,
  Card,
  ErrorBox,
  PageHeader,
  Spinner,
  StatTile,
  Tabs,
  type TabItem,
} from '../../components/ui'
import { Chart } from '../../lib/chart'
import { countsOption, histogramOption } from '../../lib/charts'
import { formatCount, formatNumber, KIND_LABELS } from '../../lib/format'
import {
  binValues,
  downloadAnalysis,
  END_LABELS,
  END_ORDER,
  guardLabel,
  SOURCE_LABELS,
} from '../../lib/trajectory'
import { Stat } from './ColumnsTab'

type TabId = 'overview' | 'elements' | 'guard' | 'episodes'

/** 説明の値を短い文にする */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '–'
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** 気付き (ML-EDA の notes) の一覧 */
export function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) {
    return <p className="text-sm text-good-text">読むときと要約で気付いたことはありません.</p>
  }
  return (
    <ul className="divide-y divide-line">
      {notes.map((note, index) => (
        <li key={`${index}-${note}`} className="flex gap-3 py-2.5 text-sm text-ink-2">
          <Info size={16} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
          <span className="min-w-0 break-words">{note}</span>
        </li>
      ))}
    </ul>
  )
}

/** 全てのエピソードの値の要約と, 並べたエピソードのヒストグラム */
function Distribution({
  title,
  stats,
  values,
  axis,
  truncated,
  children,
}: {
  title: string
  stats: TrajectoryStats
  values: number[]
  axis: string
  truncated: boolean
  children?: ReactNode
}) {
  const histogram = useMemo(() => binValues(values), [values])
  return (
    <Card title={title}>
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <div>
          <Stat label="平均" value={formatNumber(stats.mean)} />
          <Stat label="標準偏差" value={formatNumber(stats.std)} />
          <Stat label="最小" value={formatNumber(stats.min)} />
          <Stat label="中央値" value={formatNumber(stats.median)} />
          <Stat label="最大" value={formatNumber(stats.max)} />
          {children}
        </div>
        <div className="min-w-0">
          {histogram ? (
            <Chart
              label={`${title}のヒストグラム`}
              option={histogramOption(histogram, axis, histogram.labels)}
            />
          ) : (
            <p className="text-sm text-ink-3">描ける値がありません.</p>
          )}
          {truncated && (
            <p className="mt-1 text-xs text-ink-3">
              グラフは先頭の {formatCount(values.length)} 件のエピソードで描いています
              (左の値は全てのエピソード).
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

/** 概要: 数, 長さと報酬の和の分布, 終わり方, 気付き, 説明 */
function OverviewPanel({ summary }: { summary: TrajectorySummary }) {
  const episodes = summary.per_episode
  const lengths = useMemo(() => episodes.map((row) => row.length), [episodes])
  const returns = useMemo(
    () => episodes.flatMap((row) => (row.return === null ? [] : [row.return])),
    [episodes],
  )
  const ends = END_ORDER.map((end) => ({
    value: END_LABELS[end],
    count: summary.ends[end],
  }))
  const described: [string, unknown][] = [
    ['表の形式', summary.format],
    ['説明 (JSON)', summary.described ? 'あり' : 'なし'],
    ['説明の版', summary.format_version],
    ['出どころ', summary.source && (SOURCE_LABELS[summary.source] ?? summary.source)],
    ['環境', summary.env],
    ['エポック', summary.epoch],
    ['説明の文', summary.description],
    ['全てのエピソードを記録したか', summary.complete],
    ['落としたエピソード', summary.dropped_episodes],
    ['観測の空間', summary.observation_space],
    ['行動の空間', summary.action_space],
    ['観測の列', summary.observation_columns.join(', ')],
    ['行動の列', summary.action_columns.join(', ')],
    ['その他の列', summary.extra_columns.join(', ') || null],
  ]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatTile label="エピソード" value={formatCount(summary.episodes)} />
        <StatTile label="行" value={formatCount(summary.rows)} />
        <StatTile label="環境を進めた歩数" value={formatCount(summary.steps)} hint="報酬のある行" />
        <StatTile label="長さの平均" value={formatNumber(summary.length.mean)} />
        <StatTile label="報酬の和の平均" value={formatNumber(summary.return.mean)} />
        <StatTile label="守り" value={summary.guarded ? 'あり' : 'なし'} />
        <StatTile
          label="行動を選んだ確率"
          value={summary.with_action_prob ? 'あり' : 'なし'}
          hint="確率の列"
        />
      </div>
      <Card title={`気付き (${summary.notes.length} 件)`}>
        <Notes notes={summary.notes} />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Distribution
          title="エピソードの長さ"
          stats={summary.length}
          values={lengths}
          axis="歩数"
          truncated={summary.per_episode_truncated}
        />
        <Distribution
          title="報酬の和"
          stats={summary.return}
          values={returns}
          axis="報酬の和"
          truncated={summary.per_episode_truncated}
        >
          <Stat label="和が有限でないエピソード" value={formatNumber(summary.unknown_returns)} />
        </Distribution>
      </div>
      <Card title="終わり方ごとのエピソードの数">
        <Chart label="終わり方ごとのエピソードの数" height={160} option={countsOption(ends)} />
      </Card>
      <Card title="記録の説明">
        <div className="grid gap-x-6 md:grid-cols-2">
          {described.map(([label, value]) => (
            <Stat key={label} label={label} value={describeValue(value)} />
          ))}
        </div>
      </Card>
    </div>
  )
}

/** 観測か行動の要素ごとの統計の表 */
function ElementTable({ caption, elements }: { caption: string; elements: TrajectoryElement[] }) {
  const headers = [
    '型',
    '欠け',
    'nan (数でない値)',
    '無限大',
    '最小',
    '最大',
    '平均',
    '標準偏差',
    '中央値',
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-ink-3">
          <tr>
            <th scope="col" className="py-1 text-left font-normal">
              要素
            </th>
            {headers.map((header) => (
              <th key={header} scope="col" className="text-right font-normal">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {elements.map((item) => (
            <tr key={item.name} className="border-t border-line">
              <th scope="row" className="py-1 text-left font-mono font-normal">
                {item.name}
              </th>
              <td className="text-right">{item.type}</td>
              {[
                item.missing,
                item.nan,
                item.infinite,
                item.min,
                item.max,
                item.mean,
                item.std,
                item.median,
              ].map((value, index) => (
                <td key={headers[index + 1]} className="tabular text-right font-mono">
                  {formatNumber(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 行動を選んだ確率の列の有無と, 欠けと範囲の外の数 */
function ActionProbCard({ summary }: { summary: TrajectorySummary }) {
  const prob = summary.action_prob
  return (
    <Card title="行動を選んだ確率">
      {prob === null ? (
        <p className="text-sm text-ink-3">表に行動を選んだ確率の列はありません.</p>
      ) : (
        <>
          <div className="grid gap-x-6 md:grid-cols-2">
            <Stat label="欠け" value={formatNumber(prob.missing)} />
            <Stat
              label="範囲の外 (0 より大きく 1 以下でない値)"
              value={formatNumber(prob.out_of_range)}
            />
            <Stat label="最小" value={formatNumber(prob.min)} />
            <Stat label="最大" value={formatNumber(prob.max)} />
            <Stat label="平均" value={formatNumber(prob.mean)} />
            <Stat label="中央値" value={formatNumber(prob.median)} />
          </div>
          <p className="mt-2 text-xs text-ink-3">
            確率の列 (action_prob) の欠けは空の値の数です (守りで止めた行は確率が空).
            最小から中央値は範囲の中の値で求めます.
          </p>
        </>
      )}
    </Card>
  )
}

/** 観測と行動: 要素ごとの統計と, 行動の値ごとの数 */
function ElementsPanel({ summary }: { summary: TrajectorySummary }) {
  const counted = summary.actions.filter((item) => item.counts !== null)
  return (
    <div className="space-y-4">
      <Card title={`行動 (${summary.actions.length} 要素)`}>
        <ElementTable caption="行動の要素ごとの統計" elements={summary.actions} />
        <p className="mt-2 text-xs text-ink-3">
          欠けは空の値の数です (守りで止めた行は行動が空). nan は値として数えます.
        </p>
        {counted.map((item) => (
          <div key={item.name} className="mt-4">
            <h3 className="mb-1 text-xs font-semibold text-ink-2">
              <span className="font-mono">{item.name}</span> の値ごとの数
            </h3>
            <Chart
              label={`${item.name} の値ごとの数`}
              height={Math.max(120, Math.min(item.counts!.length, 20) * 22)}
              option={countsOption(
                item.counts!.map((entry) => ({ value: String(entry.value), count: entry.count })),
              )}
            />
          </div>
        ))}
      </Card>
      <ActionProbCard summary={summary} />
      <Card title={`観測 (${summary.observations.length} 要素)`}>
        <ElementTable caption="観測の要素ごとの統計" elements={summary.observations} />
      </Card>
    </div>
  )
}

/** 守り: 結果ごとの行の数と, 理由ごとの数 */
function GuardPanel({ guard }: { guard: NonNullable<TrajectorySummary['guard']> }) {
  const results = Object.entries(guard.results)
    .sort((a, b) => b[1] - a[1])
    .map(([result, count]) => ({ value: guardLabel(result), count }))
  return (
    <div className="space-y-4">
      <Card title="守りの結果ごとの行の数">
        <Chart
          label="守りの結果ごとの行の数"
          height={Math.max(120, results.length * 28)}
          option={countsOption(results)}
        />
      </Card>
      <Card title={`守りが働いた理由 (${guard.reasons.length} 種類)`}>
        {guard.reasons.length === 0 ? (
          <p className="text-sm text-ink-3">守りが働いた理由はありません.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">守りが働いた理由ごとの行の数</caption>
            <thead className="text-xs text-ink-3">
              <tr>
                <th scope="col" className="py-1 text-left font-normal">
                  理由
                </th>
                <th scope="col" className="text-right font-normal">
                  行
                </th>
              </tr>
            </thead>
            <tbody>
              {guard.reasons.map((item) => (
                <tr key={item.reason} className="border-t border-line">
                  <td className="py-1 break-words">{item.reason}</td>
                  <td className="tabular pl-3 text-right font-mono">{formatNumber(item.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

/** エピソードごとの一覧 */
function EpisodesPanel({ summary }: { summary: TrajectorySummary }) {
  const rows: TrajectoryEpisode[] = summary.per_episode
  return (
    <Card title={`エピソードごとの一覧 (${formatCount(rows.length)} 件)`}>
      {summary.per_episode_truncated && (
        <p role="note" className="mb-2 text-xs text-warning-text">
          エピソードが {formatCount(summary.episodes)} 件あるので, 先頭の {formatCount(rows.length)}{' '}
          件だけを並べています.
        </p>
      )}
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">エピソードごとの行の数, 長さ, 報酬の和, 終わり方</caption>
          <thead className="sticky top-0 bg-surface text-ink-3">
            <tr>
              {['エピソード', '行', '長さ', '報酬の和', '終わり方', '乱数の種'].map((header) => (
                <th key={header} scope="col" className="py-1 text-right font-normal">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.episode} className="tabular border-t border-line text-right font-mono">
                <th scope="row" className="py-1 font-normal">
                  {row.episode}
                </th>
                <td>{formatNumber(row.rows)}</td>
                <td>{formatNumber(row.length)}</td>
                <td>{formatNumber(row.return)}</td>
                <td className="font-sans">{END_LABELS[row.end] ?? row.end}</td>
                <td>{formatNumber(row.seed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** 記録した軌跡の分析 (ML-EDA の describe_trajectory) */
export function TrajectoryView({ source }: { source: Source }) {
  const api = useApi()
  const [search, setSearch] = useSearchParams()
  const summary = useQuery({
    queryKey: ['trajectory', source.id],
    queryFn: () => api.trajectory(source.id),
  })
  const data = summary.data
  const items: TabItem<TabId>[] = [
    { id: 'overview', label: '概要と気付き', count: data?.notes.length },
    { id: 'elements', label: '観測と行動' },
    ...(data?.guard ? [{ id: 'guard' as const, label: '守り' }] : []),
    { id: 'episodes', label: 'エピソード', count: data?.episodes },
  ]
  const requested = (search.get('tab') as TabId | null) ?? 'overview'
  const tab = items.some((item) => item.id === requested) ? requested : 'overview'
  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/">データ</Link>}
        title={source.name}
        subtitle={
          <span className="font-mono" title={source.path}>
            {KIND_LABELS[source.kind] ?? source.kind} · {source.path}
          </span>
        }
        actions={
          <Button icon={Download} disabled={!data} onClick={() => data && downloadAnalysis(data)}>
            分析を書き出す
          </Button>
        }
      />
      <Tabs
        items={items}
        value={tab}
        onChange={(next) => setSearch({ tab: next }, { replace: true })}
        idBase="trajectory"
        label="軌跡の分析"
      />
      <div
        id="trajectory-panel"
        role="tabpanel"
        aria-labelledby={`trajectory-tab-${tab}`}
        tabIndex={0}
        className="pt-4"
      >
        {summary.isPending && <Spinner label="分析しています" />}
        {summary.error && <ErrorBox error={summary.error} />}
        {data && tab === 'overview' && <OverviewPanel summary={data} />}
        {data && tab === 'elements' && <ElementsPanel summary={data} />}
        {data && tab === 'guard' && data.guard && <GuardPanel guard={data.guard} />}
        {data && tab === 'episodes' && <EpisodesPanel summary={data} />}
      </div>
    </>
  )
}
