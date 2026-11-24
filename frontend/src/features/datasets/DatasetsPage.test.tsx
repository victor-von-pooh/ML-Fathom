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
    format_version: 3,
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
        convention: { pose: 'camera_to_world', depth: 'z', pixel_center: 0.5 },
        shape: [8, 24, 32],
        formats: ['transforms.json'],
        steps: [{ op: 'resize', width: 32, height: 24 }, { op: 'grayscale' }],
      },
      {
        name: 'cloud',
        kind: 'point_cloud',
        role: 'target',
        units: 'meter',
        convention: { frame: 'capture' },
        shape: [null, 3],
        formats: ['ply'],
        steps: null,
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
    model: {
      inputs: [{ name: 'x', shape: [null, 4], dtype: 'float32' }],
      task: 'classification',
      target: 'bought',
      classes: ['no', 'yes'],
      outputs: 2,
    },
  },
  {
    form: 'table',
    name: 'dataset',
    path: '/work/sales/data/dataset',
    format_version: 1,
    created_at: '2026-11-17T10:00:00+09:00',
    kind: 'timeseries',
    task: 'forecasting',
    target: 'sales',
    splits: { train: 100, valid: 20 },
    features: 6,
    model: {
      inputs: [{ name: 'x', shape: [null, 6], dtype: 'float32' }],
      task: 'forecasting',
      target: 'sales',
      classes: null,
      outputs: 1,
    },
    project: '総菜の作る量',
  },
  {
    form: 'table',
    name: 'reviews',
    path: '/home/datasets/reviews',
    format_version: 1,
    created_at: '2026-11-17T11:00:00+09:00',
    kind: 'text',
    task: 'classification',
    target: 'label',
    splits: { train: 40, valid: 10 },
    features: 0,
    model: {
      inputs: [{ name: 'x', shape: [null, 16], dtype: 'int64', vocabulary: 321 }],
      task: 'classification',
      target: 'label',
      classes: ['bad', 'good'],
      outputs: 2,
    },
  },
  {
    form: 'unreadable',
    name: 'future',
    path: '/home/datasets/future',
    format_version: 4,
    created_at: null,
    unknown_version: true,
    error: 'format_version 4 は, この ML-Fathom の ML-EDA が読める版 (1, 2, 3) ではありません',
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

test('版 3 は項目と中身の手順と出どころ, 版 1 は表, 知らない版は「読めない版」として並べる', async () => {
  vi.spyOn(api, 'datasets').mockResolvedValue(DATASETS)
  renderPage()

  // 版 3: 受け持ち, 正解の種類, 項目の単位と座標の決まりと中身の手順, 分割, 出どころの注意
  const objects = (await screen.findByText('objects')).closest('section')!
  const card = within(objects)
  expect(card.getByText('版 3 · ファイルの組')).toBeInTheDocument()
  expect(card.getByText('resize (width 32, height 24) → grayscale')).toBeInTheDocument()
  expect(card.getByText(/予測する · 点群 \(point_cloud\)/)).toBeInTheDocument()
  expect(card.getByText('pose=camera_to_world')).toBeInTheDocument()
  expect(
    card.getByText(/深度 z \(カメラの前の軸に沿った距離\) · 画素の中心 \+0\.5/),
  ).toBeInTheDocument()
  expect(card.getByText(/train 3 件, valid 1 件 \(全て 4 件\)/)).toBeInTheDocument()
  expect(card.getByText(/今ある処理の出力 \(process\)/)).toBeInTheDocument()
  expect(card.getByText('{"voxel":0.01}')).toBeInTheDocument()
  expect(card.getByText(/処理 fusion を超えられません/)).toBeInTheDocument()
  expect(card.getByText(/点群の無い撮影/)).toBeInTheDocument()

  // 版 1 は表と, モデルに要るもの (入力の形と型, 出す値の数)
  const people = within(screen.getByText('people').closest('section')!)
  expect(people.getByText('版 1 · 表')).toBeInTheDocument()
  expect(people.getByText('bought')).toBeInTheDocument()
  expect(people.getByText('[バッチ, 4] float32')).toBeInTheDocument()
  expect(people.getByText(/2 \(クラスの数\)/)).toBeInTheDocument()
  expect(people.queryByText(/語彙の大きさ/)).not.toBeInTheDocument()

  // 文のデータセットは語彙の大きさも
  const reviews = within(screen.getByText('reviews').closest('section')!)
  expect(reviews.getByText('[バッチ, 16] int64')).toBeInTheDocument()
  expect(reviews.getByText(/語彙の大きさ 321/)).toBeInTheDocument()
  expect(people.queryByText('プロジェクト')).not.toBeInTheDocument()

  // プロジェクトへ書き出したものは印を付ける
  const project = within(screen.getByText('dataset').closest('section')!)
  expect(project.getAllByText('プロジェクト')).toHaveLength(2)
  expect(project.getByText(/データ 総菜の作る量 からプロジェクトへ/)).toBeInTheDocument()
  expect(project.getByText(/1 \(値\)/)).toBeInTheDocument()

  // 知らない版も消さずに理由を出す
  const future = within(screen.getByText('future').closest('section')!)
  expect(future.getByText('読めない版')).toBeInTheDocument()
  expect(future.getByText(/読める版 \(1, 2, 3\) ではありません/)).toBeInTheDocument()
})

test('群分けの表は正解なしと列の項目を出し, 正解の出どころを出さない', async () => {
  vi.spyOn(api, 'datasets').mockResolvedValue([
    {
      form: 'items',
      name: 'customers_groups',
      path: '/home/datasets/customers_groups',
      format_version: 2,
      created_at: '2026-11-20T10:00:00+09:00',
      role: 'group',
      target: { kind: 'none', entries: [], origin: { type: 'unknown' } },
      entries: [
        {
          name: 'spend',
          kind: 'value',
          role: 'input',
          units: null,
          convention: null,
          shape: null,
          formats: null,
          steps: null,
        },
        {
          name: 'region',
          kind: 'class',
          role: 'input',
          units: null,
          convention: null,
          shape: null,
          formats: null,
          steps: null,
        },
        {
          name: 'when',
          kind: 'future_kind',
          role: 'input',
          units: null,
          convention: null,
          shape: null,
          formats: null,
          steps: null,
        },
      ],
      splits: { train: 72, valid: 18 },
      items: 90,
      normalization: null,
      notes: ['群を作る列に欠けた値のある行が 5 行あります'],
    },
  ])
  renderPage()
  const card = within((await screen.findByText('customers_groups')).closest('section')!)
  expect(card.getByText('版 2 · 群分けの表')).toBeInTheDocument()
  expect(card.getByText('まとめる · 正解なし')).toBeInTheDocument()
  expect(card.getByText('数の値')).toBeInTheDocument()
  expect(card.getByText('種類の値')).toBeInTheDocument()
  expect(card.getByText('その他の値')).toBeInTheDocument()
  expect(card.queryByText('future_kind')).not.toBeInTheDocument()
  expect(card.queryByText('正解の出どころ')).not.toBeInTheDocument()
  expect(card.getByText(/欠けた値のある行が 5 行/)).toBeInTheDocument()
})
