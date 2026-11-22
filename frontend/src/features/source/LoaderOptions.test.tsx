import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { LoaderInfo, Source } from '../../api/types'
import { LoaderOptions } from './LoaderOptions'

afterEach(() => {
  vi.restoreAllMocks()
})

const SOURCE: Source = {
  id: 's1',
  name: 'pictures',
  path: '/data/pictures',
  loader: 'image_folder',
  kind: 'image',
  options: {},
  target: null,
  created_at: '2026-01-01T00:00:00',
  exists: true,
}

const LOADER: LoaderInfo = {
  name: 'image_folder',
  kind: 'image',
  extensions: ['.png'],
  options: { digest: '中身の hash を求めるか', follow_links: '外を指すリンクの先も読むか' },
  description: '画像',
}

function renderOptions(source: Source) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <LoaderOptions source={source} loader={LOADER} />
    </QueryClientProvider>,
  )
}

test('follow_links を選んで真偽の値で読み直す', async () => {
  const update = vi.spyOn(api, 'updateSource').mockResolvedValue(SOURCE)
  renderOptions(SOURCE)
  fireEvent.click(screen.getByRole('button', { name: '読み込みの設定' }))
  const field = screen.getByLabelText('follow_links')
  expect(field.tagName).toBe('SELECT')
  expect(field).toHaveValue('')
  expect(field).toHaveAccessibleDescription('外を指すリンクの先も読むか')
  fireEvent.change(field, { target: { value: 'true' } })
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith('s1', { options: { follow_links: true } }),
  )
})

test('文字で保存した真偽の設定も選んだ形で出し, 既定に戻すと外す', async () => {
  const update = vi.spyOn(api, 'updateSource').mockResolvedValue(SOURCE)
  renderOptions({ ...SOURCE, options: { follow_links: ' Yes ', digest: false } })
  fireEvent.click(screen.getByRole('button', { name: '読み込みの設定' }))
  expect(screen.getByLabelText('follow_links')).toHaveValue('true')
  expect(screen.getByLabelText('digest')).toHaveValue('false')
  fireEvent.change(screen.getByLabelText('follow_links'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith('s1', { options: { digest: false } }))
})

test.each([
  [true, 'true'],
  [false, 'false'],
  [' ON ', 'true'],
  ['Off', 'false'],
  ['', 'false'],
  [1, 'true'],
  [0, 'false'],
  [null, 'false'],
])('保存した %j を ML-EDA と同じく %s と出す', (value, shown) => {
  renderOptions({ ...SOURCE, options: { follow_links: value } })
  fireEvent.click(screen.getByRole('button', { name: '読み込みの設定' }))
  expect(screen.getByLabelText('follow_links')).toHaveValue(shown)
})

test('知らない文字は書いてある文字のまま選択肢に出し, 変えなければ送らない', async () => {
  const update = vi.spyOn(api, 'updateSource').mockResolvedValue(SOURCE)
  renderOptions({ ...SOURCE, options: { follow_links: 'maybe' } })
  fireEvent.click(screen.getByRole('button', { name: '読み込みの設定' }))
  const field = screen.getByLabelText('follow_links')
  expect(field).toHaveValue('maybe')
  expect(screen.getByRole('option', { name: 'maybe' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('digest'), { target: { value: 'false' } })
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith('s1', {
      options: { follow_links: 'maybe', digest: false },
    }),
  )
})
