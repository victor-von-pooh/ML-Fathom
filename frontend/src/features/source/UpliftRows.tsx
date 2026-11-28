import type { UpliftSplits } from '../../api/types'
import { formatNumber } from '../../lib/format'
import { OUTCOME_TEXT, splitLabel } from '../../lib/recipe'

/** 結果の欠けた行の扱いの言葉 */
const UNLABELED_TEXT: Record<UpliftSplits['unlabeled'], string> = {
  drop: '落とす',
  keep: 'unlabeled の分割に残す',
}

/**
 * 効果を見積もるの分割ごとの処置の群と対照の群の行の数, 結果の平均と差 (ML-EDA の説明の
 * uplift. 前処理の様子, 書き出しの結果, データセットの一覧で同じ形)
 */
export function UpliftRows({ summary }: { summary: UpliftSplits }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs text-ink-3">
        処置の列: <span className="font-mono">{summary.treatment}</span>. 結果の種類:{' '}
        {OUTCOME_TEXT[summary.outcome] ?? summary.outcome}. 結果の欠けた行:{' '}
        {UNLABELED_TEXT[summary.unlabeled] ?? summary.unlabeled}. 行の id の列:{' '}
        <span className="font-mono">{summary.id}</span>. 処置の群は処置の列が 1 の行 (配った行),
        対照の群は 0 の行 (配らなかった行) です. 差は処置の群の平均 − 対照の群の平均です (unlabeled
        の分割は行の数だけ).
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <caption className="sr-only">
            分割ごとの処置の群と対照の群の行の数, 群ごとの結果の平均と差
          </caption>
          <thead className="text-ink-3">
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-normal">
                分割
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                処置の群
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                対照の群
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                処置の群の平均
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                対照の群の平均
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                差
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(summary.splits).map(([split, rows]) => (
              <tr key={split} className="border-t border-line">
                <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                  {splitLabel(split)}
                </th>
                <td className="tabular-nums pr-3 text-right font-mono">
                  {formatNumber(rows.treated)}
                </td>
                <td className="tabular-nums pr-3 text-right font-mono">
                  {formatNumber(rows.control)}
                </td>
                <td className="tabular-nums pr-3 text-right font-mono">
                  {formatNumber(rows.treated_mean)}
                </td>
                <td className="tabular-nums pr-3 text-right font-mono">
                  {formatNumber(rows.control_mean)}
                </td>
                <td className="tabular-nums pr-3 text-right font-mono">
                  {formatNumber(rows.effect)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
