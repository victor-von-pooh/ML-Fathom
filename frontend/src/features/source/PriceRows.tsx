import type { PriceSplits } from '../../api/types'
import { formatNumber } from '../../lib/format'
import { splitLabel } from '../../lib/recipe'

/** 売れた数の欠けた行の扱いの言葉 */
const UNLABELED_TEXT: Record<PriceSplits['unlabeled'], string> = {
  drop: '落とす',
  keep: 'unlabeled の分割に残す',
}

/**
 * 値段を変える判断の分割ごとの行と商品の数, 元の値段の範囲, 売れた数と原価の平均 (ML-EDA の説明の
 * price. 前処理の様子, 書き出しの結果, データセットの一覧で同じ形)
 */
export function PriceRows({ summary }: { summary: PriceSplits }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs text-ink-3">
        値段の列: <span className="font-mono">{summary.price}</span> (学習に使う列の最後.
        値段の手順: {summary.steps.length > 0 ? summary.steps.join(', ') : 'なし'}). 元の値段の列:{' '}
        <span className="font-mono">{summary.raw}</span>. 原価の列:{' '}
        <span className="font-mono">{summary.cost ?? 'なし (利益は売上で数える)'}</span>. 商品の id
        の列: <span className="font-mono">{summary.product ?? 'なし'}</span>. 行の id の列:{' '}
        <span className="font-mono">{summary.id}</span>. 売れた数の欠けた行:{' '}
        {UNLABELED_TEXT[summary.unlabeled] ?? summary.unlabeled}. 値段は手順をかける前の元の値段です
        (unlabeled の分割は売れた数の平均を出しません).
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <caption className="sr-only">
            分割ごとの行と商品の数, 元の値段の範囲と種類の数, 売れた数と原価の平均
          </caption>
          <thead className="text-ink-3">
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-normal">
                分割
              </th>
              {[
                '行',
                '商品',
                '値段の最小',
                '値段の最大',
                '値段の種類',
                '売れた数の平均',
                '原価の平均',
              ].map((name) => (
                <th key={name} scope="col" className="pr-3 text-right font-normal">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(summary.splits).map(([split, rows]) => (
              <tr key={split} className="border-t border-line">
                <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                  {splitLabel(split)}
                </th>
                {[
                  rows.rows,
                  rows.products,
                  rows.price_min,
                  rows.price_max,
                  rows.prices,
                  rows.units_mean,
                  rows.cost_mean,
                ].map((value, index) => (
                  <td key={index} className="tabular pr-3 text-right font-mono">
                    {formatNumber(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
