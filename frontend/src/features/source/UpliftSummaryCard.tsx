import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'

import { useApi } from '../../api/client'
import type { Recipe, UpliftRequest } from '../../api/types'
import { Button, Card, ErrorBox, Spinner } from '../../components/common'
import { formatNumber, formatPercent } from '../../lib/format'
import { OUTCOME_TEXT, postTreatmentColumns } from '../../lib/recipe'
import { Findings } from './Findings'

/** 釣り合いが崩れたとみなす標準化した平均の差の絶対値 (ML-EDA の treatment_imbalance と同じ) */
const IMBALANCE = 0.25

/** 釣り合いの表に並べる列の数の上限 (差の大きい順) */
const BALANCE_ROWS = 20

/**
 * 介入の記録の要約 (ML-EDA の describe_uplift). 処置の群と対照の群の行の数と結果の平均,
 * 処置の割合, 結果の差, 釣り合いと気付きを, 読み込んだ元の表で数えて出す. 処置の後に決まる
 * 列には, 落とす手順を足す押しボタンを置く
 */
export function UpliftSummaryCard({
  sourceId,
  recipe,
  onDrop,
}: {
  sourceId: string
  recipe: Recipe
  /** 列を落とす手順を足す */
  onDrop: (columns: string[]) => void
}) {
  const api = useApi()
  // 結果の列と処置の列を選ぶまでは求めない
  const body: UpliftRequest | null =
    recipe.target && recipe.treatment
      ? {
          treatment: recipe.treatment,
          outcome: recipe.target,
          ...(recipe.outcome ? { outcome_kind: recipe.outcome } : {}),
          ...(recipe.id ? { id: recipe.id } : {}),
        }
      : null
  const summary = useQuery({
    queryKey: ['uplift', sourceId, JSON.stringify(body)],
    queryFn: () => api.uplift(sourceId, body!),
    enabled: body !== null,
    retry: false,
  })
  const data = summary.data
  const posts = data ? postTreatmentColumns(data.findings, recipe.steps) : []
  const balance = data?.balance.slice(0, BALANCE_ROWS) ?? []
  return (
    <Card title="介入の記録の要約">
      {body === null && (
        <p className="text-sm text-ink-3">
          {recipe.target
            ? '処置の列を選ぶと, 処置の群 (配った行) と対照の群 (配らなかった行) の数, 結果の差と釣り合いを出します.'
            : '上で結果の列 (目的の列) を選び, 処置の列を選ぶと, 処置の群 (配った行) と対照の群 (配らなかった行) の数, 結果の差と釣り合いを出します.'}
        </p>
      )}
      {summary.isFetching && <Spinner label="介入の記録を要約しています" />}
      {summary.error && <ErrorBox error={summary.error} />}
      {data && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-x-4">
            <span>行 {formatNumber(data.rows)}</span>
            <span>処置の群 {formatNumber(data.groups.treated.rows)}</span>
            <span>対照の群 {formatNumber(data.groups.control.rows)}</span>
            <span>処置の割合 {formatPercent(data.treated_rate)}</span>
          </div>
          <div className="flex flex-wrap gap-x-4">
            <span>処置の群の平均 {formatNumber(data.groups.treated.mean)}</span>
            <span>対照の群の平均 {formatNumber(data.groups.control.mean)}</span>
            <span className="font-semibold">差 (全体の効果) {formatNumber(data.effect)}</span>
          </div>
          <p className="text-xs text-ink-3">
            処置の群は処置の列が 1 の行 (配った顧客), 対照の群は 0 の行 (配らなかった顧客) です.
            結果の種類: {OUTCOME_TEXT[data.outcome_kind] ?? data.outcome_kind}. 行は処置と結果の
            両方が分かる行で, 前処理の手順をかける前の表で数えます. 欠けた行: 処置{' '}
            {formatNumber(data.missing.treatment)} 行, 結果 {formatNumber(data.missing.outcome)} 行.
            差は処置の群の平均 − 対照の群の平均で, 無作為に配った記録なら全体の効果です.
          </p>
          <Findings findings={data.findings} />
          {/* 行の id の列を選ばないと, ML-EDA の既定で ID らしい列も釣り合いに入る */}
          {!recipe.id && (
            <p className="text-xs text-ink-3">
              行の id の列 (顧客の ID など) を選ぶと, その列は釣り合いの表から外れます.
            </p>
          )}
          {posts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button icon={Plus} onClick={() => onDrop(posts)}>
                処置の後に決まる列 ({posts.join(', ')}) を落とす手順を足す
              </Button>
            </div>
          )}
          {balance.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <caption className="mb-1 text-left text-ink-3">
                  群どうしの釣り合い. 標準化した平均の差は, 2 つの群の平均の差を値の散らばりで
                  割った数で, 0 に近いほど 2 つの群がそろっています (目安: 絶対値が 0.1 未満なら
                  よくそろい, {IMBALANCE} 以上なら釣り合いが崩れています). 差の大きい順に{' '}
                  {BALANCE_ROWS} 列まで
                </caption>
                <thead className="text-ink-3">
                  <tr>
                    <th scope="col" className="py-1 pr-3 text-left font-normal">
                      列
                    </th>
                    <th scope="col" className="pr-3 text-left font-normal">
                      型
                    </th>
                    <th scope="col" className="pr-3 text-right font-normal">
                      標準化した平均の差
                    </th>
                    <th scope="col" className="pr-3 text-left font-normal">
                      最も差の大きい値 (カテゴリの列)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {balance.map((item) => {
                    const broken = item.smd !== null && Math.abs(item.smd) >= IMBALANCE
                    return (
                      <tr key={item.column} className="border-t border-line">
                        <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                          {item.column}
                        </th>
                        <td className="pr-3">{item.type}</td>
                        <td
                          className={
                            broken
                              ? 'tabular-nums pr-3 text-right font-mono text-warning-text'
                              : 'tabular-nums pr-3 text-right font-mono'
                          }
                        >
                          {formatNumber(item.smd)}
                          {broken && ' (釣り合いが崩れ)'}
                        </td>
                        <td className="pr-3 font-mono">{item.value ?? ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
