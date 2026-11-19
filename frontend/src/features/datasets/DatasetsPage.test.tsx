import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '../../api/client'
import type { DatasetSummary } from '../../api/types'
import { DatasetsPage } from './DatasetsPage'

afterEach(() => {
  vi.restoreAllMocks()
})

const DATASETS: DatasetSummary[] = [
  {
    form: 'items',
    name: 'objects',
    path: '/home/datasets/objects',
    format_version: 2,
    created_at: '2026-11-19T10:00:00+09:00',
    role: 'predict',
    target: {
      kind: 'point_cloud',
      entries: ['cloud'],
      origin: { type: 'process', name: 'fusion', settings: { voxel: 0.01 } },
    },
    entries: [
      {
        name: 'capture',
        kind: 'capture',
        role: 'input',
        units: 'meter',
        convention: { pose: 'camera_to_world' },
        shape: [8, 24, 32],
        formats: ['transforms.json'],
      },
      {
        name: 'cloud',
        kind: 'point_cloud',
        role: 'target',
        units: 'meter',
        convention: { frame: 'capture' },
        shape: [null, 3],
        formats: ['ply'],
      },
    ],
    splits: { train: 3, valid: 1 },
    items: 4,
    normalization: 'view_center',
    notes: ['点群の無い撮影が 1 件あり, 除きました'],
  },
  {
    form: 'table',
    name: 'people',
    path: '/home/datasets/people',
    format_version: 1,
    created_at: '2026-11-18T10:00:00+09:00',
    kind: 'table',
    task: 'classification',
    target: 'bought',
    splits: { train: 150, valid: 50 },
    features: 4,
  },
  {
    form: 'unreadable',
    name: 'future',
    path: '/home/datasets/future',
    format_version: 3,
    created_at: null,
    unknown_version: true,
    error: 'format_version 3 は, この ML-Fathom の ML-EDA が読める版 (1, 2) ではありません',
  },
]

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DatasetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('版 2 は項目と出どころ, 版 1 は表, 知らない版は「読めない版」として並べる', async () => {
  vi.spyOn(api, 'datasets').mockResolvedValue(DATASETS)
  renderPage()

  // 版 2: 受け持ち, 正解の種類, 項目の単位と座標の決まり, 分割, 出どころの注意
  const objects = (await screen.findByText('objects')).closest('section')!
  const card = within(objects)
  expect(card.getByText('版 2 · ファイルの組')).toBeInTheDocument()
  expect(card.getByText(/予測する · 点群 \(point_cloud\)/)).toBeInTheDocument()
  expect(card.getByText('pose=camera_to_world')).toBeInTheDocument()
  expect(card.getByText(/train 3 件, valid 1 件 \(全て 4 件\)/)).toBeInTheDocument()
  expect(card.getByText(/今ある処理の出力 \(process\)/)).toBeInTheDocument()
  expect(card.getByText('{"voxel":0.01}')).toBeInTheDocument()
  expect(card.getByText(/処理 fusion を超えられません/)).toBeInTheDocument()
  expect(card.getByText(/点群の無い撮影/)).toBeInTheDocument()

  // 版 1 は今までどおり
  const people = within(screen.getByText('people').closest('section')!)
  expect(people.getByText('版 1 · 表')).toBeInTheDocument()
  expect(people.getByText('bought')).toBeInTheDocument()

  // 知らない版も消さずに理由を出す
  const future = within(screen.getByText('future').closest('section')!)
  expect(future.getByText('読めない版')).toBeInTheDocument()
  expect(future.getByText(/読める版 \(1, 2\) ではありません/)).toBeInTheDocument()
})
