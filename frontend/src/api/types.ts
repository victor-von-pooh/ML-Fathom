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
  /** プロジェクトへ書き出した場所 */
  project_dataset?: string | null
}

/** ML-Quest がプロジェクトを作ったときの記録 (問題の設定の project) */
export interface ProjectRecord {
  path?: string
  dataset?: string
  model_spec?: string
}

/** ML-Pathfinder の置き場の問題の設定の 1 件 */
export interface StoredProblem {
  path: string
  name: string
  created_at: string | null
  updated_at: string | null
  /** 始められるか (列の予測で, データを入れてある) */
  startable: boolean
  /** 始められない理由 */
  reason: string | null
  project: ProjectRecord | null
}

/** ML-Pathfinder の置き場の問題の設定の一覧 */
export interface ProblemList {
  /** 置き場の problems の場所 */
  root: string
  problems: StoredProblem[]
  /** 置き場を読めない場合の理由 */
  error: string | null
}

/** 始めた問題の設定のプロジェクトの書き出し先と, その場所の様子 */
export interface ProjectPlace {
  project: string | null
  dataset: string | null
  /** missing は無い, dataset は前に書き出したもの, occupied はデータセットでないもの */
  state: 'missing' | 'dataset' | 'occupied' | null
  ready: boolean
  reason: string | null
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

/** ファイルの組の書き出しの項目で選べる中身の手順 (省けない引数付き) */
export interface PairStepInfo extends ItemStepInfo {
  required: string[]
  /** 引数の上限 (画像の辺と点の数. 上限の無い引数は無い) */
  limits: Record<string, number>
}

/** ファイルの組の書き出しの種類から, 項目の名前から選べる中身の手順 */
export type PairSteps = Record<'image_masks' | 'capture_clouds', Record<string, PairStepInfo[]>>

export interface Info {
  loaders: LoaderInfo[]
  steps: StepInfo[]
  item_steps: ItemStepInfo[]
  pair_steps: PairSteps
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
  /** 音声の標本化の周波数 (Hz) とチャンネルの数ごとの件数, 長さ (秒) */
  sample_rates?: Record<string, number>
  channels?: Record<string, number>
  duration?: { min: number; median: number; max: number; total: number } | null
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

/** モデルの入力の 1 つ (ML-EDA の model_inputs. 形の null はバッチの次元) */
export interface ModelInput {
  name: string
  shape: (number | null)[]
  dtype: string
  /** 文の語の番号の入力の語彙の大きさ (埋め込みの数. 文でなければ無い) */
  vocabulary?: number
}

/** データセットからモデルに要るもの (ML-EDA の model_inputs) */
export interface ModelInputs {
  inputs: ModelInput[]
  task: string | null
  target: string | null
  classes: unknown[] | null
  /** 1 件に出す値の数 (分類はクラスの数, 回帰と時系列の予測は 1) */
  outputs: number | null
}

export interface ExportResult {
  path: string
  info: Record<string, unknown>
  hints?: ModelHints
}

interface DatasetBase {
  name: string
  path: string
  /** dataset.yaml の版 (読めないものは書かれた値のまま) */
  format_version: unknown
  created_at: string | null
  /** プロジェクトへ書き出したもの (書き出したデータか問題の設定の名前. 空のこともある) */
  project?: string
  /** project の元 (登録したデータか, ML-Pathfinder の置き場の問題の設定) */
  project_from?: 'source' | 'problem'
}

/** 版 1 (1 件 = 1 行の表. load_dataset で読む) */
export interface TableDataset extends DatasetBase {
  form: 'table'
  kind: string
  task: string
  target: string | null
  splits: Record<string, number>
  features: number
  /** モデルに要るもの */
  model: ModelInputs
}

/** 正解の出どころ (ML-EDA の target.origin) */
export interface PairOrigin {
  type: string
  name?: string | null
  settings?: Record<string, unknown>
}

/** 版 2 の項目 (入力か正解) */
export interface ItemEntry {
  name: string
  kind: string
  role: string
  units: string | null
  convention: Record<string, unknown> | null
  shape: (number | null)[] | null
  formats: string[] | null
  /** 書き出しでかけた中身の手順 (版 3 の手順をかけた項目だけ) */
  steps: RecipeStep[] | null
}

/** 版 2 と版 3 (入力と正解がファイルの組. load_items で読む. 版 3 は中身の手順付き) */
export interface ItemsDataset extends DatasetBase {
  form: 'items'
  role: string | null
  target: { kind: string | null; entries: string[]; origin: PairOrigin }
  entries: ItemEntry[]
  splits: Record<string, number>
  items: number
  /** 座標の正規化の方法 (かけた場合だけ) */
  normalization: string | null
  notes: string[]
}

/** 読めないデータセット (知らない版, 壊れたもの) */
export interface UnreadableDataset extends DatasetBase {
  form: 'unreadable'
  /** 版 1, 2, 3 の他の版 */
  unknown_version: boolean
  error: string
}

export type DatasetSummary = TableDataset | ItemsDataset | UnreadableDataset

/** ファイルの組の書き出しに共通の設定 */
export interface PairExportBase {
  name: string
  overwrite: boolean
  split: {
    method?: 'random' | 'group' | 'none'
    /** 正解の無い件を unlabeled の分割に書くなら keep (除くなら省く) */
    unlabeled?: 'drop' | 'keep'
    valid: number
    test: number
    seed: number
  }
  groups?: Record<string, string>
  origin: PairOrigin
  /** 項目の名前から中身の手順の並び (渡すと版 3 で書き出す) */
  item_steps?: Record<string, RecipeStep[]>
}

export interface ImageMaskExport extends PairExportBase {
  images: string
  masks: string
  classes?: Record<string, string>
  mask_suffix: string
}

export interface CaptureCloudExport extends PairExportBase {
  captures: string
  clouds: string
  cloud_units: string
}

export interface PairExportResult {
  path: string
  info: Record<string, unknown>
  notes: string[]
}

/** ML-Quest のファイルの組の書き出しの設定 (問題の設定の data.export) */
export interface PairSettings {
  function: 'export_image_masks' | 'export_capture_clouds'
  inputs: string | null
  targets: string | null
  split: {
    method?: 'random' | 'group' | 'none'
    unlabeled?: 'drop' | 'keep'
    valid?: number
    test?: number
    seed?: number
  }
  groups: Record<string, string> | null
  origin: Partial<PairOrigin>
  options: {
    classes?: Record<string, string>
    mask_suffix?: string
    cloud_units?: string
    /** 項目の名前から中身の手順の並び (手順が無ければ無い) */
    item_steps?: Record<string, RecipeStep[]>
  }
}

/** ファイルの組の受け持ちの問題の設定から始めたときの下書きと書き出し先 */
export interface ProblemPairs {
  name: string | null
  path: string
  /** 書き出すときに送り返す, 問題の設定のファイルの中身の印 */
  version: string
  form: 'image_masks' | 'capture_clouds'
  export: PairSettings
  notes: string[]
  project: ProjectPlace
}

/** 問題の設定のプロジェクトへ書き出して書き戻した結果 */
export interface ProblemPairsResult extends PairExportResult {
  changes: string[]
  conflicts: ProblemFinding[]
  version: string
}

/** 問題の設定から始めた結果 (ファイルの組の受け持ちは source が null で form を持つ) */
export interface ProblemStarted {
  source: Source | null
  problem: string
  form: 'image_masks' | 'capture_clouds' | null
  notes: string[]
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

/** 音声の 1 件 (先頭の決まった秒まで). 波形はチャンネルを平均した振幅の区間ごとの最小と最大 */
export interface AudioItem {
  sample_rate: number
  channels: number
  /** 全体の長さ (秒. 分からなければ null) */
  duration: number | null
  /** 再生と波形に使う長さ (秒) */
  seconds: number
  /** 先頭だけを読んだか */
  truncated: boolean
  waveform: { min: number[]; max: number[] }
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
