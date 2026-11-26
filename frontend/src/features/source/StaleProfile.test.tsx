import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { ColumnInfo, Info, PreviewResult, Profile, Recipe, Source } from '../../api/types'
import { clearDraft, readDraft } from '../../lib/drafts'
import { SourcePage } from './SourcePage'

// jsdom はタブを横に送る scrollIntoView を持たない
Element.prototype.scrollIntoView = () => {}

beforeEach(() => {
  window.localStorage.clear()
  // 前の確かめで変えた編集中のレシピ (メモリにも覚える) を捨てる
  clearDraft('s1')
})

afterEach(() => {
  vi.restoreAllMocks()
})

const SOURCE: Source = {
  id: 's1',
  name: 'readings',
  path: '/work/readings.csv',
  loader: 'csv',
  kind: 'table',
  options: {},
  target: 'is_anomaly',
  created_at: '2026-01-01T00:00:00',
  exists: true,
}

const INFO = {
  loaders: [],
  steps: [],
  item_steps: [],
  pair_steps: {},
  kinds: ['table'],
  version: '0',
} as unknown as Info

/** 分類のレシピ (手順なし. タスクを異常の検知に変える前) */
const RECIPE: Recipe = {
  format_version: 1,
  target: 'is_anomaly',
  task: 'classification',
  steps: [],
  split: { method: 'random', valid: 0.2, test: 0.1, seed: 0 },
}

const column = (type: string, missing: number, unique = 2): ColumnInfo =>
  ({
    type,
    dtype: 'float64',
    count: 100 - missing,
    missing,
    missing_ratio: missing / 100,
    unique,
  }) as unknown as ColumnInfo

/** 異常の行にだけ印を付けた表の分析 (findings だけをタスクで変える) */
const profileWith = (findings: Profile['findings']) =>
  ({
    summary: { kind: 'table', rows: 100, roles: {}, has_items: false },
    overview: { roles: {}, sampled: false },
    columns: { temp: column('numeric', 0, 80), is_anomaly: column('boolean', 90) },
    correlations: { columns: [], pearson: [], spearman: [] },
    associations: { columns: [], cramers_v: [] },
    target: null,
    timeseries: null,
    findings,
  }) as unknown as Profile

/** タスクを決めない分析 (正解の欠けを target_missing の気付きにする. 重複した行もある) */
const PLAIN = profileWith([
  { severity: 'warning', code: 'target_missing', message: '', columns: ['is_anomaly'] },
  { severity: 'info', code: 'duplicate_rows', message: '', columns: [] },
])
/** task=anomaly の分析 (target_missing の代わりに異常の検知の気付き) */
const ANOMALY = profileWith([
  { severity: 'warning', code: 'few_anomalies', message: '', columns: ['is_anomaly'] },
])

const VIEW = { rows: 100, columns: [], head: [] }
const PREVIEW: PreviewResult = {
  before: VIEW,
  after: VIEW,
  added: [],
  removed: [],
  features: ['temp'],
  notes: [],
  findings: [],
  splits: { train: 70, valid: 20, test: 10 },
  classes: [],
}

/** task=anomaly の分析を, 確かめが返すまで待たせて前処理のタブを描く */
function renderPage() {
  let resolveAnomaly: (profile: Profile) => void = () => {}
  vi.spyOn(api, 'listSources').mockResolvedValue([SOURCE])
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  vi.spyOn(api, 'recipe').mockResolvedValue(RECIPE)
  vi.spyOn(api, 'preview').mockResolvedValue(PREVIEW)
  vi.spyOn(api, 'profile').mockImplementation((_id, task) =>
    task === 'anomaly'
      ? new Promise<Profile>((resolve) => {
          resolveAnomaly = resolve
        })
      : Promise.resolve(PLAIN),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sources/s1?tab=recipe']}>
        <Routes>
          <Route path="/sources/:id" element={<SourcePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { resolve: (profile: Profile) => resolveAnomaly(profile) }
}

const steps = () => readDraft('s1')?.steps ?? []

test('異常の検知に変えた直後は, 前の分析で手順を作らず, 求め直した後も正解の欠けた行を落とさない', async () => {
  const { resolve } = renderPage()
  // 前の分析 (分類) では, 正解の欠けた行を落とす気付きの手順が出る
  expect(await screen.findByRole('button', { name: /気付きから 2 手順を足す/ })).toBeTruthy()

  fireEvent.change(screen.getByLabelText('タスク'), { target: { value: 'anomaly' } })
  await waitFor(() => expect(api.profile).toHaveBeenCalledWith('s1', 'anomaly'))

  // 求め直す間は, 手順を作る押しボタンを止めて理由を出す. 前の分析の target_missing は,
  // 異常の検知では手順の案にしない (残るのは重複した行を落とす 1 手順)
  const auto = screen.getByRole('button', { name: /学習できる形にする手順を作る/ })
  const suggest = screen.getByRole('button', { name: /気付きから 1 手順を足す/ })
  expect((auto as HTMLButtonElement).disabled).toBe(true)
  expect((suggest as HTMLButtonElement).disabled).toBe(true)
  const help = screen.getByText(/分析を求め直しています/)
  expect(auto.getAttribute('aria-describedby')).toBe(help.id)
  expect(suggest.getAttribute('aria-describedby')).toBe(help.id)
  fireEvent.click(auto)
  fireEvent.click(suggest)
  expect(steps()).toEqual([])

  // 求め直した後は押せ, 作った手順は正解の欠けた行を落とさない
  resolve(ANOMALY)
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: /学習できる形にする手順を作る/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  )
  expect(screen.queryByText(/分析を求め直しています/)).toBeNull()
  expect(screen.queryByRole('button', { name: /気付きから/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /学習できる形にする手順を作る/ }))
  expect(steps().length).toBeGreaterThan(0)
  expect(steps().some((step) => step.op === 'drop_missing')).toBe(false)
})
