import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { PairStepInfo } from '../../api/types'
import { Button } from '../../components/common'
import type { StepDraft } from '../../lib/entrySteps'

/**
 * 1 つの項目にかける中身の手順の欄. 選べる手順は ML-EDA の登録簿を項目の種類で絞ったもの.
 * 手順は足した順にかける
 */
export function EntryStepsField({
  id,
  label,
  infos,
  drafts,
  onChange,
}: {
  /** 欄の id の頭 */
  id: string
  /** 項目の呼び名 (画像, 撮影, 点群) */
  label: string
  infos: PairStepInfo[]
  drafts: StepDraft[]
  onChange: (drafts: StepDraft[]) => void
}) {
  const [adding, setAdding] = useState('')
  const setValue = (index: number, name: string, text: string) =>
    onChange(
      drafts.map((draft, at) =>
        at === index ? { ...draft, values: { ...draft.values, [name]: text } } : draft,
      ),
    )
  return (
    <div className="space-y-2">
      {drafts.length === 0 && (
        <p className="text-xs text-ink-3">手順なし (ファイルをそのまま写す)</p>
      )}
      <ol className="space-y-2" aria-label={`${label}の中身の手順`}>
        {drafts.map((draft, index) => {
          const info = infos.find((item) => item.op === draft.op)
          return (
            <li key={`${index}-${draft.op}`} className="rounded border border-line p-2">
              <div className="flex items-center gap-2">
                <span className="tabular-nums rounded-full bg-surface-2 px-2 text-xs">
                  {index + 1}
                </span>
                <code className="text-sm font-semibold">{draft.op}</code>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-3">
                  {info?.description}
                </span>
                <Button
                  variant="ghost"
                  aria-label={`${label}の手順 ${index + 1} を消す`}
                  onClick={() => onChange(drafts.filter((_, at) => at !== index))}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              {Object.entries(info?.params ?? {}).map(([name, description]) => {
                const field = `${id}-${index}-${name}`
                const required = info?.required.includes(name)
                return (
                  <div key={name} className="mt-1 grid grid-cols-[5rem_1fr] items-center gap-2">
                    <label htmlFor={field} className="font-mono text-xs text-ink-2">
                      {name}
                    </label>
                    <input
                      id={field}
                      value={draft.values[name] ?? ''}
                      inputMode="numeric"
                      aria-label={`${label}の手順 ${index + 1} の ${name}`}
                      placeholder={required ? `${description} (必須)` : `${description} (任意)`}
                      onChange={(event) => setValue(index, name, event.target.value)}
                      className="h-7 rounded border border-line bg-surface px-2 font-mono text-xs"
                    />
                  </div>
                )
              })}
            </li>
          )
        })}
      </ol>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`${id}-add`}>
          {`${label}に足す中身の手順`}
        </label>
        <select
          id={`${id}-add`}
          value={adding}
          onChange={(event) => setAdding(event.target.value)}
          className="h-8 w-0 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-sm"
        >
          <option value="">足す手順を選ぶ…</option>
          {infos.map((item) => (
            <option key={item.op} value={item.op}>
              {item.op} — {item.description}
            </option>
          ))}
        </select>
        <Button
          icon={Plus}
          disabled={!adding}
          aria-label={`${label}に手順を足す`}
          onClick={() => {
            onChange([...drafts, { op: adding, values: {} }])
            setAdding('')
          }}
        >
          足す
        </Button>
      </div>
    </div>
  )
}
