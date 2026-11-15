import type { ColumnInfo, Finding, RecipeStep } from '../api/types'

/** 気付きから作る手順の候補 */
export function suggestSteps(
  findings: Finding[],
  target: string | null,
  columns: Record<string, ColumnInfo>,
): RecipeStep[] {
  const drop = new Set<string>()
  const steps: RecipeStep[] = []
  for (const item of findings) {
    const [column] = item.columns
    if (!column) {
      if (item.code === 'duplicate_rows') steps.push({ op: 'drop_duplicates' })
      continue
    }
    if (['id_like', 'constant', 'target_leak'].includes(item.code) && column !== target) {
      drop.add(column)
    } else if (item.code === 'high_missing') {
      // 数値は中央値, それ以外は最も多い値で埋める
      const numeric = columns[column]?.type === 'numeric'
      steps.push({
        op: 'impute',
        columns: [column],
        strategy: numeric ? 'median' : 'most_frequent',
        indicator: true,
      })
    } else if (item.code === 'skewed') {
      steps.push({ op: 'log', columns: [column] })
    } else if (item.code === 'outliers') {
      steps.push({ op: 'clip', columns: [column] })
    } else if (item.code === 'high_cardinality') {
      steps.push({ op: 'label_encode', columns: [column] })
    } else if (item.code === 'target_missing') {
      steps.push({ op: 'drop_missing', columns: [column] })
    }
  }
  if (drop.size > 0) steps.unshift({ op: 'drop_columns', columns: [...drop] })
  return steps
}

/**
 * 列の型から, 学習できる形 (全て数値, 欠損なし) にする手順の並びを作る
 *
 * 文, ID, 定数の列は落とし, 日時は分解し, カテゴリはワンホット (値が多い
 * 場合は番号付け), 欠損は埋め, 偏った数値は対数を取り, 最後に標準化する
 */
export function autoRecipe(
  columns: Record<string, ColumnInfo>,
  target: string | null,
  findings: Finding[],
  roles: Record<string, string>,
): RecipeStep[] {
  const drop: string[] = []
  const oneHot: string[] = []
  const encode: string[] = []
  const dates: string[] = []
  const numericMissing: string[] = []
  const categoryMissing: string[] = []
  const skewed = new Set(
    findings.filter((item) => item.code === 'skewed').flatMap((item) => item.columns),
  )
  const leaks = new Set(
    findings.filter((item) => item.code === 'target_leak').flatMap((item) => item.columns),
  )
  for (const [name, info] of Object.entries(columns)) {
    if (name === target || name === roles.time) continue
    if (['text', 'id', 'constant', 'empty', 'other'].includes(info.type) || leaks.has(name)) {
      drop.push(name)
      continue
    }
    if (info.type === 'datetime') {
      dates.push(name)
      continue
    }
    const stringLike = !/int|float|bool/.test(info.dtype)
    if ((info.type === 'categorical' || info.type === 'boolean') && stringLike) {
      if (info.missing) categoryMissing.push(name)
      if (info.unique > 20) encode.push(name)
      else oneHot.push(name)
      continue
    }
    if (info.missing) numericMissing.push(name)
  }
  const steps: RecipeStep[] = []
  if (drop.length) steps.push({ op: 'drop_columns', columns: drop })
  if (target && columns[target]?.missing) steps.push({ op: 'drop_missing', columns: [target] })
  if (dates.length) steps.push({ op: 'datetime_parts', columns: dates })
  if (numericMissing.length)
    steps.push({ op: 'impute', columns: numericMissing, strategy: 'median', indicator: true })
  if (categoryMissing.length)
    steps.push({ op: 'impute', columns: categoryMissing, strategy: 'most_frequent' })
  const logs = [...skewed].filter(
    (name) =>
      name !== target &&
      typeof columns[name]?.min === 'number' &&
      (columns[name]!.min as number) >= 0,
  )
  if (logs.length) steps.push({ op: 'log', columns: logs })
  if (encode.length) steps.push({ op: 'label_encode', columns: encode })
  if (oneHot.length) steps.push({ op: 'one_hot', columns: oneHot })
  steps.push({ op: 'standardize', columns: 'auto' })
  return steps
}
