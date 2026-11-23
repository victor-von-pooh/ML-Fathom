import { useMutation } from '@tanstack/react-query'
import { Calculator, Info } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'

import { api } from '../../api/client'
import type { PolicyKind, PolicyValueResult, TrajectorySummary } from '../../api/types'
import { Button, Card, ErrorBox, StatTile } from '../../components/ui'
import { formatCount, formatNumber } from '../../lib/format'

/** 見積もる方策の形の名前 */
const POLICY_LABELS: Record<PolicyKind, string> = {
  uniform: '全ての行動を一様に選ぶ',
  epsilon_greedy: '記録で最も多い行動を ε-greedy で選ぶ',
}

/** 0 以上 1 以下の数の欄の値を読む (読めなければ null) */
function unitValue(text: string): number | null {
  if (text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

/** 見積もった方策の説明の文 */
function describePolicy(policy: PolicyValueResult['policy']): string {
  const space = `行動 ${policy.start} から ${policy.start + policy.n - 1} の ${policy.n} 個`
  if (policy.name === 'epsilon_greedy') {
    return `確率 ${formatNumber(1 - (policy.epsilon ?? 0))} で行動 ${policy.action}, 残りは一様 (${space})`
  }
  return `全ての行動を確率 ${formatNumber(1 / policy.n)} で選ぶ (${space})`
}

/** 見積もりの結果: 3 つの見積もりと記録の値の比べ, 有効なサンプルの数, 知らせること */
function EstimateResult({ result }: { result: PolicyValueResult }) {
  const estimate = result.estimate
  const rows: [string, number | null, string][] = [
    ['重み付きの重点サンプリング', estimate.value, '主な見積もり. ばらつきが小さい'],
    ['普通の重点サンプリング', estimate.ordinary, '偏りは無いが, ばらつきが大きい'],
    ['歩ごとの重点サンプリング', estimate.per_decision, '各歩までの重みを掛ける'],
    ['記録した方策の報酬の和の平均', estimate.behavior_value, '比べるための, 記録のままの値'],
  ]
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        {describePolicy(result.policy)} 方策を, 割引率 {formatNumber(result.gamma)}{' '}
        で見積もりました.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="見積もり (重み付き)" value={formatNumber(estimate.value)} />
        <StatTile
          label="有効なサンプルの数"
          value={formatNumber(estimate.effective_sample_size)}
          hint={`エピソード ${formatCount(estimate.episodes)} 件のうち`}
        />
        <StatTile label="最も大きい重みの割合" value={formatNumber(estimate.max_weight_share)} />
        <StatTile
          label="重みが 0 のエピソード"
          value={formatCount(estimate.zero_weight_episodes)}
          hint={`非常に小さく 0 として計算した ${formatCount(estimate.underflow_episodes)} 件`}
        />
      </div>
      <Card title="見積もりの比べ">
        <table className="w-full text-sm">
          <caption className="sr-only">見積もりの比べ</caption>
          <thead className="text-xs text-ink-3">
            <tr>
              <th scope="col" className="py-1 text-left font-normal">
                見積もり
              </th>
              <th scope="col" className="text-right font-normal">
                値
              </th>
              <th scope="col" className="pl-4 text-left font-normal">
                意味
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, value, meaning]) => (
              <tr key={label} className="border-t border-line">
                <th scope="row" className="py-1 text-left font-normal">
                  {label}
                </th>
                <td className="tabular text-right font-mono">{formatNumber(value)}</td>
                <td className="pl-4 text-xs text-ink-3">{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-3">
          決まらない見積もり (重みが全て 0 か, 大きすぎて有限にならない) は – と出します.
        </p>
      </Card>
      <Card title={`見積もりで知らせること (${estimate.notes.length} 件)`}>
        {estimate.notes.length === 0 ? (
          <p className="text-sm text-good-text">知らせることはありません.</p>
        ) : (
          <ul className="divide-y divide-line">
            {estimate.notes.map((note, index) => (
              <li key={`${index}-${note}`} className="flex gap-3 py-2.5 text-sm text-ink-2">
                <Info size={16} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
                <span className="min-w-0 break-words">{note}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/** 方策の見積もり: 見積もる方策を選び, ML-Found の estimate_policy_value の結果を出す */
export function PolicyValuePanel({
  sourceId,
  summary,
}: {
  sourceId: string
  summary: TrajectorySummary
}) {
  const id = useId()
  const [policy, setPolicy] = useState<PolicyKind>('uniform')
  const [epsilonText, setEpsilonText] = useState('0.1')
  const [gammaText, setGammaText] = useState('1')
  const run = useMutation({
    mutationFn: (body: { policy: PolicyKind; epsilon: number; gamma: number }) =>
      api.policyValue(sourceId, body),
  })

  // 記録した方策の確率が無いと重みが決まらない
  if (!summary.with_action_prob) {
    return (
      <Card title="方策の見積もり">
        <p role="note" className="text-sm text-ink-2">
          この表には, 記録した方策が行動を選んだ確率の列 (action_prob) が無いので,
          方策の良さを見積もれません. 重点サンプリングには,
          確率で行動を選ぶ方策で記録した軌跡が要ります.
        </p>
      </Card>
    )
  }

  const epsilon = unitValue(epsilonText)
  const gamma = unitValue(gammaText)
  const ready = gamma !== null && (policy === 'uniform' || epsilon !== null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    run.mutate({ policy, epsilon: epsilon ?? 0, gamma })
  }
  return (
    <div className="space-y-4">
      <Card title="見積もる方策">
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-ink-3">
            記録した軌跡から, 環境で動かさずに方策の良さ (エピソードの割り引いた報酬の和の期待値)
            を重点サンプリングで見積もります. Discrete の行動の, CSV の表だけを読みます.
          </p>
          <div className="grid gap-3 md:grid-cols-[1fr_10rem_10rem]">
            <div className="space-y-1 text-sm">
              <label htmlFor={`${id}-policy`} className="block text-xs text-ink-3">
                方策
              </label>
              <select
                id={`${id}-policy`}
                value={policy}
                onChange={(event) => setPolicy(event.target.value as PolicyKind)}
                className="h-8 w-full rounded border border-line bg-surface px-2 text-sm"
              >
                {(Object.keys(POLICY_LABELS) as PolicyKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {POLICY_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1 text-sm">
              <label htmlFor={`${id}-epsilon`} className="block text-xs text-ink-3">
                ε (一様に選ぶ確率)
              </label>
              <input
                type="number"
                min={0}
                max={1}
                id={`${id}-epsilon`}
                step={0.05}
                value={epsilonText}
                disabled={policy !== 'epsilon_greedy'}
                aria-invalid={policy === 'epsilon_greedy' && epsilon === null}
                aria-describedby={`${id}-range`}
                onChange={(event) => setEpsilonText(event.target.value)}
                className="h-8 w-full rounded border border-line bg-surface px-2 font-mono text-sm disabled:opacity-50"
              />
            </div>
            <div className="space-y-1 text-sm">
              <label htmlFor={`${id}-gamma`} className="block text-xs text-ink-3">
                割引率 γ
              </label>
              <input
                type="number"
                min={0}
                max={1}
                id={`${id}-gamma`}
                step={0.01}
                value={gammaText}
                aria-invalid={gamma === null}
                aria-describedby={`${id}-range`}
                onChange={(event) => setGammaText(event.target.value)}
                className="h-8 w-full rounded border border-line bg-surface px-2 font-mono text-sm"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p id={`${id}-range`} className="text-xs text-ink-3">
              ε と γ は 0 以上 1 以下の数です.
            </p>
            <Button
              type="submit"
              variant="primary"
              icon={Calculator}
              disabled={!ready || run.isPending}
            >
              見積もる
            </Button>
          </div>
        </form>
      </Card>
      {run.error && <ErrorBox error={run.error} />}
      {run.data && !run.error && <EstimateResult result={run.data} />}
    </div>
  )
}
