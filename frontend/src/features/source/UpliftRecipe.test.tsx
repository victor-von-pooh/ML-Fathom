import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { ColumnInfo, PreviewResult, Profile, Recipe, UpliftSummary } from '../../api/types'
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

/** クーポンを配った記録の, 効果を見積もるのレシピ (ML-Quest の雛形と同じ形) */
const RECIPE: Recipe = {
  format_version: 1,
  target: 'purchased',
  task: 'uplift',
  treatment: 'coupon',
  outcome: 'binary',
  id: 'customer_id',
  steps: [{ op: 'standardize', columns: 'auto' }],
  split: { method: 'stratified', valid: 0.2, test: 0.2, seed: 0 },
}

const column = (unique: number): ColumnInfo =>
  ({
    type: 'numeric',
    dtype: 'float64',
    count: 200,
    missing: 0,
    unique,
  }) as unknown as ColumnInfo

/** 行の id, 特徴, 処置, 結果, 処置の後に決まる列の表の分析 */
const PROFILE = {
  summary: { kind: 'table', rows: 200, roles: {}, has_items: false },
  overview: { roles: {}, sampled: false },
  columns: {
    customer_id: column(200),
    age: column(60),
    coupon: column(2),
    purchased: column(2),
    used: column(2),
  },
  correlations: { columns: [], pearson: [], spearman: [] },
  associations: { columns: [], cramers_v: [] },
  target: null,
  timeseries: null,
  findings: [],
} as unknown as Profile

const VIEW = { rows: 200, columns: [], head: [] }

/** 全ての手順の後の様子 (全ての分割に両方の群) */
const PREVIEW: PreviewResult = {
  before: VIEW,
  after: VIEW,
  added: [],
  removed: [],
  features: ['age', 'used'],
  notes: [],
  findings: [],
  splits: { train: 120, valid: 40, test: 40 },
  classes: [],
  anomaly: null,
  uplift: {
    id: 'customer_id',
    treatment: 'coupon',
    outcome: 'binary',
    unlabeled: 'drop',
    splits: {
      train: { treated: 61, control: 59, treated_mean: 0.4, control_mean: 0.2, effect: 0.2 },
      valid: { treated: 21, control: 19, treated_mean: 0.38, control_mean: 0.21, effect: 0.17 },
      test: { treated: 20, control: 20, treated_mean: 0.45, control_mean: 0.15, effect: 0.3 },
    },
  },
}

/** 介入の記録の要約 (処置の後に決まる列 used の気付き) */
const SUMMARY: UpliftSummary = {
  treatment: 'coupon',
  outcome: 'purchased',
  outcome_kind: 'binary',
  rows: 200,
  missing: { treatment: 0, outcome: 0 },
  groups: { treated: { rows: 102, mean: 0.41 }, control: { rows: 98, mean: 0.19 } },
  treated_rate: 0.51,
  effect: 0.22,
  balance: [
    { column: 'used', type: 'numeric', smd: 1.2, value: null },
    { column: 'age', type: 'numeric', smd: 0.05, value: null },
  ],
  findings: [
    {
      severity: 'warning',
      code: 'post_treatment',
      message: 'used は片方の群でだけ値が変わります',
      columns: ['used'],
    },
  ],
}

