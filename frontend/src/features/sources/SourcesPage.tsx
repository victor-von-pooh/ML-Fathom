import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ClipboardList, FolderSearch, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { useApi } from '../../api/client'
import type { ProblemStarted, Source } from '../../api/types'
import { clearDraft } from '../../lib/drafts'
import { Button, Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { KIND_LABELS } from '../../lib/format'
import { problemIdOf, useStage } from '../../lib/stage'
import { AddSourceDialog } from './AddSourceDialog'
import { useStartFromProblem } from './useStartFromProblem'

/**
 * 殻で選んだ問題の設定の欄. 名前と「この問題の設定から始める」を出す.
 * 始められなければ理由を, 置き場に無ければ無いと出す
 */
function ProjectProblem({
  project,
  onAdded,
}: {
  project: string
  onAdded: (source: Source, tab?: ProblemStarted['tab']) => void
}) {
  const api = useApi()
  const problems = useQuery({ queryKey: ['problems'], queryFn: api.problems })
  const start = useStartFromProblem({ onAdded })
  const item = problems.data?.problems.find((entry) => problemIdOf(entry.path) === project)
  return (
    <Card title="選んだ問題の設定" className="mb-4">
      {problems.isPending && <Spinner />}
      {problems.error && <ErrorBox error={problems.error} live={false} />}
      {problems.data?.error && <p className="text-sm text-critical-text">{problems.data.error}</p>}
      {problems.data && !problems.data.error && !item && (
        <p className="text-sm text-critical-text">
          問題の設定 <span className="font-mono">{project}</span> は置き場 (
          <span className="font-mono">{problems.data.root}</span>) にありません.
        </p>
      )}
      {item && (
        <div className="flex flex-wrap items-center gap-3">
          <ClipboardList size={16} className="shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{item.name}</div>
            <div className="truncate font-mono text-xs text-ink-3" title={item.path}>
              {item.path}
            </div>
            {item.reason && <p className="text-sm text-warning-text">{item.reason}</p>}
          </div>
          {item.startable && (
            <Button
              variant="primary"
              disabled={start.isPending}
              onClick={() => start.mutate(item.path)}
            >
              {start.isPending ? '読み込み中…' : 'この問題の設定から始める'}
            </Button>
          )}
        </div>
      )}
      {start.error && (
        <div className="mt-3">
          <ErrorBox error={start.error} />
        </div>
      )}
    </Card>
  )
}

/** 登録したデータの一覧 */
export function SourcesPage() {
  const api = useApi()
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.listSources })
  const [adding, setAdding] = useState<'data' | 'problem' | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { project } = useStage()
  // 殻で問題の設定を選んでいれば, そこから始めたデータに絞る (外すと全てを出す)
  const [showAll, setShowAll] = useState(false)
  const filtered = project !== null && !showAll
  const shown = filtered
    ? sources.data?.filter(
        (source) => source.problem != null && problemIdOf(source.problem) === project,
      )
    : sources.data
  // 登録したら一覧を読み直して, そのデータの画面 (開くタブがあればそのタブ) へ
  const added = (source: Source, tab?: ProblemStarted['tab']) => {
    void queryClient.invalidateQueries({ queryKey: ['sources'] })
    setAdding(null)
    void navigate(`/sources/${source.id}${tab ? `?tab=${tab}` : ''}`)
  }
  // 途中で失敗しても登録できた分を一覧に出すため, 成否によらず読み直す
  const samples = useMutation({
    mutationFn: api.addSamples,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sources'] }),
  })
  const remove = useMutation({
    mutationFn: api.deleteSource,
    onSuccess: (_, id) => {
      // 登録を外したデータの編集中の手順も捨てる
      clearDraft(id)
      samples.reset()
      return queryClient.invalidateQueries({ queryKey: ['sources'] })
    },
  })
  // 操作を試すための見本 (表, 時系列, 画像, 文, 点群) を置き場に作って登録
  return (
    <>
      <PageHeader
        title="データ"
        subtitle="分析して前処理するデータ. 元のファイルは変えません"
        actions={
          <>
            <Button icon={Sparkles} disabled={samples.isPending} onClick={() => samples.mutate()}>
              {samples.isPending ? '見本を作っています…' : '見本のデータを入れる'}
            </Button>
            <Button icon={ClipboardList} onClick={() => setAdding('problem')}>
              問題の設定から始める
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setAdding('data')}>
              データを追加
            </Button>
          </>
        }
      />
      {project !== null && <ProjectProblem project={project} onAdded={added} />}
      {project !== null && (
        <label className="mb-3 flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          全てのデータを出す (選んだ問題の設定から始めていないものも)
        </label>
      )}
      {sources.isPending && <Spinner />}
      {sources.error && <ErrorBox error={sources.error} />}
      {samples.error && <ErrorBox error={samples.error} />}
      <p role="status" className="mb-3 text-sm text-ink-2 empty:hidden">
        {samples.data &&
          (samples.data.length === 0
            ? '見本は登録済みです'
            : `見本を ${samples.data.length} 件登録しました (置き場の samples に作りました)`)}
      </p>
      {sources.data?.length === 0 && (
        <EmptyState icon={FolderSearch} title="まだデータがありません">
          「データを追加」で, 分析したいファイルかディレクトリを選んでください.
          まず操作を試すなら「見本のデータを入れる」で, 表, 時系列, 画像, 文,
          点群の見本を登録できます
        </EmptyState>
      )}
      {filtered && sources.data && sources.data.length > 0 && shown?.length === 0 && (
        <p className="mb-3 text-sm text-ink-3">
          選んだ問題の設定から始めたデータはまだありません. 「この問題の設定から始める」で始めるか,
          「全てのデータを出す」で他のデータを開けます.
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown?.map((source) => (
          <Card key={source.id} className="relative">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link
                  to={`/sources/${source.id}`}
                  className="block truncate font-semibold text-accent-text hover:underline"
                >
                  {source.name}
                </Link>
                <div className="truncate font-mono text-xs text-ink-3" title={source.path}>
                  {source.path}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs">
                {KIND_LABELS[source.kind] ?? source.kind}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs text-ink-3">
              <span>読み込み {source.loader}</span>
              <span>目的の列 {source.target ?? 'なし'}</span>
              {source.problem && <span>問題の設定から</span>}
              {!source.exists && (
                <span className="flex items-center gap-1 text-critical-text">
                  <AlertTriangle size={12} aria-hidden /> ファイルがありません
                </span>
              )}
              <button
                type="button"
                aria-label={`${source.name} の登録を外す`}
                onClick={() => {
                  if (window.confirm(`${source.name} の登録を外しますか? (ファイルは消えません)`)) {
                    remove.mutate(source.id)
                  }
                }}
                className="ml-auto rounded p-1 hover:bg-surface-2"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
          </Card>
        ))}
      </div>
      {adding && <AddSourceDialog mode={adding} onClose={() => setAdding(null)} onAdded={added} />}
    </>
  )
}
