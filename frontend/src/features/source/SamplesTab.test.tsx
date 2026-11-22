import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { Profile, Rows, Source } from '../../api/types'
import { SamplesTab } from './SamplesTab'

afterEach(() => {
  vi.restoreAllMocks()
})

const REASON =
  'link.png は読み込んだディレクトリの外を指すリンクなので読みません (読むには読み込みの設定 follow_links を trueにしてください)'

function renderTab(kind: string, rows: Rows) {
  vi.spyOn(api, 'rows').mockResolvedValue(rows)
  const source = { id: 's1', kind, options: {} } as unknown as Source
  const profile = { items: { kind, count: rows.total, unreadable: 1 } } as unknown as Profile
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SamplesTab source={source} profile={profile} />
    </QueryClientProvider>,
  )
}

test('画像の一覧で, 外を指すリンクの件は読まずに理由を出す', async () => {
  const { container } = renderTab('image', {
    total: 2,
    offset: 0,
    columns: ['path', 'width', 'height', 'error'].map((name) => ({ name, dtype: 'object' })),
    rows: [
      ['inside.png', 4, 4, null],
      ['link.png', null, null, REASON],
    ],
    index: [0, 1],
  })
  const reason = await screen.findByTitle(REASON)
  expect(reason).toHaveTextContent(`読めません: ${REASON}`)
  // 読める 1 枚だけを読み込む
  const images = container.querySelectorAll('img')
  expect(images).toHaveLength(1)
  expect(images[0]!.getAttribute('src')).toBe('/api/sources/s1/items/0?size=256')
})

test('音声の一覧で, 読めない件に理由を出す', async () => {
  renderTab('audio', {
    total: 1,
    offset: 0,
    columns: ['path', 'sample_rate', 'channels', 'duration', 'error'].map((name) => ({
      name,
      dtype: 'object',
    })),
    rows: [['link.wav', null, null, null, REASON]],
    index: [0],
  })
  expect(await screen.findByTitle(REASON)).toHaveTextContent('follow_links')
  expect(screen.queryByText(/Hz/)).not.toBeInTheDocument()
})
