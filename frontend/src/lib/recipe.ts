import type { ColumnInfo, Recipe } from '../api/types'

/**
 * 目的の列の欠けた行の扱いを変えたレシピ (ML-EDA の split.unlabeled).
 * 落とすは既定と同じなので項目を消す (項目の無いレシピと見分けない)
 */
export function withUnlabeled(recipe: Recipe, keep: boolean): Recipe {
  const split: Recipe['split'] = { ...recipe.split }
  if (keep) split.unlabeled = 'keep'
  else delete split.unlabeled
  return { ...recipe, split }
}

/**
 * 目的の列に合わせたレシピ. 目的の列が無ければ split.unlabeled を消す
 * (ML-EDA では目的の列の無い keep は誤り. 欄も出さないので隠れたまま残さない)
 */
export function fitUnlabeled(recipe: Recipe, target: string | null): Recipe {
  if (target || recipe.split.unlabeled === undefined) return recipe
  return withUnlabeled(recipe, false)
}

/**
 * 正解の欠けた行を残す欄を選べるか. 分析した全ての行で目的の列が欠けていない
 * (間引いていない) 場合は残す行が無いので選べない. 残すを選んでいれば戻せるように選べる
 */
export function canKeepUnlabeled(
  recipe: Recipe,
  column: ColumnInfo | undefined,
  sampled: boolean,
): boolean {
  if (!recipe.target) return false
  if (recipe.split.unlabeled === 'keep') return true
  return column === undefined || sampled || column.missing > 0
}

/** 分割の名前の表示 (unlabeled は正解の無い分割と分かるように) */
export function splitLabel(name: string): string {
  return name === 'unlabeled' ? 'unlabeled (正解なし)' : name
}
