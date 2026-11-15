import { keepPreviousData, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'

import { api } from '../../api/client'
import type { PointsItem, Profile, Source } from '../../api/types'
import { Button, Card, ErrorBox, Spinner, StatTile } from '../../components/ui'
import { formatCount, formatNumber } from '../../lib/format'
import { useDebounced } from '../../lib/useDebounced'
import { PointCloudView } from './PointCloudView'

// 1 ページの件数
const PAGE = { image: 48, text: 30, pointcloud: 20 } as Record<string, number>

// 一覧の画像の長い辺 (画素)
const THUMBNAIL = 256

/** 1 つの点群を読んで 3D で描く */
function PointCloudItem({ sourceId, index }: { sourceId: string; index: number }) {
  const item = useQuery({
    queryKey: ['item', sourceId, index],
    queryFn: () => api.item<PointsItem>(sourceId, index),
  })
  if (item.isPending) return <Spinner label="点群を読み込み中" />
  if (item.error) return <ErrorBox error={item.error} />
  return (
    <div>
      <p className="mb-2 text-xs text-ink-3">
        点 {formatCount(item.data.count)} 個
        {item.data.points.length / 3 < item.data.count &&
          ` (表示は ${formatCount(item.data.points.length / 3)} 個. 間引きと, 座標が数でない点を除く)`}
      </p>
      <PointCloudView item={item.data} label={`${index} 番目の点群`} />
    </div>
  )
}

/** 一覧の 1 枚の画像 (読めなければ代わりの表示. 小さな画像は画素をぼかさない) */
function Thumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  const [small, setSmall] = useState(false)
  if (failed) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded bg-surface-2 text-xs text-ink-3">
        読めません
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={(event) => setSmall(event.currentTarget.naturalWidth < 128)}
      className={clsx(
        'aspect-square w-full rounded bg-surface-2 object-contain',
        small && '[image-rendering:pixelated]',
      )}
    />
  )
}

/** 画像, 文, 点群の中身を 1 件ずつ見る */
export function SamplesTab({ source, profile }: { source: Source; profile: Profile }) {
  const kind = source.kind
  const page = PAGE[kind] ?? 30
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState('')
  const search = useDebounced(query)
  const [selected, setSelected] = useState<number | null>(null)
  const rows = useQuery({
    queryKey: ['rows', source.id, offset, search, page],
    queryFn: () => api.rows(source.id, { offset, limit: page, query: search }),
    placeholderData: keepPreviousData,
  })
  const data = rows.data
  const items = profile.items
  // 列の位置 (行の値を名前で取り出すため)
  const position = (name: string) => data?.columns.findIndex((column) => column.name === name) ?? -1
  const valueOf = (row: unknown[], name: string) => {
    const at = position(name)
    return at >= 0 ? row[at] : undefined
  }
  return (
    <div className="space-y-4">
      {items && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="件数" value={formatCount(items.count)} />
          {items.sizes && items.sizes[0] && (
            <StatTile
              label="最も多い大きさ"
              value={`${items.sizes[0].width}×${items.sizes[0].height}`}
              hint={`${items.sizes.length} 種類`}
            />
          )}
          {items.modes && <StatTile label="色の形式" value={Object.keys(items.modes).join(', ')} />}
          {items.brightness !== undefined && (
            <StatTile
              label="明るさの平均"
              value={formatNumber(items.brightness)}
              hint="0 から 255"
            />
          )}
          {items.unreadable !== undefined && (
            <StatTile label="読めないファイル" value={items.unreadable} />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="sample-query">
          絞り込む
        </label>
        <input
          id="sample-query"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOffset(0)
            setSelected(null)
          }}
          placeholder="ラベルやファイルの名前で絞り込む"
          className="h-8 w-72 rounded-lg border border-line bg-surface px-2 text-sm"
        />
        {data && (
          <span className="text-sm text-ink-3">
            {data.total === 0
              ? '合う件がありません'
              : `${formatNumber(data.total)} 件のうち ${data.offset + 1}–${Math.min(data.offset + page, data.total)}`}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page))}>
            前へ
          </Button>
          <Button
            disabled={!data || offset + page >= data.total}
            onClick={() => setOffset(offset + page)}
          >
            次へ
          </Button>
        </div>
      </div>
      {rows.isPending && <Spinner />}
      {rows.error && <ErrorBox error={rows.error} />}
      {data && kind === 'image' && (
        <ul
          aria-label="画像"
          className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8"
        >
          {data.rows.map((row, at) => {
            const index = data.index[at]!
            const label = valueOf(row, 'label')
            const path = String(valueOf(row, 'path') ?? index)
            return (
              <li key={index}>
                <figure className="rounded-lg border border-line bg-surface p-1.5">
                  <Thumbnail
                    src={`${api.itemUrl(source.id, index)}?size=${THUMBNAIL}`}
                    alt={`${path}${label ? ` (${label})` : ''}`}
                  />
                  <figcaption className="mt-1 truncate text-xs" title={path}>
                    {label ? <span className="font-semibold">{String(label)} </span> : null}
                    <span className="text-ink-3">
                      {String(valueOf(row, 'width'))}×{String(valueOf(row, 'height'))}
                    </span>
                  </figcaption>
                </figure>
              </li>
            )
          })}
        </ul>
      )}
      {data && kind === 'text' && (
        <ul
          aria-label="文"
          className="divide-y divide-line rounded-xl border border-line bg-surface"
        >
          {data.rows.map((row, at) => {
            const label = valueOf(row, 'label')
            return (
              <li key={data.index[at]} className="px-4 py-2 text-sm">
                <div className="mb-1 flex gap-2 text-xs text-ink-3">
                  <span className="tabular">#{data.index[at]}</span>
                  {label !== undefined && (
                    <span className="font-semibold text-ink-2">{String(label)}</span>
                  )}
                  <span>{String(valueOf(row, 'length'))} 文字</span>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap">{String(valueOf(row, 'text'))}</p>
              </li>
            )
          })}
        </ul>
      )}
      {data && kind === 'pointcloud' && (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <ul
            aria-label="点群"
            className="max-h-[70vh] overflow-auto rounded-xl border border-line bg-surface"
          >
            {data.rows.map((row, at) => {
              const index = data.index[at]!
              const label = valueOf(row, 'label')
              return (
                <li key={index}>
                  <button
                    type="button"
                    aria-current={selected === index}
                    onClick={() => setSelected(index)}
                    className={clsx(
                      'flex w-full flex-col px-3 py-1.5 text-left text-sm hover:bg-surface-2',
                      selected === index && 'bg-accent-soft',
                    )}
                  >
                    <span className="truncate font-mono">{String(valueOf(row, 'path'))}</span>
                    <span className="text-xs text-ink-3">
                      {label !== undefined && `${String(label)} · `}点{' '}
                      {formatNumber(valueOf(row, 'points'))}
                      {valueOf(row, 'error') ? ' · 読めません' : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <Card title={selected === null ? '点群を選んでください' : `${selected} 番目の点群`}>
            {selected === null ? (
              <p className="text-sm text-ink-3">左の一覧から選ぶと, 3D で表示します.</p>
            ) : (
              <PointCloudItem sourceId={source.id} index={selected} />
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
