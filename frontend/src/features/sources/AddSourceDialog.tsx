import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowUp, ClipboardList, File, Folder, Home } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { api } from '../../api/client'
import type { Source } from '../../api/types'
import { Dialog } from '../../components/Dialog'
import { Button, ErrorBox, Spinner } from '../../components/ui'
import { formatBytes, KIND_LABELS } from '../../lib/format'

/**
 * ML-Pathfinder の置き場にある問題の設定の一覧. 押すとその問題の設定を選ぶ.
 * 始められないものも理由を付けて並べる
 */
function StoredProblems({
  picked,
  onPick,
}: {
  picked: string | null
  onPick: (path: string) => void
}) {
  const problems = useQuery({ queryKey: ['problems'], queryFn: api.problems })
  const list = problems.data
  return (
    <section aria-labelledby="stored-problems" className="mb-4">
      <h3 id="stored-problems" className="mb-1 text-xs font-semibold text-ink-2">
        ML-Pathfinder に保存した問題の設定
      </h3>
      {problems.isPending && <Spinner />}
      {problems.error && <ErrorBox error={problems.error} />}
      {list?.error && <p className="text-xs text-critical-text">{list.error}</p>}
      {list && list.problems.length === 0 && !list.error && (
        <p className="text-xs text-ink-3">
          置き場 (<span className="font-mono">{list.root}</span>) に問題の設定がありません.
          下のファイルの選び方で選べます.
        </p>
      )}
      {list && list.problems.length > 0 && (
        <ul
          aria-label="保存した問題の設定"
          className="max-h-48 overflow-auto rounded-lg border border-line"
        >
          {list.problems.map((item) => (
            <li key={item.path}>
              <button
                type="button"
                onClick={() => onPick(item.path)}
                // 始められないものは理由を出して選べなくする
                disabled={!item.startable}
                aria-pressed={picked === item.path}
                aria-describedby={item.reason ? `reason-${item.path}` : undefined}
                className={clsx(
                  'flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-70',
                  picked === item.path && 'bg-accent-soft',
                )}
              >
                <ClipboardList size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.name}</span>
                  <span className="block truncate font-mono text-xs text-ink-3" title={item.path}>
                    {item.path}
                  </span>
                  {item.reason && (
                    <span id={`reason-${item.path}`} className="block text-xs text-warning-text">
                      {item.reason}
                    </span>
                  )}
                  {item.project?.dataset && (
                    <span className="block text-xs text-ink-2">プロジェクトあり</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-ink-3">
                  {item.updated_at?.slice(0, 16).replace('T', ' ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * ファイルかディレクトリを選び, 読み込みを確かめて登録する.
 * problem では問題の設定 (ML-Pathfinder の置き場の一覧か, problem.yaml か
 * それを持つディレクトリ) を選び, 決めた状態で始める
 */
export function AddSourceDialog({
  onClose,
  onAdded,
  mode = 'data',
}: {
  onClose: () => void
  onAdded: (source: Source) => void
  mode?: 'data' | 'problem'
}) {
  const fromProblem = mode === 'problem'
  const [dir, setDir] = useState('~')
  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [loader, setLoader] = useState<string>('')
  // 開けないディレクトリ (権限が無いなど) の後も, 前の一覧と「上へ」を使えるように
  const listing = useQuery({
    queryKey: ['browse', dir],
    queryFn: () => api.browse(dir),
    placeholderData: keepPreviousData,
  })
  const candidates = useQuery({
    queryKey: ['detect', picked],
    queryFn: () => api.detect(picked!),
    enabled: picked !== null && !fromProblem,
  })
  const navigate = useNavigate()
  const start = useMutation({
    mutationFn: () => api.startFromProblem(picked!),
    // ファイルの組の受け持ちはデータを登録せず, 書き出しの画面へ問題の設定を付けて移る
    onSuccess: (result) => {
      if (result.source) {
        onAdded(result.source)
        return
      }
      const search = new URLSearchParams({ form: result.form ?? '', problem: result.problem })
      onClose()
      void navigate(`/datasets/export?${search.toString()}`)
    },
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
    start.reset()
  }
  const best = candidates.data?.[0]
  return (
    <Dialog title={fromProblem ? '問題の設定から始める' : 'データを追加'} onClose={onClose}>
      {fromProblem ? (
        <p className="mb-3 text-xs text-ink-2">
          ML-Pathfinder に保存した問題の設定を一覧から選ぶか, problem.yaml (か,
          それを持つディレクトリ) をファイルから選びます. 入れたデータを登録し, 目的の列, タスク,
          分割, 使わない列を決めた状態で始めます. ここで変えた選び方は,
          前処理のタブから問題の設定に書き戻せます. 正解が画像の領域か点群の問題の設定は,
          ファイルの組の書き出しを問題の設定の値で埋めて開きます.
        </p>
      ) : (
        <p className="mb-3 text-xs text-ink-2">
          分析するファイル (csv, json, parquet, xlsx, 画像, 文, 点群など) か,
          画像や文のファイルを集めたディレクトリや, 多視点の撮影 (transforms.json を持つ)
          のディレクトリを選びます. 元のファイルは変えません.
        </p>
      )}
      {fromProblem && <StoredProblems picked={picked} onPick={pick} />}
      {fromProblem && <h3 className="mb-1 text-xs font-semibold text-ink-2">ファイルから選ぶ</h3>}
      <form
        className="mb-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          // ディレクトリなら開き, ファイルならそれを選ぶ
          const value = typed.trim()
          if (!value) return
          api.browse(value).then(
            () => setDir(value),
            () => pick(value),
          )
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
          <li key={entry.path} className="flex items-center">
            <button
              type="button"
              onClick={() => pick(entry.path)}
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
              {!entry.is_dir && (
                <span className="text-xs text-ink-3">{formatBytes(entry.size)}</span>
              )}
            </button>
            {entry.is_dir && (
              <Button
                variant="ghost"
                className="mr-1 shrink-0"
                aria-label={`${entry.name} を開く`}
                onClick={() => setDir(entry.path)}
              >
                開く
              </Button>
            )}
          </li>
        ))}
        {listing.data?.truncated && (
          <li className="px-3 py-2 text-xs text-ink-3">
            多いので先頭の 1000 件だけを出しています.
          </li>
        )}
        {listing.data?.entries.length === 0 && (
          <li className="px-3 py-2 text-sm text-ink-3">空のディレクトリです.</li>
        )}
      </ul>
      {picked && (
        <section aria-label="選んだ場所" className="rounded-lg border border-line p-3">
          <div className="mb-2 truncate font-mono text-sm">{picked}</div>
          {fromProblem && (
            <div className="flex justify-end">
              <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? '読み込み中…' : 'この問題の設定から始める'}
              </Button>
            </div>
          )}
          {start.error && <ErrorBox error={start.error} />}
          {!fromProblem && candidates.isPending && <Spinner label="形式を調べています" />}
          {!fromProblem && candidates.error && <ErrorBox error={candidates.error} />}
          {!fromProblem && candidates.data && candidates.data.length === 0 && (
            <p className="text-sm text-critical-text">この場所を読める読み込みがありません.</p>
          )}
          {!fromProblem && best && (
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
