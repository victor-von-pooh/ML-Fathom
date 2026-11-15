import type { ColumnInfo, Finding, Profile, RecipeStep } from '../api/types'

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
    // 目的の列には, 欠損の行を落とす以外の手順を作らない
    if (column === target && item.code !== 'target_missing') continue
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

/**
 * 分析から, 画像, 文, 点群を学習用の配列にする中身の手順を作る
 *
 * 画像は最も多い大きさにそろえ (色の形式が混ざれば RGB に), 正規化する.
 * 文は語の数の多めの値を長さにして語彙で番号にする. 点群は点の数の中央値
 * (1024 まで) にそろえて正規化する
 */
export function autoItemSteps(kind: string, profile: Profile): RecipeStep[] {
  if (kind === 'image') {
    const size = profile.items?.sizes?.[0]
    const steps: RecipeStep[] = []
    if (size) {
      // 写真のような大きな画像は, 長い辺を 224 までに縮める (配列が大きくなりすぎない)
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(size.width, size.height))
      steps.push({
        op: 'resize',
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      })
    }
    if (Object.keys(profile.items?.modes ?? {}).length > 1) steps.push({ op: 'rgb' })
    steps.push({ op: 'normalize' })
    return steps
  }
  if (kind === 'text') {
    // 空白で区切らない文 (日本語など) は, 語の数が文字の数よりずっと少ないので文字ごとに
    const words = typical(profile.columns.words, 32)
    const letters = typical(profile.columns.length, 128)
    const byChar = words * 4 < letters
    const length = Math.min(512, Math.max(8, Math.ceil((byChar ? letters : words) * 1.5)))
    return [
      byChar
        ? { op: 'vocabulary', length, max_tokens: 20000, unit: 'char' }
        : { op: 'vocabulary', length, max_tokens: 20000 },
    ]
  }
  if (kind === 'pointcloud') {
    const points = Math.min(
      1024,
      Math.max(64, Math.round(typical(profile.columns.points, 1024, 'median'))),
    )
    return [{ op: 'sample_points', points }, { op: 'normalize_cloud' }]
  }
  return []
}

// 画像を縮める長い辺の上限
const MAX_IMAGE_SIDE = 224

/** 列のよくある大きさ (数値なら第 3 四分位か中央値, 種類が少なければ最も多い値) */
function typical(
  column: ColumnInfo | undefined,
  fallback: number,
  key: 'q3' | 'median' = 'q3',
): number {
  if (!column) return fallback
  const stat = column[key]
  if (typeof stat === 'number') return stat
  const top = Number(column.top?.[0]?.value)
  return Number.isFinite(top) ? top : fallback
}
