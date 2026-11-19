// 入力と正解がファイルの組のデータセット (ML-EDA の dataset.yaml の版 2) の書き出しと表示
import YAML from 'yaml'

import type { PairOrigin } from '../api/types'

/** 正解の出どころの種類の日本語の名前 (ML-EDA の target.origin.type) */
export const ORIGIN_LABELS: Record<string, string> = {
  unknown: '分からない',
  annotation: '人が付けた',
  process: '今ある処理の出力',
  measurement: '測った',
  synthetic: '作った正確な正解',
}

/** 受け持ちの日本語の名前 (ML-Quest の受け持ちと同じ値) */
export const ROLE_LABELS: Record<string, string> = {
  predict: '予測する',
  generate: '作る',
  rank: '並べる',
  group: 'まとめる',
  effect: '効果を見積もる',
}

/** 項目の種類の日本語の名前 */
export const ENTRY_KIND_LABELS: Record<string, string> = {
  image: '画像',
  mask: '領域',
  point_cloud: '点群',
  capture: '多視点の撮影',
  boxes: '物の箱',
}

/** 文を辞書にした結果 (誤りがあれば error) */
export type Parsed<T> = { value: T; error: null } | { value: null; error: string }

/** 空でない行 (前後の空白を除く) */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 値の名前 (1 行に `値: 名前`) を, 値から名前の辞書にする.
 * 空なら undefined (名前を付けない)
 */
export function parseClasses(text: string): Parsed<Record<string, string> | undefined> {
  const classes: Record<string, string> = {}
  for (const line of lines(text)) {
    const match = /^(-?\d+)\s*[:=,]\s*(.+)$/.exec(line)
    if (!match) return { value: null, error: `「値: 名前」の形ではありません: ${line}` }
    const key = String(Number(match[1]))
    if (key in classes) return { value: null, error: `同じ値が 2 つあります: ${key}` }
    classes[key] = match[2]!.trim()
  }
  const value = Object.keys(classes).length > 0 ? classes : undefined
  return { value, error: null }
}

/**
 * グループ (1 行に `件の id,グループ`. タブ区切りも) を, 件の id からグループの辞書にする.
 * 空なら undefined (グループ無し)
 */
export function parseGroups(text: string): Parsed<Record<string, string> | undefined> {
  // Map で集める (constructor や __proto__ のような id も 1 件として扱う)
  const groups = new Map<string, string>()
  for (const line of lines(text)) {
    const match = /^([^,\t]+?)\s*[,\t]\s*(.+)$/.exec(line)
    if (!match) return { value: null, error: `「件の id,グループ」の形ではありません: ${line}` }
    const key = match[1]!
    if (groups.has(key)) return { value: null, error: `同じ件が 2 つあります: ${key}` }
    groups.set(key, match[2]!.trim())
  }
  const value = groups.size > 0 ? Object.fromEntries(groups) : undefined
  return { value, error: null }
}

/** 正解を作った処理の設定 (YAML の辞書) を辞書にする. 空なら空の辞書 */
export function parseSettings(text: string): Parsed<Record<string, unknown>> {
  if (text.trim() === '') return { value: {}, error: null }
  let loaded: unknown
  try {
    loaded = YAML.parse(text)
  } catch (error) {
    return { value: null, error: `YAML を読めません: ${(error as Error).message}` }
  }
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return { value: null, error: '設定は「名前: 値」の辞書にしてください' }
  }
  return { value: loaded as Record<string, unknown>, error: null }
}

/**
 * 出どころが今ある処理の出力の場合の注意. 他は null.
 * 正解はその処理の出力なので, 測れるのはその処理との一致
 */
export function originNote(origin: PairOrigin | null | undefined): string | null {
  if (origin?.type !== 'process') return null
  const name = origin.name ? `処理 ${origin.name} ` : 'その処理'
  return `正解は${name}の出力です. 測れるのは${name}との一致で, モデルは${name}を超えられません.`
}

/** 座標の決まりを 1 行の文にする (`鍵=値` の並び) */
export function conventionText(convention: Record<string, unknown> | null | undefined): string {
  if (!convention) return '—'
  return Object.entries(convention)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
}

/**
 * 書き出した版 2 のデータセットを読む例 (load_items).
 * 検証用とテスト用の行は, その分割がある場合だけ. 正規化をかけたものは推論の注意を足す
 */
export function itemsSnippet(
  path: string,
  splits: Record<string, unknown>,
  entries: string[],
  normalized: boolean,
): string {
  const keys = ['id', 'split', 'group', ...entries].map((key) => `"${key}"`).join(', ')
  const lines = [
    'from ml_eda import load_items',
    '',
    `dataset = load_items(${JSON.stringify(path)})`,
    `train = dataset.split("train")    # len と番号で 1 件. PyTorch の Dataset に包める`,
    `item = train[0]                   # {${keys}} の辞書`,
    'valid' in splits ? 'valid = dataset.split("valid")' : null,
    'test' in splits ? 'test = dataset.split("test")' : null,
    'paths = dataset.split("train", read=False)[0]   # 配列の代わりに場所',
    normalized
      ? '# 推論のときは capture_shift と normalize_capture で同じ正規化をかけ, 出力から shift を引いて元の座標に戻す'
      : null,
  ]
  const snippet = lines.filter((line) => line !== null).join('\n')
  return snippet
}
