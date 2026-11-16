import { useCallback, useSyncExternalStore } from 'react'

import type { Recipe } from '../api/types'

// データごとの編集中のレシピ (タブを移っても, 目的の列を変えても, ページを
// 読み込み直しても消さない. ブラウザに覚え, 読めない環境では開いている間だけ)
const drafts = new Map<string, Recipe | null>()
const listeners = new Set<() => void>()

/** ブラウザに覚える鍵 */
function storageKey(id: string): string {
  return `ml-fathom:draft:${id}`
}

/** 覚えた編集中のレシピを読む (形が違うものは捨てる) */
function load(id: string): Recipe | null {
  try {
    const text = window.localStorage.getItem(storageKey(id))
    if (!text) return null
    const value = JSON.parse(text) as unknown
    if (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as Recipe).steps) &&
      typeof (value as Recipe).split === 'object'
    ) {
      return value as Recipe
    }
  } catch {
    // 読めなければ編集中のレシピは無し
  }
  return null
}

/** 編集中のレシピを覚える (null で消す) */
function store(id: string, recipe: Recipe | null): void {
  try {
    if (recipe) window.localStorage.setItem(storageKey(id), JSON.stringify(recipe))
    else window.localStorage.removeItem(storageKey(id))
  } catch {
    // 覚えられなくても, 開いている間は残る
  }
}

/** 編集中のレシピ (初めて見るデータはブラウザに覚えたものから) */
function get(id: string): Recipe | null {
  if (!drafts.has(id)) drafts.set(id, load(id))
  return drafts.get(id) ?? null
}

// 別のタブで変えた (保存した, 読み方を変えた) 編集中のレシピは, 覚えたもの
// から読み直す (古いレシピで上書きしないように)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    const prefix = storageKey('')
    if (event.key === null) drafts.clear()
    else if (event.key.startsWith(prefix)) drafts.delete(event.key.slice(prefix.length))
    else return
    listeners.forEach((listener) => listener())
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** データの編集中のレシピと, それを変える関数 (null で編集をやめる) */
export function useRecipeDraft(id: string): [Recipe | null, (recipe: Recipe | null) => void] {
  const draft = useSyncExternalStore(subscribe, () => get(id))
  const setDraft = useCallback(
    (recipe: Recipe | null) => {
      drafts.set(id, recipe)
      store(id, recipe)
      listeners.forEach((listener) => listener())
    },
    [id],
  )
  return [draft, setDraft]
}

/** データの編集中のレシピを捨てる (読み方を変えて手順が合わなくなった場合) */
export function clearDraft(id: string): void {
  drafts.set(id, null)
  store(id, null)
  listeners.forEach((listener) => listener())
}
