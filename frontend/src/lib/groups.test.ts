import { expect, test } from 'vitest'

import type { ColumnInfo } from '../api/types'
import { cellText, defaultGroupColumns, groupLabel, groupUsage, summaryColumns } from './groups'

function info(type: string): ColumnInfo {
  return { type } as ColumnInfo
}

test('群を作る列の初めは, 数, 種類, 2 値の列で, 目的の列と見分ける列は外す', () => {
  const columns = {
    member: info('id'),
    spend: info('numeric'),
    region: info('categorical'),
    member_flag: info('boolean'),
    memo: info('text'),
    joined: info('datetime'),
    country: info('constant'),
    churn: info('categorical'),
  }
  expect(defaultGroupColumns(columns, 'churn')).toEqual(['spend', 'region', 'member_flag'])
  expect(defaultGroupColumns(columns, null)).toContain('churn')
})

test('群の要約の行から, 群を作った列を表の順に取り出す', () => {
  const rows = [
    { group: 0, rows: 2, share: 0.5, stability: 1, spend: 1.5, region: 'east (100 %)' },
    { group: '全体', rows: 4, share: 1, stability: null, spend: 2, region: 'east (50 %)' },
  ]
  expect(summaryColumns(rows)).toEqual(['spend', 'region'])
  expect(summaryColumns([])).toEqual([])
})

test('群の名前と値の文', () => {
  expect(groupLabel(0)).toBe('群 0')
  expect(groupLabel('全体')).toBe('全体')
  expect(cellText(1.23456)).toBe('1.2346')
  expect(cellText('east (100 %)')).toBe('east (100 %)')
  expect(cellText(null)).toBe('–')
})

test('書き出した表の読み方の例に場所と群の数を入れる', () => {
  const text = groupUsage('/home/datasets/groups', 3)
  expect(text).toContain('ml_eda.load_items("/home/datasets/groups")')
  expect(text).toContain('describe_groups(dataset, k=3)')
})
