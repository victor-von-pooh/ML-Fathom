import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { ProjectPlace, ReactionsResult, ReactionsSummary, Source } from '../../api/types'
import { ReactionsView } from './ReactionsView'

// グラフは描かず, 名前だけを出す (jsdom では canvas を描けないため)
vi.mock('../../lib/chart', () => ({
  Chart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

// jsdom はタブを横に送る scrollIntoView を持たない
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  vi.restoreAllMocks()
})

const COUNTS = {
  min: 1,
  max: 3,
  mean: 2,
  std: 1,
  median: 2,
  once: 1,
  bins: [
    { from: 1, to: 1, count: 1 },
    { from: 2, to: 2, count: 1 },
    { from: 3, to: 5, count: 1 },
  ],
}

/** 反応の表の要約 (ML-EDA の describe_reactions の形) */
function summaryOf(overrides: Partial<ReactionsSummary> = {}): ReactionsSummary {
  return {
    columns: {
      user: 'member',
      item: 'item_id',
      time: 'ts',
      reaction: 'qty',
      shown: null,
      presentation: null,
    },
    source: { path: '/data/reactions.csv', loader: 'csv', options: {} },
    rows: 10,
    reactions: 6,
    dropped: {
      missing: 3,
      unreadable_time: 1,
      not_positive: 1,
      unreadable_shown: 0,
      conflict: 0,
      duplicate_shown: 0,
      total: 4,
    },
    users: 3,
    items: 2,
    pairs: 5,
    repeated: 1,
    density: 0.8333,
    per_user: COUNTS,
    per_item: COUNTS,
    popularity: {
      top_items: 1,
      top_share: 0.5,
      gini: 0.25,
      popular: [
        { item: 'i1', reactions: 3 },
        { item: 'i2', reactions: 3 },
      ],
    },
    time: { kind: 'datetime', min: '2025-01-01T00:00:00', max: '2025-01-05T12:00:00', distinct: 6 },
    reaction: { min: 1, max: 2, mean: 1.5, std: 0.5, median: 1.5 },
    shown: null,
    notes: ['利用者, 品物か時刻の欠けた 3 行を除きました'],
    ...overrides,
  }
}

const PLACE: ProjectPlace = {
  project: '/work/project',
  dataset: '/work/project/data/reactions.csv',
  state: 'file',
  ready: true,
  reason: null,
}

function renderView(summary: ReactionsSummary, tab = 'overview', place: ProjectPlace = PLACE) {
  const result: ReactionsResult = {
    name: '総菜の推薦',
    path: '/problems/rank/problem.yaml',
    k: 10,
    summary,
  }
  vi.spyOn(api, 'reactions').mockResolvedValue(result)
  vi.spyOn(api, 'project').mockResolvedValue(place)
  const source = {
    id: 's1',
    name: '総菜の推薦',
    path: '/data/reactions.csv',
    loader: 'csv',
    kind: 'reactions',
    options: {},
    target: null,
    problem: '/problems/rank/problem.yaml',
  } as unknown as Source
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/sources/s1?tab=${tab}`]}>
        <ReactionsView source={source} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 見出しの付いたカード */
function card(title: string): HTMLElement {
  return screen.getByText(title, { selector: 'h2' }).closest('section')!
}

test('概要に数, 気付き, 読んだ列, 除いた行, 時刻の範囲を出す', async () => {
  renderView(summaryOf())
  expect(await screen.findByText('利用者, 品物か時刻の欠けた 3 行を除きました')).toBeInTheDocument()
  expect(screen.getByText('並べる件数 (K)').parentElement).toHaveTextContent('10')
  expect(screen.getByText('除いた行', { selector: 'div' }).parentElement).toHaveTextContent('4')
  const columns = card('読んだ列 (問題の答え)')
  expect(within(columns).getByText('qty')).toBeInTheDocument()
  expect(within(columns).getByText(/0 より大きい行だけ/)).toBeInTheDocument()
  const dropped = card('除いた行')
  expect(within(dropped).getByText('うち, 日時として読めない時刻').nextSibling).toHaveTextContent(
    '1',
  )
  const time = card('時刻の範囲')
  expect(within(time).getByText('日時')).toBeInTheDocument()
  expect(within(time).getByText('2025-01-05 12:00:00')).toBeInTheDocument()
  expect(screen.getByText('反応の強さ (残した反応)')).toBeInTheDocument()
})

test('反応の強さの列が無ければ, 全ての行を反応とみなすと知らせる', async () => {
  renderView(
    summaryOf({
      columns: {
        user: 'member',
        item: 'item_id',
        time: 'ts',
        reaction: null,
        shown: null,
        presentation: null,
      },
      reaction: null,
    }),
  )
  const columns = (await screen.findByText('読んだ列 (問題の答え)')).closest('section')!
  expect(within(columns).getByText('反応の強さ').nextSibling).toHaveTextContent('なし')
  expect(within(columns).getByText(/全ての行を反応とみなします/)).toBeInTheDocument()
  expect(screen.queryByText('反応の強さ (残した反応)')).not.toBeInTheDocument()
})

test('見せただけの印の列があれば, 見せただけの記録の要約と除いた行の内訳を出す', async () => {
  renderView(
    summaryOf({
      columns: {
        user: 'member',
        item: 'item_id',
        time: 'ts',
        reaction: 'qty',
        shown: 'shown_only',
        presentation: 'impression_id',
      },
      dropped: {
        missing: 1,
        unreadable_time: 0,
        not_positive: 0,
        unreadable_shown: 1,
        conflict: 1,
        duplicate_shown: 1,
        total: 4,
      },
      shown: {
        negatives: 12,
        users: 3,
        items: 4,
        by: 'presentation',
        presentations: 5,
        chosen_presentations: 4,
        unseen_items: 2,
      },
    }),
  )
  const columns = (await screen.findByText('読んだ列 (問題の答え)')).closest('section')!
  expect(within(columns).getByText('見せただけの印').nextSibling).toHaveTextContent('shown_only')
  expect(within(columns).getByText('提示').nextSibling).toHaveTextContent('impression_id')
  expect(within(columns).getByText(/学習の負の例/)).toBeInTheDocument()
  const dropped = card('除いた行')
  expect(within(dropped).getByText('利用者, 品物, 時刻か提示の欠け').nextSibling).toHaveTextContent(
    '1',
  )
  expect(within(dropped).getByText('見せただけの印が読めない').nextSibling).toHaveTextContent('1')
  expect(
    within(dropped).getByText('選んだ行と同じ提示の同じ品物の見せただけの行').nextSibling,
  ).toHaveTextContent('1')
  expect(
    within(dropped).getByText('同じ提示の同じ品物の見せただけの行の 2 行目から').nextSibling,
  ).toHaveTextContent('1')
  const shown = card('見せただけの記録')
  expect(within(shown).getByText('残した見せただけの行 (負の例)').nextSibling).toHaveTextContent(
    '12',
  )
  expect(within(shown).getByText('選んだ反応のある提示').nextSibling).toHaveTextContent('4')
  expect(within(shown).getByText('反応の表に無い品物の行').nextSibling).toHaveTextContent('2')
  expect(within(shown).getByText(/同じ利用者と提示の行を 1 回の提示/)).toBeInTheDocument()
})

test('見せただけの印の列が無ければ, 見せただけの記録と内訳を出さない', async () => {
  renderView(summaryOf())
  const dropped = (await screen.findByText('除いた行', { selector: 'h2' })).closest('section')!
  expect(within(dropped).queryByText('見せただけの印が読めない')).not.toBeInTheDocument()
  expect(screen.queryByText('見せただけの記録', { selector: 'h2' })).not.toBeInTheDocument()
  expect(screen.queryByText('提示')).not.toBeInTheDocument()
})

test('偏りに人気の偏りと多い品物, 利用者ごとと品物ごとの分布を出す', async () => {
  renderView(summaryOf(), 'bias')
  const popularity = (await screen.findByText('品物の人気の偏り')).closest('section')!
  expect(within(popularity).getByText('ジニ係数').nextSibling).toHaveTextContent('0.25')
  expect(within(popularity).getByText('その品物の反応の割合').nextSibling).toHaveTextContent(
    '50.0%',
  )
  const table = within(popularity).getByRole('table', { name: '反応の多い品物' })
  expect(within(table).getAllByRole('row')).toHaveLength(3)
  expect(
    screen.getByRole('img', { name: '利用者ごとの反応の数の区切りごとの数' }),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('img', { name: '品物ごとの反応の数の区切りごとの数' }),
  ).toBeInTheDocument()
})

test('前に置いたファイルは確かめてから置き換えて書き出す', async () => {
  const exporter = vi.spyOn(api, 'exportReactions').mockResolvedValue({
    path: PLACE.dataset!,
    copied: true,
    reactions: 6,
    dropped: 4,
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderView(summaryOf(), 'export')
  expect(await screen.findByText(PLACE.dataset!)).toBeInTheDocument()
  expect(screen.getByText(/前に置いたファイルがあります/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '学習のプロジェクトへ書き出す' }))
  expect(confirm).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(exporter).toHaveBeenCalledWith('s1', true))
  expect(await screen.findByRole('status')).toHaveTextContent(
    `学習のプロジェクトへ書き出しました: ${PLACE.dataset} (骨組みが反応とみなす行 6, 除く行 4)`,
  )
})

test('置き換えを断れば書き出さず, 書き出せない理由を出す', async () => {
  const exporter = vi.spyOn(api, 'exportReactions')
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderView(summaryOf(), 'export')
  fireEvent.click(await screen.findByRole('button', { name: '学習のプロジェクトへ書き出す' }))
  expect(exporter).not.toHaveBeenCalled()
})

test('書き出し先がファイルでなければ, 理由を出して押せるボタンを出さない', async () => {
  renderView(summaryOf(), 'export', {
    ...PLACE,
    state: 'occupied',
    ready: false,
    reason: '/work/project/data/reactions.csv はファイルではないので上書きしません',
  })
  expect(await screen.findByText(/ファイルではないので上書きしません/)).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: '学習のプロジェクトへ書き出す' }),
  ).not.toBeInTheDocument()
})
