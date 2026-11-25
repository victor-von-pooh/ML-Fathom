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
  /** 問題の設定から始めたときの ML-Quest の知らせ (作るものの落とす列, 画像の大きさなど) */
  problem_notes?: string[]
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
  /**
   * missing は無い, dataset は前に書き出したもの, occupied はデータセットでないもの.
   * 並べるの反応の表とまとめるの表 (ファイル 1 つ) では dataset の代わりに file (前に置いたファイル) で,
   * occupied はファイルでないもの
   */
  state: 'missing' | 'dataset' | 'file' | 'occupied' | null
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
  /** 引数の上限 (画像の辺, 点の数, 音声の周波数など. 上限の無い引数は無い) */
  limits: Record<string, number>
}

/** ファイルの組の書き出しの項目で選べる中身の手順 (省けない引数付き) */
export interface PairStepInfo extends ItemStepInfo {
  required: string[]
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
  /** 開くタブ (まとめるは群分けのタブ. 他は null) */
  tab: 'groups' | null
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

/** 中身の手順の前と後の音声 (先頭の決まった秒の波形と, 再生用の WAVE の data URL) */
export interface AudioPreviewItem extends AudioItem {
  src: string
}

/** 中身の手順の前と後の 1 件 (画像は PNG の data URL, 文は文字と [番号, 語], 点群は点, 音声は波形と音) */
export interface ItemPreviewItem {
  index: number
  label: string | null
  shape: number[]
  before: string | PointsItem | AudioPreviewItem
  after: string | [number, string][] | PointsItem | AudioPreviewItem
}

export interface ItemPreview {
  items: ItemPreviewItem[]
  fit_rows: number
}

/** 記録した軌跡の値の要約 (ML-EDA の describe_trajectory の length, return) */
export interface TrajectoryStats {
  min: number | null
  max: number | null
  mean: number | null
  std: number | null
  median: number | null
}

/** 記録した軌跡の観測か行動の 1 つの要素 */
export interface TrajectoryElement {
  name: string
  type: string
  /** 空の数 (nan は値なので含まない) */
  missing: number
  nan: number
  infinite: number
  min: number | null
  max: number | null
  mean: number | null
  std: number | null
  median: number | null
  /** 整数の列で, 異なる値が 50 以下なら値ごとの数 */
  counts: { value: number; count: number }[] | null
}

/** 記録した軌跡のエピソードの終わり方 */
export type TrajectoryEnd = 'terminated' | 'truncated' | 'stop' | 'handover' | 'open'

/** 記録した軌跡の 1 つのエピソード */
export interface TrajectoryEpisode {
  episode: number
  rows: number
  length: number
  /** 報酬の和 (有限でなければ null) */
  return: number | null
  end: TrajectoryEnd
  seed: number | null
}

/** 記録した軌跡の要約 (ML-EDA の describe_trajectory) */
export interface TrajectorySummary {
  name: string
  format: string
  described: boolean
  format_version: number | null
  source: string | null
  env: unknown
  epoch: number | null
  description: string | null
  complete: boolean | null
  dropped_episodes: number | null
  observation_space: Record<string, unknown> | null
  action_space: Record<string, unknown> | null
  rows: number
  episodes: number
  steps: number
  columns: { name: string; type: string }[]
  observation_columns: string[]
  action_columns: string[]
  extra_columns: string[]
  guarded: boolean
  /** 行動を選んだ確率の列 (action_prob) があるか */
  with_action_prob: boolean
  length: TrajectoryStats
  return: TrajectoryStats
  unknown_returns: number
  ends: Record<TrajectoryEnd, number>
  observations: TrajectoryElement[]
  actions: TrajectoryElement[]
  guard: {
    results: Record<string, number>
    reasons: { reason: string; count: number }[]
  } | null
  /** 確率の列の空の数, 範囲 (0 より大きく 1 以下) の外の数と, 範囲の中の値の要約 */
  action_prob: (TrajectoryStats & { missing: number; out_of_range: number }) | null
  per_episode: TrajectoryEpisode[]
  per_episode_truncated: boolean
  notes: string[]
}

/** 利用者ごとか品物ごとの反応の数の要約 (ML-EDA の describe_reactions の per_user, per_item) */
export interface ReactionCounts {
  min: number | null
  max: number | null
  mean: number | null
  std: number | null
  median: number | null
  /** 1 回だけの数 */
  once: number
  /** 区切りごとの数 (to は含み, 最後は null) */
  bins: { from: number; to: number | null; count: number }[]
}

/** 並べるの反応の表の要約 (ML-EDA の describe_reactions) */
export interface ReactionsSummary {
  columns: { user: string; item: string; time: string; reaction: string | null }
  source: Record<string, unknown>
  /** 除く前の行の数 */
  rows: number
  /** 残した反応の数 */
  reactions: number
  dropped: { missing: number; unreadable_time: number; not_positive: number; total: number }
  users: number
  items: number
  pairs: number
  repeated: number
  density: number | null
  per_user: ReactionCounts
  per_item: ReactionCounts
  popularity: {
    top_items: number
    top_share: number | null
    gini: number | null
    popular: { item: string | number | boolean; reactions: number }[]
  }
  time: {
    kind: 'number' | 'datetime'
    min: number | string | null
    max: number | string | null
    distinct: number
  }
  reaction: {
    min: number | null
    max: number | null
    mean: number | null
    std: number | null
    median: number | null
  } | null
  notes: string[]
}

/** 並べるの問題の設定の列で読んだ反応の表 */
export interface ReactionsResult {
  /** 問題の設定の名前 */
  name: string | null
  /** problem.yaml の場所 */
  path: string
  /** 利用者ごとに並べる件数の答え */
  k: number | null
  summary: ReactionsSummary
}

/** 反応の表をプロジェクトへ写した結果 */
export interface ReactionsExportResult {
  path: string
  /** 写したか (書き出し先が登録した表そのものなら false) */
  copied: boolean
  /** 骨組みが反応とみなす行の数 */
  reactions: number
  /** 骨組みが除く行の数 */
  dropped: number
}

/**
 * 群の要約の 1 行 (ML-EDA の describe_groups の groups. ML-Quest のまとめるの骨組みの
 * evaluations/group_summary.json の行と同じ形). 群を作った列ごとの要約は列の名前の鍵で,
 * 数の列は平均, 他の列は最も多い値と割合の文 (行の無い群は null)
 */
export interface GroupRow {
  /** k-means では 0 から始まる群の番号. 最後の全ての行の行は「全体」 */
  group: number | string
  rows: number
  share: number | null
  /** 作り直した群のうち最も重なる群との Jaccard 係数の平均 (全体と行の無い群は null) */
  stability: number | null
  [column: string]: number | string | null
}

/** 学習に通さずに作った群の要約 (ML-EDA の describe_groups) */
export interface GroupSummary {
  method: 'kmeans' | 'labels'
  k: number
  rows: number
  columns: { numeric: string[]; categorical: string[] }
  /** 符号化した行の幅 */
  width: number
  seed: number | null
  groups: GroupRow[]
  /** 種を変えて作り直した群との調整ランド指数の平均と最も低い値 */
  stability: { method: string; repeats: number; ari: number | null; ari_min: number | null } | null
  silhouette: number | null
  source: Record<string, unknown>
  notes: string[]
}

/** 群を作る要求 */
export interface GroupRequest {
  columns: string[]
  k: number
  seed: number
}

/** 群分けの表の書き出しの要求 (ML-EDA の export_group_rows) */
export interface GroupExport {
  columns: string[]
  /** 行を見分ける列 (無ければ行の位置) */
  id: string | null
  split: { method: 'random' | 'none'; valid: number; test: number; seed: number }
  name: string
  overwrite: boolean
}

/** まとめるの問題の設定の答え (ML-Quest の ml.parts.<n>.group) */
export interface GroupAnswers {
  /** 群を作る列 (答えていなければ空) */
  columns: string[]
  /** 行を見分ける列 */
  id: string | null
  /** 群の数の答え (答えていなければ null) */
  k: number | null
  /** 安定性の数え方 (seed か sample) と, その言葉 */
  stability: string | null
  stability_label: string | null
}

/** 群分けのタブが読む, 始めた問題の設定の答えとプロジェクトの書き出し先 */
export interface GroupProblem {
  name: string | null
  /** problem.yaml の場所 */
  path: string
  /** まとめるで学習する受け持ちでなければ null */
  group: GroupAnswers | null
  project: ProjectPlace | null
}

/** まとめるの表をプロジェクトへ写した結果 */
export interface GroupProjectResult {
  path: string
  /** 写したか (書き出し先が登録した表そのものなら false) */
  copied: boolean
  rows: number
  /** 骨組みが群を作る列と, 行を見分ける列 */
  columns: string[]
  id: string | null
}
