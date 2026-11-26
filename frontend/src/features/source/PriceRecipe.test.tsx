import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type {
  ColumnInfo,
  PreviewResult,
  PriceSummary,
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

/** 値段を変えた売れ行きの記録の, 値段を変える判断のレシピ (ML-Quest の雛形と同じ形) */
const RECIPE: Recipe = {
  format_version: 1,
  target: 'units',
  task: 'price',
  price: 'price',
  cost: 'unit_cost',
  product: 'product_id',
  id: 'record_id',
  steps: [{ op: 'standardize', columns: 'auto' }],
  split: { method: 'stratified', valid: 0.2, test: 0.2, seed: 0 },
}

const column = (unique: number, type = 'numeric'): ColumnInfo =>
  ({
    type,
    dtype: type === 'numeric' ? 'float64' : 'object',
    count: 240,
    missing: 0,
    unique,
  }) as unknown as ColumnInfo

/** 行の id, 商品の id, 特徴, 値段, 売れた数, 原価の表の分析 */
const PROFILE = {
  summary: { kind: 'table', rows: 240, roles: {}, has_items: false },
  overview: { roles: {}, sampled: false },
  columns: {
    record_id: column(240, 'id'),
    product_id: column(10, 'categorical'),
    weekday: column(7),
    price: column(40),
    units: column(30),
    unit_cost: column(10),
  },
  correlations: { columns: [], pearson: [], spearman: [] },
  associations: { columns: [], cramers_v: [] },
  target: null,
  timeseries: null,
  findings: [],
} as unknown as Profile

const VIEW = { rows: 240, columns: [], head: [] }

/** 全ての手順の後の様子 (値段の列が最後) */
const PREVIEW: PreviewResult = {
  before: VIEW,
  after: VIEW,
  added: [],
  removed: [],
  features: ['weekday', 'price'],
  notes: [],
  findings: [],
  splits: { train: 144, valid: 48, test: 48 },
  classes: [],
  anomaly: null,
  uplift: null,
  price: {
    id: 'record_id',
    price: 'price',
    raw: 'price_raw',
    cost: 'unit_cost',
    product: 'product_id',
    unlabeled: 'drop',
    steps: ['standardize'],
    splits: {
      train: {
        rows: 144,
        products: 10,
        price_min: 80,
        price_max: 324,
        prices: 38,
        units_mean: 21.5,
        cost_mean: 132,
      },
      valid: {
        rows: 48,
        products: 9,
        price_min: 81,
        price_max: 310,
        prices: 25,
        units_mean: 20.25,
        cost_mean: 130,
      },
      test: {
        rows: 48,
        products: 10,
        price_min: 80,
        price_max: 320,
        prices: 27,
        units_mean: 22,
        cost_mean: 135,
      },
    },
  },
}

/** 値段を変えた記録の要約 (試した値段が 1 つの商品と, 値段と強く関わる列の気付き) */
const SUMMARY: PriceSummary = {
  price: 'price',
  units: 'units',
  cost: 'unit_cost',
  product: 'product_id',
  rows: 240,
  missing: { price: 0, units: 0, cost: 0, product: 0 },
  invalid: { price: 0, units: 0, cost: 0 },
  price_stats: { min: 80, max: 324, median: 180, mean: 190, distinct: 40, width: 0.4 },
  unit_stats: { min: 5, max: 40, mean: 21, zero_rate: 0 },
  relation: {
    correlation: -0.3,
    elasticity: -1.5,
    bins: [{ bin: 0, rows: 48, price_min: 80, price_max: 120, price_mean: 100, units_mean: 28 }],
  },
  products: {
    count: 10,
    single_price: 1,
    width: 0.4,
    rows: [
      { product: 'p9', rows: 24, prices: 1, price_min: 280, price_max: 280, units_mean: 20 },
      { product: 'p0', rows: 24, prices: 5, price_min: 80, price_max: 120, units_mean: 21 },
    ],
  },
  cost_stats: { rows: 240, mean: 132, margin: 0.3, below: 0 },
  confounding: [
    { column: 'weekday', type: 'numeric', strength: 0.45 },
    { column: 'category', type: 'categorical', strength: 0.02 },
  ],
  findings: [
    {
      severity: 'warning',
      code: 'single_price_products',
      message: '試した値段が 1 つの商品があります (p9)',
      columns: ['product_id'],
    },
  ],
}

/** 手順の説明 (列の欄を出す手順. 列を落とすは名前で選ぶだけ) */
const STEPS: StepInfo[] = ['impute', 'clip', 'drop_columns'].map((op) => ({
  op,
  params: { columns: op === 'drop_columns' ? '落とす列' : '列 (auto も)' },
  description: op,
  fits: false,
}))

/** 値段を変える判断のレシピで前処理のタブを描く */
function renderTab(recipe: Recipe = RECIPE) {
  vi.spyOn(api, 'recipe').mockResolvedValue(recipe)
  vi.spyOn(api, 'preview').mockResolvedValue(PREVIEW)
  const price = vi.spyOn(api, 'price').mockResolvedValue(SUMMARY)
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sources/s1?tab=recipe']}>
        <RecipeTab
          sourceId="s1"
          sourceName="sales"
          sourcePath="/work/sales.csv"
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
  return price
}

/** 選ぶ欄の選択肢の値 */
const optionsOf = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map(
    (option) => option.value,
  )

test('値段を変える判断では, 値段, 原価, 商品の id と行の id の列を選べ, 分割は層化だけ', async () => {
  renderTab()
  const price = (await screen.findByLabelText('値段の列')) as HTMLSelectElement
  expect(price.value).toBe('price')
  // 値段と原価の候補は数の列から目的の列と行の id の列を除く
  expect(optionsOf('値段の列')).toEqual(['', 'weekday', 'price', 'unit_cost'])
  expect(optionsOf('原価の列')).toEqual(['', 'weekday', 'price', 'unit_cost'])
  expect(optionsOf('商品の id の列')).toEqual(['', 'product_id', 'weekday', 'price', 'unit_cost'])
  expect(optionsOf('行の id の列')).toEqual(['', 'record_id'])
  expect(optionsOf('正解の欠けた行')).toEqual(['drop', 'keep'])
  const split = screen.getByLabelText('分割') as HTMLSelectElement
  const enabled = Array.from(split.options)
    .filter((option) => !option.disabled)
    .map((option) => option.value)
  expect(enabled).toEqual(['stratified'])
  // 言葉の説明
  expect(screen.getByText(/売ったときの値段 \(0 より大きい数\)/)).toBeTruthy()
  expect(screen.getByText(/商品 1 つを仕入れるか作るのにかかる値段/)).toBeTruthy()
})

test('値段を変えた記録の要約に値段の幅, 弾力性, 商品ごとの試した値段と関わりを出す', async () => {
  const price = renderTab()
  expect(await screen.findByText('弾力性の目安 -1.5')).toBeTruthy()
  expect(screen.getByText('値段の種類 40')).toBeTruthy()
  expect(screen.getByText('試した値段が 1 つの商品 1')).toBeTruthy()
  expect(screen.getByText(/売れた数がおよそ 1.5 % 減ります/)).toBeTruthy()
  expect(price).toHaveBeenCalledWith('s1', {
    price: 'price',
    units: 'units',
    cost: 'unit_cost',
    product: 'product_id',
    id: 'record_id',
  })
  const confounding = screen.getByRole('table', { name: /値段と他の列の関わり/ })
  expect(confounding.textContent).toContain('0.45 (値段と強く関わる)')
  const products = screen.getByRole('table', { name: /商品ごとの試した値段/ })
  expect(products.textContent).toContain('p9')
  expect(screen.getByText(/試した値段が 1 つの商品があります/)).toBeTruthy()
})

test('学習用のデータに, 分割ごとの値段の範囲と売れた数を出す', async () => {
  renderTab()
  const table = await screen.findByRole('table', {
    name: '分割ごとの行と商品の数, 元の値段の範囲と種類の数, 売れた数と原価の平均',
  })
  expect(table.textContent).toContain('valid')
  expect(table.textContent).toContain('20.25')
})

test('値段の列は値段の手順でだけ選べ, 他の手順に書いた値段の列は誤りを出す', async () => {
  renderTab({
    ...RECIPE,
    steps: [
      { op: 'impute', columns: ['price'] },
      { op: 'clip', columns: [] },
    ],
  })
  const alert = await screen.findByText(/手順 1 \(impute\) は値段の列 price を変えられません/)
  expect(alert).toBeTruthy()
  // 値段の手順 (clip) の列の候補には値段の列があり, 原価と商品の id の列は無い
  const select = (id: string) =>
    Array.from((document.getElementById(id) as HTMLSelectElement).options).map(
      (option) => option.value,
    )
  expect(select('step-1-columns')).toContain('price')
  expect(select('step-1-columns')).not.toContain('unit_cost')
  expect(select('step-1-columns')).not.toContain('product_id')
  // 列を落とす手順の候補には, 原価の列があり値段の列は無い
  fireEvent.change(screen.getByLabelText('足す手順'), { target: { value: 'drop_columns' } })
  fireEvent.click(screen.getByRole('button', { name: '足す' }))
  await screen.findByRole('button', { name: '手順 3 を消す' })
  expect(select('step-2-columns')).toContain('unit_cost')
  expect(select('step-2-columns')).not.toContain('price')
})

test('他のタスクに変えると, 値段, 原価, 商品の id と行の id の列を消す', async () => {
  renderTab()
  await screen.findByLabelText('値段の列')
  fireEvent.change(screen.getByLabelText('タスク'), { target: { value: 'regression' } })
  expect(screen.queryByLabelText('値段の列')).toBeNull()
  expect(screen.queryByLabelText('行の id の列')).toBeNull()
  expect(screen.queryByText('値段を変えた記録の要約')).toBeNull()
  const yaml = screen.getByText(/format_version/).textContent ?? ''
  expect(yaml).not.toContain('unit_cost')
  expect(yaml).not.toContain('product_id')
  expect(yaml).not.toContain('record_id')
})

test('分割が層化でなければ誤りを出し, 値段の列が無ければ要約を求めない', async () => {
  const { price: _price, ...rest } = RECIPE
  const price = renderTab({ ...rest, split: { ...RECIPE.split, method: 'random' } })
  expect((await screen.findByRole('alert')).textContent).toContain(
    '値段を変える判断の分割は層化だけ',
  )
  expect(screen.getByText(/値段の列を選ぶと/)).toBeTruthy()
  expect(price).not.toHaveBeenCalled()
})
