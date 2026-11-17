import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ClipboardList } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../api/client'
import type { ProblemFinding, Recipe } from '../../api/types'
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
  recipe,
  onWritten,
}: {
  sourceId: string
  /** 編集中のレシピ (打つたびに試さないよう, 少し待ったもの) */
  recipe: Recipe | null
  onWritten: (recipe: Recipe) => void
}) {
  const queryClient = useQueryClient()
  const [picked, setPicked] = useState<Record<string, 'known' | 'drop'>>({})
  const key = ['problem-check', sourceId, JSON.stringify(recipe)]
  const check = useQuery({
    queryKey: key,
    queryFn: () => api.checkProblem(sourceId, recipe!),
    enabled: recipe !== null,
    retry: false,
  })
  const write = useMutation({
    mutationFn: () => api.writeProblem(sourceId, recipe!, picked),
    onSuccess: (result) => {
      setPicked({})
      queryClient.setQueryData(['recipe', sourceId], result.recipe)
      void queryClient.invalidateQueries({ queryKey: ['problem-check', sourceId] })
      onWritten(result.recipe)
    },
  })
  const data = check.data
  const choices = data?.choices ?? []
  const errors = data?.conflicts.filter((item) => item.level === 'error') ?? []
  const unanswered = choices.filter((choice) => !picked[choice.column])
  const blocked = !data || errors.length > 0 || unanswered.length > 0 || write.isPending
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
      {check.isPending && recipe !== null && <Spinner label="問題の設定と比べています" />}
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
          {choices.map((choice) => (
            <div key={choice.column} className="rounded-lg border border-line p-3">
              <p id={`choice-${choice.column}`} className="text-xs text-ink-2">
                {choice.message}
              </p>
              <div
                className="mt-2 flex flex-wrap gap-2"
                role="group"
                aria-labelledby={`choice-${choice.column}`}
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
      {write.data && (
        <div role="status" className="mt-3 text-xs text-good-text">
          書き戻しました (レシピもここに保存しました).
          {write.data.changes.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {write.data.changes.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}
