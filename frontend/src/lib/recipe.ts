import type {
  AnomalySummary,
  ColumnInfo,
  DemandSplits,
  ItemStepInfo,
  PriceSplits,
  Recipe,
  RecipeStep,
  UpliftOutcome,
  UpliftSplits,
} from '../api/types'

/** 目的の列の欠けた行の扱い (ML-EDA の split.unlabeled. normal は異常の検知だけ) */
export type UnlabeledMode = 'drop' | 'keep' | 'normal'

/**
 * 目的の列の欠けた行の扱いを変えたレシピ (ML-EDA の split.unlabeled).
 * 落とすは既定と同じなので項目を消す (項目の無いレシピと見分けない)
 */
export function withUnlabeled(recipe: Recipe, mode: UnlabeledMode): Recipe {
  const split: Recipe['split'] = { ...recipe.split }
  if (mode === 'drop') delete split.unlabeled
  else split.unlabeled = mode
  return { ...recipe, split }
}

/**
 * 行の id の列の候補. 分析で欠けも同じ値も無い列だけ (ML-EDA が他の列を誤りにする).
 * 目的の列と, 他の役割の列 (処置の列, 値段の列, 原価の列, 商品の id の列) は除く
 */
export function rowIdColumns(
  columns: Record<string, ColumnInfo>,
  target: string | null,
  ...others: (string | undefined)[]
): string[] {
  return Object.entries(columns)
    .filter(
      ([name, info]) =>
        name !== target &&
        !others.includes(name) &&
        info.missing === 0 &&
        info.unique === info.count,
    )
    .map(([name]) => name)
}

/** 行の id の列を使うタスク (ML-EDA のレシピの id. 他のタスクでは誤り) */
const ID_TASKS = ['anomaly', 'uplift', 'price', 'demand']

/** 商品の id の列を使うタスク (ML-EDA のレシピの product. 他のタスクでは誤り) */
const PRODUCT_TASKS = ['price', 'demand']

/** 時間をまたぐ量の判断の列の役割 (レシピの鍵. 互いに違う列にする) */
export type DemandRole = 'product' | 'date' | 'stock'

/** 時間をまたぐ量の判断の列の役割の鍵 */
const DEMAND_ROLES: DemandRole[] = ['product', 'date', 'stock']

/** 時間をまたぐ量の判断の期間の鍵 (先の期間の日数と発注を決める日の間隔) */
export type DemandPeriod = 'horizon' | 'interval'

/** 値段を変える判断の列の役割 (レシピの鍵. 互いに違う列にする) */
export type PriceRole = 'price' | 'cost' | 'product'

/** 値段を変える判断の列の役割の鍵 */
const PRICE_ROLES: PriceRole[] = ['price', 'cost', 'product']

/**
 * タスクを変えたレシピ. 異常の検知 (anomaly), 効果を見積もる (uplift), 値段を変える判断
 * (price) と時間をまたぐ量の判断 (demand) の書き方のうち, 新しいタスクで使えないもの (行の id の
 * 列 id, split.unlabeled: normal, 処置の列 treatment と結果の種類 outcome, 値段の列 price と原価の
 * 列 cost, 商品の id の列 product, 日付の列 date, 在庫の数の列 stock と期間 horizon, interval) を
 * 消す (ML-EDA が他のタスクで誤りにし, 欄も出さないので隠れたまま残さない). 商品の id の列は
 * 値段を変える判断と時間をまたぐ量の判断の間では残す. 分割は変えない (欄の下の誤りで知らせる)
 */
export function withTask(recipe: Recipe, task: string): Recipe {
  let next: Recipe = { ...recipe, task }
  if (!ID_TASKS.includes(task)) delete next.id
  if (task !== 'uplift') {
    delete next.treatment
    delete next.outcome
  }
  if (task !== 'price') {
    delete next.price
    delete next.cost
  }
  if (!PRODUCT_TASKS.includes(task)) delete next.product
  if (task !== 'demand') {
    delete next.date
    delete next.stock
    delete next.horizon
    delete next.interval
  }
  if (task !== 'anomaly' && next.split.unlabeled === 'normal') next = withUnlabeled(next, 'drop')
  return next
}

