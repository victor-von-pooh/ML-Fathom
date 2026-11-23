import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { Info, PolicyValueResult, Source, TrajectorySummary } from '../../api/types'
import { TrajectoryView } from './TrajectoryView'

// グラフは描かず, 名前だけを出す (jsdom では canvas を描けないため)
vi.mock('../../lib/chart', () => ({
  Chart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

// jsdom はタブを横に送る scrollIntoView を持たない
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  vi.restoreAllMocks()
})

const STATS = { min: 3, max: 3, mean: 3, std: 0, median: 3 }

/** 守りの付いた軌跡の要約 (ML-EDA の describe_trajectory の形) */
function summaryOf(overrides: Partial<TrajectorySummary> = {}): TrajectorySummary {
  return {
    name: 'guarded',
    format: 'csv',
    described: true,
    format_version: 1,
    source: 'evaluate_policy',
    env: null,
    epoch: 1,
    description: null,
    complete: true,
    dropped_episodes: 0,
    observation_space: { type: 'box', shape: [1] },
    action_space: { type: 'discrete', n: 2, start: 0 },
    rows: 8,
    episodes: 2,
    steps: 6,
    columns: [],
    observation_columns: ['obs_0'],
    action_columns: ['action'],
    extra_columns: ['prob'],
    guarded: true,
    with_action_prob: false,
    length: STATS,
    return: STATS,
    unknown_returns: 0,
    ends: { terminated: 0, truncated: 0, stop: 2, handover: 0, open: 0 },
    observations: [
      {
        name: 'obs_0',
        type: 'number',
        missing: 0,
        nan: 1,
        infinite: 0,
        min: 0,
        max: 3,
        mean: 1.5,
        std: 1.2,
        median: 1.5,
        counts: null,
      },
    ],
    actions: [
      {
        name: 'action',
        type: 'integer',
        missing: 2,
        nan: 0,
        infinite: 0,
        min: 1,
        max: 1,
        mean: 1,
        std: 0,
        median: 1,
        counts: [{ value: 1, count: 6 }],
      },
    ],
    guard: {
      results: { ok: 6, stop: 2 },
      reasons: [{ reason: '観測の要素 0 が範囲の外 (3)', count: 2 }],
    },
    action_prob: null,
    per_episode: [
      { episode: 0, rows: 4, length: 3, return: 3, end: 'stop', seed: 7 },
      { episode: 1, rows: 4, length: 3, return: 3, end: 'stop', seed: 8 },
    ],
    per_episode_truncated: false,
    notes: [],
    ...overrides,
  }
}

function renderView(summary: TrajectorySummary, tab = 'overview', policyValue = false) {
  vi.spyOn(api, 'trajectory').mockResolvedValue(summary)
  vi.spyOn(api, 'info').mockResolvedValue({ policy_value: policyValue } as Info)
  const source = {
    id: 's1',
    name: 'guarded.csv',
    path: '/data/guarded.csv',
    loader: 'trajectory',
    kind: 'trajectory',
    options: {},
    target: null,
  } as unknown as Source
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/sources/s1?tab=${tab}`]}>
        <TrajectoryView source={source} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('概要に数と分布と終わり方と説明を出し, 守りのタブを出す', async () => {
  renderView(summaryOf({ notes: ['番号が 0 から続きません'] }))
  expect(await screen.findByText('番号が 0 から続きません')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'エピソードの長さのヒストグラム' })).toBeInTheDocument()
  expect(screen.getByRole('img', { name: '報酬の和のヒストグラム' })).toBeInTheDocument()
  expect(screen.getByRole('img', { name: '終わり方ごとのエピソードの数' })).toBeInTheDocument()
  expect(screen.getByText('prob')).toBeInTheDocument()
  // 出どころは関数の名前でなく日本語の言い換え
  expect(screen.getByText('守り付きの評価')).toBeInTheDocument()
  expect(screen.queryByText('evaluate_policy')).not.toBeInTheDocument()
  expect(screen.getByRole('tab', { name: '守り' })).toBeInTheDocument()
  // 切っていなければ, 先頭だけで描いた知らせは出さない
  expect(screen.queryByText(/先頭の .* 件のエピソードで描いています/)).not.toBeInTheDocument()
})

test('守りの無い表には守りのタブを出さない', async () => {
  renderView(summaryOf({ guarded: false, guard: null }))
  expect(await screen.findByText('エピソードの長さ')).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: '守り' })).not.toBeInTheDocument()
})

test('観測と行動に要素ごとの欠けと nan を分けて出し, 整数の行動は値ごとの数を描く', async () => {
  renderView(summaryOf(), 'elements')
  const actions = await screen.findByRole('table', { name: '行動の要素ごとの統計' })
  const row = within(actions).getByRole('row', { name: /action/ })
  // 型, 欠け 2, nan 0
  expect(
    within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['integer', '2', '0', '0', '1', '1', '1', '0', '1'])
  expect(screen.getByRole('img', { name: 'action の値ごとの数' })).toBeInTheDocument()
  const observations = screen.getByRole('table', { name: '観測の要素ごとの統計' })
  expect(within(observations).getByRole('row', { name: /obs_0/ })).toHaveTextContent('number01')
})

test('守りの理由ごとの数を並べる', async () => {
  renderView(summaryOf(), 'guard')
  expect(await screen.findByText('観測の要素 0 が範囲の外 (3)')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: '守りの結果ごとの行の数' })).toBeInTheDocument()
})

test('エピソードを切った場合は一覧で知らせる', async () => {
  renderView(summaryOf({ episodes: 1500, per_episode_truncated: true }), 'episodes')
  expect(await screen.findByRole('note')).toHaveTextContent(
    'エピソードが 1,500 件あるので, 先頭の 2 件だけを並べています.',
  )
  const table = screen.getByRole('table', { name: /エピソードごと/ })
  expect(within(table).getAllByText('守りで止めた')).toHaveLength(2)
})

test('分析を書き出すと要約の JSON を保存させる', async () => {
  const create = vi.fn((_blob: Blob) => 'blob:analysis')
  URL.createObjectURL = create as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn()
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const summary = summaryOf()
  renderView(summary)
  await screen.findByText('エピソードの長さ')
  fireEvent.click(screen.getByRole('button', { name: '分析を書き出す' }))
  expect(click).toHaveBeenCalledTimes(1)
  const link = click.mock.contexts[0] as HTMLAnchorElement
  expect(link.download).toBe('guarded.analysis.json')
  const written = JSON.parse(await create.mock.calls[0]![0].text()) as TrajectorySummary
  expect(written).toEqual(summary)
})

/** 確率の列のある軌跡の要約 */
const WITH_PROB: Partial<TrajectorySummary> = {
  with_action_prob: true,
  action_prob: {
    missing: 2,
    out_of_range: 1,
    min: 0.3,
    max: 0.7,
    mean: 0.5,
    std: 0.2,
    median: 0.5,
  },
}

test('確率の列の有無を概要に出し, 観測と行動に欠けと範囲の外の数を出す', async () => {
  renderView(summaryOf(WITH_PROB))
  const tile = (await screen.findByText('行動を選んだ確率')).parentElement!
  expect(tile).toHaveTextContent('あり')
  fireEvent.click(screen.getByRole('tab', { name: '観測と行動' }))
  const card = (await screen.findByText('行動を選んだ確率 (action_prob)')).closest('section')!
  expect(within(card).getByText('欠け').nextSibling).toHaveTextContent('2')
  expect(
    within(card).getByText('範囲の外 (0 より大きく 1 以下でない値)').nextSibling,
  ).toHaveTextContent('1')
})

test('確率の列が無い表は, 観測と行動で無いと知らせる', async () => {
  renderView(summaryOf(), 'elements')
  expect(await screen.findByText('表に行動を選んだ確率の列はありません.')).toBeInTheDocument()
})

test('ML-Found が無い場合は方策の見積もりのタブを出さない', async () => {
  renderView(summaryOf(WITH_PROB), 'policy')
  expect(await screen.findByText('エピソードの長さ')).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: '方策の見積もり' })).not.toBeInTheDocument()
})

test('確率の列が無い表では, 見積もれない理由を出す', async () => {
  renderView(summaryOf(), 'policy', true)
  expect(await screen.findByRole('note')).toHaveTextContent('action_prob')
  expect(screen.queryByRole('button', { name: '見積もる' })).not.toBeInTheDocument()
})

test('見積もる方策を選んで見積もり, 3 つの見積もりと有効なサンプルの数と知らせることを出す', async () => {
  const result: PolicyValueResult = {
    policy: { name: 'epsilon_greedy', n: 2, start: 0, action: 1, epsilon: 0.2 },
    gamma: 0.9,
    estimate: {
      value: 1.855,
      ordinary: 1.25,
      per_decision: null,
      behavior_value: 1.5,
      episodes: 2,
      steps: 6,
      effective_sample_size: 1.8,
      max_weight_share: 0.6,
      zero_weight_episodes: 0,
      underflow_episodes: 0,
      notes: ['守りで止めた判断の行 (2 行) は重みに入れません'],
    },
  }
  const estimate = vi.spyOn(api, 'policyValue').mockResolvedValue(result)
  renderView(summaryOf(WITH_PROB), 'policy', true)
  fireEvent.change(await screen.findByLabelText('方策'), {
    target: { value: 'epsilon_greedy' },
  })
  fireEvent.change(screen.getByLabelText('ε (一様に選ぶ確率)'), { target: { value: '0.2' } })
  const gamma = screen.getByLabelText('割引率 γ')

  // 範囲の外の割引率では見積もれない
  fireEvent.change(gamma, { target: { value: '1.5' } })
  expect(screen.getByRole('button', { name: '見積もる' })).toBeDisabled()
  fireEvent.change(gamma, { target: { value: '0.9' } })
  fireEvent.click(screen.getByRole('button', { name: '見積もる' }))
  await waitFor(() =>
    expect(estimate).toHaveBeenCalledWith('s1', {
      policy: 'epsilon_greedy',
      epsilon: 0.2,
      gamma: 0.9,
    }),
  )
  const table = await screen.findByRole('table', { name: '見積もりの比べ' })
  expect(within(table).getByRole('row', { name: /重み付き/ })).toHaveTextContent('1.855')
  expect(within(table).getByRole('row', { name: /歩ごと/ })).toHaveTextContent('–')
  expect(within(table).getByRole('row', { name: /記録した方策/ })).toHaveTextContent('1.5')
  expect(screen.getByText('有効なサンプルの数').parentElement).toHaveTextContent('1.8')
  expect(screen.getByText('守りで止めた判断の行 (2 行) は重みに入れません')).toBeInTheDocument()
  expect(screen.getByText(/確率 0.8 で行動 1/)).toBeInTheDocument()
})
