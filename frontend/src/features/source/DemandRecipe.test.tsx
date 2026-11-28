import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type {
  ColumnInfo,
  DemandSummary,
  PreviewResult,
  Profile,
  Recipe,
  StepInfo,
} from '../../api/types'
import { clearDraft } from '../../lib/drafts'
import { RecipeTab } from './RecipeTab'

beforeEach(() => {
  window.localStorage.clear()
  // 前の確かめで変えた編集中のレシピ (メモリにも覚える) を捨てる
  clearDraft('s1')
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 商品ごとの日ごとの売れた数の記録の, 時間をまたぐ量の判断のレシピ */
const RECIPE: Recipe = {
  format_version: 1,
  target: 'units',
  task: 'demand',
  product: 'product_id',
  date: 'date',
  stock: 'stock',
  horizon: 7,
  steps: [
    {
      op: 'lag',
      columns: ['units'],
      lags: [1, 7],
      by: ['product_id'],
      time: 'date',
      freq: '1D',
    },
    { op: 'standardize', columns: 'auto' },
  ],
  split: { method: 'time', valid: 0.2, test: 0.2 },
}

const column = (unique: number, type = 'numeric', dtype = 'float64'): ColumnInfo =>
  ({
    type,
    dtype: type === 'numeric' ? dtype : 'object',
    count: 353,
    missing: 0,
    unique,
  }) as unknown as ColumnInfo

/** 商品の id, 日付, 特徴, 売れた数, 在庫の数と行の番号の表の分析 */
const PROFILE = {
  summary: { kind: 'table', rows: 353, roles: {}, has_items: false },
  overview: { roles: {}, sampled: false },
  columns: {
    record_id: column(353, 'id', 'int64'),
    product_id: column(5, 'categorical'),
    date: column(84, 'categorical'),
    category: column(2, 'categorical'),
    units: column(30, 'numeric', 'int64'),
    stock: column(35, 'numeric', 'int64'),
  },
  correlations: { columns: [], pearson: [], spearman: [] },
  associations: { columns: [], cramers_v: [] },
  target: null,
  timeseries: null,
  findings: [],
} as unknown as Profile

const VIEW = { rows: 353, columns: [], head: [] }

/** 全ての手順の後の様子 */
const PREVIEW: PreviewResult = {
  before: VIEW,
  after: VIEW,
  added: [],
  removed: [],
  features: ['units_lag1', 'units_lag7', 'category=food'],
  notes: [],
  findings: [],
  splits: { train: 20, valid: 11, test: 8 },
  classes: [],
  anomaly: null,
  uplift: null,
  price: null,
  demand: {
    id: 'row_id',
    product: 'product_id',
    date: 'date',
    units: 'units',
    stock: 'stock',
    target: 'demand',
    previous: 'demand_previous',
    horizon: 7,
    interval: 7,
    unlabeled: 'drop',
    skipped: { previous: 8, boundary: 0 },
    splits: {
      train: {
        rows: 20,
        products: 4,
        date_min: '2025-01-13',
        date_max: '2025-02-17',
        demand_mean: 78.95,
        previous_mean: 79.3,
        stockout: 1,
      },
      valid: {
        rows: 11,
        products: 4,
        date_min: '2025-02-24',
        date_max: '2025-03-10',
        demand_mean: 79.25,
        previous_mean: 79.9,
        stockout: 1,
      },
      test: {
        rows: 8,
        products: 5,
        date_min: '2025-03-17',
        date_max: '2025-03-24',
        demand_mean: 82.25,
        previous_mean: 87.75,
        stockout: 0,
      },
    },
  },
}

/** 需要の記録の要約 (記録の短い商品, 抜けの日, 在庫が 0 の日の気付き) */
const SUMMARY: DemandSummary = {
  product: 'product_id',
  date: 'date',
  units: 'units',
  stock: 'stock',
  horizon: 7,
  rows: 353,
  missing: { product: 0, date: 0, units: 0, stock: 0 },
  invalid: { date: 0, units: 0, stock: 0 },
  duplicates: 0,
  dates: { min: '2025-01-06', max: '2025-03-30', days: 84 },
  unit_stats: { min: 0, max: 32, mean: 11.4, zero_rate: 0.003 },
  weekdays: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    rows: 50,
    units_mean: weekday >= 5 ? 14.8 : 10.1,
  })),
  products: {
    count: 5,
    short: 1,
    gaps: 1,
    missing_days: 3,
    rows: [
      {
        product: 'p4',
        days: 20,
        first: '2025-03-11',
        last: '2025-03-30',
        gaps: 0,
        stockout: 0,
        units_mean: 19.9,
      },
      {
        product: 'p1',
        days: 81,
        first: '2025-01-06',
        last: '2025-03-30',
        gaps: 3,
        stockout: 0,
        units_mean: 9,
      },
    ],
  },
  stockout: { rows: 4, products: 1, rate: 0.011 },
  findings: [
    {
      severity: 'warning',
      code: 'short_history',
      message: '記録の日数が 28 日 (先の期間の 4 倍) 未満の商品が 1 件あります (p4)',
      columns: ['product_id'],
    },
  ],
}

