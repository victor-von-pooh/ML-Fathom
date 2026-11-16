import type { ColumnInfo, Finding, Profile } from '../api/types'
import { defaultDatasetName } from './format'
import { autoItemSteps, autoRecipe, suggestSteps, unreadableFilter } from './suggest'

/** 分析の結果の列の情報を作る */
function column(type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    type,
    dtype: type === 'numeric' ? 'float64' : 'str',
    count: 100,
    missing: 0,
    missing_ratio: 0,
    unique: 3,
    ...extra,
  }
}

const columns: Record<string, ColumnInfo> = {
  id: column('id', { dtype: 'int64', unique: 100 }),
  age: column('numeric', { missing: 40, missing_ratio: 0.4, min: 1 }),
  income: column('numeric', { min: 0 }),
  name: column('text'),
  city: column('categorical', { missing: 2 }),
  shop: column('categorical', { unique: 80 }),
  label: column('boolean'),
}

const findings: Finding[] = [
  { severity: 'warning', code: 'id_like', message: '', columns: ['id'] },
  { severity: 'warning', code: 'high_missing', message: '', columns: ['age'] },
  { severity: 'info', code: 'skewed', message: '', columns: ['income'] },
]

test('気付きから, 列を落とす手順と型に合う補完の手順を作る', () => {
  const steps = suggestSteps(findings, 'label', columns)
  expect(steps[0]).toEqual({ op: 'drop_columns', columns: ['id'] })
  expect(steps).toContainEqual(
    expect.objectContaining({ op: 'impute', columns: ['age'], strategy: 'median' }),
  )
  expect(steps).toContainEqual({ op: 'log', columns: ['income'] })
})

test('列の型から, 全て数値で欠損の無い形にする手順を作る', () => {
  const steps = autoRecipe(columns, 'label', findings, {})
  const ops = steps.map((step) => step.op)
  expect(steps[0]).toEqual({ op: 'drop_columns', columns: ['id', 'name'] })
  expect(ops.at(-1)).toBe('standardize')
  expect(steps).toContainEqual({ op: 'one_hot', columns: ['city'] })
  expect(steps).toContainEqual({ op: 'label_encode', columns: ['shop'] })
  expect(steps).toContainEqual({ op: 'impute', columns: ['city'], strategy: 'most_frequent' })
  // 目的の列は手順に入れない
  const used = steps.flatMap((step) => (Array.isArray(step.columns) ? step.columns : []))
  expect(used).not.toContain('label')
})

describe('autoItemSteps', () => {
  /** 中身の分析の結果だけを持つ分析の結果を作る */
  const profile = (extra: Partial<Profile>) => ({ columns: {}, ...extra }) as Profile

  it('大きな写真は長い辺を 224 までに縮める', () => {
    const steps = autoItemSteps(
      'image',
      profile({
        items: { kind: 'image', count: 3, sizes: [{ width: 4000, height: 3000, count: 3 }] },
      }),
    )
    expect(steps[0]).toEqual({ op: 'resize', width: 224, height: 168 })
  })

  it('空白で区切らない文は文字ごと, 点の数が 1 種類の点群は最も多い値', () => {
    const text = autoItemSteps(
      'text',
      profile({
        columns: {
          words: column('numeric', { q3: 1 }),
          length: column('numeric', { q3: 40 }),
        },
      }),
    )
    expect(text[0]).toMatchObject({ unit: 'char', length: 60 })
    // 英語 (1 語 5 文字ほど) は語ごと
    const english = autoItemSteps(
      'text',
      profile({
        columns: { words: column('numeric', { q3: 25 }), length: column('numeric', { q3: 140 }) },
      }),
    )
    expect(english[0]).toEqual({ op: 'vocabulary', length: 38, max_tokens: 20000 })
    const cloud = autoItemSteps(
      'pointcloud',
      profile({
        columns: { points: column('constant', { top: [{ value: '512', count: 9 }] }) },
      }),
    )
    expect(cloud[0]).toEqual({ op: 'sample_points', points: 512 })
  })
})