/**
 * 行の id の列を変えたレシピ (空なら項目を消し, ML-EDA が行の位置の row_id を置く).
 * 処置の列か, 値段を変える判断か時間をまたぐ量の判断の列と同じ列にすると, その指定を消す
 * (ML-EDA が誤りにする)
 */
export function withRowId(recipe: Recipe, column: string): Recipe {
  const next: Recipe = { ...recipe }
  if (column) next.id = column
  else delete next.id
  if (column && next.treatment === column) delete next.treatment
  if (column) for (const key of PRICE_ROLES) if (next[key] === column) delete next[key]
  if (column) for (const key of DEMAND_ROLES) if (next[key] === column) delete next[key]
  return next
}

/**
 * 値段を変える判断の列 (値段, 原価, 商品の id) を変えたレシピ (空なら項目を消す).
 * 他の役割 (値段, 原価, 商品の id, 行の id の列) と同じ列にすると, 他の役割の指定を消す
 * (ML-EDA が誤りにする)
 */
export function withPriceRole(recipe: Recipe, role: PriceRole, column: string): Recipe {
  const next: Recipe = { ...recipe }
  if (!column) {
    delete next[role]
    return next
  }
  for (const key of PRICE_ROLES) if (key !== role && next[key] === column) delete next[key]
  if (next.id === column) delete next.id
  next[role] = column
  return next
}

/**
 * 目的の列 (売れた数の列) に合わせた値段を変える判断のレシピ. 値段, 原価, 商品の id の列が
 * 目的の列と同じなら, その指定を消す (ML-EDA が誤りにする. 目的の列は上の欄で変わるため)
 */
export function fitPrice(recipe: Recipe, target: string | null): Recipe {
  if (!target || !PRICE_ROLES.some((key) => recipe[key] === target)) return recipe
  const next: Recipe = { ...recipe }
  for (const key of PRICE_ROLES) if (next[key] === target) delete next[key]
  return next
}

/** 値段を変える判断 (task: price) を選べるデータの種類 (ML-EDA が他の種類を誤りにする) */
export const PRICE_KINDS = ['table', 'timeseries']

/** 値段の列を変えられる値段の手順 (ML-EDA の PRICE_STEPS と同じ) */
export const PRICE_STEPS = ['clip', 'log', 'standardize', 'minmax']

/** 行を絞る手順のうち, 役割の列を見てよいもの (ML-EDA が列の役割を確かめない手順) */
const ROW_STEPS = ['drop_missing', 'drop_duplicates']

/**
 * 値段を変える判断の手順で名前を書けない列. 値段の列は値段の手順と行を絞る手順だけで, 原価と
 * 商品の id の列は列を落とす手順と行を絞る手順だけで書ける (ML-EDA の決まり)
 */
export function priceBlockedColumns(recipe: Recipe, op: string): string[] {
  if (recipe.task !== 'price' || ROW_STEPS.includes(op)) return []
  const blocked: string[] = []
  if (recipe.price && !PRICE_STEPS.includes(op)) blocked.push(recipe.price)
  for (const name of [recipe.cost, recipe.product])
    if (name && op !== 'drop_columns') blocked.push(name)
  return blocked
}

/** 値段を変える判断で, 書けない列を名前で書いた手順の誤りの文の並び (手順の番号は 1 から) */
export function priceStepErrors(recipe: Recipe): string[] {
  const errors: string[] = []
  recipe.steps.forEach((step, index) => {
    const named = Array.isArray(step.columns) ? (step.columns as string[]) : []
    const blocked = priceBlockedColumns(recipe, step.op).filter((name) => named.includes(name))
    for (const name of blocked) {
      errors.push(
        name === recipe.price
          ? `手順 ${index + 1} (${step.op}) は値段の列 ${name} を変えられません. 値段の列を変えられるのは ${PRICE_STEPS.join(', ')} だけです (候補の値段にも同じ手順をかけ直すため)`
          : `手順 ${index + 1} (${step.op}) には ${name} を書けません (原価と商品の id の列は学習に使わず, 元の値のまま残すため. 落とす drop_columns だけは書けます)`,
      )
    }
  })
  return errors
}

