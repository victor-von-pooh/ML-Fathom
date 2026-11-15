import { useCallback, useState } from 'react'

/** ブラウザに覚える「決めた」の印の鍵 */
function storageKey(sourceId: string): string {
  return `ml-fathom:decided:${sourceId}`
}

/** データごとに決めたこと (ブラウザに覚える. 読めない環境では開いている間だけ) */
export function useDecided(sourceId: string): [ReadonlySet<string>, (id: string) => void] {
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => {
    try {
      const saved = window.localStorage.getItem(storageKey(sourceId))
      return new Set(saved ? (JSON.parse(saved) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const decide = useCallback(
    (id: string) => {
      setDecided((previous) => {
        const next = new Set(previous).add(id)
        try {
          window.localStorage.setItem(storageKey(sourceId), JSON.stringify([...next]))
        } catch {
          // 覚えられなくても, 開いている間は消す
        }
        return next
      })
    },
    [sourceId],
  )
  return [decided, decide]
}
