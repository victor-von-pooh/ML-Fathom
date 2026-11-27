import { createContext, useContext } from 'react'

import type {
  Candidate,
  CaptureCloudExport,
  DatasetSummary,
  ExportResult,
  GroupCheck,
  GroupChoice,
  GroupExport,
  GroupProblem,
  GroupProjectResult,
  GroupRequest,
  GroupSummary,
  GroupWritten,
  ImageMaskExport,
  Info,
  Listing,
  PairExportResult,
  PreviewResult,
  Profile,
  Recipe,
  Rows,
  Source,
  ItemPreview,
  PointsItem,
  ProblemCheck,
  ProblemList,
  ProblemPairs,
  ProblemPairsResult,
  ProblemStarted,
  ProblemWritten,
  PairSettings,
  ProjectPlace,
  PriceRequest,
  PriceSummary,
  DemandRequest,
  DemandSummary,
  ReactionsExportResult,
  ReactionsResult,
  TrajectorySummary,
  UpliftRequest,
  UpliftSummary,
} from './types'

/** API がエラーを返したときの例外 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** エラーのレスポンスから表示する文を取り出す */
async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'detail' in body) {
      const detail = (body as { detail: unknown }).detail
      if (typeof detail === 'string') return detail
      return JSON.stringify(detail)
    }
  } catch {
    // JSON でない場合は状態の文を使う
  }
  return `${response.status} ${response.statusText}`
}

/** JSON の API を呼ぶ */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    throw new ApiError(response.status, await readError(response))
  }
  // 中身の無い応答 (消した場合の 204) は undefined
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
})

/**
 * API の頭 (単独では `/api`, 殻の下では `/api/data` など) の下に送る呼び出しの一式を作る
 *
 * @param base - API の頭 (末尾の `/` は無し)
 */
