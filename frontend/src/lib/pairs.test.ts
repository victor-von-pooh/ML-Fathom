import { expect, test } from 'vitest'

import {
  conventionText,
  itemsSnippet,
  originNote,
  parseClasses,
  parseGroups,
  parseSettings,
} from './pairs'

test('値の名前を 1 行ずつ辞書にし, 空なら名前を付けない', () => {
  expect(parseClasses('0: background\n 1 : circle\n\n2=square')).toEqual({
    value: { '0': 'background', '1': 'circle', '2': 'square' },
    error: null,
  })
  expect(parseClasses('  \n')).toEqual({ value: undefined, error: null })
  // 値は整数だけで, 同じ値 (01 と 1) は誤り
  expect(parseClasses('a: x').error).toMatch(/値: 名前/)
  expect(parseClasses('1: a\n01: b').error).toMatch(/同じ値/)
})

test('グループを件の id から辞書にし, カンマとタブの区切りを読む', () => {
  expect(parseGroups('scan_1,obj_a\nscan_2\tobj_b')).toEqual({
    value: { scan_1: 'obj_a', scan_2: 'obj_b' },
    error: null,
  })
  expect(parseGroups('')).toEqual({ value: undefined, error: null })
  expect(parseGroups('scan_1').error).toMatch(/件の id,グループ/)
  expect(parseGroups('a,x\na,y').error).toMatch(/同じ件/)
})

test('設定は YAML の辞書だけを受け取る', () => {
  expect(parseSettings('')).toEqual({ value: {}, error: null })
  expect(parseSettings('threshold: 0.5\nmodel: v2')).toEqual({
    value: { threshold: 0.5, model: 'v2' },
    error: null,
  })
  expect(parseSettings('- a\n- b').error).toMatch(/辞書/)
  expect(parseSettings('a: [').error).toMatch(/YAML/)
})

test('出どころが今ある処理の出力なら, その処理を超えられないと添える', () => {
  expect(originNote({ type: 'process', name: 'fusion' })).toMatch(
    /処理 fusion との一致で, モデルは処理 fusion を超えられません/,
  )
  expect(originNote({ type: 'process' })).toMatch(/その処理を超えられません/)
  expect(originNote({ type: 'annotation', name: 'x' })).toBeNull()
  expect(originNote(null)).toBeNull()
})

test('座標の決まりを 1 行にし, 空の値を除く', () => {
  expect(conventionText({ origin: 'top_left', axes: ['row', 'column'], up: null })).toBe(
    'origin=top_left, axes=["row","column"]',
  )
  expect(conventionText(null)).toBe('—')
})

test('load_items の使い方の例は, ある分割と正規化だけを書く', () => {
  const plain = itemsSnippet('/d/shapes', { train: {} }, ['image', 'mask'], false)
  expect(plain).toContain('from ml_eda import load_items')
  expect(plain).toContain('dataset = load_items("/d/shapes")')
  expect(plain).toContain('{"id", "split", "group", "image", "mask"}')
  expect(plain).not.toContain('dataset.split("valid")')
  expect(plain).not.toContain('normalize_capture')
  const full = itemsSnippet('/d/objects', { train: {}, valid: {}, test: {} }, [], true)
  expect(full).toContain('valid = dataset.split("valid")')
  expect(full).toContain('test = dataset.split("test")')
  expect(full).toContain('capture_shift と normalize_capture')
})
