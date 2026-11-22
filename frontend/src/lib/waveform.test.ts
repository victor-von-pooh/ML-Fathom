import { expect, test } from 'vitest'

import { formatSeconds, WAVE, waveformPath } from './waveform'

test('waveformPath は上を最大, 下を最小でつなぎ, 1 を超える値を端に収める', () => {
  const path = waveformPath([-0.5, -2], [0.5, 2])
  const points = path
    .replace(/^M /, '')
    .replace(/ Z$/, '')
    .split(' L ')
    .map((point) => point.split(' ').map(Number))
  // 上の 2 点, 下の 2 点 (逆の順)
  expect(points).toHaveLength(4)
  expect(points.map(([x]) => x)).toEqual([250, 750, 750, 250])
  const middle = WAVE.height / 2
  expect(points[0]![1]).toBeCloseTo(middle / 2)
  expect(points[1]![1]).toBeCloseTo(0)
  expect(points[2]![1]).toBeCloseTo(WAVE.height)
  expect(points[3]![1]).toBeCloseTo(middle * 1.5)
})

test('waveformPath は最小と最大が同じでも幅のある線にし, 空なら空の道筋', () => {
  const path = waveformPath([0], [0])
  const [top, bottom] = path
    .replace(/^M /, '')
    .replace(/ Z$/, '')
    .split(' L ')
    .map((point) => Number(point.split(' ')[1]))
  expect(bottom! - top!).toBeCloseTo(1)
  expect(waveformPath([], [])).toBe('')
})

test('formatSeconds は 60 秒を境に形を変える', () => {
  expect(formatSeconds(1.234)).toBe('1.23 秒')
  expect(formatSeconds(12.34)).toBe('12.3 秒')
  expect(formatSeconds(125)).toBe('2 分 5 秒')
  expect(formatSeconds(119.6)).toBe('2 分 0 秒')
  expect(formatSeconds(null)).toBe('–')
})