/** 書き出しの説明 (dataset.yaml の中身) の値段を変える判断の price (他のタスクは null) */
export function priceOf(info: Record<string, unknown>): PriceSplits | null {
  const value = info.price
  if (typeof value !== 'object' || value === null || !('splits' in value)) return null
  return value as PriceSplits
}

/**
 * 時間をまたぐ量の判断の列 (商品の id, 日付, 在庫の数) を変えたレシピ (空なら項目を消す).
 * 他の役割 (商品の id, 日付, 在庫の数, 行の id の列) と同じ列にすると, 他の役割の指定を消す
 * (ML-EDA が誤りにする)
 */
export function withDemandRole(recipe: Recipe, role: DemandRole, column: string): Recipe {
  const next: Recipe = { ...recipe }
  if (!column) {
    delete next[role]
    return next
  }
  for (const key of DEMAND_ROLES) if (key !== role && next[key] === column) delete next[key]
  if (next.id === column) delete next.id
  next[role] = column
  return next
}

/**
 * 時間をまたぐ量の判断の期間 (先の期間の日数か発注を決める日の間隔) を変えたレシピ. 空か 1 未満か
 * 整数でなければ項目を消す (ML-EDA の既定を使う. 先の期間は 7 日, 間隔は先の期間と同じ)
 */
export function withDemandPeriod(recipe: Recipe, key: DemandPeriod, value: number | null): Recipe {
  const next: Recipe = { ...recipe }
  if (value === null || !Number.isInteger(value) || value < 1) delete next[key]
  else next[key] = value
  return next
}

/**
 * 目的の列 (日ごとの売れた数の列) に合わせた時間をまたぐ量の判断のレシピ. 商品の id, 日付,
 * 在庫の数の列が目的の列と同じなら, その指定を消す (ML-EDA が誤りにする. 目的の列は上の欄で
 * 変わるため)
 */
export function fitDemand(recipe: Recipe, target: string | null): Recipe {
  if (recipe.task !== 'demand' || !target) return recipe
  if (!DEMAND_ROLES.some((key) => recipe[key] === target)) return recipe
  const next: Recipe = { ...recipe }
  for (const key of DEMAND_ROLES) if (next[key] === target) delete next[key]
  return next
}

/** 時間をまたぐ量の判断 (task: demand) を選べるデータの種類 (ML-EDA が他の種類を誤りにする) */
export const DEMAND_KINDS = ['table', 'timeseries']

/** 時間をまたぐ量の判断の先の期間の日数の既定 (ML-EDA の HORIZON と同じ) */
export const DEMAND_HORIZON = 7

/**
 * 時間をまたぐ量の判断の手順で名前を書けない列. 商品の id と在庫の数の列は, 列を落とす手順と
 * 行を絞る手順 (列を選ぶもの) だけで書ける (ML-EDA の決まり. 書き出しに元の値を置くため)
 */
export function demandBlockedColumns(recipe: Recipe, op: string): string[] {
  if (recipe.task !== 'demand' || ROW_STEPS.includes(op) || op === 'drop_columns') return []
  return [recipe.product, recipe.stock].filter((name): name is string => Boolean(name))
}

/**
 * 時間をまたぐ量の判断で, ML-EDA が止める手順の誤りの文の並び (手順の番号は 1 から).
 * 商品の id と在庫の数の列を名前で書いた手順, 値を学ぶ最初の手順より後の lag, 商品ごと (by) と
 * 日付 (time) でずらさない lag, 1 以上の整数でないずらし幅. fits は値を学ぶ手順か
 */
