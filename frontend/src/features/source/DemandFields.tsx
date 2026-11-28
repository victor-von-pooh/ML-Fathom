import { Plus } from 'lucide-react'

import type { Recipe } from '../../api/types'
import { Button } from '../../components/common'
import {
  DEMAND_HORIZON,
  demandSteps,
  withDemandPeriod,
  withDemandRole,
  type DemandPeriod,
  type DemandRole,
} from '../../lib/recipe'

/** 列を選ぶ欄 1 つ (候補でない列も, 選んだままと分かるように出す) */
function RoleSelect({
  id,
  help,
  value,
  empty,
  candidates,
  onChange,
}: {
  id: string
  help: string
  value: string | undefined
  /** 何も選ばないときの選択肢の言葉 */
  empty: string
  candidates: string[]
  onChange: (column: string) => void
}) {
  return (
    <select
      id={id}
      aria-describedby={help}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded border border-line bg-surface px-2 font-mono min-w-0 max-w-full"
    >
      <option value="">{empty}</option>
      {candidates.map((column) => (
        <option key={column}>{column}</option>
      ))}
      {value && !candidates.includes(value) && <option value={value}>{value}</option>}
    </select>
  )
}

/**
 * 時間をまたぐ量の判断 (task: demand) の欄 (商品の id, 日付, 在庫の数の列, 先の期間の日数, 発注を
 * 決める日の間隔) と, 過去の売れた数と曜日の手順を足すボタン. 目的と分割のカードの 2 列の格子の中に
 * 置く (ML-EDA のレシピの product, date, stock, horizon, interval)
 */
export function DemandFields({
  recipe,
  target,
  productColumns,
  dateColumns,
  stockColumns,
  onChange,
}: {
  recipe: Recipe
  target: string | null
  /** 商品の id の列の候補 (目的の列と行の id の列を除く) */
  productColumns: string[]
  /** 日付の列の候補 (数と真偽値でない列から目的の列と行の id の列を除く) */
  dateColumns: string[]
  /** 在庫の数の列の候補 (数の列から目的の列と行の id の列を除く) */
  stockColumns: string[]
  onChange: (next: Recipe) => void
}) {
  const role = (key: DemandRole) => (column: string) =>
    onChange(withDemandRole(recipe, key, column))
  const period = (key: DemandPeriod) => (text: string) =>
    onChange(withDemandPeriod(recipe, key, text === '' ? null : Number(text)))
  const horizon = recipe.horizon ?? DEMAND_HORIZON
  // 過去の売れた数の手順 (lag) がまだ無ければ, 足すボタンを出す
  const made = demandSteps(recipe)
  const lagged = recipe.steps.some((step) => step.op === 'lag')
  return (
    <>
      <label htmlFor="demand-product" className="text-ink-3">
        商品の id の列
      </label>
      <RoleSelect
        id="demand-product"
        help="demand-product-help"
        value={recipe.product}
        empty="選ぶ…"
        candidates={productColumns}
        onChange={role('product')}
      />
      <p id="demand-product-help" className="col-span-2 text-xs text-ink-3">
        {
          '発注の数を決める単位の商品を指す列です. 学習に使う列から除き, 全ての分割にそのまま残します. 商品の特徴は別の列に書きます. '
        }
        {target
          ? '目的の列は日ごとの売れた数の列 (その日に売れた数. 0 以上の数) です. 書き出す正解は, 発注を決める日から先の期間の売れた数の合計です.'
          : '上で日ごとの売れた数の列 (その日に売れた数. 0 以上の数) を目的の列に選んでください.'}
      </p>
      <label htmlFor="demand-date" className="text-ink-3">
        日付の列
      </label>
      <RoleSelect
        id="demand-date"
        help="demand-date-help"
        value={recipe.date}
        empty="選ぶ…"
        candidates={dateColumns}
        onChange={role('date')}
      />
      <p id="demand-date-help" className="col-span-2 text-xs text-ink-3">
        {
          '1 行が 1 日の記録の日付の列です (同じ商品の同じ日は 1 行. 時刻は 0 時だけ). 学習に使う列から除き, 全ての分割に発注を決める日で残します. 曜日や月は datetime_parts で列にします.'
        }
      </p>
      <label htmlFor="demand-stock" className="text-ink-3">
        在庫の数の列
      </label>
      <RoleSelect
        id="demand-stock"
        help="demand-stock-help"
        value={recipe.stock}
        empty="なし"
        candidates={stockColumns}
        onChange={role('stock')}
      />
      <p id="demand-stock-help" className="col-span-2 text-xs text-ink-3">
        {
          'その日の始めの在庫の数 (0 以上の数) の列です (任意). 学習に使う列から除き, 全ての分割に元の値で残します. 推論の段階は, 予測した需要から在庫の数を引いた数を発注します. 在庫が 0 の日の売れた数は需要より少ないので, 要約と書き出しで数えます.'
        }
      </p>
      <label htmlFor="demand-horizon" className="text-ink-3">
        先の期間の日数
      </label>
      <input
        id="demand-horizon"
        type="number"
        min="1"
        step="1"
        aria-describedby="demand-period-help"
        value={recipe.horizon ?? ''}
        placeholder={`${DEMAND_HORIZON} (既定)`}
        onChange={(event) => period('horizon')(event.target.value)}
        className="h-8 w-28 rounded border border-line bg-surface px-2"
      />
      <label htmlFor="demand-interval" className="text-ink-3">
        発注を決める日の間隔
      </label>
      <input
        id="demand-interval"
        type="number"
        min="1"
        step="1"
        aria-describedby="demand-period-help"
        value={recipe.interval ?? ''}
        placeholder={`${horizon} (先の期間と同じ)`}
        onChange={(event) => period('interval')(event.target.value)}
        className="h-8 w-28 rounded border border-line bg-surface px-2"
      />
      <p id="demand-period-help" className="col-span-2 text-xs text-ink-3">
        {`書き出す 1 行は (商品, 発注を決める日) で, 正解はその日から ${horizon} 日の売れた数の合計です. 発注を決める日は記録の最初の日から間隔の日数ごとで, 間隔が先の期間より短いと隣の行の期間が重なり, 分割の境目をまたぐ行を落とします. 空なら既定 (先の期間は ${DEMAND_HORIZON} 日, 間隔は先の期間と同じ) です. 分割は発注を決める日の時刻の順だけです.`}
      </p>
      {made.length > 0 && !lagged && (
        <div className="col-span-2">
          <Button
            icon={Plus}
            onClick={() => onChange({ ...recipe, steps: [...made, ...recipe.steps] })}
            title="過去の売れた数 (1 日前と 7 日前, 前の 7 日と 28 日の平均) を商品ごとに日付でずらす lag と, 曜日と月の datetime_parts を手順の先頭に足す"
          >
            過去の売れた数と曜日の手順を足す
          </Button>
        </div>
      )}
    </>
  )
}
