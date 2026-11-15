import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings2 } from 'lucide-react'
import { useState } from 'react'
import YAML from 'yaml'

import { api } from '../../api/client'
import type { LoaderInfo, Source } from '../../api/types'
import { Button, ErrorBox } from '../../components/ui'
import { clearDraft } from '../../lib/drafts'

// 「読み方」で選ぶ設定 (ここでは出さない)
const READ_AS = new Set(['kind', 'time_column', 'text_column'])

/** 入力の文字を値にする (数や null は YAML として読む. 空は省略) */
function toValue(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    const value: unknown = YAML.parse(text)
    return typeof value === 'object' && value !== null ? text : value
  } catch {
    return text
  }
}

/** 読み込みの設定 (Excel のシート, 区切り文字, 文字コードなど) を変える */
export function LoaderOptions({ source, loader }: { source: Source; loader?: LoaderInfo }) {
  const queryClient = useQueryClient()
  const keys = Object.keys(loader?.options ?? {}).filter((key) => !READ_AS.has(key))
  const initial = Object.fromEntries(
    keys.map((key) => {
      const value = source.options[key]
      return [key, value === undefined ? '' : String(value)]
    }),
  )
  const [open, setOpen] = useState(false)
  const [texts, setTexts] = useState<Record<string, string>>(initial)
  const save = useMutation({
    mutationFn: () => {
      // 空の欄は設定から外す (読み込みが推定する)
      const options: Record<string, unknown> = { ...source.options }
      for (const key of keys) {
        const value = toValue(texts[key] ?? '')
        if (value === undefined) delete options[key]
        else options[key] = value
      }
      return api.updateSource(source.id, { options })
    },
    onSuccess: () => {
      clearDraft(source.id)
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'sources' || query.queryKey[1] === source.id,
      })
      setOpen(false)
    },
  })
  if (keys.length === 0) return null
  return (
    <div className="relative">
      <Button
        icon={Settings2}
        aria-expanded={open}
        aria-controls={`loader-options-${source.id}`}
        onClick={() => {
          setTexts(initial)
          setOpen(!open)
        }}
      >
        読み込みの設定
      </Button>
      {open && (
        <form
          id={`loader-options-${source.id}`}
          aria-label="読み込みの設定"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
          className="absolute right-0 z-20 mt-1 w-96 space-y-2 rounded-xl border border-line bg-surface p-3 shadow-lg"
        >
          <p className="text-xs text-ink-3">
            {loader?.name} の読み込みの設定. 空の欄は読み込みが推定します.
          </p>
          {keys.map((key) => (
            <label key={key} className="grid grid-cols-[6rem_1fr] items-start gap-2 text-sm">
              <span className="pt-1 font-mono text-xs">{key}</span>
              <span>
                <input
                  value={texts[key] ?? ''}
                  onChange={(event) => setTexts({ ...texts, [key]: event.target.value })}
                  className="h-8 w-full rounded border border-line bg-surface px-2 font-mono text-sm"
                />
                <span className="text-xs text-ink-3">{loader?.options[key]}</span>
              </span>
            </label>
          ))}
          {save.error && <ErrorBox error={save.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>
              やめる
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              読み直す
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
