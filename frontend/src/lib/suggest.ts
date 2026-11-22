import type { ColumnInfo, Finding, Profile, RecipeStep } from '../api/types'

/** 気付きから作る手順の候補 */
export function suggestSteps(
  findings: Finding[],
  target: string | null,
  columns: Record<string, ColumnInfo>,
  roles: Record<string, string> = {},
): RecipeStep[] {
  const drop = new Set<string>()
  const steps: RecipeStep[] = []
  // 役割のある列 (文, 長さ, 時刻など) は落とさず符号化もしない
  const reserved = new Set(Object.values(roles))
  for (const item of findings) {
    const [column] = item.columns
    // 目的の列には, 欠損の行を落とすことと表記をそろえること以外の手順を作らない
    if (column === target && !['target_missing', 'mixed_forms'].includes(item.code)) continue
    if (!column) {
      if (item.code === 'duplicate_rows') steps.push({ op: 'drop_duplicates' })
      continue
    }
    if (
      reserved.has(column) &&
      ['id_like', 'constant', 'target_leak', 'high_cardinality'].includes(item.code)
    ) {
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
    } else if (item.code === 'mixed_forms') {
      // 大文字と小文字だけが違う組があれば小文字にもそろえる
      steps.push(
        item.message.includes('lowercase: true')
          ? { op: 'normalize_text', columns: [column], lowercase: true }
          : { op: 'normalize_text', columns: [column] },
      )
    } else if (item.code === 'duplicate_items') {
      steps.push({ op: 'drop_duplicates', columns: [column] })
    } else if (item.code === 'empty_items') {
      steps.push({ op: 'filter_rows', column: roles.length ?? 'length', compare: '>', value: 0 })
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
  period: number | null = null,
  seriesBy: string | null = null,
  interval: number | null = null,
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
  // ずらす数値の列 (目的の列も. 欠損の印や日時の部分の列は含めない)
  const numeric: string[] = []
  if (target && columns[target]?.type === 'numeric') numeric.push(target)
  for (const [name, info] of Object.entries(columns)) {
    if (name === target || name === roles.time) continue
    // 系列を分ける列は, 落とさず埋めず, ずらした後に符号化する (文字の場合.
    // 商品ごとのように系列が多ければ, 列が増えすぎないように番号付け)
    if (name === seriesBy) {
      if (!/int|float|bool/.test(info.dtype)) (info.unique > 20 ? encode : oneHot).push(name)
      continue
    }
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
    if (info.type === 'numeric') numeric.push(name)
  }
  const steps: RecipeStep[] = []
  // 表記のゆれをそろえてから重複した行を落とす (系列や符号化の前に)
  for (const item of findings.filter((entry) => entry.code === 'mixed_forms')) {
    steps.push(
      item.message.includes('lowercase: true')
        ? { op: 'normalize_text', columns: item.columns, lowercase: true }
        : { op: 'normalize_text', columns: item.columns },
    )
  }
  if (findings.some((item) => item.code === 'duplicate_rows')) steps.push({ op: 'drop_duplicates' })
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
  // 時系列は, 数値の列 (目的の列も) の 1 つ前と 1 周期前の値, 1 周期の移動平均を足し,
  // 過去が足りない始めの行を落とす. 店ごとのような複数の系列は系列ごとにずらす
  // (系列を分ける列を符号化する前に)
  if (roles.time) {
    const lag: RecipeStep = {
      op: 'lag',
      columns: numeric.length ? numeric : 'auto',
      lags: period && period > 1 ? [1, period] : [1],
    }
    if (period && period > 1) lag.windows = [period]
    if (seriesBy) lag.by = [seriesBy]
    steps.push(lag)
    steps.push({ op: 'drop_missing' })
    // 曜日と月 (1 日より細かい間隔なら時と曜日). 時刻の列は分割に使うので残す
    steps.push({
      op: 'datetime_parts',
      columns: [roles.time],
      parts: interval !== null && interval < 86400 ? ['hour', 'weekday'] : ['weekday', 'month'],
      drop: false,
    })
  }
  if (encode.length) steps.push({ op: 'label_encode', columns: encode })
  if (oneHot.length) steps.push({ op: 'one_hot', columns: oneHot })
  steps.push({ op: 'standardize', columns: 'auto' })
  return steps
}

/** 1 件ずつの中身を持ち, 中身の手順を組み立てる種類 */
export const ITEM_KINDS = ['image', 'text', 'pointcloud', 'audio']

/**
 * 分析から, 画像, 文, 点群, 音声を学習用の配列にする中身の手順を作る
 *
 * 画像は最も多い大きさにそろえ (色の形式が混ざれば RGB に), 正規化する.
 * 文は分析が比べて勧めた区切り方 (無ければ語の数の多めの値を長さ) の語彙で番号にする. 点群は点の数の中央値
 * (1024 まで) にそろえて正規化する. 音声は最も多い標本化の周波数とチャンネルの数, 長さの中央値 (0.01 秒に
 * 丸め, 30 秒まで) にそろえる
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
    // 区切り方を比べた結果があれば, 勧めたものを使う
    const recommended = profile.items?.tokenizers?.recommended
    if (recommended) return [{ ...recommended }]
    // 空白で区切らない文 (日本語など) は, 1 語あたりの文字が多い (英語は 5 から 6 文字) ので文字ごとに
    const roles: Record<string, string> = profile.overview?.roles ?? {}
    const words = typical(profile.columns[roles.words ?? 'words'], 32)
    const letters = typical(profile.columns[roles.length ?? 'length'], 128)
    const byChar = letters > words * 8
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
  if (kind === 'audio') {
    // そろっていても足す (推論で読む新しい音声も同じ形にするため. 画像の resize と同じ).
    // 順は ML-EDA の設計の順 (周波数, チャンネル, 長さ)
    const steps: RecipeStep[] = []
    const rate = mostCommon(profile.items?.sample_rates)
    const channels = mostCommon(profile.items?.channels)
    if (rate) steps.push({ op: 'resample', rate })
    if (channels) steps.push({ op: 'mix_channels', channels })
    const median = profile.items?.duration?.median
    if (median !== undefined && median > 0) {
      // 長い録音は配列が大きくなりすぎないように切る
      const seconds = Math.min(MAX_AUDIO_SECONDS, Math.max(0.01, Math.round(median * 100) / 100))
      steps.push({ op: 'fix_length', seconds })
    }
    return steps
  }
  return []
}

/** 読めない件 (画像は大きさが欠損, 点群と音声などは error がある件) を除く表の手順 (無ければ null) */
export function unreadableFilter(kind: string, profile: Profile): RecipeStep | null {
  if (!profile.items?.unreadable) return null
  if (kind === 'image' && profile.columns.width) {
    return { op: 'filter_rows', column: 'width', compare: 'notna' }
  }
  if (profile.columns.error) return { op: 'filter_rows', column: 'error', compare: 'isna' }
  return null
}

// 画像を縮める長い辺の上限
const MAX_IMAGE_SIDE = 224

// 音声をそろえる長さの上限 (秒)
const MAX_AUDIO_SECONDS = 30

/** 値ごとの件数 ({"16000": 12}) から, 最も多い値 (同じ数なら大きい値. 無ければ null) */
function mostCommon(counts: Record<string, number> | undefined): number | null {
  const entries = Object.entries(counts ?? {})
    .map(([value, count]) => [Number(value), count] as const)
    .filter(([value]) => Number.isFinite(value) && value > 0)
  if (entries.length === 0) return null
  entries.sort((a, b) => b[1] - a[1] || b[0] - a[0])
  return entries[0]![0]
}

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
