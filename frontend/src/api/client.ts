import type {
  Candidate,
  DatasetSummary,
  ExportResult,
  Info,
  Listing,
  PreviewResult,
  Profile,
  Recipe,
  Rows,
  Source,
  ItemPreview,
  PointsItem,
  ProblemCheck,
  ProblemWritten,
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

export const api = {
  info: () => request<Info>('/api/info'),
  browse: (path: string) => request<Listing>(`/api/browse?path=${encodeURIComponent(path)}`),
  detect: (path: string) => request<Candidate[]>('/api/detect', json('POST', { path })),
  listSources: () => request<Source[]>('/api/sources'),
  addSamples: () => request<Source[]>('/api/samples', json('POST', {})),
  createSource: (body: { path: string; name?: string; loader?: string }) =>
    request<Source>('/api/sources', json('POST', body)),
  updateSource: (
    id: string,
    body: Partial<Pick<Source, 'name' | 'target' | 'loader' | 'options'>>,
  ) => request<Source>(`/api/sources/${id}`, json('PATCH', body)),
  deleteSource: (id: string) => request<void>(`/api/sources/${id}`, { method: 'DELETE' }),
  profile: (id: string) => request<Profile>(`/api/sources/${id}/profile`),
  rows: (
    id: string,
    params: { offset: number; limit: number; sort?: string; descending?: boolean; query?: string },
  ) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value))
    }
    return request<Rows>(`/api/sources/${id}/rows?${search.toString()}`)
  },
  itemUrl: (id: string, index: number) => `/api/sources/${id}/items/${index}`,
  item: <T>(id: string, index: number) => request<T>(`/api/sources/${id}/items/${index}`),
  captureFrameUrl: (
    id: string,
    index: number,
    frame: number,
    layer: 'image' | 'depth' | 'confidence',
    size: number,
  ) => `/api/sources/${id}/items/${index}/frames/${frame}?layer=${layer}&size=${size}`,
  captureCloud: (id: string, index: number) =>
    request<PointsItem>(`/api/sources/${id}/items/${index}/cloud`),
  recipe: (id: string) => request<Recipe>(`/api/sources/${id}/recipe`),
  saveRecipe: (id: string, recipe: Recipe) =>
    request<Recipe>(`/api/sources/${id}/recipe`, json('PUT', { recipe })),
  preview: (id: string, recipe: Recipe, upto: number) =>
    request<PreviewResult>(`/api/sources/${id}/preview`, json('POST', { recipe, upto })),
  itemPreview: (id: string, recipe: Recipe, count = 8) =>
    request<ItemPreview>(`/api/sources/${id}/item_preview`, json('POST', { recipe, count })),
  exportDataset: (id: string, recipe: Recipe, name: string, overwrite: boolean) =>
    request<ExportResult>(`/api/sources/${id}/export`, json('POST', { recipe, name, overwrite })),
  datasets: () => request<DatasetSummary[]>('/api/datasets'),
  startFromProblem: (path: string) =>
    request<{ source: Source; notes: string[] }>('/api/problems/start', json('POST', { path })),
  checkProblem: (id: string, recipe: Recipe) =>
    request<ProblemCheck>(`/api/sources/${id}/problem/check`, json('POST', { recipe })),
  writeProblem: (
    id: string,
    recipe: Recipe,
    choices: Record<string, 'known' | 'drop'>,
    version?: string,
  ) =>
    request<ProblemWritten>(
      `/api/sources/${id}/problem/write`,
      json('POST', { recipe, choices, version }),
    ),
}
