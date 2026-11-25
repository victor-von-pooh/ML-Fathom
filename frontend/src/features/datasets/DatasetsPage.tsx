import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Database, Upload } from 'lucide-react'
import { Link } from 'react-router'

import { api } from '../../api/client'
import type {
  ItemsDataset,
  ModelInputs,
  TableDataset,
  UnreadableDataset,
  DatasetSummary,
} from '../../api/types'
import { Card, EmptyState, ErrorBox, PageHeader, Spinner } from '../../components/ui'
import { stepText } from '../../lib/entrySteps'
import { formatNumber, KIND_LABELS, TASK_LABELS } from '../../lib/format'
import { AnomalyRows } from '../source/AnomalyRows'
import {
  conventionText,
  depthConventionText,
  ENTRY_KIND_LABELS,
  ORIGIN_LABELS,
  originNote,
  ROLE_LABELS,
} from '../../lib/pairs'
import { splitLabel } from '../../lib/recipe'

/** 分割ごとの数を 1 行にする */
function splitText(splits: Record<string, number>, unit: string): string {
  return Object.entries(splits)
    .map(([split, count]) => `${splitLabel(split)} ${formatNumber(count)}${unit}`)
    .join(', ')
}

/** 場所と作った時刻 (どの版にも共通) */
function Footer({ item }: { item: DatasetSummary }) {
  return (
    <>
      <dt className="text-ink-3">場所</dt>
      <dd className="truncate font-mono text-xs" title={item.path}>
        {item.path}
      </dd>
      <dt className="text-ink-3">作った時刻</dt>
      <dd>{item.created_at?.slice(0, 19).replace('T', ' ') ?? '—'}</dd>
    </>
  )
}

/** 出す値の数の説明 (分類はクラスの数, 他は値の数) */
function outputsText(model: ModelInputs): string {
  if (model.outputs === null) return 'なし (タスクを決めていません)'
  if (model.task === 'classification') return `${model.outputs} (クラスの数)`
  if (model.task === 'anomaly')
    return `${model.outputs} (モデルが入力を作り直す値の数. 学習に使う列の数と同じ)`
  return `${model.outputs} (値)`
}

/** モデルに要るもの (ML-EDA の model_inputs). モデルの入力と最後の層の出す数に合わせる */
function ModelNeeds({ model }: { model: ModelInputs }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {model.inputs.map((input) => (
        <li key={input.name}>
          入力 <span className="font-mono">{input.name}</span>:{' '}
          <span className="font-mono">
            [{input.shape.map((size) => (size === null ? 'バッチ' : String(size))).join(', ')}]{' '}
            {input.dtype}
          </span>
          {input.vocabulary !== undefined && <>, 語彙の大きさ {input.vocabulary}</>}
        </li>
      ))}
      <li>出す値: {outputsText(model)}</li>
    </ul>
  )
}

/** 版 1 (1 件 = 1 行の表) */
/** プロジェクトへ書き出したものの元 (登録したデータか問題の設定) */
function ProjectRow({ item }: { item: DatasetSummary }) {
  if (item.project === undefined) return null
  const from = item.project_from === 'problem' ? '問題の設定' : 'データ'
  return (
    <>
      <dt className="text-ink-3">プロジェクト</dt>
      <dd>
        {item.project
          ? `${from} ${item.project} からプロジェクトへ書き出したもの`
          : 'プロジェクトへ書き出したもの'}
      </dd>
    </>
  )
}

function TableCard({ item }: { item: TableDataset }) {
  return (
    <Card
      title={<span className="font-mono">{item.name}</span>}
      actions={
        <span className="flex gap-1">
          {item.project !== undefined && <Badge>プロジェクト</Badge>}
          <Badge>版 1 · 表</Badge>
        </span>
      }
    >
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
        <dd>{splitText(item.splits, '')}</dd>
        {item.anomaly && (
          <>
            <dt className="text-ink-3">正解と異常</dt>
            <dd>
              <AnomalyRows summary={item.anomaly} />
            </dd>
          </>
        )}
        <dt className="text-ink-3">モデルに要るもの</dt>
        <dd>
          <ModelNeeds model={item.model} />
        </dd>
        <ProjectRow item={item} />
        <Footer item={item} />
      </dl>
    </Card>
  )
}

