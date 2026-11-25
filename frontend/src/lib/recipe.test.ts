import { expect, test } from 'vitest'

import type { AnomalySummary, ColumnInfo, ItemStepInfo, Recipe } from '../api/types'
import {
  anomalyOf,
  anomalyTotals,
  canKeepUnlabeled,
  looksLikeDatetime,
  fitUnlabeled,
  itemLimitErrors,
  splitLabel,
  untargetedDraft,
  rowIdColumns,
  usageSnippet,
  withRowId,
  withTask,
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
  const kept = withUnlabeled(recipe, 'keep')
  expect(kept.split).toEqual({ ...recipe.split, unlabeled: 'keep' })
  // 元のレシピは変えない
  expect(recipe.split.unlabeled).toBeUndefined()
  // 落とすに戻すと元のレシピと同じ (編集中の印が消える)
  expect(withUnlabeled(kept, 'drop')).toEqual(recipe)
  // 保存したレシピに書いた drop も, 落とすを選び直すと消える (既定と同じ)
  const dropped: Recipe = { ...recipe, split: { ...recipe.split, unlabeled: 'drop' } }
  expect(withUnlabeled(dropped, 'drop').split.unlabeled).toBeUndefined()
})

test('目的の列が無いと split.unlabeled を消し, あればそのまま', () => {
  const kept = withUnlabeled(recipe, 'keep')
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
  expect(canKeepUnlabeled(withUnlabeled(recipe, 'keep'), column(0), false)).toBe(true)
  expect(canKeepUnlabeled({ ...recipe, target: null }, column(3), false)).toBe(false)
})

test('分割の名前は unlabeled にだけ正解なしと添える', () => {
  expect(splitLabel('train')).toBe('train')
  expect(splitLabel('unlabeled')).toBe('unlabeled (正解なし)')
})

test('目的の列を外すと, 編集中か保存したレシピから split.unlabeled を消した下書きにする', () => {
  const kept = withUnlabeled(recipe, 'keep')
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

test('異常の検知でなくなると, 行の id の列と正常と見なすを消す', () => {
  const anomaly: Recipe = {
    ...recipe,
    task: 'anomaly',
    id: 'reading_id',
    split: { method: 'random', valid: 0.2, unlabeled: 'normal' },
  }
  expect(withTask(anomaly, 'anomaly')).toEqual(anomaly)
  const changed = withTask(anomaly, 'classification')
  expect(changed.id).toBeUndefined()
  expect(changed.split).toEqual({ method: 'random', valid: 0.2 })
  // 残すは他のタスクでも使えるので残す
  const kept = withTask(withUnlabeled(anomaly, 'keep'), 'regression')
  expect(kept.split.unlabeled).toBe('keep')
  // 元のレシピは変えない
  expect(anomaly.id).toBe('reading_id')
})

test('行の id の列は空なら項目を消し, 正常と見なすも選んだままにできる', () => {
  const anomaly: Recipe = { ...recipe, task: 'anomaly' }
  expect(withRowId(anomaly, 'reading_id').id).toBe('reading_id')
  expect('id' in withRowId({ ...anomaly, id: 'reading_id' }, '')).toBe(false)
  const normal = withUnlabeled(anomaly, 'normal')
  expect(normal.split.unlabeled).toBe('normal')
  expect(canKeepUnlabeled(normal, column(0), false)).toBe(true)
  expect(withUnlabeled(normal, 'drop').split.unlabeled).toBeUndefined()
})

test('異常の検知の行の数を合わせ, 正解なしの行を除いて異常の割合を求める', () => {
  const summary: AnomalySummary = {
    id: 'row_id',
    labeled: true,
    unlabeled: 'keep',
    rows: {
      train: { normal: 50, presumed: 0, anomaly: 0, unlabeled: 0 },
      valid: { normal: 10, presumed: 0, anomaly: 4, unlabeled: 0 },
      unlabeled: { normal: 0, presumed: 0, anomaly: 0, unlabeled: 30 },
    },
  }
  expect(anomalyTotals(summary)).toEqual({
    labeled: 64,
    normal: 60,
    presumed: 0,
    anomaly: 4,
    unlabeled: 30,
    ratio: 4 / 64,
  })
  expect(anomalyTotals({ ...summary, rows: {} }).ratio).toBeNull()
  expect(anomalyOf({ anomaly: summary })).toBe(summary)
  expect(anomalyOf({ anomaly: null })).toBeNull()
  expect(anomalyOf({})).toBeNull()
})

test('異常の検知の使い方の例は, 学習用が正常の行だけであることを添える', () => {
  const snippet = usageSnippet('/d', { train: {}, valid: {} }, false, true)
  expect(snippet).toContain('train は正常の行だけ')
  expect(snippet).toContain('dataset.info["anomaly"]["rows"]')
  expect(snippet).not.toContain('クラスの数')
})

test('行の id の列の候補は, 目的の列でなく欠けも同じ値も無い列だけ', () => {
  const info = (count: number, missing: number, unique: number): ColumnInfo =>
    ({ ...column(missing), count, unique }) as ColumnInfo
  const columns = {
    reading_id: info(10, 0, 10),
    temp: info(10, 0, 7),
    note: info(9, 1, 9),
    label: info(10, 0, 10),
  }
  expect(rowIdColumns(columns, 'label')).toEqual(['reading_id'])
  expect(rowIdColumns(columns, null)).toEqual(['reading_id', 'label'])
})
