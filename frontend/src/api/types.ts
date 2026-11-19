// API の応答の型 (バックエンドは ML-EDA の辞書をそのまま返すので, 画面で使う形を書く)

export interface Source {
  id: string
  name: string
  path: string
  loader: string
  kind: string
  options: Record<string, unknown>
  target: string | null
  created_at: string
  exists: boolean
  /** 問題の設定から始めた場合の problem.yaml の場所 */
  problem?: string | null
}

/** 問題の設定の確かめ (ML-Quest の check の形) */
export interface ProblemFinding {
  level: 'error' | 'warning' | 'info'
  id: string
  message: string
}

/** 書き戻しで利用者が選ぶ問い (分からない列をレシピで使った) */
export interface ProblemChoice {
  column: string
  options: ('known' | 'drop')[]
  message: string
}

/** 編集中のレシピを問題の設定に試しに書き戻した結果 */
export interface ProblemCheck {
  name: string | null
  path: string
  /** 書き戻すときに送り返す, 問題の設定のファイルの中身の印 */
  version: string
  changes: string[]
  conflicts: ProblemFinding[]
  choices: ProblemChoice[]
}

/** 問題の設定に書き戻した結果 */
export interface ProblemWritten {
  changes: string[]
  recipe: Recipe
  path: string
}

export interface LoaderInfo {
  name: string
  kind: string
  extensions: string[]
  options: Record<string, string>
  description: string
}

export interface StepInfo {
  op: string
  params: Record<string, string>
  description: string
  fits: boolean
}

export interface ItemStepInfo extends StepInfo {
  kind: string
}

export interface Info {
  loaders: LoaderInfo[]
  steps: StepInfo[]
  item_steps: ItemStepInfo[]
  kinds: string[]
  version: string
}

export interface Candidate {
  loader: string
  kind: string
  score: number
}

export interface BrowseEntry {
  name: string
  path: string
  is_dir: boolean
  size: number | null
}

export interface Listing {
  path: string
  parent: string | null
  home: string
  entries: BrowseEntry[]
  truncated?: boolean
}

export interface Histogram {
  counts: number[]
  edges: number[]
}

export interface ValueCount {
  value: string
  count: number
}

export interface ColumnInfo {
  type: string
  dtype: string
  count: number
  missing: number
  missing_ratio: number
  unique: number
  mean?: number
  std?: number
  min?: number | string
  q1?: number
  median?: number
  q3?: number
  max?: number | string
  skew?: number
  zeros?: number
  outliers?: number
  histogram?: Histogram
  top?: ValueCount[]
  other_count?: number
  top_ratio?: number
  length_mean?: number
  length_min?: number
  length_max?: number
  words_mean?: number
  vocabulary?: number
  length_histogram?: Histogram
  top_words?: ValueCount[]
  interval_seconds?: number | null
}

export interface Finding {
  severity: 'warning' | 'info'
  code: string
  message: string
  columns: string[]
}

export interface Overview {
  kind: string
  rows: number
  columns: number
  memory_bytes: number
  duplicate_rows: number
  missing_cells: number
  sampled: boolean
  sample_rows: number
  /** Excel の全てのシートの名前と, 読んだシート */
  sheets?: string[]
  sheet?: string | null
  roles: Record<string, string>
}

export interface TargetInfo {
  column: string
  task: string
  type: string
  classes?: ValueCount[]
  associations: { column: string; strength: number }[]
}

export interface TimeSeriesInfo {
  time_column: string
  series_by?: string | null
  series_count?: number
  interval_seconds: number | null
  gaps: number
  duplicates: number
  start: string | null
  end: string | null
  columns: Record<string, { acf: number[]; period: number | null }>
  series: { time: string[]; values: Record<string, (number | null)[]> }
}

export interface Profile {
  summary: { kind: string; rows: number; roles: Record<string, string>; has_items: boolean }
  overview: Overview
  columns: Record<string, ColumnInfo>
  correlations: { columns: string[]; pearson: (number | null)[][]; spearman: (number | null)[][] }
  associations: { columns: string[]; cramers_v: (number | null)[][] }
  target: TargetInfo | null
  timeseries: TimeSeriesInfo | null
  items?: ItemsInfo | null
  findings: Finding[]
}

