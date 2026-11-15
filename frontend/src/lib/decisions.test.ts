import { describe, expect, test } from 'vitest'

import type { ColumnInfo, Finding, Profile, Recipe } from '../api/types'
import { findDecisions } from './decisions'
import { autoItemSteps } from './suggest'

/** 分析の結果の列の情報を作る */
function column(type: string): ColumnInfo {
  return { type, dtype: 'str', count: 10, missing: 0, missing_ratio: 0, unique: 3 }
}

/** 分析の結果を作る */
function profileOf(
  columns: Record<string, ColumnInfo>,
  findings: Finding[] = [],
  extra: Partial<Profile> = {},
): Profile {
  return {
    columns,
    findings,
    overview: { roles: {} },
    ...extra,
  } as unknown as Profile
}

const recipe: Recipe = {
  format_version: 1,
  target: null,
  task: 'classification',
  steps: [],
  split: { method: 'random', valid: 0.2 },
}

/** 決めてほしいことの ID の並び */
function ids(...args: Parameters<typeof findDecisions>): string[] {
  return findDecisions(...args).map((item) => item.id)
}

const base = { kind: 'table', loader: 'csv', options: {}, decided: new Set<string>() }

describe('決めてほしいこと', () => {
  test('目的の列が無ければ, よくある名前の列を先に候補にする', () => {
    const profile = profileOf({
      id: column('id'),
      age: column('numeric'),
      label: column('categorical'),
    })
    const [decision] = findDecisions({ ...base, profile, recipe, target: null })
    expect(decision!.id).toBe('target')
    expect(decision!.choices[0]).toMatchObject({
      label: 'label',
      primary: true,
      action: { kind: 'source', target: 'label' },
    })
    expect(decision!.choices.map((choice) => choice.label)).not.toContain('id')
    // 決めたものは出さない
    expect(ids({ ...base, profile, recipe, target: null, decided: new Set(['target']) })).toEqual(
      [],
    )
  })

  test('表の中の文の列は, 文として読むかを聞く (他の読み方の設定は外す)', () => {
    const profile = profileOf({ review: column('text'), label: column('categorical') })
    const options = { encoding: 'cp932', time_column: 'posted' }
    const [decision] = findDecisions({ ...base, options, profile, recipe, target: 'label' })
    expect(decision!.id).toBe('text_column:review')
    expect(decision!.choices[0]!.action).toEqual({
      kind: 'source',
      options: { encoding: 'cp932', text_column: 'review' },
    })
    // 読み方を選べない読み込みでは聞かない
    expect(ids({ ...base, loader: 'npy', profile, recipe, target: 'label' })).toEqual([])
  })

  test('リークの疑いの列は, 落とすか残すかをレシピに反映する', () => {
    const findings: Finding[] = [
      { severity: 'warning', code: 'target_leak', message: '列 a は…', columns: ['a', 'y'] },
    ]
    const profile = profileOf({ a: column('numeric'), y: column('numeric') }, findings)
    const withDrop = {
      ...recipe,
      steps: [{ op: 'drop_columns', columns: ['a'] }, { op: 'standardize' }],
    }
    const [decision] = findDecisions({ ...base, profile, recipe: withDrop, target: 'y' })
    expect(decision!.id).toBe('leak:y:a')
    const [drop, keep] = decision!.choices
    expect(drop!.action).toMatchObject({ kind: 'recipe', recipe: withDrop })
    expect(keep!.action).toMatchObject({ recipe: { steps: [{ op: 'standardize' }] } })
    // 前の目的の列の気付き (目的の列を含まない) と, 役割の列は出さない
    expect(ids({ ...base, profile, recipe, target: 'z' })).toEqual([])
    const timed = profileOf({ a: column('numeric'), y: column('numeric') }, findings, {
      overview: { roles: { time: 'a' } },
    } as unknown as Partial<Profile>)
    expect(ids({ ...base, profile: timed, recipe, target: 'y' })).toEqual([])
    // 落とす手順が無ければ先頭に作る
    const [fresh] = findDecisions({ ...base, profile, recipe, target: 'y' })
    expect(fresh!.choices[0]!.action).toMatchObject({
      recipe: { steps: [{ op: 'drop_columns', columns: ['a'] }] },
    })
  })

  test('時系列の分割, 偏ったクラスの分割, 時刻の抜けと過去の値の列', () => {
    const findings: Finding[] = [
      { severity: 'info', code: 'irregular_interval', message: '', columns: ['date'] },
    ]
    const profile = profileOf({ sales: column('numeric') }, findings)
    const lagged = { ...recipe, steps: [{ op: 'lag', columns: ['sales'] }] }
    const found = findDecisions({
      ...base,
      kind: 'timeseries',
      profile,
      recipe: lagged,
      target: 'sales',
    })
    expect(found.map((item) => item.id)).toEqual(['split:time', 'gaps'])
    expect(found[0]!.choices[0]!.action).toMatchObject({
      recipe: { split: { method: 'time', valid: 0.2 } },
    })
    expect(found[1]!.choices[1]!.action).toMatchObject({ recipe: { steps: [] } })

    const imbalance = profileOf({}, [
      { severity: 'warning', code: 'class_imbalance', message: '', columns: ['y'] },
    ])
    expect(ids({ ...base, profile: imbalance, recipe, target: 'y' })).toEqual(['split:stratified'])
  })

  test('文は中身の手順が無ければ作り, 区切り方が勧めと違えば聞く', () => {
    const tokenizers = {
      candidates: [],
      recommended: { op: 'vocabulary', unit: 'subword', length: 16, max_tokens: 500 },
      reason: '部分語が短い',
      notes: [],
    }
    const profile = profileOf({}, [], { items: { kind: 'text', count: 9, tokenizers } })
    const text = { ...base, kind: 'text', profile, target: 'label' }
    const [items] = findDecisions({ ...text, recipe })
    expect(items!.id).toBe('items')
    // 作る手順は勧めた区切り方
    expect(autoItemSteps('text', profile)).toEqual([tokenizers.recommended])

    const byChar = { ...recipe, item_steps: [{ op: 'vocabulary', unit: 'char', length: 64 }] }
    const [unit] = findDecisions({ ...text, recipe: byChar })
    expect(unit!.id).toBe('tokenizer:char->subword')
    expect(unit!.choices[0]!.action).toMatchObject({
      recipe: { item_steps: [{ op: 'vocabulary', unit: 'subword', length: 16, max_tokens: 500 }] },
    })
    const same = { ...recipe, item_steps: [tokenizers.recommended] }
    expect(ids({ ...text, recipe: same })).toEqual([])
  })
})
