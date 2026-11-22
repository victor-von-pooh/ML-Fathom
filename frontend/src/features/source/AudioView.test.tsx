import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { ApiError, api } from '../../api/client'
import type { AudioItem } from '../../api/types'
import { AudioView } from './AudioView'

afterEach(() => {
  vi.restoreAllMocks()
})

const ITEM: AudioItem = {
  sample_rate: 16000,
  channels: 2,
  duration: 95,
  seconds: 30,
  truncated: true,
  waveform: { min: [-0.5, -0.2, -0.1], max: [0.5, 0.3, 0.1] },
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AudioView sourceId="s1" index={3} />
    </QueryClientProvider>,
  )
}

test('音声の再生の部品と波形を出し, 先頭だけのことを添える', async () => {
  const item = vi.spyOn(api, 'item').mockResolvedValue(ITEM)
  const { container } = renderView()
  const figure = await screen.findByRole('img', { name: /3 番目の音声の波形/ })
  expect(item).toHaveBeenCalledWith('s1', 3)
  expect(screen.getByText(/16,000 Hz · 2 チャンネル · 長さ 1 分 35 秒/)).toBeInTheDocument()
  expect(screen.getByText(/再生と波形は先頭の 30.0 秒だけ/)).toBeInTheDocument()
  const audio = container.querySelector('audio')!
  expect(audio.getAttribute('src')).toBe('/api/sources/s1/items/3/audio')
  expect(figure.querySelector('path')!.getAttribute('d')).toMatch(/^M .+ Z$/)

  // 再生した位置に縦の線を引く
  expect(figure.querySelectorAll('line')).toHaveLength(1)
  Object.defineProperty(audio, 'currentTime', { value: 15, configurable: true })
  fireEvent.timeUpdate(audio)
  const lines = figure.querySelectorAll('line')
  expect(lines).toHaveLength(2)
  expect(lines[1]!.getAttribute('x1')).toBe('500')
})

test('鳴らせない音声はそう知らせる', async () => {
  vi.spyOn(api, 'item').mockResolvedValueOnce({ ...ITEM, truncated: false })
  const { container } = renderView()
  await screen.findByRole('img', { name: /波形/ })
  expect(screen.queryByText(/先頭の/)).not.toBeInTheDocument()
  fireEvent.error(container.querySelector('audio')!)
  expect(screen.getByText('このブラウザでは再生できませんでした.')).toBeInTheDocument()
})

test('読めない件は理由を出す', async () => {
  vi.spyOn(api, 'item').mockRejectedValue(new ApiError(422, '読めませんでした: 壊れています'))
  renderView()
  expect(await screen.findByText(/読めませんでした: 壊れています/)).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: /波形/ })).not.toBeInTheDocument()
})
