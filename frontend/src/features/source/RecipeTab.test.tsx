import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api, ApiError } from '../../api/client'
import type { ColumnInfo, GroupProblem, Profile, ProjectPlace, Recipe } from '../../api/types'
import { RecipeTab } from './RecipeTab'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 問題の設定から始めた, 目的の列の無い表のレシピ */
const RECIPE: Recipe = {
  format_version: 1,
  target: null,
  task: 'none',
  steps: [],
  split: { method: 'random', valid: 0.2, test: 0, seed: 0 },
}

/** 数の列 2 つの表の分析 */
const PROFILE = {
  summary: { kind: 'table', rows: 10, roles: {}, has_items: false },
  overview: { roles: {} },
  columns: {
    spend: { dtype: 'float64', kind: 'numeric' } as unknown as ColumnInfo,
    visits: { dtype: 'float64', kind: 'numeric' } as unknown as ColumnInfo,
  },
  correlations: { columns: [], pearson: [], spearman: [] },
  associations: { columns: [], cramers_v: [] },
  target: null,
  timeseries: null,
  findings: [],
} as unknown as Profile

const PLACE: ProjectPlace = {
  project: '/work/project',
  dataset: '/work/project/data/dataset',
  state: 'missing',
  ready: true,
  reason: null,
}

/** 群分けのタブが読む答え (group が null ならまとめるでない) */
function linked(group: GroupProblem['group']): GroupProblem {
  return { name: '問題', path: '/work/problem/problem.yaml', group, project: null }
}

/** 他の API は答えずに待たせ, 前処理のタブを描く */
function renderTab() {
  vi.spyOn(api, 'recipe').mockResolvedValue(RECIPE)
  vi.spyOn(api, 'preview').mockReturnValue(new Promise(() => undefined))
  vi.spyOn(api, 'project').mockResolvedValue(PLACE)
  const check = vi.spyOn(api, 'checkProblem').mockResolvedValue({
    name: '問題',
    path: '/work/problem/problem.yaml',
    version: 'abc',
    changes: [],
    conflicts: [],
    choices: [],
  })
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sources/s1?tab=recipe']}>
        <RecipeTab
          sourceId="s1"
          sourceName="表"
          sourcePath="/work/table.csv"
          profile={PROFILE}
          target={null}
          steps={[]}
          kind="table"
          itemSteps={[]}
          loader="csv"
          options={{}}
          problem="/work/problem/problem.yaml"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return check
}

test('受け持ちを読み込む間は, 確かめのカードも学習のプロジェクトへの書き出しも出さず確かめない', async () => {
  vi.spyOn(api, 'groupProblem').mockReturnValue(new Promise(() => undefined))
  const check = renderTab()
  expect(await screen.findByText('問題を読んでいます')).toBeTruthy()
  expect(screen.queryByText('問題との食い違いはありません.')).toBeNull()
  expect(screen.queryByRole('button', { name: '問題に書き戻す' })).toBeNull()
  expect(screen.queryByText('学習のプロジェクトへ書き出す')).toBeNull()
  expect(check).not.toHaveBeenCalled()
})

test('まとめるなら, 確かめずに案内を出し, 学習のプロジェクトへの書き出しを出さない', async () => {
  vi.spyOn(api, 'groupProblem').mockResolvedValue(
    linked({
      columns: ['spend'],
      id: null,
      k: 3,
      stability: 'seed',
      stability_label: '種を変えて作り直す',
    }),
  )
  const check = renderTab()
  expect(await screen.findByRole('link', { name: '群分けのタブへ移る' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '問題に書き戻す' })).toBeNull()
  expect(screen.queryByText('学習のプロジェクトへ書き出す')).toBeNull()
  expect(check).not.toHaveBeenCalled()
})

test('まとめるでなければ, 今までどおり確かめのカードと学習のプロジェクトへの書き出しを出す', async () => {
  vi.spyOn(api, 'groupProblem').mockResolvedValue(linked(null))
  const check = renderTab()
  expect(await screen.findByText('問題との食い違いはありません.')).toBeTruthy()
  expect(check).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '問題に書き戻す' })).toBeTruthy()
  expect(await screen.findByRole('button', { name: '学習のプロジェクトへ書き出す' })).toBeTruthy()
  expect(screen.queryByRole('link', { name: '群分けのタブへ移る' })).toBeNull()
})

test('受け持ちを読めなければ, 今までどおり確かめのカードが理由を出す', async () => {
  vi.spyOn(api, 'groupProblem').mockRejectedValue(new ApiError(422, '問題を読めません'))
  const check = renderTab()
  // 確かめも同じ理由で断る (カードが理由を出す)
  check.mockRejectedValue(new ApiError(422, '問題を読めません'))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('問題を読めません')
  expect(check).toHaveBeenCalled()
  expect(screen.queryByRole('link', { name: '群分けのタブへ移る' })).toBeNull()
})
