import { expect, test } from 'vitest'

import type { ColumnInfo, ItemStepInfo, Recipe } from '../api/types'
import {
  canKeepUnlabeled,
  looksLikeDatetime,
  fitUnlabeled,
  itemLimitErrors,
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

test('日時の型の列と, よく出る値が全て日付の文字の列を日時に見える列とする', () => {
  const info = (fields: Partial<ColumnInfo>): ColumnInfo =>
    ({
      type: 'categorical',
      dtype: 'object',
      count: 1,
      missing: 0,
      missing_ratio: 0,
      unique: 1,
      ...fields,
    }) as ColumnInfo
  expect(looksLikeDatetime(info({ type: 'datetime' }))).toBe(true)
  const dates = [
    { value: '2025-01-01', count: 4 },
    { value: '2025/1/2 12:30', count: 4 },
  ]
  expect(looksLikeDatetime(info({ top: dates }))).toBe(true)
  expect(looksLikeDatetime(info({ top: [...dates, { value: 'east', count: 1 }] }))).toBe(false)
  expect(looksLikeDatetime(info({ top: [] }))).toBe(false)
  expect(looksLikeDatetime(info({ type: 'numeric' }))).toBe(false)
})

test('中身の手順の引数が上限を超えた値だけに, 手順の番号と上限を添えた理由を出す', () => {
  const info = (op: string, limits: Record<string, number>): ItemStepInfo => ({
    op,
    kind: 'audio',
    params: {},
    description: '',
    fits: false,
    limits,
  })
  const infos = [info('resample', { rate: 192000 }), info('fix_length', { seconds: 600 })]
  // 上限ちょうど, 数でない値, 上限の無い手順と知らない手順は通す
  expect(
    itemLimitErrors(
      [
        { op: 'resample', rate: 192000 },
        { op: 'fix_length', seconds: 'long' },
        { op: 'mix_channels', channels: 99 },
      ],
      infos,
    ),
  ).toEqual([])
  expect(
    itemLimitErrors(
      [
        { op: 'fix_length', seconds: 10 },
        { op: 'resample', rate: 200000 },
        { op: 'fix_length', seconds: 601 },
      ],
      infos,
    ),
  ).toEqual([
    '中身の手順 2 (resample) の rate は 192000 以下にしてください',
    '中身の手順 3 (fix_length) の seconds は 600 以下にしてください',
  ])
})
