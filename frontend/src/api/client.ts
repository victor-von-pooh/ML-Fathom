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
  ReactionsExportResult,
  ReactionsResult,
  TrajectorySummary,
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
  trajectory: (id: string) => request<TrajectorySummary>(`/api/sources/${id}/trajectory`),
  reactions: (id: string) => request<ReactionsResult>(`/api/sources/${id}/reactions`),
  exportReactions: (id: string, overwrite: boolean) =>
    request<ReactionsExportResult>(
      `/api/sources/${id}/export_reactions`,
      json('POST', { overwrite }),
    ),
  groups: (id: string, body: GroupRequest) =>
    request<GroupSummary>(`/api/sources/${id}/groups`, json('POST', body)),
  exportGroups: (id: string, body: GroupExport) =>
    request<PairExportResult>(`/api/sources/${id}/export_groups`, json('POST', body)),
  groupProblem: (id: string) => request<GroupProblem>(`/api/sources/${id}/group_problem`),
  checkGroupProblem: (id: string, group: GroupChoice) =>
    request<GroupCheck>(`/api/sources/${id}/group_problem/check`, json('POST', { group })),
  writeGroupProblem: (id: string, group: GroupChoice, version: string) =>
    request<GroupWritten>(
      `/api/sources/${id}/group_problem/write`,
      json('POST', { group, version }),
    ),
  exportGroupProject: (id: string, overwrite: boolean) =>
    request<GroupProjectResult>(
      `/api/sources/${id}/export_group_project`,
      json('POST', { overwrite }),
    ),
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
  itemAudioUrl: (id: string, index: number) => `/api/sources/${id}/items/${index}/audio`,
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
  exportImageMasks: (body: ImageMaskExport) =>
    request<PairExportResult>('/api/datasets/image_masks', json('POST', body)),
  exportCaptureClouds: (body: CaptureCloudExport) =>
    request<PairExportResult>('/api/datasets/capture_clouds', json('POST', body)),
  problems: () => request<ProblemList>('/api/problems'),
  project: (id: string) => request<ProjectPlace>(`/api/sources/${id}/project`),
  exportProject: (id: string, recipe: Recipe, overwrite: boolean) =>
    request<ExportResult>(`/api/sources/${id}/export_project`, json('POST', { recipe, overwrite })),
  startFromProblem: (path: string) =>
    request<ProblemStarted>('/api/problems/start', json('POST', { path })),
  problemPairs: (path: string) =>
    request<ProblemPairs>(`/api/problems/pairs?path=${encodeURIComponent(path)}`),
  exportProblemPairs: (body: {
    path: string
    version: string
    export: PairSettings
    overwrite: boolean
  }) => request<ProblemPairsResult>('/api/problems/pairs/export', json('POST', body)),
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
