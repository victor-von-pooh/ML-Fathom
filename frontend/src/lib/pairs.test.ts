import { expect, test } from 'vitest'

import {
  classesText,
  conventionText,
  depthConventionText,
  groupsText,
  itemsSnippet,
  numberText,
  originNote,
  parseClasses,
  parseGroups,
  parseSettings,
  settingsText,
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
  // 組み込みの名前の id も 1 件として扱う
  const builtin = parseGroups('constructor,a\n__proto__,b').value!
  expect(Object.keys(builtin)).toEqual(['constructor', '__proto__'])
  expect(builtin['__proto__']).toBe('b')
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
  // 深度の測り方と画素の中心は別の行に出す
  expect(conventionText({ pose: 'camera_to_world', depth: 'z', pixel_center: 0.5 })).toBe(
    'pose=camera_to_world',
  )
})

test('撮影の深度の測り方と画素の中心を 1 行にし, 欄の無い撮影は書き出し直しを勧める', () => {
  expect(depthConventionText('capture', { depth: 'z', pixel_center: 0.5 })).toBe(
    '深度 z (カメラの前の軸に沿った距離) · 画素の中心 +0.5 (行 r, 列 c の画素は (c + 0.5, r + 0.5))',
  )
  expect(depthConventionText('capture', { depth: 'ray' })).toBe('深度 ray (光線に沿った距離)')
  expect(depthConventionText('capture', { pose: 'camera_to_world' })).toMatch(
    /書き出し直すと入ります/,
  )
  expect(depthConventionText('point_cloud', { depth: 'z' })).toBeNull()
})

test('load_items の使い方の例は, ある分割と正規化だけを書く', () => {
  const plain = itemsSnippet('/d/shapes', { train: {} }, ['image', 'mask'], false)
  expect(plain).toContain('from ml_eda import load_items')
  expect(plain).toContain('dataset = load_items("/d/shapes")')
  expect(plain).toContain('{"id", "split", "group", "image", "mask"}')
  expect(plain).not.toContain('dataset.split("valid")')
  expect(plain).not.toContain('normalize_capture')
  expect(plain).not.toContain('dataset.split("unlabeled")')
  // 正解の無い件を unlabeled の分割に書いた場合は, その読み方を足す
  const kept = itemsSnippet('/d/partial', { train: {}, unlabeled: {} }, ['image', 'mask'], false)
  expect(kept).toContain('unlabeled = dataset.split("unlabeled")')
  expect(kept).toContain('正解の項目は None')
  const full = itemsSnippet('/d/objects', { train: {}, valid: {}, test: {} }, [], true)
  expect(full).toContain('valid = dataset.split("valid")')
  expect(full).toContain('test = dataset.split("test")')
  expect(full).toContain('normalize_capture で同じ正規化をかけて read_capture で読み')
  expect(full).not.toContain('transform_entry')
  // 中身の手順をかけたもの (版 3) は, 推論で同じ手順をかける関数を添える
  const stepped = itemsSnippet('/d/resized', { train: {} }, ['image', 'mask'], false, true)
  expect(stepped).toContain('transform_entry(dataset, 項目の名前, 中身)')
})

test('書き戻した辞書を欄の文に戻し, 読み直すと同じになる', () => {
  const groups = { a: 'site_1', b: 'site_2' }
  expect(groupsText(groups)).toBe('a,site_1\nb,site_2')
  expect(parseGroups(groupsText(groups)).value).toEqual(groups)
  expect(groupsText(null)).toBe('')
  const classes = { '0': 'background', '1': 'circle' }
  expect(parseClasses(classesText(classes)).value).toEqual(classes)
  expect(classesText(undefined)).toBe('')
  expect(settingsText({})).toBe('')
  expect(parseSettings(settingsText({ note: '細かさ 1 画素' })).value).toEqual({
    note: '細かさ 1 画素',
  })
  expect(numberText(0.15, '0.2')).toBe('0.15')
  expect(numberText(undefined, '0.2')).toBe('0.2')
})
