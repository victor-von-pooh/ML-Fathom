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

/**
 * 目的の列を外したときの編集中のレシピ. 編集中のもの (無ければ保存したもの) に
 * split.unlabeled があれば消したものを返し, 無ければ null (変えない).
 * 編集中のレシピから消すので, 目的の列を戻しても残すには戻らず, 保存する
 * まで編集中の印が出る
 */
export function untargetedDraft(draft: Recipe | null, saved: Recipe | null): Recipe | null {
  const base = draft ?? saved
  if (!base || base.split.unlabeled === undefined) return null
  return withUnlabeled(base, false)
}

/**
 * 書き出したデータセットを ML-Found の学習スクリプトで読む例.
 * 検証用と unlabeled の行は, その分割がある場合だけ
 */
export function usageSnippet(
  path: string,
  splits: Record<string, unknown>,
  media: boolean,
): string {
  const valid =
    'valid' in splits
      ? 'valid_loader = DataLoader(TensorDataset(*dataset.tensors("valid")), batch_size=64)'
      : null
  const unlabeled =
    'unlabeled' in splits ? '# 正解の無い行: dataset.tensors("unlabeled") (入力だけ)' : null
  const sizes = media
    ? '# 入力の形: dataset.info["splits"]["train"]["shape"][1:], クラスの数: len(dataset.info["classes"])'
    : '# 入力の次元: len(dataset.features), クラスの数: len(dataset.info["classes"])'
  const lines = [
    'from ml_eda import load_dataset',
    'from torch.utils.data import DataLoader, TensorDataset',
    '',
    `dataset = load_dataset("${path}")`,
    'train_loader = DataLoader(TensorDataset(*dataset.tensors("train")), batch_size=64, shuffle=True)',
    valid,
    unlabeled,
    sizes,
  ]
  const snippet = lines.filter((line) => line !== null).join('\n')
  return snippet
}

/** 分割の名前の表示 (unlabeled は正解の無い分割と分かるように) */
export function splitLabel(name: string): string {
  return name === 'unlabeled' ? 'unlabeled (正解なし)' : name
}