export function demandStepErrors(recipe: Recipe, fits: (op: string) => boolean): string[] {
  if (recipe.task !== 'demand') return []
  const errors: string[] = []
  const head = recipe.steps.findIndex((step) => fits(step.op))
  recipe.steps.forEach((step, index) => {
    const label = `手順 ${index + 1} (${step.op})`
    const named = Array.isArray(step.columns) ? (step.columns as string[]) : []
    for (const name of demandBlockedColumns(recipe, step.op).filter((item) => named.includes(item)))
      errors.push(
        `${label} には ${name} を書けません (商品の id と在庫の数の列は学習に使わず, 元の値のまま残すため. 落とす drop_columns だけは書けます)`,
      )
    if (step.op !== 'lag') return
    if (head >= 0 && index > head)
      errors.push(
        `${label} は値を学ぶ最初の手順 (手順 ${head + 1}) より前に置いてください (過去の売れた数は日ごとの全ての行でずらし, 発注を決める日の行に絞るのはその後のため)`,
      )
    const lags = step.lags ?? [1]
    if (
      !Array.isArray(lags) ||
      !lags.every((lag) => typeof lag === 'number' && Number.isInteger(lag) && lag >= 1)
    )
      errors.push(
        `${label} の lags は 1 以上の整数の並びにしてください (0 以下は発注を決める日か先の日の売れた数で, 目的の値が入るため)`,
      )
    const by = typeof step.by === 'string' ? [step.by] : Array.isArray(step.by) ? step.by : []
    if (recipe.product && !by.includes(recipe.product))
      errors.push(
        `${label} の by に商品の id の列 ${recipe.product} を書いてください (別の商品の売れた数を読まないように)`,
      )
    if (recipe.date && step.time !== recipe.date)
      errors.push(
        `${label} の time に日付の列 ${recipe.date} を書いてください (表の並びに依らず前の日の値を読むように)`,
      )
  })
  return errors
}

/**
 * 時間をまたぐ量の判断の, 過去の売れた数 (1 日前と 7 日前, 前の 7 日と 28 日の平均) と曜日と月の
 * 手順. 日ごとの売れた数, 商品の id, 日付の列を選んでいなければ空. 先頭に置く (lag は値を学ぶ
 * 手順より前に置く ML-EDA の決まりのため)
 */
export function demandSteps(recipe: Recipe): RecipeStep[] {
  if (recipe.task !== 'demand' || !recipe.target || !recipe.product || !recipe.date) return []
  return [
    {
      op: 'lag',
      columns: [recipe.target],
      lags: [1, 7],
      windows: [7, 28],
      by: [recipe.product],
      time: recipe.date,
      freq: '1D',
    },
    { op: 'datetime_parts', columns: [recipe.date], parts: ['weekday', 'month'] },
  ]
}

/** 書き出しの説明 (dataset.yaml の中身) の時間をまたぐ量の判断の demand (他のタスクは null) */
export function demandOf(info: Record<string, unknown>): DemandSplits | null {
  const value = info.demand
  if (typeof value !== 'object' || value === null || !('splits' in value)) return null
  return value as DemandSplits
}

/** 処置の列を変えたレシピ (空なら項目を消す) */
export function withTreatment(recipe: Recipe, column: string): Recipe {
  const next: Recipe = { ...recipe }
  if (column) next.treatment = column
  else delete next.treatment
  return next
}

/** 結果の種類を変えたレシピ (空なら項目を消し, ML-EDA が値から決める) */
export function withOutcome(recipe: Recipe, outcome: UpliftOutcome | ''): Recipe {
  const next: Recipe = { ...recipe }
  if (outcome) next.outcome = outcome
  else delete next.outcome
  return next
}

/**
 * 目的の列に合わせた効果を見積もるのレシピ. 処置の列が目的の列と同じなら処置の列の指定を消す
 * (ML-EDA が誤りにする. 目的の列は上の欄で変わるため)
 */
export function fitTreatment(recipe: Recipe, target: string | null): Recipe {
  if (recipe.treatment === undefined || recipe.treatment !== target) return recipe
  return withTreatment(recipe, '')
}

/** 効果を見積もるの結果の種類の言葉 (ML-Quest の UPLIFT_OUTCOMES と同じ分け方) */
export const OUTCOME_TEXT: Record<UpliftOutcome, string> = {
  binary: '起きたか (0 と 1. 効果は確率の差)',
  amount: '量 (効果は値の差)',
}

/** 効果を見積もる (task: uplift) を選べるデータの種類 (ML-EDA が他の種類を誤りにする) */
export const UPLIFT_KINDS = ['table', 'timeseries']

/** 書き出しの説明 (dataset.yaml の中身) の効果を見積もるの uplift (他のタスクは null) */
export function upliftOf(info: Record<string, unknown>): UpliftSplits | null {
  const value = info.uplift
  if (typeof value !== 'object' || value === null || !('splits' in value)) return null
  return value as UpliftSplits
}

