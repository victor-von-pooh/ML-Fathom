import { expect, test } from 'vitest'

import type { ColumnInfo, Recipe } from '../api/types'
import {
  canKeepUnlabeled,
  fitUnlabeled,
  splitLabel,
  untargetedDraft,
  usageSnippet,
  withUnlabeled,
} from './recipe'

const recipe: Recipe = {
  format_version: 1,
  target: 'y',
  task: 'classification',
  steps: [],
  split: { method: 'stratified', valid: 0.2, column: 'member' },
}

const column = (missing: number): ColumnInfo =>
  ({
    type: 'categorical',
    dtype: 'object',
    count: 10,
    missing,
    missing_ratio: 0,
    unique: 2,
  }) as ColumnInfo

test('残すを選ぶと split.unlabeled を keep にし, 落とすで項目を消す', () => {
  const kept = withUnlabeled(recipe, true)
  expect(kept.split).toEqual({ ...recipe.split, unlabeled: 'keep' })
  // 元のレシピは変えない
  expect(recipe.split.unlabeled).toBeUndefined()
  // 落とすに戻すと元のレシピと同じ (編集中の印が消える)
  expect(withUnlabeled(kept, false)).toEqual(recipe)
  // 保存したレシピに書いた drop も, 落とすを選び直すと消える (既定と同じ)
  const dropped: Recipe = { ...recipe, split: { ...recipe.split, unlabeled: 'drop' } }
  expect(withUnlabeled(dropped, false).split.unlabeled).toBeUndefined()
})

test('目的の列が無いと split.unlabeled を消し, あればそのまま', () => {
  const kept = withUnlabeled(recipe, true)
  expect(fitUnlabeled(kept, 'y')).toBe(kept)
  expect(fitUnlabeled(kept, null).split).toEqual(recipe.split)
  expect(fitUnlabeled(recipe, null)).toBe(recipe)
})

test('目的の列が欠けた行の無いデータでは, 残すを選べない (選んでいれば戻せる)', () => {
  expect(canKeepUnlabeled(recipe, column(3), false)).toBe(true)
  expect(canKeepUnlabeled(recipe, column(0), false)).toBe(false)
  // 間引いて分析した場合と, 列の分析が無い場合は分からないので選べる
  expect(canKeepUnlabeled(recipe, column(0), true)).toBe(true)
  expect(canKeepUnlabeled(recipe, undefined, false)).toBe(true)
  expect(canKeepUnlabeled(withUnlabeled(recipe, true), column(0), false)).toBe(true)
  expect(canKeepUnlabeled({ ...recipe, target: null }, column(3), false)).toBe(false)
})

test('分割の名前は unlabeled にだけ正解なしと添える', () => {
  expect(splitLabel('train')).toBe('train')
  expect(splitLabel('unlabeled')).toBe('unlabeled (正解なし)')
})

test('目的の列を外すと, 編集中か保存したレシピから split.unlabeled を消した下書きにする', () => {
  const kept = withUnlabeled(recipe, true)
  // 編集中のレシピがあればそれから (他の編集は残す)
  const edited: Recipe = { ...kept, steps: [{ op: 'standardize', columns: 'auto' }] }
  expect(untargetedDraft(edited, kept)).toEqual({ ...edited, split: recipe.split })
  // 編集中のものが無ければ保存したものから (保存するまで編集中の印が出る)
  expect(untargetedDraft(null, kept)).toEqual(recipe)
  // 書いた drop も消す. 指定が無ければ変えない
  const dropped: Recipe = { ...recipe, split: { ...recipe.split, unlabeled: 'drop' } }
  expect(untargetedDraft(null, dropped)).toEqual(recipe)
  expect(untargetedDraft(null, recipe)).toBeNull()
  expect(untargetedDraft(recipe, kept)).toBeNull()
  expect(untargetedDraft(null, null)).toBeNull()
})

test('使い方の例は, ある分割だけを読む', () => {
  const full = usageSnippet('/d', { train: {}, valid: {}, unlabeled: {} }, false)
  expect(full).toContain('dataset.tensors("valid")')
  expect(full).toContain('dataset.tensors("unlabeled")')
  expect(full).toContain('len(dataset.features)')
  // 検証用の無い (割合 0 か分けない) データセットでは valid を読まない
  const only = usageSnippet('/d', { train: {} }, true)
  expect(only).not.toContain('"valid"')
  expect(only).not.toContain('unlabeled')
  expect(only).toContain('["shape"][1:]')
  expect(only.split('\n')[3]).toBe('dataset = load_dataset("/d")')
})
