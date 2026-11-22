import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { AudioPreviewItem, ItemPreview, Recipe } from '../../api/types'
import { ItemPreviewCard } from './ItemPreviewCard'

afterEach(() => {
  vi.restoreAllMocks()
})

/** 音声の前か後の 1 件 */
function sound(rate: number, channels: number, src: string): AudioPreviewItem {
  return {
    sample_rate: rate,
    channels,
    duration: 1,
    seconds: 1,
    truncated: false,
    waveform: { min: [-0.5, -0.1], max: [0.5, 0.1] },
    src,
  }
}

const RECIPE: Recipe = {
  format_version: 1,
  target: 'label',
  task: 'classification',
  steps: [],
  item_steps: [{ op: 'resample', rate: 8000 }],
  split: { method: 'random', valid: 0.2 },
}

test('音声は選んだ 1 件の前と後を, 再生の部品と波形で並べる', async () => {
  const preview: ItemPreview = {
    fit_rows: 6,
    items: [
      {
        index: 2,
        label: 'dog',
        shape: [1, 8000],
        before: sound(16000, 2, 'data:audio/wav;base64,AAA'),
        after: sound(8000, 1, 'data:audio/wav;base64,BBB'),
      },
      {
        index: 5,
        label: 'cat',
        shape: [1, 8000],
        before: sound(44100, 1, 'data:audio/wav;base64,CCC'),
        after: sound(8000, 1, 'data:audio/wav;base64,DDD'),
      },
    ],
  }
  const call = vi.spyOn(api, 'itemPreview').mockResolvedValue(preview)
  const client = new QueryClient()
  const { container } = render(
    <QueryClientProvider client={client}>
      <ItemPreviewCard sourceId="s1" kind="audio" recipe={RECIPE} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '数件で試す' }))
  expect(await screen.findByRole('img', { name: /#2 の手順の前の波形/ })).toBeInTheDocument()
  expect(call).toHaveBeenCalledWith('s1', RECIPE)
  expect(screen.getByRole('img', { name: /#2 の手順の後の波形/ })).toBeInTheDocument()
  expect(screen.getByText(/16,000 Hz · 2 チャンネル/)).toBeInTheDocument()
  expect(screen.getByText('後 (形 (1, 8000))')).toBeInTheDocument()
  expect(screen.getByText(/先頭の 5 秒まで/)).toBeInTheDocument()
  const sources = () =>
    Array.from(container.querySelectorAll('audio')).map((item) => item.getAttribute('src'))
  expect(sources()).toEqual(['data:audio/wav;base64,AAA', 'data:audio/wav;base64,BBB'])

  // 件を変えると, その件の前と後
  const select = within(container).getByRole('combobox')
  fireEvent.change(select, { target: { value: '1' } })
  expect(sources()).toEqual(['data:audio/wav;base64,CCC', 'data:audio/wav;base64,DDD'])
  expect(screen.getByText(/44,100 Hz · 1 チャンネル/)).toBeInTheDocument()
})

test('試せない理由があれば, 数件で試すを押せず理由を読み上げる', () => {
  const call = vi.spyOn(api, 'itemPreview')
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <p id="reasons">中身の手順 1 (resample) の rate は 192000 以下にしてください</p>
      <ItemPreviewCard sourceId="s1" kind="audio" recipe={RECIPE} reasons="reasons" />
    </QueryClientProvider>,
  )
  const button = screen.getByRole('button', { name: '数件で試す' })
  expect(button).toBeDisabled()
  expect(button).toHaveAccessibleDescription(/rate は 192000 以下/)
  fireEvent.click(button)
  expect(call).not.toHaveBeenCalled()
})
