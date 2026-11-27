import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowUp, Folder, Home } from 'lucide-react'
import { useId, useState } from 'react'

import { useApi } from '../api/client'
import { Dialog } from './Dialog'
import { Button, ErrorBox, Spinner } from './ui'

/** ディレクトリをたどって 1 つを選ぶ対話の枠 (ディレクトリだけを並べる) */
function FolderDialog({
  title,
  start,
  onPick,
  onClose,
}: {
  title: string
  start: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const api = useApi()
  const [dir, setDir] = useState(start || '~')
  // 開けないディレクトリの後も, 前の一覧と「上へ」を使えるように
  const listing = useQuery({
    queryKey: ['browse', dir],
    queryFn: () => api.browse(dir),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const folders = listing.data?.entries.filter((entry) => entry.is_dir) ?? []
  return (
    <Dialog title={title} onClose={onClose}>
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
        {/* 開けなかった場合は前の一覧が残るので, 選べないようにする */}
        {listing.data && !listing.isError && (
          <Button variant="primary" className="ml-auto" onClick={() => onPick(listing.data.path)}>
            このディレクトリを選ぶ
          </Button>
        )}
      </div>
      {listing.isPending && <Spinner />}
      {listing.error && <ErrorBox error={listing.error} />}
      <ul
        aria-label="ディレクトリ"
        className="max-h-72 overflow-auto rounded-lg border border-line"
      >
        {folders.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => setDir(entry.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              <Folder size={14} className="text-accent" aria-hidden />
              <span className="flex-1 truncate font-mono">{entry.name}</span>
            </button>
          </li>
        ))}
        {listing.data && folders.length === 0 && (
          <li className="px-3 py-2 text-sm text-ink-3">中にディレクトリはありません.</li>
        )}
      </ul>
    </Dialog>
  )
}

/** ディレクトリの場所の欄. 書くか, 「選ぶ」でたどって選ぶ */
export function FolderField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (path: string) => void
  placeholder?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <>
      <label htmlFor={id} className="text-ink-3">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 font-mono"
        />
        <Button aria-label={`${label}を選ぶ`} onClick={() => setOpen(true)}>
          選ぶ
        </Button>
      </div>
      {open && (
        <FolderDialog
          title={label}
          start={value}
          onClose={() => setOpen(false)}
          onPick={(path) => {
            onChange(path)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}
