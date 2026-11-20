import { expect, test } from 'vitest'

import type { PairStepInfo } from '../api/types'
import { itemStepsBody, itemStepsDrafts, stepsBody, stepText } from './entrySteps'

const RESIZE: PairStepInfo = {
  op: 'resize',
  kind: 'image',
  params: { width: '幅', height: '高さ' },
  description: '画像の大きさをそろえる',
  fits: false,
  required: ['width', 'height'],
  limits: { width: 4096, height: 4096 },
}
const SAMPLE: PairStepInfo = {
  op: 'sample_points',
  kind: 'pointcloud',
  params: { points: 'そろえる点の数', seed: '乱数のシード' },
  description: '点の数をそろえる',
  fits: false,
  required: ['points'],
  limits: { points: 1000000 },
}
const GRAY: PairStepInfo = { ...RESIZE, op: 'grayscale', params: {}, required: [], limits: {} }

test('引数を整数にし, 空の任意の引数は省く', () => {
  expect(
    stepsBody(
      [
        { op: 'resize', values: { width: ' 64 ', height: '48' } },
        { op: 'grayscale', values: {} },
      ],
      [RESIZE, GRAY],
      '画像',
    ),
  ).toEqual({
    value: [{ op: 'resize', width: 64, height: 48 }, { op: 'grayscale' }],
    errors: [],
  })
  expect(stepsBody([{ op: 'sample_points', values: { points: '100' } }], [SAMPLE], '点群')).toEqual(
    { value: [{ op: 'sample_points', points: 100 }], errors: [] },
  )
})

test('省けない引数の欠け, 整数でない値, 小さすぎる値, 使えない手順を誤りにする', () => {
  const { errors } = stepsBody(
    [
      { op: 'resize', values: { width: '', height: '1.5' } },
      { op: 'sample_points', values: { points: '0', seed: '-1' } },
      { op: 'normalize', values: {} },
    ],
    [RESIZE, SAMPLE],
    '画像',
  )
  expect(errors).toEqual([
    '画像の手順 1 (resize) の width を入れてください',
    '画像の手順 1 (resize) の height は 1 以上の整数にしてください',
    '画像の手順 2 (sample_points) の points は 1 以上の整数にしてください',
    '画像の手順 2 (sample_points) の seed は 0 以上の整数にしてください',
    '画像の手順 3 (normalize) はこの項目に使えません',
  ])
  // 乱数の種は 0 でよい
  expect(
    stepsBody([{ op: 'sample_points', values: { points: '5', seed: '0' } }], [SAMPLE], '点群')
      .errors,
  ).toEqual([])
})

test('上限を超えた大きさと点の数を誤りにし, 上限ちょうどは通す', () => {
  const { errors } = stepsBody(
    [
      { op: 'resize', values: { width: '4097', height: '4096' } },
      { op: 'sample_points', values: { points: '1000001' } },
    ],
    [RESIZE, SAMPLE],
    '撮影',
  )
  expect(errors).toEqual([
    '撮影の手順 1 (resize) の width は 4096 以下にしてください',
    '撮影の手順 2 (sample_points) の points は 1000000 以下にしてください',
  ])
  expect(
    stepsBody([{ op: 'sample_points', values: { points: '1000000' } }], [SAMPLE], '点群').errors,
  ).toEqual([])
})

test('書き戻した手順を欄の値に戻し, 組み立て直すと同じ手順になる', () => {
  const steps = {
    capture: [{ op: 'resize', width: 32, height: 24 }],
    cloud: [{ op: 'sample_points', points: 50, seed: 1 }],
  }
  const drafts = itemStepsDrafts(steps, ['capture', 'cloud'])
  expect(drafts).toEqual({
    capture: [{ op: 'resize', values: { width: '32', height: '24' } }],
    cloud: [{ op: 'sample_points', values: { points: '50', seed: '1' } }],
  })
  const infos = { capture: [RESIZE, GRAY], cloud: [SAMPLE] }
  const labels = { capture: '撮影', cloud: '点群' }
  expect(itemStepsBody(drafts, infos, labels)).toEqual({ value: steps, errors: [] })
  // 手順が無ければ項目ごとに空
  expect(itemStepsDrafts(undefined, ['image'])).toEqual({ image: [] })
})

test('手順の無い項目は渡さず, 全て無ければ undefined (版 2 のまま)', () => {
  const infos = { capture: [RESIZE, GRAY], cloud: [SAMPLE] }
  const labels = { capture: '撮影', cloud: '点群' }
  expect(itemStepsBody({ capture: [], cloud: [] }, infos, labels)).toEqual({
    value: undefined,
    errors: [],
  })
  expect(
    itemStepsBody(
      { capture: [], cloud: [{ op: 'sample_points', values: { points: '' } }] },
      infos,
      labels,
    ).errors,
  ).toEqual(['点群の手順 1 (sample_points) の points を入れてください'])
  expect(
    itemStepsBody({ capture: [{ op: 'grayscale', values: {} }], cloud: [] }, infos, labels).value,
  ).toEqual({ capture: [{ op: 'grayscale' }] })
})

test('手順を 1 行の文にする', () => {
  expect(stepText({ op: 'resize', width: 64, height: 48 })).toBe('resize (width 64, height 48)')
  expect(stepText({ op: 'grayscale' })).toBe('grayscale')
})