/** 効果を見積もるのレシピで前処理のタブを描く */
function renderTab(recipe: Recipe = RECIPE) {
  vi.spyOn(api, 'recipe').mockResolvedValue(recipe)
  vi.spyOn(api, 'preview').mockResolvedValue(PREVIEW)
  const uplift = vi.spyOn(api, 'uplift').mockResolvedValue(SUMMARY)
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sources/s1?tab=recipe']}>
        <RecipeTab
          sourceId="s1"
          sourceName="coupons"
          sourcePath="/work/coupons.csv"
          profile={PROFILE}
          target="purchased"
          steps={[]}
          kind="table"
          itemSteps={[]}
          loader="csv"
          options={{}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return uplift
}

test('効果を見積もるでは, 処置の列と結果の種類と行の id の列を選べ, 分割は層化だけ', async () => {
  renderTab()
  const treatment = (await screen.findByLabelText('処置の列')) as HTMLSelectElement
  expect(treatment.value).toBe('coupon')
  // 候補は目的の列と行の id の列を除く
  expect(Array.from(treatment.options).map((option) => option.value)).toEqual([
    '',
    'age',
    'coupon',
    'used',
  ])
  expect((screen.getByLabelText('結果の種類') as HTMLSelectElement).value).toBe('binary')
  const rowId = screen.getByLabelText('行の id の列') as HTMLSelectElement
  expect(Array.from(rowId.options).map((option) => option.value)).toEqual(['', 'customer_id'])
  const unlabeled = screen.getByLabelText('正解の欠けた行') as HTMLSelectElement
  expect(Array.from(unlabeled.options).map((option) => option.value)).toEqual(['drop', 'keep'])
  const split = screen.getByLabelText('分割') as HTMLSelectElement
  const enabled = Array.from(split.options)
    .filter((option) => !option.disabled)
    .map((option) => option.value)
  expect(enabled).toEqual(['stratified'])
})

test('介入の記録の要約に群の数と結果の差と釣り合いを出し, 処置の後に決まる列を落とせる', async () => {
  const uplift = renderTab()
  expect(await screen.findByText('処置の群 102')).toBeTruthy()
  expect(screen.getByText('処置の割合 51.0%')).toBeTruthy()
  expect(screen.getByText('差 (全体の効果) 0.22')).toBeTruthy()
  expect(uplift).toHaveBeenCalledWith('s1', {
    treatment: 'coupon',
    outcome: 'purchased',
    outcome_kind: 'binary',
    id: 'customer_id',
  })
  const balance = screen.getByRole('table', { name: /群どうしの釣り合い/ })
  expect(balance.textContent).toContain('1.2 (釣り合いが崩れ)')
  fireEvent.click(screen.getByRole('button', { name: /used\) を落とす手順を足す/ }))
  const yaml = screen.getByText(/format_version/).textContent ?? ''
  expect(yaml).toContain('drop_columns')
  // 落とした後は押しボタンを出さない
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /を落とす手順を足す/ })).toBeNull(),
  )
})

test('学習用のデータに, 分割ごとの群の数と結果の差を出す', async () => {
  renderTab()
  const table = await screen.findByRole('table', {
    name: '分割ごとの処置の群と対照の群の行の数, 群ごとの結果の平均と差',
  })
  expect(table.textContent).toContain('valid')
  expect(table.textContent).toContain('0.17')
})

test('他のタスクに変えると, 処置の列, 結果の種類と行の id の列を消す', async () => {
  renderTab()
  await screen.findByLabelText('処置の列')
  fireEvent.change(screen.getByLabelText('タスク'), { target: { value: 'classification' } })
  expect(screen.queryByLabelText('処置の列')).toBeNull()
  expect(screen.queryByLabelText('行の id の列')).toBeNull()
  expect(screen.queryByText('介入の記録の要約')).toBeNull()
  const yaml = screen.getByText(/format_version/).textContent ?? ''
  expect(yaml).not.toContain('coupon')
  expect(yaml).not.toContain('customer_id')
  expect(yaml).not.toContain('outcome')
})

test('分割が層化でなければ誤りを出し, 処置の列が無ければ要約を求めない', async () => {
  const { treatment: _treatment, ...rest } = RECIPE
  const uplift = renderTab({ ...rest, split: { ...RECIPE.split, method: 'random' } })
  // 欄の下の誤りは分割の欄から結び, 欄を正しくない値にする
  const split = await screen.findByLabelText('分割')
  expect(split).toHaveAttribute('aria-invalid', 'true')
  expect(split).toHaveAccessibleDescription(new RegExp('効果を見積もるの分割は層化だけ'))
  expect(screen.getByText(/処置の列を選ぶと/)).toBeTruthy()
  expect(uplift).not.toHaveBeenCalled()
})
