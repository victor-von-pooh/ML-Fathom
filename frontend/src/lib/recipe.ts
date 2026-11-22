import type { ColumnInfo, ItemStepInfo, Recipe, RecipeStep } from '../api/types'

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
/** 日付か日時の文字の形 (2025-01-01, 2025/1/1 12:00 など) */
const DATE_TEXT =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * 日時に見える列か. 日時の型の列か, 表として読んで文字のままの列で, よく出る値が全て日付か日時の
 * 文字の形のもの (時刻で分けるときに, 読み方を時系列にする案内に使う)
 */
export function looksLikeDatetime(info: ColumnInfo): boolean {
  if (info.type === 'datetime') return true
  const values = (info.top ?? []).map((item) => item.value)
  return values.length > 0 && values.every((value) => DATE_TEXT.test(value.trim()))
}

export function splitLabel(name: string): string {
  return name === 'unlabeled' ? 'unlabeled (正解なし)' : name
}

/**
 * 版 1 のレシピの中身の手順で, 引数の上限 (`GET /api/info` の item_steps の limits) を
 * 超えた値の理由の並び. 数でない値や上限の無い引数は ML-EDA が確かめるので見ない
 */
export function itemLimitErrors(steps: RecipeStep[], infos: ItemStepInfo[]): string[] {
  const errors: string[] = []
  steps.forEach((step, index) => {
    const info = infos.find((item) => item.op === step.op)
    for (const [name, highest] of Object.entries(info?.limits ?? {})) {
      const value = step[name]
      if (typeof value === 'number' && value > highest) {
        errors.push(
          `中身の手順 ${index + 1} (${step.op}) の ${name} は ${highest} 以下にしてください`,
        )
      }
    }
  })
  return errors
}
