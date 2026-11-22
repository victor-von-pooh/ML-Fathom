import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'

import { api } from '../../api/client'
import type { LoaderInfo, Source } from '../../api/types'
import { Button, ErrorBox } from '../../components/ui'
import { clearDraft } from '../../lib/drafts'

// 「読み方」で選ぶ設定 (ここでは出さない)
const READ_AS = new Set(['kind', 'time_column', 'text_column'])

// 整数と null を値として読む設定 (それ以外は書いたとおりの文字)
const NUMERIC = new Set(['header', 'sheet'])

// 真偽を選ぶ設定 (空は読み込みの既定. 取り違えた文字を送らないように選ばせる)
const BOOLEAN = new Set(['digest', 'follow_links'])

// 真と読む文字 (ML-EDA の読み込みと同じ. 大文字と小文字, 前後の空白は区別しない)
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on'])

/** 保存した値を欄の文字にする (並びや辞書は JSON. 真偽の設定は true か false) */
function toText(key: string, value: unknown): string {
  if (value === undefined) return ''
  if (BOOLEAN.has(key) && typeof value !== 'object') {
    const word = String(value).trim().toLowerCase()
    if (word === '') return ''
    return value === true || TRUE_WORDS.has(word) ? 'true' : 'false'
  }
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 欄の文字を値にする (空は省略. 区切り文字の \t はタブ. sheets はシートの名前) */
function toValue(key: string, text: string, previous: unknown, sheets: string[]): unknown {
  if (text === '') return undefined
  if (BOOLEAN.has(key)) return text === 'true'
  if (typeof previous === 'object' && previous !== null) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  // 数の名前のシート (2020 など) は名前のまま
  if (key === 'sheet' && sheets.includes(text)) return text
  if (NUMERIC.has(key)) {
    if (text.trim() === 'null') return null
    if (/^-?\d+$/.test(text.trim())) return Number(text.trim())
    return text
  }
  if (key === 'sep') return text.replace(/\\t/g, '\t')
  return text
}

/** 読み込みの設定 (Excel のシート, 区切り文字, 文字コードなど) を変える */
export function LoaderOptions({
  source,
  loader,
  sheets = [],
}: {
  source: Source
  loader?: LoaderInfo
  /** Excel のシートの名前 (分析の概要から. 数の名前のシートを番号と取り違えない) */
  sheets?: string[]
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const keys = Object.keys(loader?.options ?? {}).filter((key) => !READ_AS.has(key))
  const initial = Object.fromEntries(keys.map((key) => [key, toText(key, source.options[key])]))
  const [open, setOpen] = useState(false)
  const [texts, setTexts] = useState<Record<string, string>>(initial)
  const close = () => {
    setOpen(false)
    // 閉じたら設定を開くボタンに戻る
    box.current?.querySelector('button')?.focus()
  }
  const save = useMutation({
    mutationFn: () => {
      // 変えた欄だけを書き換え, 空にした欄は設定から外す (読み込みの既定)
      const options: Record<string, unknown> = { ...source.options }
      for (const key of keys) {
        if (texts[key] === initial[key]) continue
        const value = toValue(key, texts[key] ?? '', source.options[key], sheets)
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
      close()
    },
  })
  if (keys.length === 0) return null
  return (
    <div ref={box} className="relative">
      <Button
        icon={Settings2}
        aria-expanded={open}
        aria-controls={`${id}-form`}
        onClick={() => {
          setTexts(initial)
          save.reset()
          setOpen(!open)
        }}
      >
        読み込みの設定
      </Button>
      {open && (
        <form
          id={`${id}-form`}
          aria-label="読み込みの設定"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
          className="absolute left-0 z-20 mt-1 w-[min(24rem,calc(100vw-2rem))] space-y-2 rounded-xl border border-line bg-surface p-3 shadow-lg sm:right-0 sm:left-auto"
        >
          <p className="text-xs text-ink-3">
            {loader?.name} の読み込みの設定. 空の欄は読み込みの既定 (推定か最初のシートなど).
            区切り文字のタブは \t, シートの番号は数 (0 が最初), 数の名前のシートは名前のまま.
          </p>
          {keys.map((key, index) => (
            <div key={key} className="grid grid-cols-[6rem_1fr] items-start gap-2 text-sm">
              <label htmlFor={`${id}-${key}`} className="pt-1 font-mono text-xs">
                {key}
              </label>
              <span>
                {BOOLEAN.has(key) ? (
                  <select
                    id={`${id}-${key}`}
                    value={texts[key] ?? ''}
                    autoFocus={index === 0}
                    aria-describedby={`${id}-${key}-help`}
                    onChange={(event) => setTexts({ ...texts, [key]: event.target.value })}
                    className="h-8 w-full rounded border border-line bg-surface px-2 font-mono text-sm"
                  >
                    <option value="">既定</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    id={`${id}-${key}`}
                    value={texts[key] ?? ''}
                    autoFocus={index === 0}
                    aria-describedby={`${id}-${key}-help`}
                    onChange={(event) => setTexts({ ...texts, [key]: event.target.value })}
                    className="h-8 w-full rounded border border-line bg-surface px-2 font-mono text-sm"
                  />
                )}
                <span id={`${id}-${key}-help`} className="text-xs text-ink-3">
                  {loader?.options[key]}
                </span>
              </span>
            </div>
          ))}
          {save.error && <ErrorBox error={save.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={close}>
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
