import { afterEach, expect, test, vi } from 'vitest'

import { ApiError, request } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 誤りの応答を 1 つ返す fetch に差し替える */
function respond(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  )
}

test('入力の検証の誤り (422) は欄ごとに 1 行の文にする', async () => {
  respond(
    Response.json(
      { detail: [{ loc: ['body', 'path'], msg: 'Field required' }] },
      { status: 422, statusText: 'Unprocessable Entity' },
    ),
  )
  const error = await request('/api/sources').catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).status).toBe(422)
  expect((error as ApiError).message).toBe('path: Field required')
})

test('画面の文 message を持つ形はその文, 本文が JSON でなければ状態の番号と文', async () => {
  respond(Response.json({ detail: { message: '問題が他で変わりました' } }, { status: 409 }))
  await expect(request('/api/x')).rejects.toThrow('問題が他で変わりました')
  respond(new Response('oops', { status: 502, statusText: 'Bad Gateway' }))
  await expect(request('/api/x')).rejects.toThrow('502 Bad Gateway')
})
