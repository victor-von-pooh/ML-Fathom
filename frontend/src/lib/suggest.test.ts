import type { ColumnInfo, Finding } from '../api/types'
import { autoRecipe, suggestSteps } from './suggest'

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
