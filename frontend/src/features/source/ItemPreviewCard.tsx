import { useMutation } from '@tanstack/react-query'
import clsx from 'clsx'
import { Eye } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../api/client'
import type { ItemPreviewItem, PointsItem, Recipe } from '../../api/types'
import { Button, Card, ErrorBox, Spinner } from '../../components/ui'
import { formatCount } from '../../lib/format'
import { PointCloudView } from './PointCloudView'

// 文の後の番号の並びで見せる数
const TOKENS = 48

/** 形を (3, 32, 32) のように書く */
function shapeText(shape: number[]) {
  return `(${shape.join(', ')})`
}

/** 画像の前と後 */
function ImagePair({ item }: { item: ItemPreviewItem }) {
  return (
    <figure className="rounded-lg border border-line bg-surface p-2">
      <div className="grid grid-cols-2 gap-2">
        {(['before', 'after'] as const).map((side) => (
          <div key={side}>
            <img
              src={item[side] as string}
              alt={`#${item.index} の${side === 'before' ? '手順の前' : '手順の後'}`}
              className="aspect-square w-full rounded bg-surface-2 object-contain [image-rendering:pixelated]"
            />
            <div className="mt-0.5 text-center text-[10px] text-ink-3">
              {side === 'before' ? '前' : '後'}
            </div>
          </div>
        ))}
      </div>
      <figcaption className="mt-1 truncate text-xs">
        {item.label && <span className="font-semibold">{item.label} </span>}
        <span className="text-ink-3">
          #{item.index} {shapeText(item.shape)}
        </span>
      </figcaption>
    </figure>
  )
}

/** 文の前と, 後の番号の並び (語に戻したもの) */
function TextPair({ item }: { item: ItemPreviewItem }) {
  const tokens = item.after as [number, string][]
  // 後ろの詰め物 (<pad>) は 1 つにまとめる
  let end = tokens.length
  while (end > 0 && tokens[end - 1]![1] === '<pad>') end -= 1
  const shown = tokens.slice(0, Math.min(end, TOKENS))
  const pads = tokens.length - end
  return (
    <li className="px-4 py-2 text-sm">
      <div className="mb-1 flex gap-2 text-xs text-ink-3">
        <span className="tabular">#{item.index}</span>
        {item.label && <span className="font-semibold text-ink-2">{item.label}</span>}
        <span>{shapeText(item.shape)}</span>
      </div>
      <p className="line-clamp-2 whitespace-pre-wrap">{item.before as string}</p>
      <ul aria-label="番号の並び" className="mt-1 flex flex-wrap gap-1">
        {shown.map(([id, word], at) => (
          <li
            key={at}
            title={`番号 ${id}`}
            className={clsx(
              'rounded px-1 font-mono text-[11px]',
              word === '<unk>'
                ? 'bg-surface-2 text-warning-text'
                : 'bg-accent-soft text-accent-text',
            )}
          >
            {word}
          </li>
        ))}
        {end > TOKENS && <li className="text-[11px] text-ink-3">… 他 {end - TOKENS}</li>}
        {pads > 0 && (
          <li
            title="長さをそろえる詰め物 (番号 0)"
            className="rounded bg-surface-2 px-1 font-mono text-[11px] text-ink-3"
          >
            {'<pad>'} × {pads}
          </li>
        )}
      </ul>
    </li>
  )
}

/** 点群の前と後 (選んだ 1 件) */
function CloudPair({ items }: { items: ItemPreviewItem[] }) {
  const [at, setAt] = useState(0)
  const item = items[Math.min(at, items.length - 1)]
  if (!item) return null
  const before = item.before as PointsItem
  const after = item.after as PointsItem
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-ink-3">件</span>
        <select
          value={at}
          onChange={(event) => setAt(Number(event.target.value))}
          className="h-8 rounded border border-line bg-surface px-2"
        >
          {items.map((entry, position) => (
            <option key={entry.index} value={position}>
              #{entry.index} {entry.label ?? ''}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-ink-3">前 (点 {formatCount(before.count)})</p>
          <PointCloudView item={before} label={`#${item.index} の手順の前`} />
        </div>
        <div>
          <p className="mb-1 text-xs text-ink-3">
            後 (点 {formatCount(after.count)}, 形 {shapeText(item.shape)})
          </p>
          <PointCloudView item={after} label={`#${item.index} の手順の後`} />
        </div>
      </div>
    </div>
  )
}

/** 中身の手順を数件にかけた前と後 (押したときに読む) */
export function ItemPreviewCard({
  sourceId,
  kind,
  recipe,
}: {
  sourceId: string
  kind: string
  recipe: Recipe
}) {
  const run = useMutation({
    mutationFn: (current: Recipe) => api.itemPreview(sourceId, current),
  })
  const data = run.data
  // 試した後に手順を変えた場合は, 古い結果だと分かるようにする
  const stale =
    run.variables !== undefined && JSON.stringify(run.variables) !== JSON.stringify(recipe)
  return (
    <Card
      title="中身の手順の前と後"
      actions={
        <Button icon={Eye} disabled={run.isPending} onClick={() => run.mutate(recipe)}>
          {data ? 'もう一度試す' : '数件で試す'}
        </Button>
      }
    >
      {!data && !run.isPending && !run.error && (
        <p className="text-sm text-ink-3">
          「数件で試す」で, 学習用から選んだ数件に中身の手順をかけた前と後を見られます. 値を学ぶ手順
          (正規化, 語彙) は, 学習用の少ない見本で当てはめます.
        </p>
      )}
      {run.isPending && <Spinner label="中身を読んで試しています" />}
      {run.error && <ErrorBox error={run.error} />}
      {data && (
        <div className={clsx('space-y-2', stale && '[&>:not(:first-child)]:opacity-50')}>
          {stale ? (
            <p role="status" className="text-sm font-semibold text-warning-text">
              手順が変わりました. 「もう一度試す」で今の手順の前と後を見られます
              (下は前の手順の結果).
            </p>
          ) : (
            <p className="text-xs text-ink-3">
              学習用の {formatCount(data.fit_rows)} 件で当てはめた
              (書き出しではもっと多くの件で当てはめます).
            </p>
          )}
          {kind === 'image' && (
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {data.items.map((item) => (
                <li key={item.index}>
                  <ImagePair item={item} />
                </li>
              ))}
            </ul>
          )}
          {kind === 'text' && (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {data.items.map((item) => (
                <TextPair key={item.index} item={item} />
              ))}
            </ul>
          )}
          {kind === 'pointcloud' && <CloudPair items={data.items} />}
        </div>
      )}
    </Card>
  )
}
