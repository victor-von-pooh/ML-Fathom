// ファイルの組の書き出しの項目ごとの中身の手順 (ML-EDA の版 2 の書き出しの item_steps)
import type { PairStepInfo, RecipeStep } from '../api/types'

/** 欄で組み立て中の手順 (引数は入れた文字のまま) */
export interface StepDraft {
  op: string
  values: Record<string, string>
}

/** 項目の名前から組み立て中の手順の並び */
export type EntryDrafts = Record<string, StepDraft[]>

/** 0 から始められる引数 (他の引数は 1 以上. ML-EDA の書き出しと同じ) */
const ZERO_PARAMS = ['seed']

/**
 * 組み立て中の手順を, 書き出しに渡す手順にする. 誤りがあれば理由の並び.
 * 引数は全て整数 (大きさ, 点の数, 乱数の種). 空の引数は省く
 */
export function stepsBody(
  drafts: StepDraft[],
  infos: PairStepInfo[],
  label: string,
): { value: RecipeStep[]; errors: string[] } {
  const errors: string[] = []
  const value: RecipeStep[] = []
  drafts.forEach((draft, index) => {
    const info = infos.find((item) => item.op === draft.op)
    const where = `${label}の手順 ${index + 1} (${draft.op})`
    if (!info) {
      errors.push(`${where} はこの項目に使えません`)
      return
    }
    const step: RecipeStep = { op: draft.op }
    for (const name of Object.keys(info.params)) {
      const text = (draft.values[name] ?? '').trim()
      if (text === '') {
        if (info.required.includes(name)) errors.push(`${where} の ${name} を入れてください`)
        continue
      }
      const number = Number(text)
      const lowest = ZERO_PARAMS.includes(name) ? 0 : 1
      if (!Number.isInteger(number) || number < lowest) {
        errors.push(`${where} の ${name} は ${lowest} 以上の整数にしてください`)
        continue
      }
      const highest: number | undefined = info.limits[name]
      if (highest !== undefined && number > highest) {
        errors.push(`${where} の ${name} は ${highest} 以下にしてください`)
        continue
      }
      step[name] = number
    }
    value.push(step)
  })
  return { value, errors }
}

/**
 * 項目ごとの組み立て中の手順を, 書き出しの item_steps にする.
 * 手順が 1 つも無ければ undefined (版 2 のまま書き出す)
 */
export function itemStepsBody(
  drafts: EntryDrafts,
  infos: Record<string, PairStepInfo[]>,
  labels: Record<string, string>,
): { value: Record<string, RecipeStep[]> | undefined; errors: string[] } {
  const errors: string[] = []
  const steps: Record<string, RecipeStep[]> = {}
  for (const [entry, list] of Object.entries(drafts)) {
    if (list.length === 0) continue
    const built = stepsBody(list, infos[entry] ?? [], labels[entry] ?? entry)
    errors.push(...built.errors)
    steps[entry] = built.value
  }
  const value = Object.keys(steps).length > 0 ? steps : undefined
  return { value, errors }
}

/**
 * 書き出しの item_steps を, 欄で組み立て中の手順にする (開き直したときに欄を埋めるため).
 * 名前の項目は全て並べ (無ければ空), 引数は文字にする
 */
export function itemStepsDrafts(
  steps: Record<string, RecipeStep[]> | undefined,
  entries: string[],
): EntryDrafts {
  const drafts: EntryDrafts = {}
  for (const entry of entries) {
    drafts[entry] = (steps?.[entry] ?? []).map((step) => {
      const values: Record<string, string> = {}
      for (const [name, value] of Object.entries(step)) {
        if (name !== 'op') values[name] = String(value)
      }
      return { op: step.op, values }
    })
  }
  return drafts
}

/** 手順を 1 行の文にする (`resize (width 64, height 64)`) */
export function stepText(step: RecipeStep): string {
  const params = Object.entries(step)
    .filter(([name]) => name !== 'op')
    .map(([name, value]) => `${name} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return params.length > 0 ? `${step.op} (${params.join(', ')})` : step.op
}
