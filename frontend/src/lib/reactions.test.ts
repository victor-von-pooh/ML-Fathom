import { expect, test } from 'vitest'

import { binCounts, binLabel, timeText } from './reactions'

test('区切りの見出しは 1 つの値, 範囲, 最後は以上にする', () => {
  expect(binLabel({ from: 2, to: 2, count: 1 })).toBe('2')
  expect(binLabel({ from: 3, to: 5, count: 1 })).toBe('3–5')
  expect(binLabel({ from: 101, to: null, count: 0 })).toBe('101 以上')
})

test('区切りごとの数を見出しと数の組にする', () => {
  const counts = {
    min: 1,
    max: 4,
    mean: 2,
    std: 1,
    median: 2,
    once: 1,
    bins: [
      { from: 1, to: 1, count: 1 },
      { from: 3, to: 5, count: 2 },
    ],
  }
  expect(binCounts(counts)).toEqual([
    { value: '1', count: 1 },
    { value: '3–5', count: 2 },
  ])
})

test('時刻は数をそのまま, 日時を読みやすく, 無ければ –', () => {
  expect(timeText(1200)).toBe('1,200')
  expect(timeText('2025-01-02T03:04:05')).toBe('2025-01-02 03:04:05')
  expect(timeText(null)).toBe('–')
})