export function createApi(base: string) {
  return {
    info: () => request<Info>(`${base}/info`),
    browse: (path: string) => request<Listing>(`${base}/browse?path=${encodeURIComponent(path)}`),
    detect: (path: string) => request<Candidate[]>(`${base}/detect`, json('POST', { path })),
    listSources: () => request<Source[]>(`${base}/sources`),
    addSamples: () => request<Source[]>(`${base}/samples`, json('POST', {})),
    createSource: (body: { path: string; name?: string; loader?: string }) =>
      request<Source>(`${base}/sources`, json('POST', body)),
    updateSource: (
      id: string,
      body: Partial<Pick<Source, 'name' | 'target' | 'loader' | 'options'>>,
    ) => request<Source>(`${base}/sources/${id}`, json('PATCH', body)),
    deleteSource: (id: string) => request<void>(`${base}/sources/${id}`, { method: 'DELETE' }),
    profile: (id: string, task?: 'anomaly') =>
      request<Profile>(`${base}/sources/${id}/profile${task ? `?task=${task}` : ''}`),
    trajectory: (id: string) => request<TrajectorySummary>(`${base}/sources/${id}/trajectory`),
    reactions: (id: string) => request<ReactionsResult>(`${base}/sources/${id}/reactions`),
    exportReactions: (id: string, overwrite: boolean) =>
      request<ReactionsExportResult>(
        `${base}/sources/${id}/export_reactions`,
        json('POST', { overwrite }),
      ),
    uplift: (id: string, body: UpliftRequest) =>
      request<UpliftSummary>(`${base}/sources/${id}/uplift`, json('POST', body)),
    price: (id: string, body: PriceRequest) =>
      request<PriceSummary>(`${base}/sources/${id}/price`, json('POST', body)),
    demand: (id: string, body: DemandRequest) =>
      request<DemandSummary>(`${base}/sources/${id}/demand`, json('POST', body)),
    groups: (id: string, body: GroupRequest) =>
      request<GroupSummary>(`${base}/sources/${id}/groups`, json('POST', body)),
    exportGroups: (id: string, body: GroupExport) =>
      request<PairExportResult>(`${base}/sources/${id}/export_groups`, json('POST', body)),
    groupProblem: (id: string) => request<GroupProblem>(`${base}/sources/${id}/group_problem`),
    checkGroupProblem: (id: string, group: GroupChoice) =>
      request<GroupCheck>(`${base}/sources/${id}/group_problem/check`, json('POST', { group })),
    writeGroupProblem: (id: string, group: GroupChoice, version: string) =>
      request<GroupWritten>(
        `${base}/sources/${id}/group_problem/write`,
        json('POST', { group, version }),
      ),
    exportGroupProject: (id: string, overwrite: boolean) =>
      request<GroupProjectResult>(
        `${base}/sources/${id}/export_group_project`,
        json('POST', { overwrite }),
      ),
    rows: (
      id: string,
      params: {
        offset: number
        limit: number
        sort?: string
        descending?: boolean
        query?: string
      },
    ) => {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') search.set(key, String(value))
      }
      return request<Rows>(`${base}/sources/${id}/rows?${search.toString()}`)
    },
    itemUrl: (id: string, index: number) => `${base}/sources/${id}/items/${index}`,
    item: <T>(id: string, index: number) => request<T>(`${base}/sources/${id}/items/${index}`),
    itemAudioUrl: (id: string, index: number) => `${base}/sources/${id}/items/${index}/audio`,
    captureFrameUrl: (
      id: string,
      index: number,
      frame: number,
      layer: 'image' | 'depth' | 'confidence',
      size: number,
    ) => `${base}/sources/${id}/items/${index}/frames/${frame}?layer=${layer}&size=${size}`,
    captureCloud: (id: string, index: number) =>
      request<PointsItem>(`${base}/sources/${id}/items/${index}/cloud`),
    recipe: (id: string) => request<Recipe>(`${base}/sources/${id}/recipe`),
    saveRecipe: (id: string, recipe: Recipe) =>
      request<Recipe>(`${base}/sources/${id}/recipe`, json('PUT', { recipe })),
    preview: (id: string, recipe: Recipe, upto: number) =>
      request<PreviewResult>(`${base}/sources/${id}/preview`, json('POST', { recipe, upto })),
    itemPreview: (id: string, recipe: Recipe, count = 8) =>
      request<ItemPreview>(`${base}/sources/${id}/item_preview`, json('POST', { recipe, count })),
    exportDataset: (id: string, recipe: Recipe, name: string, overwrite: boolean) =>
      request<ExportResult>(
        `${base}/sources/${id}/export`,
        json('POST', { recipe, name, overwrite }),
      ),
    datasets: () => request<DatasetSummary[]>(`${base}/datasets`),
    exportImageMasks: (body: ImageMaskExport) =>
      request<PairExportResult>(`${base}/datasets/image_masks`, json('POST', body)),
    exportCaptureClouds: (body: CaptureCloudExport) =>
      request<PairExportResult>(`${base}/datasets/capture_clouds`, json('POST', body)),
    problems: () => request<ProblemList>(`${base}/problems`),
    project: (id: string) => request<ProjectPlace>(`${base}/sources/${id}/project`),
    exportProject: (id: string, recipe: Recipe, overwrite: boolean) =>
      request<ExportResult>(
        `${base}/sources/${id}/export_project`,
        json('POST', { recipe, overwrite }),
      ),
    startFromProblem: (path: string) =>
      request<ProblemStarted>(`${base}/problems/start`, json('POST', { path })),
    problemPairs: (path: string) =>
      request<ProblemPairs>(`${base}/problems/pairs?path=${encodeURIComponent(path)}`),
    exportProblemPairs: (body: {
      path: string
      version: string
      export: PairSettings
      overwrite: boolean
      /** 外を指すリンクの先も写すか (問題の設定には書き戻さない) */
      follow_links: boolean
    }) => request<ProblemPairsResult>(`${base}/problems/pairs/export`, json('POST', body)),
    checkProblem: (id: string, recipe: Recipe) =>
      request<ProblemCheck>(`${base}/sources/${id}/problem/check`, json('POST', { recipe })),
    writeProblem: (
      id: string,
      recipe: Recipe,
      choices: Record<string, 'known' | 'drop'>,
      version?: string,
    ) =>
      request<ProblemWritten>(
        `${base}/sources/${id}/problem/write`,
        json('POST', { recipe, choices, version }),
      ),
  }
}

/** 呼び出しの一式の型 */
export type Api = ReturnType<typeof createApi>

/** 単独の頭 `/api` の一式 (根の部品の外の既定. 画面の部品は useApi を使う) */
export const api: Api = createApi('/api')

/** 根の部品が決めた呼び出しの一式 (部品の外では単独の頭 `/api`) */
export const ApiContext = createContext<Api>(api)

/** 根の部品が決めた API の頭の下に送る呼び出しの一式を使う */
export function useApi(): Api {
  return useContext(ApiContext)
}