/** 処置の後に決まる列の気付きの列のうち, まだ落としていない列 (落とす手順を足す候補) */
export function postTreatmentColumns(
  findings: { code: string; columns: string[] }[],
  steps: RecipeStep[],
): string[] {
  const dropped = new Set(
    steps
      .filter((step) => step.op === 'drop_columns' && Array.isArray(step.columns))
      .flatMap((step) => step.columns as string[]),
  )
  const found = findings
    .filter((item) => item.code === 'post_treatment')
    .flatMap((item) => item.columns)
  return [...new Set(found)].filter((name) => !dropped.has(name))
}

/** 異常の検知 (task: anomaly) を選べるデータの種類 (ML-EDA が他の種類を誤りにする) */
export const ANOMALY_KINDS = ['table', 'timeseries']

/** 書き出しの説明 (dataset.yaml の中身) の異常の検知の anomaly (他のタスクは null) */
export function anomalyOf(info: Record<string, unknown>): AnomalySummary | null {
  const value = info.anomaly
  if (typeof value !== 'object' || value === null || !('rows' in value)) return null
  return value as AnomalySummary
}

/** 異常の検知の行の数の合計と異常の割合 */
export interface AnomalyTotals {
  /** 正解の付いた行 (正解が正常と異常) */
  labeled: number
  normal: number
  presumed: number
  anomaly: number
  unlabeled: number
  /**
   * 正常の行 (正解が正常と, 正常と見なした行) と異常の行を合わせた数に対する異常の行の割合
   * (行が無ければ null. 正解なしの行は数えない)
   */
  ratio: number | null
}

/** ML-EDA の説明の anomaly から, 分割を合わせた行の数と異常の割合を求める */
export function anomalyTotals(summary: AnomalySummary): AnomalyTotals {
  const sum = (key: 'normal' | 'presumed' | 'anomaly' | 'unlabeled') =>
    Object.values(summary.rows).reduce((total, rows) => total + (rows[key] ?? 0), 0)
  const normal = sum('normal')
  const presumed = sum('presumed')
  const anomaly = sum('anomaly')
  const counted = normal + presumed + anomaly
  return {
    labeled: normal + anomaly,
    normal,
    presumed,
    anomaly,
    unlabeled: sum('unlabeled'),
    ratio: counted > 0 ? anomaly / counted : null,
  }
}

/**
 * 目的の列に合わせたレシピ. 目的の列が無ければ split.unlabeled を消す
 * (ML-EDA では目的の列の無い keep は誤り. 欄も出さないので隠れたまま残さない)
 */
export function fitUnlabeled(recipe: Recipe, target: string | null): Recipe {
  if (target || recipe.split.unlabeled === undefined) return recipe
  return withUnlabeled(recipe, 'drop')
}

/**
 * 正解の欠けた行を残す欄を選べるか. 分析した全ての行で目的の列が欠けていない
 * (間引いていない) 場合は残す行が無いので選べない. 残すを選んでいれば戻せるように選べる
 */
export function canKeepUnlabeled(
  recipe: Recipe,
  column: ColumnInfo | undefined,
  sampled: boolean,
): boolean {
  if (!recipe.target) return false
  if (recipe.split.unlabeled === 'keep' || recipe.split.unlabeled === 'normal') return true
  return column === undefined || sampled || column.missing > 0
}

/**
 * 目的の列を外したときの編集中のレシピ. 編集中のもの (無ければ保存したもの) に
 * split.unlabeled があれば消したものを返し, 無ければ null (変えない).
 * 編集中のレシピから消すので, 目的の列を戻しても残すには戻らず, 保存する
 * まで編集中の印が出る
 */
export function untargetedDraft(draft: Recipe | null, saved: Recipe | null): Recipe | null {
  const base = draft ?? saved
  if (!base || base.split.unlabeled === undefined) return null
  return withUnlabeled(base, 'drop')
}

/**
 * 書き出したデータセットを ML-Found の学習スクリプトで読む例.
 * 検証用と unlabeled の行は, その分割がある場合だけ. 異常の検知は, 学習用が
 * 正常の行だけで, 検証用とテスト用の正解で度合いを確かめることを添える. 効果を見積もるは,
 * 処置を入力と別に読むことと, 分割ごとの群の数と結果の差の場所を添える. 値段を変える判断は,
 * 値段の列が入力の最後にあることと, 候補の値段での入力, 元の値段, 原価の読み方を添える.
 * 時間をまたぐ量の判断は, 目的の値が先の期間の合計であることと, 前の期間の合計, 在庫の数の読み方を
 * 添える
 */
