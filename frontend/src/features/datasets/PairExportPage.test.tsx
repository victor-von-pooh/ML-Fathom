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
  window.localStorage.clear()
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
  model: {
    inputs: [{ name: 'image', shape: [null, 3, 64, 64], dtype: 'float32' }],
    task: null,
    target: 'mask',
    classes: ['background', 'circle'],
    target_kind: 'mask',
    outputs: 2,
  },
  model_error: null,
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
  // 結果にモデルに要るもの (入力の形と型, 背景を含むクラスの数)
  expect(panel.getByText('[バッチ, 3, 64, 64] float32')).toBeInTheDocument()
  expect(
    panel.getByText(/2 \(背景を含む領域のクラスの数: background, circle\)/),
  ).toBeInTheDocument()
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

test('問題から始めた書き出しは印なしで始め, 印を書き出しの設定の外で送る', async () => {
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
  fireEvent.click(screen.getByRole('button', { name: '学習のプロジェクトへ書き出す' }))
  expect(await screen.findByText('問題に書き戻しました.')).toBeInTheDocument()
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

test('手で始めた書き出しの欄を埋めて画面を離れ, 戻ると欄が戻る', async () => {
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  const first = renderPage()
  let panel = imagePanel()
  fireEvent.change(panel.getByLabelText('画像のディレクトリ'), { target: { value: '/d/images' } })
  fireEvent.change(panel.getByLabelText('領域のディレクトリ'), { target: { value: '/d/masks' } })
  fireEvent.change(panel.getByLabelText('値の名前 (任意)'), {
    target: { value: '0: background\n1: circle' },
  })
  fireEvent.change(panel.getByLabelText('検証用の割合'), { target: { value: '0.3' } })
  fireEvent.change(panel.getByLabelText('データセットの名前'), { target: { value: 'shapes' } })
  fireEvent.click(panel.getByRole('checkbox', { name: '外を指すリンクの先も写す' }))
  // 画面を離れる (殻で段階を移るか問題を替えると部品が外される)
  first.unmount()

  renderPage()
  panel = imagePanel()
  expect(panel.getByLabelText('画像のディレクトリ')).toHaveValue('/d/images')
  expect(panel.getByLabelText('領域のディレクトリ')).toHaveValue('/d/masks')
  expect(panel.getByLabelText('値の名前 (任意)')).toHaveValue('0: background\n1: circle')
  expect(panel.getByLabelText('検証用の割合')).toHaveValue('0.3')
  // 名前と外を指すリンクの印は残さない
  expect(panel.getByLabelText('データセットの名前')).toHaveValue('')
  expect(panel.getByRole('checkbox', { name: '外を指すリンクの先も写す' })).not.toBeChecked()
  // もう一方の組の欄には戻さない
  expect(window.localStorage.getItem('ml-fathom:pairs:capture_clouds')).toBeNull()
})

test('手で始めた書き出しを終えると下書きを捨て, 開き直すと空の欄から始める', async () => {
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  vi.spyOn(api, 'exportImageMasks').mockResolvedValue({ ...SKIPPED, notes: [], notices: [] })
  const first = renderPage()
  const panel = imagePanel()
  fireEvent.change(panel.getByLabelText('画像のディレクトリ'), { target: { value: '/d/images' } })
  fireEvent.change(panel.getByLabelText('領域のディレクトリ'), { target: { value: '/d/masks' } })
  fireEvent.change(panel.getByLabelText('データセットの名前'), { target: { value: 'shapes' } })
  expect(window.localStorage.getItem('ml-fathom:pairs:image_masks')).not.toBeNull()
  fireEvent.click(panel.getByRole('button', { name: 'ファイルの組を書き出す' }))
  expect(await panel.findByText('書き出しの注意はありません.')).toBeInTheDocument()
  expect(window.localStorage.getItem('ml-fathom:pairs:image_masks')).toBeNull()
  first.unmount()

  renderPage()
  expect(imagePanel().getByLabelText('画像のディレクトリ')).toHaveValue('')
})

test('問題から始めた書き出しは下書きを残さず, 手で始めた下書きでも埋めない', async () => {
  window.localStorage.setItem(
    'ml-fathom:pairs:image_masks',
    JSON.stringify({ inputs: '/manual/images', targets: '/manual/masks' }),
  )
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
  renderPage('/datasets/pairs?problem=/p/problem.yaml')
  const images = await screen.findByLabelText('画像のディレクトリ')
  expect(images).toHaveValue('/d/images')
  fireEvent.change(images, { target: { value: '/other/images' } })
  expect(JSON.parse(window.localStorage.getItem('ml-fathom:pairs:image_masks')!)).toMatchObject({
    inputs: '/manual/images',
  })
})

test('書き出しの途中で欄を変えると, 書き出し終えても変えた値の下書きを残す', async () => {
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  let finish: (result: PairExportResult) => void = () => {}
  vi.spyOn(api, 'exportImageMasks').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  renderPage()
  const panel = imagePanel()
  fireEvent.change(panel.getByLabelText('画像のディレクトリ'), { target: { value: '/d/images' } })
  fireEvent.change(panel.getByLabelText('領域のディレクトリ'), { target: { value: '/d/masks' } })
  fireEvent.change(panel.getByLabelText('データセットの名前'), { target: { value: 'shapes' } })
  fireEvent.click(panel.getByRole('button', { name: 'ファイルの組を書き出す' }))
  await panel.findByRole('button', { name: '書き出し中…' })
  // 書き出しの途中で欄を変える
  fireEvent.change(panel.getByLabelText('画像のディレクトリ'), { target: { value: '/e/images' } })
  finish({ ...SKIPPED, notes: [], notices: [] })
  await waitFor(() => expect(api.exportImageMasks).toHaveBeenCalled())
  await waitFor(() =>
    expect(panel.queryByRole('button', { name: '書き出し中…' })).not.toBeInTheDocument(),
  )
  const saved = window.localStorage.getItem('ml-fathom:pairs:image_masks')
  expect(saved).not.toBeNull()
  expect(JSON.parse(saved!)).toMatchObject({ inputs: '/e/images' })
})

test('知らない正解の出どころの種類は下書きから戻さない', async () => {
  window.localStorage.setItem(
    'ml-fathom:pairs:image_masks',
    JSON.stringify({ inputs: '/d/images', originType: 'toString' }),
  )
  vi.spyOn(api, 'info').mockResolvedValue(INFO)
  renderPage()
  const panel = imagePanel()
  expect(panel.getByLabelText('画像のディレクトリ')).toHaveValue('/d/images')
  expect(panel.getByLabelText('種類')).toHaveValue('unknown')
})
