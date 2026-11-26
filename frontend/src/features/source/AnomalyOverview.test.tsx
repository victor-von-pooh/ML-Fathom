import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { AnomalyProfile, Info, Profile, Recipe, Source } from '../../api/types'
import { clearDraft, writeDraft } from '../../lib/drafts'
import { SourcePage } from './SourcePage'

beforeEach(() => {
  window.localStorage.clear()
  // 前の確かめで変えた編集中のレシピ (メモリにも覚える) を捨てる
  clearDraft('s1')
  // jsdom に無い, 選んだタブを横に送る動き
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 異常の正解の列を目的の列にした表 */
const SOURCE: Source = {
  id: 's1',
  name: 'readings',
  path: 'readings.csv',
  loader: 'csv',
  kind: 'table',
  options: {},
  target: 'is_anomaly',
  created_at: '',
  exists: true,
}

/** 異常の検知のレシピ */
const RECIPE: Recipe = {
  format_version: 1,
  target: 'is_anomaly',
  task: 'anomaly',
  steps: [],
  split: { method: 'random', valid: 0.2, test: 0.1, seed: 0, unlabeled: 'normal' },
}

/** 異常の行にだけ印を付けた 100 行 (異常 10 行, 欠けた行 90 行) */
const ANOMALY: AnomalyProfile = {
  column: 'is_anomaly',
  labeled: true,
  rows: 100,
  labeled_rows: 10,
  missing: 90,
  presumed: 0,
  normal: 0,
  anomaly: 10,
  ratio: 1,
  presumed_ratio: 0.1,
  valid: true,
  invalid: 0,
  invalid_examples: [],
}

/** 異常の正解の数を添えるかを選べる分析 */
function profileOf(anomaly: AnomalyProfile | null): Profile {
  return {
    summary: { kind: 'table', rows: 100, roles: {}, has_items: false },
    overview: {
      kind: 'table',
      rows: 100,
      columns: 2,
      missing_cells: 90,
      duplicate_rows: 0,
      memory_bytes: 1600,
      roles: {},
      sampled: false,
    },
    columns: {},
    correlations: { columns: [], pearson: [], spearman: [] },
    associations: { columns: [], cramers_v: [] },
    target: null,
    timeseries: null,
    anomaly,
    findings: [],
  } as unknown as Profile
}

/** データのページを開く */
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sources/s1']}>
        <Routes>
          <Route path="/sources/:id" element={<SourcePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 一覧, 読み込みの一覧と分析を真似る (分析は task に anomaly を渡すと数を添える) */
function mockApi(saved: Recipe) {
  vi.spyOn(api, 'listSources').mockResolvedValue([SOURCE])
  vi.spyOn(api, 'info').mockResolvedValue({ loaders: [] } as unknown as Info)
  vi.spyOn(api, 'recipe').mockResolvedValue(saved)
  return vi
    .spyOn(api, 'profile')
    .mockImplementation(async (_id, task) => profileOf(task === 'anomaly' ? ANOMALY : null))
}

test('保存したレシピのタスクが異常の検知なら, 概要に異常の正解の数と割合を出す', async () => {
  const profile = mockApi(RECIPE)
  renderPage()

  const card = (await screen.findByText('異常の正解の数')).closest('section') ?? document.body
  expect(profile).toHaveBeenCalledWith('s1', 'anomaly')
  // 異常の行の数と割合は, 全ての手順を組む前に出る
  const labeled = within(card as HTMLElement).getByText('正解の付いた行')
  expect(labeled.parentElement).toHaveTextContent('10')
  expect(
    within(card as HTMLElement).getByText('異常の割合 (0 か 1 の正解の行のうち)').parentElement,
  ).toHaveTextContent('100.0%')
  expect(within(card as HTMLElement).getByText('正解の欠けた行').parentElement).toHaveTextContent(
    '90',
  )
  expect(
    within(card as HTMLElement).getByText('欠けた行も正常と見なした異常の割合').parentElement,
  ).toHaveTextContent('10.0%')
})

test('編集中のレシピのタスクが異常の検知でなければ, 異常の正解の数を出さない', async () => {
  // 保存したレシピより編集中のレシピのタスクを使う
  writeDraft('s1', { ...RECIPE, task: 'classification' })
  const profile = mockApi(RECIPE)
  renderPage()

  expect(await screen.findByText(/気付き/)).toBeInTheDocument()
  expect(profile).toHaveBeenCalledWith('s1', undefined)
  expect(screen.queryByText('異常の正解の数')).not.toBeInTheDocument()
})

test('目的の列の無い異常の検知は, 全ての行を正常と見なすと出す', async () => {
  vi.spyOn(api, 'listSources').mockResolvedValue([{ ...SOURCE, target: null }])
  vi.spyOn(api, 'info').mockResolvedValue({ loaders: [] } as unknown as Info)
  vi.spyOn(api, 'recipe').mockResolvedValue({ ...RECIPE, target: null })
  vi.spyOn(api, 'profile').mockResolvedValue(
    profileOf({ ...ANOMALY, column: null, labeled: false, labeled_rows: 0, missing: 0 }),
  )
  renderPage()

  expect(await screen.findByText(/全ての\s*100\s*行を正常と見なします/)).toBeInTheDocument()
})
