import { useQuery } from '@tanstack/react-query'
import { Database } from 'lucide-react'

import { api } from '../../api/client'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { formatNumber, KIND_LABELS, TASK_LABELS } from '../../lib/format'

/** 書き出した学習用のデータセットの一覧 */
export function DatasetsPage() {
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: api.datasets })
  return (
    <>
      <PageHeader
        title="書き出したデータセット"
        subtitle="ML-Found の学習スクリプトで load_dataset から読み込めます"
      />
      {datasets.isPending && <Spinner />}
      {datasets.error && <ErrorBox error={datasets.error} />}
      {datasets.data?.length === 0 && (
        <EmptyState icon={Database} title="まだ書き出していません">
          データの「前処理と書き出し」で学習用に書き出すと, ここに並びます.
        </EmptyState>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {datasets.data?.map((item) => (
          <Card key={item.path} title={<span className="font-mono">{item.name}</span>}>
            <dl className="grid grid-cols-[7rem_1fr] gap-1 text-sm">
              <dt className="text-ink-3">種類とタスク</dt>
              <dd>
                {KIND_LABELS[item.kind] ?? item.kind} · {TASK_LABELS[item.task] ?? item.task}
              </dd>
              <dt className="text-ink-3">目的の列</dt>
              <dd className="font-mono">{item.target ?? 'なし'}</dd>
              <dt className="text-ink-3">学習に使う列</dt>
              <dd>{item.features}</dd>
              <dt className="text-ink-3">分割</dt>
              <dd>
                {Object.entries(item.splits)
                  .map(([split, rows]) => `${split} ${formatNumber(rows)}`)
                  .join(', ')}
              </dd>
              <dt className="text-ink-3">場所</dt>
              <dd className="truncate font-mono text-xs" title={item.path}>
                {item.path}
              </dd>
              <dt className="text-ink-3">作った時刻</dt>
              <dd>{item.created_at?.slice(0, 19).replace('T', ' ')}</dd>
            </dl>
          </Card>
        ))}
      </div>
    </>
  )
}
