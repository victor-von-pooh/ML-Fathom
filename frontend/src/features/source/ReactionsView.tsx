import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOutput } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'

import { api, ApiError } from '../../api/client'
import type { ReactionCounts, ReactionsResult, ReactionsSummary, Source } from '../../api/types'
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
import { countsOption } from '../../lib/charts'
import { formatCount, formatNumber, formatPercent, KIND_LABELS } from '../../lib/format'
import { binCounts, TIME_KIND_LABELS, timeText } from '../../lib/reactions'
import { Stat } from './ColumnsTab'
import { DataTab } from './DataTab'
import { Notes } from './TrajectoryView'

type TabId = 'overview' | 'bias' | 'data' | 'export'

/** 概要: 数, 気付き, 読んだ列, 除いた行, 時刻の範囲, 反応の強さ */
function OverviewPanel({ result }: { result: ReactionsResult }) {
  const summary = result.summary
  const { columns, dropped, time, reaction } = summary
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <StatTile label="反応" value={formatCount(summary.reactions)} hint="除いた後の行" />
        <StatTile label="行" value={formatCount(summary.rows)} hint="除く前" />
        <StatTile label="除いた行" value={formatCount(dropped.total)} />
        <StatTile label="利用者" value={formatCount(summary.users)} />
        <StatTile label="品物" value={formatCount(summary.items)} />
        <StatTile label="利用者と品物の組" value={formatCount(summary.pairs)} />
        <StatTile
          label="密度"
          value={formatPercent(summary.density, 2)}
          hint="組 ÷ (利用者 × 品物)"
        />
        <StatTile label="並べる件数 (K)" value={formatNumber(result.k)} />
      </div>
      <Card title={`気付き (${summary.notes.length} 件)`}>
        <Notes notes={summary.notes} />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="読んだ列 (問題の設定の答え)">
          <Stat label="利用者" value={columns.user} />
          <Stat label="品物" value={columns.item} />
          <Stat label="時刻" value={columns.time} />
          <Stat label="反応の強さ" value={columns.reaction ?? 'なし'} />
          <p className="mt-2 text-xs text-ink-3">
            {columns.reaction
              ? '反応の強さが 0 より大きい行だけを反応とみなします.'
              : '反応の強さの列が無いので, 全ての行を反応とみなします.'}{' '}
            他の列は読みません. 列は ML-Pathfinder の問題の設定で答え直せます.
          </p>
        </Card>
        <Card title="除いた行">
          <Stat label="利用者, 品物か時刻の欠け" value={formatNumber(dropped.missing)} />
          <Stat
            label="うち, 日時として読めない時刻"
            value={formatNumber(dropped.unreadable_time)}
          />
          <Stat label="反応の強さが 0 以下か数でない" value={formatNumber(dropped.not_positive)} />
          <Stat label="合計" value={formatNumber(dropped.total)} />
          <p className="mt-2 text-xs text-ink-3">
            骨組みの学習のスクリプトも同じ決まりで除き, 除いた数を train.log に書きます.
          </p>
        </Card>
        <Card title="時刻の範囲">
          <Stat label="種類" value={TIME_KIND_LABELS[time.kind] ?? time.kind} />
          <Stat label="最も古い" value={timeText(time.min)} />
          <Stat label="最も新しい" value={timeText(time.max)} />
          <Stat label="異なる時刻" value={formatNumber(time.distinct)} />
          <p className="mt-2 text-xs text-ink-3">
            骨組みは反応を時刻の順に並べ, 古い反応を学習用, 新しい反応を検証用とテスト用にします.
          </p>
        </Card>
        {reaction && (
          <Card title="反応の強さ (残した反応)">
            <Stat label="平均" value={formatNumber(reaction.mean)} />
            <Stat label="標準偏差" value={formatNumber(reaction.std)} />
            <Stat label="最小" value={formatNumber(reaction.min)} />
            <Stat label="中央値" value={formatNumber(reaction.median)} />
            <Stat label="最大" value={formatNumber(reaction.max)} />
          </Card>
        )}
      </div>
    </div>
  )
}

