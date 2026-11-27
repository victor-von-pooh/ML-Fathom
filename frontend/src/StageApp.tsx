import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter, useNavigate } from 'react-router'

import { App } from './App'
import { ApiContext, ApiError, createApi } from './api/client'
import { StageContext, type StageValue } from './lib/stage'
import { ThemeProvider } from './lib/theme'

/** データの分析の段階の画面の根の部品の props (殻と単独で同じ形) */
export interface StageAppProps {
  /** 画面の経路の頭 (例 `/data`). 単独では `""` */
  basename: string
  /** API の頭 (例 `/api/data`). 単独では `/api` */
  apiBase: string
  /** 殻で選んだ問題の設定の識別子. null は選んでいない (一覧を絞らない) */
  project: string | null
  /** 部品の中で置き場の問題の設定から始めたときに, その識別子で呼ぶ */
  onProjectChange: (project: string | null) => void
  /** 問題の設定の一覧が変わったときに呼ぶ (このアプリは一覧を変えないので呼ばない) */
  onProjectsChange: () => void
  /** 殻の下に載せたか (アプリの名前と明暗の切り替えを出さず, 明暗は読むだけにする) */
  embedded: boolean
}

/** 部品ごとの TanStack Query の client */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // 誤りの応答などの利用者側のエラーは繰り返さない
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
      },
    },
  })
}

/**
 * 殻が project を替えたら, データの一覧に移す
 *
 * 最初に受け取った値と, 部品が知らせた値が返ってきたときは移さない (開いた URL と,
 * 始めた後のデータの画面に留まるため)
 */
function FollowProject({
  project,
  reportedBack,
}: {
  project: string | null
  /** 部品が知らせた値が返ってきたか (読むと知らせた値を忘れる) */
  reportedBack: (project: string | null) => boolean
}) {
  const navigate = useNavigate()
  // 前に合わせた値 (undefined はまだ合わせていない. StrictMode の 2 度の実行でも 1 度だけ移す)
  const followed = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (followed.current === project) return
    const first = followed.current === undefined
    followed.current = project
    const own = reportedBack(project)
    if (first || own) return
    void navigate('/')
  }, [project, reportedBack, navigate])
  return null
}

/**
 * データの分析の段階の画面の根の部品
 *
 * 自分のルーター (basename の下) と TanStack Query の client を持つ. 単独では main.tsx が
 * 既定の値 (basename `""`, apiBase `/api`, project null, embedded false) で描く
 */
export function StageApp({ basename, apiBase, project, onProjectChange, embedded }: StageAppProps) {
  const [queryClient] = useState(makeQueryClient)
  const api = useMemo(() => createApi(apiBase), [apiBase])
  // 部品が殻に知らせた値 (返ってきたときに一覧へ移さないため)
  const reported = useRef<string | null | undefined>(undefined)
  const report = useCallback(
    (next: string | null) => {
      reported.current = next
      onProjectChange(next)
    },
    [onProjectChange],
  )
  const reportedBack = useCallback((next: string | null) => {
    const own = reported.current === next
    reported.current = undefined
    return own
  }, [])
  const stage = useMemo<StageValue>(
    () => ({ project, onProjectChange: report, embedded }),
    [project, report, embedded],
  )
  return (
    <ThemeProvider readOnly={embedded}>
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={api}>
          <StageContext.Provider value={stage}>
            <BrowserRouter basename={basename}>
              <FollowProject project={project} reportedBack={reportedBack} />
              <App />
            </BrowserRouter>
          </StageContext.Provider>
        </ApiContext.Provider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
