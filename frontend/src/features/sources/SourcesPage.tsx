import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FolderSearch, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { api } from '../../api/client'
import { clearDraft } from '../../lib/drafts'
import { Button, Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { KIND_LABELS } from '../../lib/format'
import { AddSourceDialog } from './AddSourceDialog'

/** 登録したデータの一覧 */
export function SourcesPage() {
  const sources = useQuery({ queryKey: ['sources'], queryFn: api.listSources })
  const [adding, setAdding] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
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
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              データを追加
            </Button>
          </>
        }
      />
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
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sources.data?.map((source) => (
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
      {adding && (
        <AddSourceDialog
          onClose={() => setAdding(false)}
          onAdded={(source) => {
            void queryClient.invalidateQueries({ queryKey: ['sources'] })
            setAdding(false)
            void navigate(`/sources/${source.id}`)
          }}
        />
      )}
    </>
  )
}
