import { useMutation, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowUp, File, Folder, Home } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../api/client'
import type { Source } from '../../api/types'
import { Dialog } from '../../components/Dialog'
import { Button, ErrorBox, Spinner } from '../../components/ui'
import { formatBytes, KIND_LABELS } from '../../lib/format'

/** ファイルかディレクトリを選び, 読み込みを確かめて登録する */
export function AddSourceDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: (source: Source) => void
}) {
  const [dir, setDir] = useState('~')
  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [loader, setLoader] = useState<string>('')
  const listing = useQuery({ queryKey: ['browse', dir], queryFn: () => api.browse(dir) })
  const candidates = useQuery({
    queryKey: ['detect', picked],
    queryFn: () => api.detect(picked!),
    enabled: picked !== null,
  })
  const add = useMutation({
    mutationFn: () => api.createSource({ path: picked!, loader: loader || undefined }),
    onSuccess: onAdded,
  })

  // 選んだ場所 (ディレクトリも画像や文のまとまりとして選べる)
  const pick = (path: string) => {
    setPicked(path)
    setLoader('')
    add.reset()
  }
  const best = candidates.data?.[0]
  return (
    <Dialog title="データを追加" onClose={onClose}>
      <p className="mb-3 text-xs text-ink-2">
        分析するファイル (csv, json, parquet, xlsx, 画像, 文, 点群など) か,
        画像や文のファイルを集めたディレクトリを選びます. 元のファイルは変えません.
      </p>
      <form
        className="mb-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (typed.trim()) setDir(typed.trim())
        }}
      >
        <label className="sr-only" htmlFor="browse-path">
          ディレクトリのパス
        </label>
        <input
          id="browse-path"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={listing.data?.path ?? '~/data'}
          className="h-8 flex-1 rounded-lg border border-line bg-surface px-2 font-mono text-sm"
        />
        <Button type="submit">移動</Button>
      </form>
      <div className="mb-2 flex items-center gap-2 text-xs text-ink-3">
        <Button
          variant="ghost"
          icon={ArrowUp}
          disabled={!listing.data?.parent}
          onClick={() => listing.data?.parent && setDir(listing.data.parent)}
        >
          上へ
        </Button>
        <Button variant="ghost" icon={Home} onClick={() => setDir('~')}>
          ホーム
        </Button>
        <span className="truncate font-mono">{listing.data?.path}</span>
        {listing.data && (
          <Button variant="ghost" className="ml-auto" onClick={() => pick(listing.data.path)}>
            このディレクトリを選ぶ
          </Button>
        )}
      </div>
      {listing.isPending && <Spinner />}
      {listing.error && <ErrorBox error={listing.error} />}
      <ul
        aria-label="ディレクトリの中身"
        className="mb-4 max-h-64 overflow-auto rounded-lg border border-line"
      >
        {listing.data?.entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => (entry.is_dir ? pick(entry.path) : pick(entry.path))}
              onDoubleClick={() => entry.is_dir && setDir(entry.path)}
              className={clsx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2',
                picked === entry.path && 'bg-accent-soft',
              )}
            >
              {entry.is_dir ? (
                <Folder size={14} className="text-accent" aria-hidden />
              ) : (
                <File size={14} className="text-ink-3" aria-hidden />
              )}
              <span className="flex-1 truncate font-mono">{entry.name}</span>
              <span className="text-xs text-ink-3">
                {entry.is_dir ? 'ダブルクリックで開く' : formatBytes(entry.size)}
              </span>
            </button>
          </li>
        ))}
        {listing.data?.entries.length === 0 && (
          <li className="px-3 py-2 text-sm text-ink-3">空のディレクトリです.</li>
        )}
      </ul>
      {picked && (
        <section aria-label="選んだ場所" className="rounded-lg border border-line p-3">
          <div className="mb-2 truncate font-mono text-sm">{picked}</div>
          {candidates.isPending && <Spinner label="形式を調べています" />}
          {candidates.error && <ErrorBox error={candidates.error} />}
          {candidates.data && candidates.data.length === 0 && (
            <p className="text-sm text-critical-text">この場所を読める読み込みがありません.</p>
          )}
          {best && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="loader">読み込み</label>
              <select
                id="loader"
                value={loader || best.loader}
                onChange={(event) => setLoader(event.target.value)}
                className="h-8 rounded-lg border border-line bg-surface px-2"
              >
                {candidates.data!.map((item) => (
                  <option key={item.loader} value={item.loader}>
                    {item.loader} ({KIND_LABELS[item.kind] ?? item.kind}, 確からしさ{' '}
                    {Math.round(item.score * 100)}%)
                  </option>
                ))}
              </select>
              <Button
                variant="primary"
                className="ml-auto"
                disabled={add.isPending}
                onClick={() => add.mutate()}
              >
                {add.isPending ? '読み込み中…' : '追加'}
              </Button>
            </div>
          )}
          {add.error && <ErrorBox error={add.error} />}
        </section>
      )}
    </Dialog>
  )
}
