import { useCallback, useSyncExternalStore } from 'react'

import type { Recipe } from '../api/types'

// データごとの編集中のレシピ (タブを移っても, 目的の列を変えても消さない)
const drafts = new Map<string, Recipe>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** データの編集中のレシピと, それを変える関数 (null で編集をやめる) */
export function useRecipeDraft(id: string): [Recipe | null, (recipe: Recipe | null) => void] {
  const draft = useSyncExternalStore(subscribe, () => drafts.get(id) ?? null)
  const setDraft = useCallback(
    (recipe: Recipe | null) => {
      if (recipe) drafts.set(id, recipe)
      else drafts.delete(id)
      listeners.forEach((listener) => listener())
    },
    [id],
  )
  return [draft, setDraft]
}
