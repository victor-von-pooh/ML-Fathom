import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Listing, ProblemList, Source, StoredProblem } from './api/types'
import { ThemeProvider } from './lib/theme'
import { useTheme } from './lib/themeContext'
import { StageApp, type StageAppProps } from './StageApp'

/** 問題の設定の置き場 */
const ROOT = '/home/user/.ml-pathfinder/problems'

/** 1 つのデータ (problem は始めた問題の設定の識別子) */
function sourceOf(id: string, name: string, problem: string | null): Source {
  return {
    id,
    name,
    path: `/data/${name}.csv`,
    loader: 'csv',
    kind: 'table',
    options: {},
    target: null,
    created_at: '2026-01-01T00:00:00',
    exists: true,
    problem: problem === null ? null : `${ROOT}/${problem}/problem.yaml`,
  }
}

/** 置き場の問題の設定の 1 件 */
function storedOf(id: string, name: string, reason: string | null = null): StoredProblem {
  return {
    path: `${ROOT}/${id}/problem.yaml`,
    name,
    created_at: null,
    updated_at: null,
    startable: reason === null,
    reason,
    project: null,
  }
}

const SOURCES: Source[] = [
  sourceOf('s1', '総菜の売上', 'aaaaaaaaaaaa'),
  sourceOf('s2', '解約の記録', 'bbbbbbbbbbbb'),
  sourceOf('s3', '手で入れた表', null),
]

const PROBLEMS: ProblemList = {
  root: ROOT,
  problems: [
    storedOf('aaaaaaaaaaaa', '総菜の作る量'),
    storedOf('bbbbbbbbbbbb', '解約の予測'),
    storedOf('cccccccccccc', '入れていない課題', 'データが入っていません'),
  ],
  error: null,
}

const LISTING: Listing = { path: '/home/user', parent: null, home: '/home/user', entries: [] }

