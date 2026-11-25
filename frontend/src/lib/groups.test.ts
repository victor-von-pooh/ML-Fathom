import { expect, test } from 'vitest'

import type { ColumnInfo, GroupAnswers } from '../api/types'
import {
  answerColumns,
  answerId,
  answerK,
  answersKey,
  cellText,
  defaultGroupColumns,
  differsFromAnswers,
  groupLabel,
  groupUsage,
  summaryColumns,
} from './groups'

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

test('問題の設定の答えの列は表にあるものを表の順に, 違う選び方は列の順を問わずに見分ける', () => {
  const answers: GroupAnswers = {
    columns: ['region', 'spend', 'income'],
    id: null,
    k: 4,
    stability: 'seed',
    stability_label: '種を変えて作り直す',
  }
  expect(answerColumns(answers, ['member', 'spend', 'region'])).toEqual(['spend', 'region'])
  expect(answerK(answers)).toBe(4)
  expect(answerK({ ...answers, k: null })).toBe(3)
  const same = { ...answers, columns: ['region', 'spend'] }
  expect(differsFromAnswers(same, ['spend', 'region'], 4, '')).toBe(false)
  expect(differsFromAnswers(same, ['spend', 'region'], 3, '')).toBe(true)
  expect(differsFromAnswers(same, ['spend'], 4, '')).toBe(true)
  expect(differsFromAnswers(answers, ['spend', 'region'], 4, '')).toBe(true)
})

test('答えていない群の数と列は, 答えとの違いに数えない', () => {
  const unanswered: GroupAnswers = {
    columns: ['region', 'spend'],
    id: null,
    k: null,
    stability: null,
    stability_label: null,
  }
  // 未答の群の数は初めの 3 で埋めても, 違いとしない
  expect(differsFromAnswers(unanswered, ['spend', 'region'], answerK(unanswered), '')).toBe(false)
  expect(differsFromAnswers(unanswered, ['spend', 'region'], 5, '')).toBe(false)
  expect(differsFromAnswers(unanswered, ['spend'], 3, '')).toBe(true)
  expect(differsFromAnswers({ ...unanswered, columns: [] }, ['spend'], 3, '')).toBe(false)
})

test('行を見分ける列は, 表にあって群を作る列でない答えだけを埋め, 違いに数える', () => {
  const answers: GroupAnswers = {
    columns: ['spend'],
    id: 'member',
    k: 4,
    stability: 'seed',
    stability_label: '種を変えて作り直す',
  }
  expect(answerId(answers, ['member', 'spend'])).toBe('member')
  expect(answerId(answers, ['spend'])).toBe('')
  expect(answerId({ ...answers, id: 'spend' }, ['member', 'spend'])).toBe('')
  expect(answerId({ ...answers, id: null }, ['member', 'spend'])).toBe('')
  // null の答えは「なし」と同じ
  expect(differsFromAnswers(answers, ['spend'], 4, 'member')).toBe(false)
  expect(differsFromAnswers(answers, ['spend'], 4, '')).toBe(true)
  expect(differsFromAnswers({ ...answers, id: null }, ['spend'], 4, '')).toBe(false)
  expect(differsFromAnswers({ ...answers, id: null }, ['spend'], 4, 'member')).toBe(true)
})

test('欄を埋め直す鍵は, 列の順と数え方の言葉を問わない', () => {
  const answers: GroupAnswers = {
    columns: ['spend', 'region'],
    id: null,
    k: 4,
    stability: 'seed',
    stability_label: '種を変えて作り直す',
  }
  const { stability_label: _, ...plain } = answers
  expect(answersKey(answers)).toBe(answersKey({ ...plain, columns: ['region', 'spend'] }))
  expect(answersKey(answers)).not.toBe(answersKey({ ...plain, k: 5 }))
  expect(answersKey(null)).toBe('null')
})
