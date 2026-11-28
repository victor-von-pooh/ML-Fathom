import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { ColumnInfo, PreviewResult, Profile, Recipe } from '../../api/types'
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

/** 異常の行にだけ印を付けた表の, 異常の検知のレシピ (ML-Quest の雛形と同じ形) */
const RECIPE: Recipe = {
  format_version: 1,
  target: 'is_anomaly',
  task: 'anomaly',
  id: 'reading_id',
  steps: [{ op: 'standardize', columns: 'auto' }],
  split: { method: 'random', valid: 0.2, test: 0.1, seed: 0, unlabeled: 'normal' },
}

const column = (missing: number, unique = 1): ColumnInfo =>
  ({
    type: 'numeric',
    dtype: 'float64',
    count: 100 - missing,
    missing,
    unique,
  }) as unknown as ColumnInfo

/** 行の id, 数の列, 異常の正解の列の表の分析 */
const PROFILE = {
  summary: { kind: 'table', rows: 100, roles: {}, has_items: false },
  overview: { roles: {}, sampled: false },
  columns: {
    reading_id: column(0, 100),
    temp: column(0, 80),
    serial: column(0, 100),
    is_anomaly: column(90),
  },
  correlations: { columns: [], pearson: [], spearman: [] },
  associations: { columns: [], cramers_v: [] },
  target: null,
  timeseries: null,
  findings: [],
} as unknown as Profile

const VIEW = { rows: 100, columns: [], head: [] }

/** 全ての手順の後の様子 (正常と見なした 90 行, 異常 10 行) */
const PREVIEW: PreviewResult = {
  before: VIEW,
  after: VIEW,
  added: [],
  removed: [],
  features: ['temp'],
  notes: [],
  findings: [],
  splits: { train: 63, valid: 25, test: 12 },
  classes: [],
  anomaly: {
    id: 'reading_id',
    labeled: true,
    unlabeled: 'normal',
    rows: {
      train: { normal: 0, presumed: 63, anomaly: 0, unlabeled: 0 },
      valid: { normal: 0, presumed: 18, anomaly: 7, unlabeled: 0 },
      test: { normal: 0, presumed: 9, anomaly: 3, unlabeled: 0 },
    },
  },
}

/** 異常の検知のレシピで前処理のタブを描く */
function renderTab(recipe: Recipe = RECIPE) {
  vi.spyOn(api, 'recipe').mockResolvedValue(recipe)
  vi.spyOn(api, 'preview').mockResolvedValue(PREVIEW)
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sources/s1?tab=recipe']}>
        <RecipeTab
          sourceId="s1"
          sourceName="readings"
          sourcePath="/work/readings.csv"
          profile={PROFILE}
          target="is_anomaly"
          steps={[]}
          kind="table"
          itemSteps={[]}
          loader="csv"
          options={{}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('異常の検知では, 行の id の列と正常と見なすを選べ, 分割は無作為だけ', async () => {
  renderTab()
  const rowId = (await screen.findByLabelText('行の id の列')) as HTMLSelectElement
  expect(rowId.value).toBe('reading_id')
  // 候補は欠けも同じ値も無い列だけ (目的の列と, 同じ値のある temp は出さない)
  expect(Array.from(rowId.options).map((option) => option.value)).toEqual([
    '',
    'reading_id',
    'serial',
  ])
  const unlabeled = screen.getByLabelText('正解の欠けた行') as HTMLSelectElement
  expect(unlabeled.value).toBe('normal')
  const split = screen.getByLabelText('分割') as HTMLSelectElement
  const disabled = Array.from(split.options)
    .filter((option) => option.disabled)
    .map((option) => option.value)
  expect(disabled).toEqual([
    'stratified',
    'time',
    'group',
    'group_time',
    'stratified_group',
    'none',
  ])
})

test('学習用のデータに, 正解の数と異常の割合と分割ごとの行の数を出す', async () => {
  renderTab()
  expect(await screen.findByText('異常の割合 10.0%')).toBeTruthy()
  expect(screen.getByText('正解の付いた行 10')).toBeTruthy()
  expect(screen.getByText('正常と見なした行 90')).toBeTruthy()
  const table = screen.getByRole('table', {
    name: '分割ごとの正常, 正常と見なした, 異常, 正解なしの行の数',
  })
  expect(table.textContent).toContain('valid')
  expect(table.textContent).toContain('18')
})

test('他のタスクに変えると, 行の id の列と正常と見なすを消す', async () => {
  renderTab()
  await screen.findByLabelText('行の id の列')
  fireEvent.change(screen.getByLabelText('タスク'), { target: { value: 'classification' } })
  expect(screen.queryByLabelText('行の id の列')).toBeNull()
  const unlabeled = screen.getByLabelText('正解の欠けた行') as HTMLSelectElement
  expect(unlabeled.value).toBe('drop')
  expect(Array.from(unlabeled.options).map((option) => option.value)).toEqual(['drop', 'keep'])
  const yaml = screen.getByText(/format_version/).textContent ?? ''
  expect(yaml).not.toContain('reading_id')
  expect(yaml).not.toContain('unlabeled')
})

test('分割が無作為でなければ誤りを出す', async () => {
  renderTab({ ...RECIPE, split: { ...RECIPE.split, method: 'stratified' } })
  // 欄の下の誤りは分割の欄から結び, 欄を正しくない値にする
  const split = await screen.findByLabelText('分割')
  expect(split).toHaveAttribute('aria-invalid', 'true')
  expect(split).toHaveAccessibleDescription(new RegExp('異常の検知の分割は無作為だけ'))
})
