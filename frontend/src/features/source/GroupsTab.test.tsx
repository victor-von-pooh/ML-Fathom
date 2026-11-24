import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api, ApiError } from '../../api/client'
import type { GroupSummary, Profile, Source } from '../../api/types'
import { GroupsTab } from './GroupsTab'

afterEach(() => {
  vi.restoreAllMocks()
})

const SOURCE = {
  id: 's1',
  name: 'customers.csv',
  path: '/data/customers.csv',
  loader: 'csv',
  kind: 'table',
  options: {},
  target: null,
} as unknown as Source

const PROFILE = {
  columns: {
    member: { type: 'id' },
    spend: { type: 'numeric' },
    region: { type: 'categorical' },
    memo: { type: 'text' },
  },
} as unknown as Profile

/** 群の要約 (ML-EDA の describe_groups の形) */
const SUMMARY: GroupSummary = {
  method: 'kmeans',
  k: 2,
  rows: 4,
  columns: { numeric: ['spend'], categorical: ['region'] },
  width: 3,
  seed: 0,
  groups: [
    { group: 0, rows: 2, share: 0.5, stability: 1, spend: 1.5, region: 'east (100 %)' },
    { group: 1, rows: 2, share: 0.5, stability: 0.8, spend: 20.25, region: 'west (100 %)' },
    { group: '全体', rows: 4, share: 1, stability: null, spend: 10.875, region: 'east (50 %)' },
  ],
  stability: { method: 'seed', repeats: 5, ari: 0.9, ari_min: 0.75 },
  silhouette: 0.62,
  source: { path: 'customers.csv' },
  notes: ['群を作る列に欠けた値のある行が 1 行あります'],
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <GroupsTab source={SOURCE} profile={PROFILE} />
    </QueryClientProvider>,
  )
}

test('初めは数と種類の列を選び, 選んだ列と群の数で群を作って要約を出す', async () => {
  const groups = vi.spyOn(api, 'groups').mockResolvedValue(SUMMARY)
  renderTab()
  const fields = within(screen.getByRole('group', { name: '群を作る列' }))
  expect(fields.getByRole('checkbox', { name: /spend/ })).toBeChecked()
  expect(fields.getByRole('checkbox', { name: /region/ })).toBeChecked()
  expect(fields.getByRole('checkbox', { name: /member/ })).not.toBeChecked()
  expect(fields.getByRole('checkbox', { name: /memo/ })).not.toBeChecked()

  fireEvent.change(screen.getByLabelText('群の数'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: '群を作る' }))
  await waitFor(() =>
    expect(groups).toHaveBeenCalledWith('s1', { columns: ['spend', 'region'], k: 2, seed: 0 }),
  )

  // 安定性とまとまりの数と, 指標の意味
  expect((await screen.findByText('調整ランド指数 (安定性)')).parentElement).toHaveTextContent(
    '0.9',
  )
  expect(screen.getByText('シルエット係数 (まとまり)').parentElement).toHaveTextContent('0.62')
  expect(screen.getByText(/1 で全く同じ分かれ方, 0 で偶然と同じ程度/)).toBeInTheDocument()
  expect(screen.getByText('群を作る列に欠けた値のある行が 1 行あります')).toBeInTheDocument()

  // 群ごとの行と全体の行, 列の要約
  const table = screen.getByRole('table', { name: '群ごとの行の数, 割合, 安定性と列の特徴' })
  const rows = within(table).getAllByRole('row')
  expect(rows).toHaveLength(4)
  expect(rows[1]).toHaveTextContent('群 0')
  expect(rows[1]).toHaveTextContent('50.0%')
  expect(rows[1]).toHaveTextContent('east (100 %)')
  expect(rows[3]).toHaveTextContent('全体')
  expect(within(table).getByText('(平均)')).toBeInTheDocument()
  expect(within(table).getByText('(最も多い値)')).toBeInTheDocument()
  expect(screen.queryByText(/kmeans/)).not.toBeInTheDocument()
})

