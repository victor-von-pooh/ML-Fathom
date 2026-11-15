import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleHelp } from 'lucide-react'

import { api } from '../../api/client'
import type { Recipe } from '../../api/types'
import { Button, Card, ErrorBox } from '../../components/ui'
import type { Decision, DecisionChoice } from '../../lib/decisions'
import { clearDraft } from '../../lib/drafts'

/** 自動では決めきれないことを, 選択肢のボタンで決めてもらう */
export function DecisionsCard({
  sourceId,
  decisions,
  onRecipe,
  onDecide,
}: {
  sourceId: string
  decisions: Decision[]
  onRecipe: (recipe: Recipe) => void
  onDecide: (id: string) => void
}) {
  const queryClient = useQueryClient()
  // 読み方と目的の列はデータの設定を変える (読み方を変えると分析をやり直す)
  const source = useMutation({
    mutationFn: (patch: { target?: string | null; options?: Record<string, unknown> }) =>
      api.updateSource(sourceId, patch),
    onSuccess: (_, patch) => {
      if (patch.options) {
        clearDraft(sourceId)
        void queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] === 'sources' || query.queryKey[1] === sourceId,
        })
      } else {
        void queryClient.invalidateQueries({ queryKey: ['sources'] })
      }
    },
  })
  if (decisions.length === 0) return null
  const choose = (decision: Decision, choice: DecisionChoice) => {
    const { action } = choice
    if (action.kind === 'recipe') onRecipe(action.recipe)
    // 目的の列や読み方は, 変わった後の分析で当てはまらなくなれば消える
    if (action.kind === 'source') {
      source.mutate({ target: action.target, options: action.options })
    }
    if (action.kind === 'dismiss' || choice.remember) onDecide(decision.id)
  }
  return (
    <Card
      title={
        <span className="flex items-center gap-1.5">
          <CircleHelp className="size-4 text-warning-text" aria-hidden />
          決めてほしいこと ({decisions.length})
        </span>
      }
      className="border-warning/60"
    >
      <p className="mb-3 text-xs text-ink-3">
        自動では決めきれないことです. 選ぶとそのまま反映します.
      </p>
      <ul className="space-y-3">
        {decisions.map((decision) => (
          <li key={decision.id} className="rounded-lg border border-line p-3">
            <h3 className="text-sm font-semibold">{decision.title}</h3>
            <p className="mt-1 text-xs text-ink-2">{decision.message}</p>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={decision.title}>
              {decision.choices.map((choice) => (
                <Button
                  key={choice.label}
                  variant={choice.primary ? 'primary' : 'secondary'}
                  disabled={source.isPending}
                  onClick={() => choose(decision, choice)}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {source.error && <ErrorBox error={source.error} />}
    </Card>
  )
}