test('読めない件があれば, 画像は大きさ, 点群は error で除く手順を作る', () => {
  const items = { kind: 'image', count: 3, unreadable: 1 }
  const image = { columns: { width: column('numeric') }, items } as unknown as Profile
  expect(unreadableFilter('image', image)).toEqual({
    op: 'filter_rows',
    column: 'width',
    compare: 'notna',
  })
  const cloud = { columns: { error: column('text') }, items } as unknown as Profile
  expect(unreadableFilter('pointcloud', cloud)).toMatchObject({ column: 'error', compare: 'isna' })
  expect(
    unreadableFilter('image', { columns: {}, items: { kind: 'image', count: 3 } } as Profile),
  ).toBe(null)
})

test('時系列は過去の値と移動平均の列を足し, 始めの行を落としてから標準化する', () => {
  const series = { time: column('datetime'), y: column('numeric') }
  const steps = autoRecipe(series, 'y', [], { time: 'time' }, 24)
  expect(steps.map((step) => step.op)).toEqual([
    'lag',
    'drop_missing',
    'datetime_parts',
    'standardize',
  ])
  expect(steps[0]).toEqual({ op: 'lag', columns: ['y'], lags: [1, 24], windows: [24] })
})

test('文の重複, 空の文, 目的の列の表記のゆれから手順を作る', () => {
  const found: Finding[] = [
    { severity: 'warning', code: 'duplicate_items', message: '', columns: ['review'] },
    { severity: 'info', code: 'empty_items', message: '', columns: ['review'] },
    {
      severity: 'warning',
      code: 'mixed_forms',
      message: 'normalize_text (columns: [label], lowercase: true)',
      columns: ['label'],
    },
  ]
  expect(suggestSteps(found, 'label', {}, { length: 'length.1' })).toEqual([
    { op: 'drop_duplicates', columns: ['review'] },
    { op: 'filter_rows', column: 'length.1', compare: '>', value: 0 },
    { op: 'normalize_text', columns: ['label'], lowercase: true },
  ])
})

test('店ごとの系列は, 重複と表記をそろえてから系列ごとにずらし, その後に符号化する', () => {
  const panel = {
    date: column('datetime'),
    store: column('categorical'),
    sales: column('numeric'),
  }
  const found: Finding[] = [
    { severity: 'warning', code: 'duplicate_rows', message: '', columns: [] },
    { severity: 'warning', code: 'mixed_forms', message: '', columns: ['store'] },
  ]
  const steps = autoRecipe(panel, 'sales', found, { time: 'date' }, 7, 'store')
  expect(steps.map((step) => step.op)).toEqual([
    'normalize_text',
    'drop_duplicates',
    'lag',
    'drop_missing',
    'datetime_parts',
    'one_hot',
    'standardize',
  ])
  expect(steps[2]).toEqual({
    op: 'lag',
    columns: ['sales'],
    lags: [1, 7],
    windows: [7],
    by: ['store'],
  })
  // 系列を分ける列は ID らしくても落とさない
  const idLike = { ...panel, store: column('id') }
  expect(autoRecipe(idLike, 'sales', [], { time: 'date' }, 7, 'store')[0]?.op).toBe('lag')
})

test('書き出しの名前の既定は, 日本語の名前ならファイルの名前から作る', () => {
  expect(defaultDatasetName('churn.csv', '/a/churn.csv')).toBe('churn')
  expect(defaultDatasetName('日本語のレビュー', '/a/data/reviews_ja.csv')).toBe('reviews_ja')
  expect(defaultDatasetName('顧客の解約 (表)', '/a/samples/churn.csv')).toBe('churn')
  expect(defaultDatasetName('my data v2', '/x/y.csv')).toBe('my_data_v2')
  expect(defaultDatasetName('名前', '/x/データ.csv')).toBe('dataset')
  expect(defaultDatasetName('images', '/x/images/')).toBe('images')
  expect(defaultDatasetName('sales (2024)', '/x/q.csv')).toBe('sales_2024')
  expect(defaultDatasetName('-foo.csv', '/x/-foo.csv')).toBe('foo')
})

test('系列が多ければ, 系列を分ける列は番号付けにする', () => {
  const many = {
    date: column('datetime'),
    item: column('categorical', { unique: 600 }),
    sales: column('numeric'),
  }
  const steps = autoRecipe(many, 'sales', [], { time: 'date', series: 'item' }, 7, 'item', 86400)
  expect(steps.find((step) => step.op === 'label_encode')).toMatchObject({ columns: ['item'] })
  expect(steps.some((step) => step.op === 'one_hot')).toBe(false)
  expect(steps.find((step) => step.op === 'lag')).toMatchObject({ by: ['item'] })
})