export interface ItemsInfo {
  kind: string
  count: number
  sizes?: { width: number; height: number; count: number }[]
  modes?: Record<string, number>
  brightness?: number
  unreadable?: number
  /** 文を区切る単位の比較 (文だけ) */
  tokenizers?: TokenizerComparison
  /** 多視点の撮影の枚数, 深度の割合 (中央値), 撮影距離の範囲 (メートル) */
  frames?: { min: number; median: number; max: number } | null
  depth?: { valid: number | null; confident: number | null }
  distance?: { min: number | null; max: number | null }
}

/** 文を区切る単位 (文字, 語, 部分語) ごとの測った値 */
export interface TokenizerCandidate {
  unit: string
  vocabulary: number
  tokens_mean: number
  tokens_p95: number
  unknown_rate: number
  length: number
  truncated_rate: number
  max_tokens: number
}

export interface TokenizerComparison {
  candidates: TokenizerCandidate[]
  recommended: RecipeStep | null
  reason: string
  notes: string[]
}

export interface Rows {
  total: number
  offset: number
  columns: { name: string; dtype: string }[]
  rows: unknown[][]
  index: number[]
}

export interface RecipeStep {
  op: string
  [key: string]: unknown
}

export interface Recipe {
  format_version: number
  target: string | null
  task: string
  steps: RecipeStep[]
  item_steps?: RecipeStep[]
  split: {
    method: string
    valid?: number
    test?: number
    seed?: number
    column?: string
    /** 目的の列の欠けた行を落とすか, unlabeled の分割に残すか (無ければ落とす) */
    unlabeled?: 'drop' | 'keep'
  }
}

export interface FrameView {
  rows: number
  columns: { name: string; dtype: string }[]
  head: unknown[][]
}

export interface PreviewResult {
  before: FrameView
  after: FrameView
  added: string[]
  removed: string[]
  features?: string[]
  notes?: string[]
  /** 分割の後に分かる気付き (分割をまたぐグループや画像の重なり. 文は notes にも入る) */
  findings?: Finding[]
  splits?: Record<string, number>
  classes?: string[]
}

/** 書き出したデータセットに合わせてモデルを組むときの数 */
export interface ModelHints {
  input_shape: number[]
  input_dtype: string
  /** 出力の幅 (目的の無いデータセットは null) */
  outputs: number | null
  /** 文の語彙の大きさ (埋め草と語彙に無い語を含む. 文だけ) */
  vocabulary?: number
}

export interface ExportResult {
  path: string
  info: Record<string, unknown>
  hints?: ModelHints
}

export interface DatasetSummary {
  name: string
  path: string
  kind: string
  task: string
  target: string | null
  splits: Record<string, number>
  features: number
  created_at: string
}

/** 多視点の撮影の 1 件 (各枚と上から見たカメラの配置) */
export interface CaptureItem {
  frames: {
    index: number
    tracking: string | null
    image: boolean
    depth: boolean
    confidence: boolean
  }[]
  layout: {
    /** 物の周りを回った撮影か (違えば位置は null) */
    orbit: boolean
    cameras: { frame: number; x: number | null; y: number | null; tracked: boolean }[]
    /** 最も大きい方位の隙間 (度) と, その始まりの方位 (度. 上から見て反時計回り) */
    gap: number | null
    gap_from: number | null
  }
  intrinsics: Record<string, number | null>
  point_cloud: boolean
}

export interface PointsItem {
  count: number
  points: number[]
  colors: number[] | null
}

/** 中身の手順の前と後の 1 件 (画像は PNG の data URL, 文は文字と [番号, 語], 点群は点) */
export interface ItemPreviewItem {
  index: number
  label: string | null
  shape: number[]
  before: string | PointsItem
  after: string | [number, string][] | PointsItem
}

export interface ItemPreview {
  items: ItemPreviewItem[]
  fit_rows: number
}
