import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ClipboardList } from 'lucide-react'
import { useId, useState } from 'react'
import { Link } from 'react-router'

import { api, ApiError } from '../../api/client'
import type { GroupProblem, ProblemFinding, Recipe } from '../../api/types'
import { Button, Card, ErrorBox, Spinner } from '../../components/ui'

/** 食い違いの重さの名前と色 */
const LEVELS: Record<ProblemFinding['level'], { label: string; className: string }> = {
  error: { label: '誤り', className: 'text-critical-text' },
  warning: { label: '注意', className: 'text-warning-text' },
  info: { label: '知らせ', className: 'text-ink-2' },
}

/** 選ぶ問いの選択肢の名前 */
const OPTIONS = {
  known: '予測の時点で分かる列にする',
  drop: 'レシピで落とす',
} as const

/**
 * 問題の設定から始めたデータで, 編集中のレシピと問題の設定の食い違いを出し,
 * 選んだ答えとともに問題の設定に書き戻す
 */
export function ProblemCard({
  sourceId,
  notes = [],
  recipe,
  latest,
  paused = false,
  onWritten,
}: {
  sourceId: string
  /** 始めたときの ML-Quest の知らせ (作るものの落とす列と欠損, 画像の大きさなど) */
  notes?: string[]
  /** 編集中のレシピ (打つたびに試さないよう, 少し待ったもの) */
  recipe: Recipe | null
  /** 待つ前の最新の編集中のレシピ (書き戻すのはこれ) */
  latest: Recipe | null
  /** 問題の設定の受け持ちを読み直している間は確かめない (読み直した後に確かめ直す) */
  paused?: boolean
  onWritten: (recipe: Recipe) => void
}) {
  const queryClient = useQueryClient()
  const idBase = useId()
  const [picked, setPicked] = useState<Record<string, 'known' | 'drop'>>({})
  // 編集のたびにカードが消えないように, 確かめ直す間は前の結果を出す
  const check = useQuery({
    queryKey: ['problem-check', sourceId, JSON.stringify(recipe)],
    queryFn: () => api.checkProblem(sourceId, recipe!),
    // 受け持ちの読み直しと同時に確かめないよう, 画面に戻ったときは確かめ直さず,
    // 読み直しが済んで止めを外したときに確かめ直す (古くなった結果は外すと読み直す)
    enabled: recipe !== null && !paused,
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const data = check.data
  const choices = data?.choices ?? []
  const write = useMutation({
    mutationFn: () =>
      api.writeProblem(
        sourceId,
        latest!,
        // 今の選ぶ問いの答えだけ (前に出て消えた問いの答えは送らない)
        Object.fromEntries(
          choices.filter((c) => picked[c.column]).map((c) => [c.column, picked[c.column]!]),
        ),
        data?.version,
      ),
    onSuccess: (result) => {
      setPicked({})
      queryClient.setQueryData(['recipe', sourceId], result.recipe)
      void queryClient.invalidateQueries({ queryKey: ['problem-check', sourceId] })
      onWritten(result.recipe)
    },
    // 他で変わった (409) ら確かめ直す (古い印のまま押し続けないように)
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['problem-check', sourceId] })
      }
    },
  })
  const errors = data?.conflicts.filter((item) => item.level === 'error') ?? []
  const unanswered = choices.filter((choice) => !picked[choice.column])
  // 確かめが最新の編集に追いついていない間は書き戻さない
  const settling =
    check.isPlaceholderData || check.isFetching || JSON.stringify(latest) !== JSON.stringify(recipe)
  const blocked = !data || settling || errors.length > 0 || unanswered.length > 0 || write.isPending
  // 書き戻した後に編集したら, 書き戻しましたの表示を消す
  // (タスクは保存した後に推定で埋まることがあるので比べない)
  const withoutTask = (value: Recipe | null | undefined) =>
    JSON.stringify(value ? { ...value, task: null } : null)
  const written =
    write.data && withoutTask(latest) === withoutTask(write.data.recipe) ? write.data : null
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <ClipboardList className="size-4 text-accent" aria-hidden />
          問題の設定{data?.name ? `: ${data.name}` : ''}
        </span>
      }
      className="border-accent/50"
    >
      <p className="mb-3 text-xs text-ink-3">
        問題の設定 (ML-Pathfinder) で決めた状態から始めたデータです. ここで変えた選び方を,
        問題の設定と比べて書き戻せます. 列の使い方は自動では変えません.
      </p>
      {notes.length > 0 && (
        <section aria-label="始めたときの知らせ" className="mb-3">
          <h3 className="text-xs font-semibold text-ink-2">始めたときの知らせ</h3>
          <ul className="mt-1 list-disc pl-5 text-xs text-ink-2">
            {notes.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      )}
      {check.isPending && check.fetchStatus !== 'idle' && (
        <Spinner label="問題の設定と比べています" />
      )}
      {check.error && <ErrorBox error={check.error} />}
      {data && (
        <div className="space-y-3 text-sm">
          {data.changes.length > 0 && (
            <section aria-label="書き戻すと変わる点">
              <h3 className="text-xs font-semibold text-ink-2">書き戻すと変わる点</h3>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {data.changes.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </section>
          )}
          {data.conflicts.length > 0 && (
            <section aria-label="問題の設定との食い違い">
              <h3 className="text-xs font-semibold text-ink-2">問題の設定との食い違い</h3>
              <ul className="mt-1 space-y-1 text-xs">
                {data.conflicts.map((item) => (
                  <li key={item.message}>
                    <span className={clsx('mr-1 font-semibold', LEVELS[item.level].className)}>
                      {LEVELS[item.level].label}
                    </span>
                    {item.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {choices.map((choice, index) => (
            <div key={choice.column} className="rounded-lg border border-line p-3">
              <p id={`${idBase}-${index}`} className="text-xs text-ink-2">
                {choice.message}
              </p>
              <div
                className="mt-2 flex flex-wrap gap-2"
                role="group"
                aria-labelledby={`${idBase}-${index}`}
              >
                {choice.options.map((option) => (
                  <Button
                    key={option}
                    variant={picked[choice.column] === option ? 'primary' : 'secondary'}
                    aria-pressed={picked[choice.column] === option}
                    onClick={() => setPicked({ ...picked, [choice.column]: option })}
                  >
                    {OPTIONS[option]}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {data.changes.length === 0 && data.conflicts.length === 0 && choices.length === 0 && (
            <p className="text-xs text-good-text">問題の設定との食い違いはありません.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={blocked} onClick={() => write.mutate()}>
              {write.isPending ? '書き戻しています…' : '問題の設定に書き戻す'}
            </Button>
            <span role="status" className="text-xs text-ink-3">
              {errors.length > 0
                ? '誤りの食い違いを直すと書き戻せます'
                : unanswered.length > 0
                  ? `${unanswered.map((choice) => choice.column).join(', ')} の扱いを選んでください`
                  : ''}
            </span>
          </div>
          <p className="truncate font-mono text-xs text-ink-3" title={data.path}>
            {data.path}
          </p>
        </div>
      )}
      {write.error && <ErrorBox error={write.error} />}
      <div role="status" className="mt-3 text-xs text-good-text empty:hidden">
        {written && (
          <>
            書き戻しました (レシピもここに保存しました).
            {written.changes.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {written.changes.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

/**
 * まとめるで学習する問題の設定から始めたデータの「問題の設定」のカード.
 * まとめるはレシピを持たないので, 確かめと書き戻しをせず, 理由を案内として出して
 * 群分けのタブ (プロジェクトへ書き出す所) へ導く
 */
export function GroupProblemNote({ problem }: { problem: GroupProblem }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <ClipboardList className="size-4 text-accent" aria-hidden />
          問題の設定{problem.name ? `: ${problem.name}` : ''}
        </span>
      }
      className="border-accent/50"
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-2">
          まとめる (群分け) の問題の設定から始めたデータは, レシピを持ちません.
          学習のプロジェクトは表をファイル 1 つのまま読み, 分割も学習のプロジェクトが行うため,
          ここでの前処理は問題の設定に書き戻さず, プロジェクトへも書き出しません.
        </p>
        <p>
          <Link to="?tab=groups" replace className="text-accent-text underline">
            群分けのタブへ移る
          </Link>
          <span className="ml-1 text-xs text-ink-3">
            (答えた列で群を見て, 表をそのままプロジェクトへ書き出します)
          </span>
        </p>
        <p className="truncate font-mono text-xs text-ink-3" title={problem.path}>
          {problem.path}
        </p>
      </div>
    </Card>
  )
}