/** 利用者ごとか品物ごとの反応の数の分布 */
function CountsCard({ title, counts }: { title: string; counts: ReactionCounts }) {
  return (
    <Card title={title}>
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <div>
          <Stat label="平均" value={formatNumber(counts.mean)} />
          <Stat label="標準偏差" value={formatNumber(counts.std)} />
          <Stat label="最小" value={formatNumber(counts.min)} />
          <Stat label="中央値" value={formatNumber(counts.median)} />
          <Stat label="最大" value={formatNumber(counts.max)} />
          <Stat label="1 回だけ" value={formatNumber(counts.once)} />
        </div>
        <div className="min-w-0">
          <Chart label={`${title}の区切りごとの数`} option={countsOption(binCounts(counts))} />
        </div>
      </div>
    </Card>
  )
}

/** 偏り: 利用者ごとと品物ごとの数, 人気の偏り, 多い品物 */
function BiasPanel({ summary }: { summary: ReactionsSummary }) {
  const popularity = summary.popularity
  return (
    <div className="space-y-4">
      <Card title="品物の人気の偏り">
        <div className="grid gap-x-6 md:grid-cols-2">
          <Stat label="上位 10% の品物の数" value={formatNumber(popularity.top_items)} />
          <Stat label="その品物の反応の割合" value={formatPercent(popularity.top_share)} />
          <Stat label="ジニ係数" value={formatNumber(popularity.gini)} />
          <Stat label="同じ組の 2 行目から" value={formatNumber(summary.repeated)} />
        </div>
        <p className="mt-2 text-xs text-ink-3">
          ジニ係数は 0 でどの品物も同じ数, 1 に近いほど少ない品物に反応が集まります. 骨組みは人気順
          (学習用の反応の多い順) と比べるので, 偏りが大きいほど人気順は強い相手です.
        </p>
        {popularity.popular.length > 0 && (
          <table className="mt-3 w-full text-sm">
            <caption className="sr-only">反応の多い品物</caption>
            <thead className="text-xs text-ink-3">
              <tr>
                <th scope="col" className="py-1 text-left font-normal">
                  品物
                </th>
                <th scope="col" className="text-right font-normal">
                  反応
                </th>
              </tr>
            </thead>
            <tbody>
              {popularity.popular.map((row, index) => (
                <tr key={`${index}-${String(row.item)}`} className="border-t border-line">
                  <th scope="row" className="py-1 text-left font-mono font-normal break-all">
                    {String(row.item)}
                  </th>
                  <td className="tabular pl-3 text-right font-mono">
                    {formatNumber(row.reactions)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <CountsCard title="利用者ごとの反応の数" counts={summary.per_user} />
        <CountsCard title="品物ごとの反応の数" counts={summary.per_item} />
      </div>
    </div>
  )
}

/**
 * 反応の表をファイル 1 つのまま, 問題の設定に記録したプロジェクトの骨組みが読む場所へ写す.
 * 前に置いたファイルは確かめてから置き換え, ファイルでないものは置き換えない
 */
function ExportPanel({ sourceId }: { sourceId: string }) {
  const queryClient = useQueryClient()
  const place = useQuery({
    queryKey: ['project', sourceId],
    queryFn: () => api.project(sourceId),
    retry: false,
  })
  const exporter = useMutation({
    mutationFn: (overwrite: boolean) => api.exportReactions(sourceId, overwrite),
    onSettled: (_, error) => {
      // 書き出した後と, 他で書き出し先が変わった (409) ときは様子を読み直す
      if (!error || (error instanceof ApiError && error.status === 409)) {
        void queryClient.invalidateQueries({ queryKey: ['project', sourceId] })
      }
    },
  })
  if (place.isPending) return <Spinner label="プロジェクトの書き出し先を調べています" />
  if (place.error) return <ErrorBox error={place.error} />
  const data = place.data
  const run = () => {
    const replace = data.state === 'file'
    if (
      replace &&
      !window.confirm(`${data.dataset} には前に置いた反応の表があります. 置き換えますか?`)
    ) {
      return
    }
    exporter.mutate(replace)
  }
  const done = exporter.data
  return (
    <Card title="プロジェクトへ書き出す">
      <p className="text-sm text-ink-2">
        反応の表を前処理せず, ファイル 1 つのまま,
        問題の設定に記録した学習のプロジェクトの骨組みが読む場所 (config の data.dataset)
        に写します. 並べるはレシピを持たず, 分割は骨組みが時刻で行います.
      </p>
      {data.dataset && (
        <p className="mt-2 truncate font-mono text-xs" title={data.dataset}>
          {data.dataset}
        </p>
      )}
      {data.state === 'file' && (
        <p className="text-xs text-ink-3">
          前に置いたファイルがあります (書き出すと, 確かめてから置き換えます)
        </p>
      )}
      {data.reason && <p className="mt-1 text-xs text-warning-text">{data.reason}</p>}
      {data.ready && (
        <Button
          variant="primary"
          icon={FolderOutput}
          className="mt-3"
          // 書き出し先の様子を読み直す間は押せない (古い様子で置き換えを決めないように)
          disabled={exporter.isPending || place.isFetching}
          onClick={run}
        >
          {exporter.isPending ? '書き出し中…' : 'プロジェクトへ書き出す'}
        </Button>
      )}
      {exporter.error && <ErrorBox error={exporter.error} />}
      {done && (
        <p role="status" className="mt-3 text-sm text-good-text">
          {done.copied
            ? `プロジェクトへ書き出しました: ${done.path}`
            : `書き出し先は登録した反応の表そのものなので, 写さずにそのまま使います: ${done.path}`}{' '}
          (骨組みが反応とみなす行 {formatNumber(done.reactions)}, 除く行{' '}
          {formatNumber(done.dropped)})
        </p>
      )}
    </Card>
  )
}

/** 並べるの反応の表の分析 (ML-EDA の describe_reactions) と, プロジェクトへの書き出し */
export function ReactionsView({ source }: { source: Source }) {
  const [search, setSearch] = useSearchParams()
  const result = useQuery({
    queryKey: ['reactions', source.id],
    queryFn: () => api.reactions(source.id),
  })
  const data = result.data
  const items: TabItem<TabId>[] = [
    { id: 'overview', label: '概要と気付き', count: data?.summary.notes.length },
    { id: 'bias', label: '偏り' },
    { id: 'data', label: '表の中身' },
    { id: 'export', label: '書き出し' },
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
            {KIND_LABELS[source.kind] ?? source.kind} · {source.loader} · {source.path}
          </span>
        }
      />
      {source.problem && (
        <p className="mb-3 truncate text-xs text-ink-3" title={source.problem}>
          並べるの問題の設定から始めました: <span className="font-mono">{source.problem}</span>
        </p>
      )}
      <Tabs
        items={items}
        value={tab}
        onChange={(next) => setSearch({ tab: next }, { replace: true })}
        idBase="reactions"
        label="反応の表の分析"
      />
      <div
        id="reactions-panel"
        role="tabpanel"
        aria-labelledby={`reactions-tab-${tab}`}
        tabIndex={0}
        className="pt-4"
      >
        {tab !== 'data' && tab !== 'export' && result.isPending && (
          <Spinner label="分析しています" />
        )}
        {tab !== 'data' && tab !== 'export' && result.error && <ErrorBox error={result.error} />}
        {data && tab === 'overview' && <OverviewPanel result={data} />}
        {data && tab === 'bias' && <BiasPanel summary={data.summary} />}
        {tab === 'data' && <DataTab sourceId={source.id} />}
        {tab === 'export' && <ExportPanel sourceId={source.id} />}
      </div>
    </>
  )
}
