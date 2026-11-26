import type { ModelInputs } from '../../api/types'

/** 出す値の数の説明 (分類はクラスの数, 領域は背景を含むクラスの数, 点群は点の数, 他は値の数) */
function outputsText(model: ModelInputs): string {
  if (model.target_kind === 'mask') {
    if (model.outputs === null) return 'なし (領域のクラスが決まりません)'
    const names = (model.classes ?? []).map(String).join(', ')
    return `${model.outputs} (背景を含む領域のクラスの数${names ? `: ${names}` : ''})`
  }
  if (model.target_kind === 'point_cloud') {
    if (model.outputs === null) return 'なし (出す点の数が決まりません)'
    return `${model.outputs} (出す点の数. 1 点に x, y, z の 3 つの値)`
  }
  if (model.outputs === null) return 'なし (タスクを決めていません)'
  if (model.task === 'classification') return `${model.outputs} (クラスの数)`
  if (model.task === 'anomaly')
    return `${model.outputs} (モデルが入力を作り直す値の数. 学習に使う列の数と同じ)`
  if (model.task === 'uplift')
    return `${model.outputs} (処置したときの予測と, しないときの予測で, それぞれ 1 つの値)`
  if (model.task === 'price') return `${model.outputs} (売れた数の予測. 値段の列は入力の最後)`
  if (model.task === 'demand')
    return `${model.outputs} (先の期間の需要の, 分位点の水準 1 つあたりの値. 学ぶ水準の数をかける)`
  return `${model.outputs} (値)`
}

/** 形の 1 つの次元 (先頭の null はバッチ, 他の null は決まらない大きさ) */
function sizeText(size: number | null, index: number): string {
  if (size !== null) return String(size)
  return index === 0 ? 'バッチ' : '不定'
}

/**
 * モデルに要るもの (ML-EDA の model_inputs). モデルの入力と最後の層の出す数に合わせる.
 * 求められないもの (群分けの表など) は理由を出す
 */
export function ModelNeeds({ model, error }: { model: ModelInputs | null; error?: string | null }) {
  if (model === null) {
    return <p className="text-xs text-ink-2">なし ({error ?? '求められません'})</p>
  }
  return (
    <ul className="space-y-0.5 text-xs">
      {model.inputs.map((input) => (
        <li key={input.name}>
          入力 <span className="font-mono">{input.name}</span>:{' '}
          <span className="font-mono">
            [{input.shape.map(sizeText).join(', ')}] {input.dtype}
          </span>
          {input.vocabulary !== undefined && <>, 語彙の大きさ {input.vocabulary}</>}
        </li>
      ))}
      <li>出す値: {outputsText(model)}</li>
    </ul>
  )
}