/** 版 2 と版 3 (入力と正解がファイルの組. 版 3 は項目ごとの中身の手順を持つ) */
function ItemsCard({ item }: { item: ItemsDataset }) {
  const origin = item.target.origin
  const note = originNote(origin)
  const settings = origin.settings ?? {}
  const stepped = item.entries.some((entry) => entry.steps && entry.steps.length > 0)
  // 群分けの表は正解を持たず, 入力の項目は表の列 (正解の出どころと座標の決まりは無い)
  const grouped = item.role === 'group'
  return (
    <Card
      title={<span className="font-mono">{item.name}</span>}
      actions={
        <span className="flex gap-1">
          {item.project !== undefined && <Badge>プロジェクト</Badge>}
          <Badge>{`版 ${String(item.format_version)} · ${grouped ? '群分けの表' : 'ファイルの組'}`}</Badge>
        </span>
      }
    >
      <dl className="grid grid-cols-[7rem_1fr] gap-1 text-sm">
        <dt className="text-ink-3">受け持ちと正解</dt>
        <dd>
          {item.role ? (ROLE_LABELS[item.role] ?? item.role) : '—'} ·{' '}
          {grouped
            ? '正解なし'
            : item.target.kind
              ? `${ENTRY_KIND_LABELS[item.target.kind] ?? item.target.kind} (${item.target.kind})`
              : '—'}
        </dd>
        <dt className="text-ink-3">項目</dt>
        <dd>
          <table className="w-full text-xs">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="pr-2 font-normal">名前</th>
                <th className="pr-2 font-normal">種類</th>
                <th className="pr-2 font-normal">単位</th>
                <th className={stepped ? 'pr-2 font-normal' : 'font-normal'}>座標の決まり</th>
                {stepped && <th className="font-normal">中身の手順</th>}
              </tr>
            </thead>
            <tbody>
              {item.entries.map((entry) => (
                <tr key={entry.name} className="align-top">
                  <td className="pr-2 font-mono">
                    {entry.name}
                    <span className="ml-1 text-ink-3">
                      ({entry.role === 'target' ? '正解' : '入力'})
                    </span>
                  </td>
                  <td className="pr-2">{ENTRY_KIND_LABELS[entry.kind] ?? 'その他の値'}</td>
                  <td className="pr-2">{entry.units ?? '—'}</td>
                  <td className={stepped ? 'break-all pr-2' : 'break-all'}>
                    <span className="font-mono">{conventionText(entry.convention)}</span>
                    {depthConventionText(entry.kind, entry.convention) && (
                      <div className="text-ink-2">
                        {depthConventionText(entry.kind, entry.convention)}
                      </div>
                    )}
                  </td>
                  {stepped && (
                    <td className="font-mono break-all">
                      {entry.steps && entry.steps.length > 0
                        ? entry.steps.map(stepText).join(' → ')
                        : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </dd>
        <dt className="text-ink-3">分割</dt>
        <dd>
          {splitText(item.splits, ' 件')} (全て {formatNumber(item.items)} 件)
        </dd>
        {!grouped && (
          <>
            <dt className="text-ink-3">正解の出どころ</dt>
            <dd>
              {ORIGIN_LABELS[origin.type] ?? origin.type} ({origin.type})
              {origin.name && <span className="ml-1 font-mono">{origin.name}</span>}
              {Object.keys(settings).length > 0 && (
                <div className="font-mono text-xs break-all text-ink-2">
                  {JSON.stringify(settings)}
                </div>
              )}
              {note && <p className="mt-1 text-xs text-warning-text">{note}</p>}
            </dd>
          </>
        )}
        {item.normalization && (
          <>
            <dt className="text-ink-3">正規化</dt>
            <dd>{item.normalization} (表の shift の列. 推論のときは同じ正規化をかける)</dd>
          </>
        )}
        {item.notes.length > 0 && (
          <>
            <dt className="text-ink-3">書き出しの注意</dt>
            <dd>
              <ul className="list-disc pl-4 text-xs text-warning-text">
                {item.notes.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <ProjectRow item={item} />
        <Footer item={item} />
      </dl>
    </Card>
  )
}

/** 読めないもの (知らない版, 壊れたもの). 一覧から消さずに理由を出す */
function UnreadableCard({ item }: { item: UnreadableDataset }) {
  return (
    <Card
      title={<span className="font-mono">{item.name}</span>}
      actions={
        <span className="flex items-center gap-1 text-xs text-critical-text">
          <AlertTriangle size={14} aria-hidden />
          {item.unknown_version ? '読めない版' : '読めない'}
        </span>
      }
    >
      <dl className="grid grid-cols-[7rem_1fr] gap-1 text-sm">
        <dt className="text-ink-3">版</dt>
        <dd className="font-mono">{String(item.format_version ?? '—')}</dd>
        <dt className="text-ink-3">理由</dt>
        <dd className="break-words">{item.error}</dd>
        <Footer item={item} />
      </dl>
    </Card>
  )
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">{children}</span>
  )
}

/** 書き出した学習用のデータセットの一覧 */
export function DatasetsPage() {
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: api.datasets })
  return (
    <>
      <PageHeader
        title="書き出したデータセット"
        subtitle="表は load_dataset, ファイルの組 (版 2, 3) は load_items で ML-EDA から読み込めます"
        actions={
          <Link
            to="/datasets/export"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
          >
            <Upload className="size-4" aria-hidden />
            ファイルの組を書き出す
          </Link>
        }
      />
      {datasets.isPending && <Spinner />}
      {datasets.error && <ErrorBox error={datasets.error} />}
      {datasets.data?.length === 0 && (
        <EmptyState icon={Database} title="まだ書き出していません">
          データの「前処理と書き出し」で学習用に書き出すか, 「ファイルの組を書き出す」で 画像と領域,
          撮影と点群の組を書き出すと, ここに並びます.
        </EmptyState>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {datasets.data?.map((item) =>
          item.form === 'table' ? (
            <TableCard key={item.path} item={item} />
          ) : item.form === 'items' ? (
            <ItemsCard key={item.path} item={item} />
          ) : (
            <UnreadableCard key={item.path} item={item} />
          ),
        )}
      </div>
    </>
  )
}
