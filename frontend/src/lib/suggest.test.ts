import type { ColumnInfo, Finding, Profile } from '../api/types'
import { autoItemSteps, autoRecipe, suggestSteps } from './suggest'

/** 分析の結果の列の情報を作る */
function column(type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    type,
    dtype: type === 'numeric' ? 'float64' : 'str',
    count: 100,
    missing: 0,
    missing_ratio: 0,
    unique: 3,
    ...extra,
  }
}

const columns: Record<string, ColumnInfo> = {
  id: column('id', { dtype: 'int64', unique: 100 }),
  age: column('numeric', { missing: 40, missing_ratio: 0.4, min: 1 }),
  income: column('numeric', { min: 0 }),
  name: column('text'),
  city: column('categorical', { missing: 2 }),
  shop: column('categorical', { unique: 80 }),
  label: column('boolean'),
}

const findings: Finding[] = [
  { severity: 'warning', code: 'id_like', message: '', columns: ['id'] },
  { severity: 'warning', code: 'high_missing', message: '', columns: ['age'] },
  { severity: 'info', code: 'skewed', message: '', columns: ['income'] },
]

test('気付きから, 列を落とす手順と型に合う補完の手順を作る', () => {
  const steps = suggestSteps(findings, 'label', columns)
  expect(steps[0]).toEqual({ op: 'drop_columns', columns: ['id'] })
  expect(steps).toContainEqual(
    expect.objectContaining({ op: 'impute', columns: ['age'], strategy: 'median' }),
  )
  expect(steps).toContainEqual({ op: 'log', columns: ['income'] })
})

test('列の型から, 全て数値で欠損の無い形にする手順を作る', () => {
  const steps = autoRecipe(columns, 'label', findings, {})
  const ops = steps.map((step) => step.op)
  expect(steps[0]).toEqual({ op: 'drop_columns', columns: ['id', 'name'] })
  expect(ops.at(-1)).toBe('standardize')
  expect(steps).toContainEqual({ op: 'one_hot', columns: ['city'] })
  expect(steps).toContainEqual({ op: 'label_encode', columns: ['shop'] })
  expect(steps).toContainEqual({ op: 'impute', columns: ['city'], strategy: 'most_frequent' })
  // 目的の列は手順に入れない
  const used = steps.flatMap((step) => (Array.isArray(step.columns) ? step.columns : []))
  expect(used).not.toContain('label')
})

describe('autoItemSteps', () => {
  /** 中身の分析の結果だけを持つ分析の結果を作る */
  const profile = (extra: Partial<Profile>) => ({ columns: {}, ...extra }) as Profile

  it('大きな写真は長い辺を 224 までに縮める', () => {
    const steps = autoItemSteps(
      'image',
      profile({
        items: { kind: 'image', count: 3, sizes: [{ width: 4000, height: 3000, count: 3 }] },
      }),
    )
    expect(steps[0]).toEqual({ op: 'resize', width: 224, height: 168 })
  })

  it('空白で区切らない文は文字ごと, 点の数が 1 種類の点群は最も多い値', () => {
    const text = autoItemSteps(
      'text',
      profile({
        columns: {
          words: column('numeric', { q3: 1 }),
          length: column('numeric', { q3: 40 }),
        },
      }),
    )
    expect(text[0]).toMatchObject({ unit: 'char', length: 60 })
    const cloud = autoItemSteps(
      'pointcloud',
      profile({
        columns: { points: column('constant', { top: [{ value: '512', count: 9 }] }) },
      }),
    )
    expect(cloud[0]).toEqual({ op: 'sample_points', points: 512 })
  })
})
