import clsx from 'clsx'

import type { RecipeStep, TokenizerComparison } from '../../api/types'
import { Button } from '../../components/ui'
import { formatCount, formatPercent } from '../../lib/format'

const UNITS: Record<string, string> = { char: '文字', word: '語', subword: '部分語' }

/** 文を区切る単位 (文字, 語, 部分語) を比べた表と, 選んだ区切り方を手順にするボタン */
export function TokenizerTable({
  comparison,
  current,
  onUse,
}: {
  comparison: TokenizerComparison
  current: RecipeStep | undefined
  onUse: (step: RecipeStep) => void
}) {
  const recommended = comparison.recommended
  // 勧めたものと同じ区切り方 (部分語は語彙の上限も) の行
  const same = (step: RecipeStep | null | undefined, unit: string, maxTokens: number): boolean =>
    !!step &&
    String(step.unit ?? 'word') === unit &&
    (unit !== 'subword' || Number(step.max_tokens) === maxTokens)
  return (
    <details className="mb-3 text-sm" open>
      <summary className="cursor-pointer text-xs font-semibold text-ink-2">
        文の区切り方の比較 (見本の文で語彙を作り, 別の文で測った値)
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">文の区切り方ごとの語彙とトークンの数</caption>
          <thead className="text-ink-3">
            <tr>
              <th scope="col" className="py-1 text-left font-normal">
                区切り方
              </th>
              <th scope="col" className="text-right font-normal">
                語彙
              </th>
              <th scope="col" className="text-right font-normal">
                トークン (平均 / 95 %)
              </th>
              <th scope="col" className="text-right font-normal">
                語彙に無い語
              </th>
              <th scope="col" className="text-right font-normal">
                長さ
              </th>
              <th scope="col">
                <span className="sr-only">使う</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison.candidates.map((candidate) => {
              const chosen = same(recommended, candidate.unit, candidate.max_tokens)
              const using = same(current, candidate.unit, candidate.max_tokens)
              return (
                <tr
                  key={`${candidate.unit}:${candidate.max_tokens}`}
                  className={clsx('border-t border-line', chosen && 'bg-accent/5')}
                >
                  <th scope="row" className="py-1 text-left font-normal">
                    {UNITS[candidate.unit] ?? candidate.unit}
                    {chosen && <span className="ml-1 text-accent-text">(勧める)</span>}
                  </th>
                  <td className="text-right font-mono">{formatCount(candidate.vocabulary)}</td>
                  <td className="text-right font-mono">
                    {candidate.tokens_mean.toFixed(1)} / {candidate.tokens_p95.toFixed(0)}
                  </td>
                  <td className="text-right font-mono">{formatPercent(candidate.unknown_rate)}</td>
                  <td className="text-right font-mono">{candidate.length}</td>
                  <td className="pl-2 text-right">
                    {using ? (
                      <span className="text-ink-3">使っている</span>
                    ) : (
                      <Button
                        className="h-6 px-2 text-xs"
                        onClick={() =>
                          onUse({
                            op: 'vocabulary',
                            unit: candidate.unit,
                            length: candidate.length,
                            max_tokens: candidate.max_tokens,
                          })
                        }
                      >
                        使う
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-ink-3">{comparison.reason}</p>
      {comparison.notes.map((note) => (
        <p key={note} className="text-xs text-warning-text">
          {note}
        </p>
      ))}
    </details>
  )
}
