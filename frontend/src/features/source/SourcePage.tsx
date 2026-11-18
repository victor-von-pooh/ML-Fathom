import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router'

import { api } from '../../api/client'
import { ErrorBox, PageHeader, Spinner, Tabs, type TabItem } from '../../components/ui'
import { KIND_LABELS } from '../../lib/format'
import { ColumnsTab } from './ColumnsTab'
import { DataTab } from './DataTab'
import { OverviewTab } from './OverviewTab'
import { LoaderOptions } from './LoaderOptions'
import { ReadAsControl } from './ReadAsControl'
import { RecipeTab } from './RecipeTab'
import { RelationsTab } from './RelationsTab'
import { SamplesTab } from './SamplesTab'
import { TimeSeriesTab } from './TimeSeriesTab'

type TabId = 'overview' | 'columns' | 'relations' | 'timeseries' | 'samples' | 'data' | 'recipe'

/** 1 つのデータの分析と前処理 */
export function SourcePage() {
  const { id = '' } = useParams()
  const [search, setSearch] = useSearchParams()
  const queryClient = useQueryClient()
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.listSources })
  const info = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity })
  const source = sources.data?.find((item) => item.id === id)
  const profile = useQuery({
    queryKey: ['profile', id, source?.target ?? null],
    queryFn: () => api.profile(id),
    enabled: source !== undefined,
    // 目的の列を変えて分析し直す間も, 前の結果を出したままにする
    placeholderData: keepPreviousData,
  })
  const setTarget = useMutation({
    mutationFn: (target: string | null) => api.updateSource(id, { target }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sources'] }),
  })

  const requested = (search.get('tab') as TabId | null) ?? 'overview'
  const column = search.get('column')
  const go = (next: TabId, extra: Record<string, string> = {}) =>
    setSearch({ tab: next, ...extra }, { replace: true })

  if (sources.isPending) return <Spinner />
  if (!source) return <ErrorBox error={new Error(`データ ${id} がありません`)} />
  const data = profile.data
  const items: TabItem<TabId>[] = [
    { id: 'overview', label: '概要と気付き', count: data?.findings.length },
    { id: 'columns', label: '列', count: data ? Object.keys(data.columns).length : undefined },
    { id: 'relations', label: '関係' },
    ...(data?.timeseries ? [{ id: 'timeseries' as const, label: '時系列' }] : []),
    ...(data?.summary.has_items ? [{ id: 'samples' as const, label: '中身を見る' }] : []),
    { id: 'data', label: '表の中身' },
    { id: 'recipe', label: '前処理と書き出し' },
  ]
  // 読み方を変えて無くなったタブは概要に戻す
  const tab = data && !items.some((item) => item.id === requested) ? 'overview' : requested
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
        actions={
          // 読み込みの設定は, 分析に失敗した (設定が合わない) ときも直せるように出す
          <div className="flex flex-wrap items-start gap-3">
            <LoaderOptions
              key={`${source.id}:${JSON.stringify(source.options)}`}
              source={source}
              loader={info.data?.loaders.find((item) => item.name === source.loader)}
              sheets={profile.data?.overview.sheets}
            />
            {data && (
              <>
                <ReadAsControl source={source} profile={data} />
                <label className="flex items-center gap-2 text-sm">
                  目的の列
                  <select
                    value={source.target ?? ''}
                    onChange={(event) => setTarget.mutate(event.target.value || null)}
                    className="h-8 rounded-lg border border-line bg-surface px-2 font-mono"
                  >
                    <option value="">なし</option>
                    {Object.keys(data.columns).map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
        }
      />
      {setTarget.error && <ErrorBox error={setTarget.error} />}
      <Tabs items={items} value={tab} onChange={(next) => go(next)} idBase="source" label="分析" />
      <div
        id="source-panel"
        role="tabpanel"
        aria-labelledby={`source-tab-${tab}`}
        tabIndex={0}
        className="pt-4"
      >
        {profile.isPending && <Spinner label="分析しています" />}
        {profile.error && <ErrorBox error={profile.error} />}
        {data && tab === 'overview' && (
          <OverviewTab profile={data} onColumn={(name) => go('columns', { column: name })} />
        )}
        {data && tab === 'columns' && (
          <ColumnsTab
            profile={data}
            selected={column}
            onSelect={(name) => go('columns', { column: name })}
          />
        )}
        {data && tab === 'relations' && <RelationsTab profile={data} />}
        {data && tab === 'timeseries' && data.timeseries && (
          <TimeSeriesTab series={data.timeseries} />
        )}
        {data && tab === 'samples' && <SamplesTab key={source.id} source={source} profile={data} />}
        {tab === 'data' && <DataTab sourceId={id} />}
        {data && tab === 'recipe' && source.kind === 'capture' && (
          <p className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-2">
            多視点の撮影は, 今は読み込みと分析だけです. 前処理と書き出しは, 多視点の学習の正解
            (何を正解の形にするか) が決まってから足します.
          </p>
        )}
        {data && tab === 'recipe' && info.data && source.kind !== 'capture' && (
          <RecipeTab
            key={`${source.id}:${source.kind}:${JSON.stringify(source.options)}`}
            sourceId={id}
            sourceName={source.name}
            sourcePath={source.path}
            profile={data}
            target={source.target}
            steps={info.data.steps}
            kind={source.kind}
            itemSteps={info.data.item_steps}
            loader={source.loader}
            options={source.options}
            problem={source.problem}
          />
        )}
      </div>
    </>
  )
}
