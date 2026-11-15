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

export interface Info {
  loaders: LoaderInfo[]
  steps: StepInfo[]
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
  [key: string]: unknown
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
  split: { method: string; valid?: number; test?: number; seed?: number; column?: string }
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
  splits?: Record<string, number>
  classes?: string[]
}

export interface ExportResult {
  path: string
  info: Record<string, unknown>
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