test('選び方を変えると前の要約を消し, 列が無いか群の数が範囲の外なら作れない', async () => {
  vi.spyOn(api, 'groups').mockResolvedValue(SUMMARY)
  renderTab()
  fireEvent.click(screen.getByRole('button', { name: '群を作る' }))
  expect(await screen.findByText('群の要約')).toBeInTheDocument()

  // 群の数を変えると要約を消す. 範囲の外は理由を出して押せない
  fireEvent.change(screen.getByLabelText('群の数'), { target: { value: '1' } })
  expect(screen.queryByText('群の要約')).not.toBeInTheDocument()
  expect(screen.getByText('群の数は 2 から 50 の整数にしてください')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '群を作る' })).toBeDisabled()

  // 列を全て外すと作れず, 書き出せない
  fireEvent.change(screen.getByLabelText('群の数'), { target: { value: '3' } })
  const fields = within(screen.getByRole('group', { name: '群を作る列' }))
  fireEvent.click(fields.getByRole('checkbox', { name: /spend/ }))
  fireEvent.click(fields.getByRole('checkbox', { name: /region/ }))
  expect(screen.getByRole('button', { name: '群を作る' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '群分けの表を書き出す' })).toBeDisabled()
})

test('群を作れない理由を出す', async () => {
  vi.spyOn(api, 'groups').mockRejectedValue(
    new ApiError(422, '群を作れません: 群の数 3 が行の数 2 より多いです'),
  )
  renderTab()
  fireEvent.click(screen.getByRole('button', { name: '群を作る' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('群の数 3 が行の数 2 より多いです')
})

test('群を作る列と行を見分ける列で, 群分けの表を書き出す', async () => {
  const exporter = vi.spyOn(api, 'exportGroups').mockResolvedValue({
    path: '/home/datasets/customers_groups',
    info: {},
    notes: ['行の数の半分より多い種類の値を持つ列があります'],
  })
  renderTab()
  const name = screen.getByLabelText('データセットの名前')
  expect(name).toHaveValue('customers_groups')

  // 行を見分ける列は群を作る列の他から選ぶ
  const id = screen.getByLabelText('行を見分ける列')
  const options = within(id)
    .getAllByRole('option')
    .map((option) => option.textContent)
  expect(options).toEqual(['なし (行の位置)', 'member', 'memo'])
  fireEvent.change(id, { target: { value: 'member' } })
  fireEvent.change(screen.getByLabelText('検証用の割合'), { target: { value: '0.25' } })
  fireEvent.click(screen.getByRole('button', { name: '群分けの表を書き出す' }))
  await waitFor(() =>
    expect(exporter).toHaveBeenCalledWith('s1', {
      columns: ['spend', 'region'],
      id: 'member',
      split: { method: 'random', valid: 0.25, test: 0, seed: 0 },
      name: 'customers_groups',
      overwrite: false,
    }),
  )
  expect(await screen.findByRole('status')).toHaveTextContent(
    '書き出しました: /home/datasets/customers_groups',
  )
  expect(screen.getByText(/半分より多い種類の値/)).toBeInTheDocument()
  expect(
    screen.getByText(/ml_eda.load_items\("\/home\/datasets\/customers_groups"\)/),
  ).toBeInTheDocument()

  // 分けない場合は検証用の割合を出さない
  fireEvent.change(screen.getByLabelText('分割'), { target: { value: 'none' } })
  expect(screen.queryByLabelText('検証用の割合')).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('同じ名前があれば置き換えの案内を添える', async () => {
  vi.spyOn(api, 'exportGroups').mockRejectedValue(
    new ApiError(409, 'customers_groups は既にあります'),
  )
  renderTab()
  fireEvent.click(screen.getByRole('button', { name: '群分けの表を書き出す' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '「同じ名前があれば置き換える」に印を付けてください',
  )
})