/** API の頭 `/api/data` の下だけに答える fetch (他の場所を呼べば 404) */
/** 始めた場所を差し替えると, 置き場の外の写しから始めた形になる */
function stubApi(startedAt?: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (!url.startsWith('/api/data/')) return new Response(null, { status: 404 })
    const path = url.slice('/api/data'.length)
    if (path === '/sources' && method === 'GET') return Response.json(SOURCES)
    if (path === '/problems' && method === 'GET') return Response.json(PROBLEMS)
    if (path.startsWith('/browse')) return Response.json(LISTING)
    if (path === '/problems/start' && method === 'POST') {
      const { path: problem } = JSON.parse(String(init?.body)) as { path: string }
      const id = problem.split('/').at(-2) ?? ''
      return Response.json(
        {
          source: { ...sourceOf('new', '始めたデータ', id) },
          problem: startedAt ?? problem,
          form: null,
          notes: [],
          tab: null,
        },
        { status: 201 },
      )
    }
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 殻の下の形 (経路の頭 `/data`, API の頭 `/api/data`) で描く */
function renderStage(props: Partial<StageAppProps> = {}) {
  const onProjectChange = vi.fn()
  const onProjectsChange = vi.fn()
  const view = render(
    <StageApp
      basename="/data"
      apiBase="/api/data"
      project={null}
      onProjectChange={onProjectChange}
      onProjectsChange={onProjectsChange}
      embedded
      {...props}
    />,
  )
  return { ...view, onProjectChange, onProjectsChange }
}

beforeEach(() => {
  // jsdom は対話の枠を開けないので, 開いた印だけを付ける
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  window.history.replaceState(null, '', '/data')
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('StageApp', () => {
  it('API を全て apiBase の下に呼び, 経路を basename の下に置く', async () => {
    const fetchMock = stubApi()
    renderStage()
    expect(await screen.findByRole('link', { name: '総菜の売上' })).toHaveAttribute(
      'href',
      '/data/sources/s1',
    )
    // project が null なら絞らない
    expect(screen.getByRole('link', { name: '手で入れた表' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'データセット' })).toHaveAttribute(
      'href',
      '/data/datasets',
    )
    const urls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(url.startsWith('/api/data/')).toBe(true)
  })

  it('embedded ではアプリの名前と明暗の切り替えを出さず, 左の欄の移動は出す', async () => {
    stubApi()
    renderStage()
    await screen.findByRole('link', { name: '総菜の売上' })
    expect(screen.queryByText('ML-Fathom')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /表示にする/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'データ' })).toBeInTheDocument()
  })

  it('読むだけの明暗は html のクラスを書き換えず, 殻の切り替えを読み直す', async () => {
    function Shown() {
      return <p>{useTheme().theme}</p>
    }
    render(
      <ThemeProvider readOnly>
        <Shown />
      </ThemeProvider>,
    )
    expect(screen.getByText('light')).toBeInTheDocument()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    document.documentElement.classList.add('dark')
    expect(await screen.findByText('dark')).toBeInTheDocument()
    document.documentElement.classList.remove('dark')
    expect(await screen.findByText('light')).toBeInTheDocument()
  })

  it('project を渡すと, その問題の設定から始めたデータに絞り, 始める欄を出す', async () => {
    stubApi()
    renderStage({ project: 'aaaaaaaaaaaa' })
    expect(await screen.findByText('総菜の作る量')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'この問題の設定から始める' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: '総菜の売上' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '解約の記録' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '手で入れた表' })).not.toBeInTheDocument()
    // 絞りを外すと全てを出す
    fireEvent.click(screen.getByRole('checkbox', { name: /全てのデータを出す/ }))
    expect(screen.getByRole('link', { name: '解約の記録' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '手で入れた表' })).toBeInTheDocument()
  })

  it('始められない問題の設定は理由を出し, 置き場に無い識別子は無いと出す', async () => {
    stubApi()
    const { rerender } = renderStage({ project: 'cccccccccccc' })
    expect(await screen.findByText('データが入っていません')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'この問題の設定から始める' }),
    ).not.toBeInTheDocument()
    rerender(
      <StageApp
        basename="/data"
        apiBase="/api/data"
        project="dddddddddddd"
        onProjectChange={() => {}}
        onProjectsChange={() => {}}
        embedded
      />,
    )
    expect(await screen.findByText(/は置き場/)).toBeInTheDocument()
  })

  it('選んだ問題の設定から始めると, データの画面へ移り, 同じ値は知らせない', async () => {
    const fetchMock = stubApi()
    const { onProjectChange, onProjectsChange } = renderStage({ project: 'aaaaaaaaaaaa' })
    fireEvent.click(await screen.findByRole('button', { name: 'この問題の設定から始める' }))
    await waitFor(() => expect(window.location.pathname).toBe('/data/sources/new'))
    const start = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/data/problems/start',
    )
    expect(JSON.parse(String(start?.[1]?.body))).toEqual({ path: PROBLEMS.problems[0]!.path })
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onProjectsChange).not.toHaveBeenCalled()
  })

  it('対話で別の問題の設定から始めると, その識別子を知らせる', async () => {
    stubApi()
    const { onProjectChange } = renderStage({ project: 'aaaaaaaaaaaa' })
    fireEvent.click(await screen.findByRole('button', { name: '問題の設定から始める' }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(await within(dialog).findByRole('button', { name: /解約の予測/, hidden: true }))
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'この問題の設定から始める', hidden: true }),
    )
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith('bbbbbbbbbbbb'))
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.location.pathname).toBe('/data/sources/new'))
  })

  it('置き場の外の同じ名前の写しから始めても知らせない', async () => {
    stubApi('/backup/bbbbbbbbbbbb/problem.yaml')
    const { onProjectChange } = renderStage({ project: 'aaaaaaaaaaaa' })
    fireEvent.click(await screen.findByRole('button', { name: '問題の設定から始める' }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(await within(dialog).findByRole('button', { name: /解約の予測/, hidden: true }))
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'この問題の設定から始める', hidden: true }),
    )
    await waitFor(() => expect(window.location.pathname).toBe('/data/sources/new'))
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('殻が project を替えると, データの一覧へ移る', async () => {
    stubApi()
    window.history.replaceState(null, '', '/data/datasets')
    const { rerender } = renderStage({ project: 'aaaaaaaaaaaa' })
    // 最初に受け取った値では移さない
    expect(window.location.pathname).toBe('/data/datasets')
    rerender(
      <StageApp
        basename="/data"
        apiBase="/api/data"
        project="bbbbbbbbbbbb"
        onProjectChange={() => {}}
        onProjectsChange={() => {}}
        embedded
      />,
    )
    await waitFor(() => expect(window.location.pathname).toBe('/data'))
    expect(await screen.findByText('解約の予測')).toBeInTheDocument()

    // 全てを出した印は選び直すと外れ, 一覧にいれば移さない (履歴を増やさない)
    fireEvent.click(screen.getByRole('checkbox', { name: /全てのデータを出す/ }))
    expect(screen.getByRole('checkbox', { name: /全てのデータを出す/ })).toBeChecked()
    const length = window.history.length
    rerender(
      <StageApp
        basename="/data"
        apiBase="/api/data"
        project="aaaaaaaaaaaa"
        onProjectChange={() => {}}
        onProjectsChange={() => {}}
        embedded
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /全てのデータを出す/ })).not.toBeChecked(),
    )
    expect(window.history.length).toBe(length)
    expect(window.location.pathname).toBe('/data')
  })

  it('単独では名前と明暗の切り替えを出し, 絞らない', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sources') return Response.json(SOURCES)
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', '/')
    render(
      <StageApp
        basename=""
        apiBase="/api"
        project={null}
        onProjectChange={() => {}}
        onProjectsChange={() => {}}
        embedded={false}
      />,
    )
    expect(await screen.findByRole('link', { name: '手で入れた表' })).toHaveAttribute(
      'href',
      '/sources/s3',
    )
    expect(screen.getByText('ML-Fathom')).toBeInTheDocument()
    expect(screen.queryByText('選んだ問題の設定')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '暗い表示にする' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