export function usageSnippet(
  path: string,
  splits: Record<string, unknown>,
  media: boolean,
  anomaly = false,
  uplift = false,
  price = false,
  demand = false,
): string {
  const valid =
    'valid' in splits
      ? 'valid_loader = DataLoader(TensorDataset(*dataset.tensors("valid")), batch_size=64)'
      : null
  const unlabeled =
    'unlabeled' in splits ? '# 正解の無い行: dataset.tensors("unlabeled") (入力だけ)' : null
  const sizes = demand
    ? '# 入力の次元: len(dataset.features). 正解は先の期間の売れた数の合計 (demand). 前の期間の合計: dataset.previous("valid"), 在庫の数: dataset.stock("valid")\n# 先の期間の日数と分割ごとの発注を決める日の範囲: dataset.info["demand"]["horizon"], dataset.info["demand"]["splits"]'
    : price
      ? '# 入力の次元: len(dataset.features). 値段の列は入力の最後. 候補の値段での入力: dataset.price_inputs("valid", 候補の値段)\n# 元の値段: dataset.price("train"), 原価: dataset.cost("train"), 分割ごとの値段の範囲: dataset.info["price"]["splits"]'
      : uplift
        ? '# 入力の次元: len(dataset.features). 処置の列は入力に入らず, 処置 (1 か 0) は dataset.treatment("train") で読む\n# 分割ごとの群の数と結果の差: dataset.info["uplift"]["splits"]'
        : anomaly
          ? '# 入力の次元: len(dataset.features). train は正常の行だけ. valid と test の正解 (異常は 1) で度合いを確かめる\n# 分割ごとの行の数: dataset.info["anomaly"]["rows"]'
          : media
            ? '# 入力の形: dataset.info["splits"]["train"]["shape"][1:], クラスの数: len(dataset.info["classes"])'
            : '# 入力の次元: len(dataset.features), クラスの数: len(dataset.info["classes"])'
  const lines = [
    'from ml_eda import load_dataset',
    'from torch.utils.data import DataLoader, TensorDataset',
    '',
    `dataset = load_dataset("${path}")`,
    'train_loader = DataLoader(TensorDataset(*dataset.tensors("train")), batch_size=64, shuffle=True)',
    valid,
    unlabeled,
    sizes,
  ]
  const snippet = lines.filter((line) => line !== null).join('\n')
  return snippet
}

/** 日付か日時の文字の形 (2025-01-01, 2025/1/1 12:00 など) */
const DATE_TEXT =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * 日時に見える列か. 日時の型の列か, 表として読んで文字のままの列で, よく出る値が全て日付か日時の
 * 文字の形のもの (時刻で分けるときに, 読み方を時系列にする案内に使う)
 */
export function looksLikeDatetime(info: ColumnInfo): boolean {
  if (info.type === 'datetime') return true
  const values = (info.top ?? []).map((item) => item.value)
  return values.length > 0 && values.every((value) => DATE_TEXT.test(value.trim()))
}

/** 分割の名前の表示 (unlabeled は正解の無い分割と分かるように) */
export function splitLabel(name: string): string {
  return name === 'unlabeled' ? 'unlabeled (正解なし)' : name
}

/**
 * 版 1 のレシピの中身の手順で, 引数の上限 (`GET /api/info` の item_steps の limits) を
 * 超えた値の理由の並び. 数でない値や上限の無い引数は ML-EDA が確かめるので見ない
 */
export function itemLimitErrors(steps: RecipeStep[], infos: ItemStepInfo[]): string[] {
  const errors: string[] = []
  steps.forEach((step, index) => {
    const info = infos.find((item) => item.op === step.op)
    for (const [name, highest] of Object.entries(info?.limits ?? {})) {
      const value = step[name]
      if (typeof value === 'number' && value > highest) {
        errors.push(
          `中身の手順 ${index + 1} (${step.op}) の ${name} は ${highest} 以下にしてください`,
        )
      }
    }
  })
  return errors
}
