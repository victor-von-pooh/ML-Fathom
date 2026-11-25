// 群分け (まとめる) の群の要約 (ML-EDA の describe_groups) の表示
import type { ColumnInfo, GroupAnswers, GroupRow } from '../api/types'
import { formatNumber } from './format'

/** 群の要約の行の, 列の要約でない鍵 */
const ROW_KEYS = new Set(['group', 'rows', 'share', 'stability'])

/** 群を作る列の候補にしない型 (行を見分ける列, 文, 日時, 値が 1 つか空の列) */
const SKIPPED_TYPES = new Set(['id', 'text', 'datetime', 'constant', 'empty'])

/**
 * 画面で作れる群の数の範囲. 上限はバックエンドの backend/src/ml_fathom/groups.py の
 * MAX_GROUPS と同じ値にする (変えるときは両方を変える)
 */
export const MIN_GROUPS = 2
export const MAX_GROUPS = 50

/**
 * 群を作る列の初めの選び方. 数, 種類, 2 値の列を選び, 行を見分ける列, 文, 日時,
 * 値の 1 つの列と目的の列は外す (群を作る力が無いか, 別の扱いが要るため)
 */
export function defaultGroupColumns(
  columns: Record<string, ColumnInfo>,
  target: string | null,
): string[] {
  return Object.entries(columns)
    .filter(([name, info]) => name !== target && !SKIPPED_TYPES.has(info.type))
    .map(([name]) => name)
}

/** 問題の設定の答えの群を作る列のうち, 表にある列を表の順に返す */
export function answerColumns(answers: GroupAnswers, columns: string[]): string[] {
  return columns.filter((name) => answers.columns.includes(name))
}

/**
 * 問題の設定の答えの群の数. 答えていなければ 3. 範囲の外の数はそのまま返す
 * (欄に理由を出し, 黙って変えないため)
 */
export function answerK(answers: GroupAnswers): number {
  return answers.k ?? 3
}

/** 欄の群を作る列か群の数が, 問題の設定の答えと違うか (列の順は問わない) */
export function differsFromAnswers(answers: GroupAnswers, columns: string[], k: number): boolean {
  const wanted = new Set(answers.columns)
  return (
    answers.k !== k || columns.length !== wanted.size || columns.some((name) => !wanted.has(name))
  )
}

/** 群の要約の行から, 群を作った列の名前を表の順に返す */
export function summaryColumns(rows: GroupRow[]): string[] {
  const first = rows[0]
  if (!first) return []
  return Object.keys(first).filter((key) => !ROW_KEYS.has(key))
}

/** 群の名前 (群の番号はそのまま. 全ての行をまとめた行は「全体」) */
export function groupLabel(group: GroupRow['group']): string {
  return typeof group === 'number' ? `群 ${group}` : group
}

/** 群の要約の 1 つの値 (数は丸め, 文はそのまま, 無ければ –) */
export function cellText(value: GroupRow[string]): string {
  if (value === null || value === undefined) return '–'
  if (typeof value === 'number') return formatNumber(value)
  return value
}

/** 書き出した群分けの表を学習のスクリプトで読む例 */
export function groupUsage(path: string, k: number): string {
  return [
    'import ml_eda',
    '',
    `dataset = ml_eda.load_items(${JSON.stringify(path)})`,
    'dataset.items  # 1 行が 1 つの対象 (id, split と群を作る列)',
    `summary = ml_eda.describe_groups(dataset, k=${k})  # 学習の前の群の要約`,
  ].join('\n')
}