/** 手順の説明 (列の欄を出す手順. 標準化は値を学ぶ) */
const STEPS: StepInfo[] = ['lag', 'standardize', 'drop_columns', 'impute'].map((op) => ({
  op,
  params: { columns: op === 'drop_columns' ? '落とす列' : '列 (auto も)' },
  description: op,
  fits: op === 'standardize' || op === 'impute',
}))

/** 時間をまたぐ量の判断のレシピで前処理のタブを描く */
function renderTab(recipe: Recipe = RECIPE) {
  vi.spyOn(api, 'recipe').mockResolvedValue(recipe)
  vi.spyOn(api, 'preview').mockResolvedValue(PREVIEW)
  const demand = vi.spyOn(api, 'demand').mockResolvedValue(SUMMARY)
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sources/s1?tab=recipe']}>
        <RecipeTab
          sourceId="s1"
          sourceName="daily"
          sourcePath="/work/daily.csv"
          profile={PROFILE}
          target="units"
          steps={STEPS}
          kind="table"
          itemSteps={[]}
          loader="csv"
          options={{}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return demand
}

/** 選ぶ欄の選択肢の値 */
const optionsOf = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map(
    (option) => option.value,
  )

test('時間をまたぐ量の判断では, 商品の id, 日付, 在庫の数, 行の id の列と期間を選べ, 分割は時刻の順だけ', async () => {
  renderTab()
  const product = (await screen.findByLabelText('商品の id の列')) as HTMLSelectElement
  expect(product.value).toBe('product_id')
  // 日付は数でない列, 在庫の数は数の列から, 目的の列を除く
  expect(optionsOf('日付の列')).toEqual(['', 'record_id', 'product_id', 'date', 'category'])
  expect(optionsOf('在庫の数の列')).toEqual(['', 'stock'])
  expect(optionsOf('行の id の列')).toEqual(['', 'record_id'])
  expect(optionsOf('正解の欠けた行')).toEqual(['drop', 'keep'])
  expect((screen.getByLabelText('先の期間の日数') as HTMLInputElement).value).toBe('7')
  const split = screen.getByLabelText('分割') as HTMLSelectElement
  const enabled = Array.from(split.options)
    .filter((option) => !option.disabled)
    .map((option) => option.value)
  expect(enabled).toEqual(['time'])
  // 先の期間を変えるとレシピに入り, 空にすると既定に戻る
  fireEvent.change(screen.getByLabelText('先の期間の日数'), { target: { value: '14' } })
  expect(screen.getByText(/format_version/).textContent).toContain('horizon: 14')
  fireEvent.change(screen.getByLabelText('先の期間の日数'), { target: { value: '' } })
  expect(screen.getByText(/format_version/).textContent).not.toContain('horizon')
})

test('需要の記録の要約に, 商品ごとの記録の日数と抜けの日, 曜日ごとの売れた数と在庫が 0 の日を出す', async () => {
  const demand = renderTab()
  expect(await screen.findByText('記録の短い商品 1')).toBeTruthy()
  expect(screen.getByText(/抜けの日のある商品 1 \(抜けの日は計 3 日\)/)).toBeTruthy()
  expect(screen.getByText(/在庫が 0 の日 4/)).toBeTruthy()
  expect(demand).toHaveBeenCalledWith('s1', {
    product: 'product_id',
    date: 'date',
    units: 'units',
    stock: 'stock',
    horizon: 7,
  })
  const weekdays = screen.getByRole('table', { name: /曜日ごとの売れた数/ })
  expect(weekdays.textContent).toContain('土')
  expect(weekdays.textContent).toContain('14.8')
  const products = screen.getByRole('table', { name: /商品ごとの記録/ })
  expect(products.textContent).toContain('p4')
  expect(screen.getByText(/記録の日数が 28 日/)).toBeTruthy()
})

test('学習用のデータに, 分割ごとの発注を決める日の範囲と期間の合計を出す', async () => {
  renderTab()
  const table = await screen.findByRole('table', { name: /分割ごとの行と商品の数, 発注を決める日/ })
  expect(table.textContent).toContain('2025-02-24')
  expect(table.textContent).toContain('79.25')
  expect(screen.getByText(/前の期間が揃わない 8 行/)).toBeTruthy()
})

test('lag の位置と書き方, 商品の id と在庫の数の列を書いた手順は誤りを出す', async () => {
  renderTab({
    ...RECIPE,
    steps: [
      { op: 'standardize', columns: 'auto' },
      { op: 'lag', columns: ['units'], lags: [0], time: 'date' },
      { op: 'impute', columns: ['stock'] },
    ],
  })
  expect(await screen.findByText(/手順 2 \(lag\) は値を学ぶ最初の手順 \(手順 1\)/)).toBeTruthy()
  expect(screen.getByText(/手順 2 \(lag\) の lags は 1 以上の整数/)).toBeTruthy()
  expect(screen.getByText(/手順 2 \(lag\) の by に商品の id の列 product_id/)).toBeTruthy()
  expect(screen.getByText(/手順 3 \(impute\) には stock を書けません/)).toBeTruthy()
  // 埋める手順の列の候補に商品の id と在庫の数の列は無く, 列を落とす手順にはある
  const select = (id: string) =>
    Array.from((document.getElementById(id) as HTMLSelectElement).options).map(
      (option) => option.value,
    )
  expect(select('step-2-columns')).not.toContain('stock')
  expect(select('step-2-columns')).not.toContain('product_id')
  fireEvent.change(screen.getByLabelText('足す手順'), { target: { value: 'drop_columns' } })
  fireEvent.click(screen.getByRole('button', { name: '足す' }))
  await screen.findByRole('button', { name: '手順 4 を消す' })
  expect(select('step-3-columns')).toContain('stock')
})

test('lag が無ければ, 過去の売れた数と曜日の手順を先頭に足せる', async () => {
  renderTab({ ...RECIPE, steps: [{ op: 'standardize', columns: 'auto' }] })
  fireEvent.click(await screen.findByRole('button', { name: '過去の売れた数と曜日の手順を足す' }))
  const yaml = screen.getByText(/format_version/).textContent ?? ''
  expect(yaml.indexOf('op: lag')).toBeLessThan(yaml.indexOf('op: standardize'))
  expect(yaml).toContain('freq: 1D')
  expect(screen.queryByRole('button', { name: '過去の売れた数と曜日の手順を足す' })).toBeNull()
})

test('他のタスクに変えると, 日付, 在庫の数, 期間と商品の id の列を消す', async () => {
  renderTab()
  await screen.findByLabelText('日付の列')
  fireEvent.change(screen.getByLabelText('タスク'), { target: { value: 'regression' } })
  expect(screen.queryByLabelText('日付の列')).toBeNull()
  expect(screen.queryByText('需要の記録の要約')).toBeNull()
  const yaml = screen.getByText(/format_version/).textContent ?? ''
  expect(yaml).not.toContain('product: product_id')
  expect(yaml).not.toContain('date: date')
  expect(yaml).not.toContain('stock:')
  expect(yaml).not.toContain('horizon')
})

test('分割が時刻の順でなければ誤りを出し, 日付の列が無ければ要約を求めない', async () => {
  const { date: _date, ...rest } = RECIPE
  const demand = renderTab({ ...rest, split: { ...RECIPE.split, method: 'random' } })
  // 欄の下の誤りは分割の欄から結び, 欄を正しくない値にする
  const split = await screen.findByLabelText('分割')
  expect(split).toHaveAttribute('aria-invalid', 'true')
  expect(split).toHaveAccessibleDescription(new RegExp('時間をまたぐ量の判断の分割は時刻の順だけ'))
  expect(screen.getByText(/商品の id の列と日付の列を選ぶと/)).toBeTruthy()
  expect(demand).not.toHaveBeenCalled()
})
