import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { Info, PairExportResult, ProblemPairs } from '../../api/types'
import { PairExportPage } from './PairExportPage'

// jsdom はタブを横に送る scrollIntoView を持たない
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  vi.restoreAllMocks()
})

/** 選べる中身の手順 (この画面は pair_steps だけを読む) */
const INFO = {
  pair_steps: { image_masks: { image: [] }, capture_clouds: { capture: [], cloud: [] } },
} as unknown as Info

/** 外を指すリンクで 1 件を除いた書き出しの結果 */
const SKIPPED: PairExportResult = {
  path: '/home/datasets/shapes',
  info: { format_version: 2, splits: { train: { items: 5 } }, entries: {} },
  notes: [
    '画像のディレクトリの外を指すリンクが 1 件あり, 除きました (例: a.png. 読むには 引数 follow_links=True にしてください)',
  ],
  notices: [
    {
      code: 'outside_links',
      count: 1,
      label: '画像',
      message:
        '画像のディレクトリの外を指すリンクが 1 件あり, 除きました (例: a.png. 読むには 引数 follow_links=True にしてください)',
    },
  ],
}

function renderPage(path = '/datasets/pairs') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <PairExportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** 表に出ている方 (画像と領域) の欄 */
function imagePanel() {
  return within(screen.getAllByRole('tabpanel')[0]!.children[0] as HTMLElement)
}

test('外を指すリンクの先は既定で写さず, 印を付けた場合だけ follow_links を送る', async () => {
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  const exporter = vi.spyOn(api, 'exportImageMasks').mockResolvedValue(SKIPPED)
  renderPage()
  const panel = imagePanel()
  fireEvent.change(panel.getByLabelText('画像のディレクトリ'), { target: { value: '/d/images' } })
  fireEvent.change(panel.getByLabelText('領域のディレクトリ'), { target: { value: '/d/masks' } })
  fireEvent.change(panel.getByLabelText('データセットの名前'), { target: { value: 'shapes' } })

  // 既定は印なしで, 写さないと案内し, 要求に follow_links を入れない
  const links = panel.getByRole('checkbox', { name: '外を指すリンクの先も写す' })
  expect(links).not.toBeChecked()
  expect(panel.getByText(/先は写さず, 数と例を書き出しの注意に書きます/)).toBeInTheDocument()
  fireEvent.click(panel.getByRole('button', { name: 'ファイルの組を書き出す' }))
  expect(await panel.findByText(/外を指すリンクが 1 件あり/)).toBeInTheDocument()
  expect(exporter.mock.calls[0]![0]).not.toHaveProperty('follow_links')
  expect(panel.getByText(/に印を付けて書き出し直してください/)).toBeInTheDocument()

  // 印を付けると前の結果を消し, follow_links: true で書き出す
  fireEvent.click(links)
  await waitFor(() =>
    expect(panel.queryByText(/外を指すリンクが 1 件あり/)).not.toBeInTheDocument(),
  )
  expect(panel.getByText(/データセットの中に写します/)).toBeInTheDocument()
  exporter.mockResolvedValue({ ...SKIPPED, notes: [], notices: [] })
  fireEvent.click(panel.getByRole('button', { name: 'ファイルの組を書き出す' }))
  expect(await panel.findByText('書き出しの注意はありません.')).toBeInTheDocument()
  expect(exporter.mock.calls[1]![0]).toMatchObject({ follow_links: true })
})

test('問題の設定から始めた書き出しは印なしで始め, 印を書き出しの設定の外で送る', async () => {
  const pairs: ProblemPairs = {
    name: '領域の問題',
    path: '/p/problem.yaml',
    version: 'v1',
    form: 'image_masks',
    export: {
      function: 'export_image_masks',
      inputs: '/d/images',
      targets: '/d/masks',
      split: { valid: 0.2, test: 0, seed: 0 },
      groups: null,
      origin: { type: 'unknown' },
      options: {},
    },
    notes: [],
    project: {
      project: '/p',
      dataset: '/p/outputs/dataset',
      state: 'missing',
      ready: true,
      reason: null,
    },
  }
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  vi.spyOn(api, 'problemPairs').mockResolvedValue(pairs)
  const exporter = vi
    .spyOn(api, 'exportProblemPairs')
    .mockResolvedValue({ ...SKIPPED, changes: [], conflicts: [], version: 'v2' })
  renderPage('/datasets/pairs?problem=/p/problem.yaml')
  const links = await screen.findByRole('checkbox', { name: '外を指すリンクの先も写す' })
  expect(links).not.toBeChecked()
  fireEvent.click(links)
  fireEvent.click(screen.getByRole('button', { name: 'プロジェクトへ書き出す' }))
  expect(await screen.findByText('問題の設定に書き戻しました.')).toBeInTheDocument()
  const body = exporter.mock.calls[0]![0]
  expect(body.follow_links).toBe(true)
  expect(body.export.options).not.toHaveProperty('follow_links')
})

test('外を指すリンクの案内は, 注意の文の言い回しでなく注意の印の種類で出す', async () => {
  // 言い回しの違う文でも印があれば案内し, 文に言葉があっても印が無ければ案内しない
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  const exporter = vi.spyOn(api, 'exportImageMasks').mockResolvedValue({
    ...SKIPPED,
    notes: ['画像の 1 件を写しませんでした'],
    notices: [
      { code: 'outside_links', count: 1, label: '画像', message: '画像の 1 件を写しませんでした' },
    ],
  })
  renderPage()
  const panel = imagePanel()
  fireEvent.change(panel.getByLabelText('画像のディレクトリ'), { target: { value: '/d/images' } })
  fireEvent.change(panel.getByLabelText('領域のディレクトリ'), { target: { value: '/d/masks' } })
  fireEvent.change(panel.getByLabelText('データセットの名前'), { target: { value: 'shapes' } })
  fireEvent.click(panel.getByRole('button', { name: 'ファイルの組を書き出す' }))
  expect(await panel.findByText(/に印を付けて書き出し直してください/)).toBeInTheDocument()

  // 文に「外を指すリンク」の言葉があっても, 印が無ければ案内しない
  exporter.mockResolvedValue({ ...SKIPPED, notices: [] })
  fireEvent.change(panel.getByLabelText('データセットの名前'), { target: { value: 'again' } })
  fireEvent.click(panel.getByRole('button', { name: 'ファイルの組を書き出す' }))
  expect(await panel.findByText(/外を指すリンクが 1 件あり/)).toBeInTheDocument()
  expect(panel.queryByText(/に印を付けて書き出し直してください/)).not.toBeInTheDocument()
})
