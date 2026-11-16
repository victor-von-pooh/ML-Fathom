import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { Recipe } from '../api/types'

const recipe: Recipe = {
  format_version: 1,
  target: 'y',
  task: 'regression',
  steps: [{ op: 'standardize', columns: 'auto' }],
  split: { method: 'random', valid: 0.2 },
}

beforeEach(() => {
  window.localStorage.clear()
  vi.resetModules()
})

test('編集中のレシピは, 読み込み直しても (モジュールを読み直しても) 残る', async () => {
  const first = await import('./drafts')
  const { result } = renderHook(() => first.useRecipeDraft('a'))
  act(() => result.current[1](recipe))
  expect(result.current[0]).toEqual(recipe)

  // 読み込み直した後
  vi.resetModules()
  const again = await import('./drafts')
  const reloaded = renderHook(() => again.useRecipeDraft('a'))
  expect(reloaded.result.current[0]).toEqual(recipe)
  // 別のデータには無い
  expect(renderHook(() => again.useRecipeDraft('b')).result.current[0]).toBeNull()

  // 捨てると, 読み込み直しても無い
  act(() => again.clearDraft('a'))
  vi.resetModules()
  const last = await import('./drafts')
  expect(renderHook(() => last.useRecipeDraft('a')).result.current[0]).toBeNull()
})

test('形の違う覚えた値は捨てる', async () => {
  window.localStorage.setItem('ml-fathom:draft:x', '{"steps": "no"}')
  const drafts = await import('./drafts')
  expect(renderHook(() => drafts.useRecipeDraft('x')).result.current[0]).toBeNull()
})

test('別のタブで変えた編集中のレシピを読み直す', async () => {
  const drafts = await import('./drafts')
  const { result } = renderHook(() => drafts.useRecipeDraft('t'))
  act(() => result.current[1](recipe))
  // 別のタブが保存して編集中のレシピを消した
  act(() => {
    window.localStorage.removeItem('ml-fathom:draft:t')
    window.dispatchEvent(new StorageEvent('storage', { key: 'ml-fathom:draft:t' }))
  })
  expect(result.current[0]).toBeNull()
})
