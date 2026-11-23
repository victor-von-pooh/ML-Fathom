import { expect, test } from 'vitest'

import type { TrajectorySummary } from '../api/types'
import { analysisFileName, binValues, guardLabel } from './trajectory'

test('少ない種類の整数は 1 つの値を 1 つの区間にする', () => {
  const histogram = binValues([3, 3, 5])!
  expect(histogram.edges).toEqual([2.5, 3.5, 4.5, 5.5])
  expect(histogram.counts).toEqual([2, 0, 1])
  // 区間の見出しは範囲でなく値
  expect(histogram.labels).toEqual(['3', '4', '5'])
})

test('数は同じ幅の区間に分け, 最大の値は最後の区間に入れる', () => {
  const histogram = binValues([0, 0.5, 1, 1.5])!
  expect(histogram.counts).toHaveLength(2)
  expect(histogram.counts).toEqual([2, 2])
  expect(histogram.edges[0]).toBe(0)
  expect(histogram.edges[2]).toBe(1.5)
  expect(histogram.labels).toBeUndefined()
})

test('値の範囲が 20 を超える整数は, 同じ幅の区間にして見出しを範囲にする', () => {
  const histogram = binValues([0, 30])!
  expect(histogram.labels).toBeUndefined()
  expect(histogram.counts).toEqual([1, 1])
})

test('守りの結果は日本語の名前にし, 知らない結果は「その他」を添える', () => {
  expect(guardLabel('clipped')).toBe('範囲に収めた')
  expect(guardLabel('missing')).toBe('空')
  expect(guardLabel('pause')).toBe('その他 (pause)')
})

test('全て同じ数は範囲を広げ, 有限の値が無ければ描かない', () => {
  expect(binValues([-0.25])).toEqual({ counts: [1], edges: [-0.75, 0.25] })
  expect(binValues([Number.NaN])).toBeNull()
  expect(binValues([])).toBeNull()
})

test('書き出すファイルの名前は軌跡の名前から作る', () => {
  const name = (value: string) => analysisFileName({ name: value } as TrajectorySummary)
  expect(name('guarded')).toBe('guarded.analysis.json')
  expect(name('a/b')).toBe('a_b.analysis.json')
  expect(name('')).toBe('trajectory.analysis.json')
})
