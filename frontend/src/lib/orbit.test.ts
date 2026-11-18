import { describe, expect, it } from 'vitest'

import { MAP, gapPath, polar } from './orbit'

describe('上から見た配置の図', () => {
  it('方位は上から見て反時計回りで, 画面の y は下向き', () => {
    const center = MAP.size / 2
    const [, up] = polar(90, 10)
    const [right] = polar(0, 10)
    expect(up).toBeLessThan(center)
    expect(right).toBeGreaterThan(center)
  })

  it('0 から 180 度にカメラがあれば, 隙間の扇形は画面の下半分 (空いた側) に出る', () => {
    // 隙間は 180 度から 180 度 (ML-EDA の widest_gap の返す形)
    const path = gapPath(180, 180)
    // M cx cy L x0 y0 A r r 0 large sweep x1 y1 Z
    const tokens = path.split(' ')
    const [x0, y0, x1, y1] = [tokens[4], tokens[5], tokens[12], tokens[13]]
    expect(Number(x0)).toBeLessThan(MAP.size / 2)
    expect(Number(x1)).toBeGreaterThan(MAP.size / 2)
    expect(Number(y0)).toBeCloseTo(MAP.size / 2)
    expect(Number(y1)).toBeCloseTo(MAP.size / 2)
    // 掃く向き 0 (画面で反時計回り) は, 左端から下を通って右端へ
    expect(path).toContain(' 0 0 0 ')
  })

  it('ほぼ一周の隙間は円になる', () => {
    expect(gapPath(30, 360)).not.toContain(' L ')
  })
})
