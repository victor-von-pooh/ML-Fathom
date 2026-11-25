import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { GroupProblem, ProblemCheck, Recipe } from '../../api/types'
import { GroupProblemNote, ProblemCard } from './ProblemCard'

afterEach(() => {
  vi.restoreAllMocks()
})

/** 作るものが表の問題の設定から始めた, 目的の列の無いレシピ */
const RECIPE: Recipe = {
  format_version: 1,
  target: null,
  task: 'none',
  steps: [{ op: 'drop_columns', columns: ['id'] }],
  split: { method: 'random', valid: 0.15, test: 0.15, seed: 0 },
}

const CHECKED: ProblemCheck = {
  name: '顧客の表',
  path: '/work/problem/problem.yaml',
  version: 'abc',
  changes: [],
  conflicts: [],
  choices: [],
}

/** カードを描く */
function renderCard(notes?: string[]) {
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <ProblemCard
        sourceId="s1"
        notes={notes}
        recipe={RECIPE}
        latest={RECIPE}
        onWritten={() => undefined}
      />
    </QueryClientProvider>,
  )
}

test('始めたときの知らせを並べ, 食い違いが無ければ書き戻せる', async () => {
  const call = vi.spyOn(api, 'checkProblem').mockResolvedValue(CHECKED)
  renderCard(['書き出した列を全て作ります. ID のような列は drop_columns で落としてください'])
  const notes = screen.getByRole('region', { name: '始めたときの知らせ' })
  expect(within(notes).getByText(/ID のような列は drop_columns/)).toBeTruthy()
  expect(await screen.findByText('問題の設定との食い違いはありません.')).toBeTruthy()
  expect(call).toHaveBeenCalledWith('s1', RECIPE)
  const button = screen.getByRole('button', { name: '問題の設定に書き戻す' })
  expect((button as HTMLButtonElement).disabled).toBe(false)
})

test('知らせが無ければ知らせの欄を出さない', async () => {
  vi.spyOn(api, 'checkProblem').mockResolvedValue(CHECKED)
  renderCard()
  expect(await screen.findByText('問題の設定との食い違いはありません.')).toBeTruthy()
  expect(screen.queryByRole('region', { name: '始めたときの知らせ' })).toBeNull()
})

/** まとめるの問題の設定 (群分けのタブが読むもの) */
const GROUPED: GroupProblem = {
  name: '客の群',
  path: '/work/group/problem.yaml',
  group: {
    columns: ['spend', 'visits'],
    id: 'member',
    k: 3,
    stability: 'seed',
    stability_label: '種を変えて作り直す',
  },
  project: null,
}

test('まとめるの問題の設定は, 誤りでなく案内を出して群分けのタブへ導く', () => {
  const call = vi.spyOn(api, 'checkProblem')
  render(
    <MemoryRouter initialEntries={['/sources/s1?tab=recipe']}>
      <GroupProblemNote problem={GROUPED} notes={['始めたときの知らせ']} />
    </MemoryRouter>,
  )
  expect(screen.getByText('問題の設定: 客の群')).toBeTruthy()
  expect(screen.getByText(/レシピを持ちません/)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: '問題の設定に書き戻す' })).toBeNull()
  const link = screen.getByRole('link', { name: '群分けのタブへ移る' })
  expect(link.getAttribute('href')).toBe('/sources/s1?tab=groups')
  expect(
    within(screen.getByRole('region', { name: '始めたときの知らせ' })).getByText(
      '始めたときの知らせ',
      { selector: 'li' },
    ),
  ).toBeTruthy()
  // レシピの確かめ (まとめるでは 422) を呼ばない
  expect(call).not.toHaveBeenCalled()
})
