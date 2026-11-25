import type { AnomalySplitRows, AnomalySummary } from '../../api/types'
import { formatNumber, formatPercent } from '../../lib/format'
import { anomalyTotals, splitLabel } from '../../lib/recipe'

/** 分割ごとの表の列 (ML-EDA の説明の anomaly.rows の鍵と見出し) */
const COLUMNS: [keyof AnomalySplitRows, string][] = [
  ['normal', '正常'],
  ['presumed', '正常と見なした'],
  ['anomaly', '異常'],
  ['unlabeled', '正解なし'],
]

/** 正解の欠けた行の扱いの言葉 */
const UNLABELED_TEXT: Record<AnomalySummary['unlabeled'], string> = {
  drop: '落とす',
  keep: 'unlabeled の分割に残す',
  normal: '正常と見なす',
}

/**
 * 異常の検知の正解の数と異常の割合と, 分割ごとの行の数 (ML-EDA の説明の anomaly.
 * 前処理の様子, 書き出しの結果, データセットの一覧で同じ形)
 */
export function AnomalyRows({ summary }: { summary: AnomalySummary }) {
  const totals = anomalyTotals(summary)
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap gap-x-4">
        <span>正解の付いた行 {formatNumber(totals.labeled)}</span>
        <span>異常の行 {formatNumber(totals.anomaly)}</span>
        <span>正常と見なした行 {formatNumber(totals.presumed)}</span>
        <span>異常の割合 {formatPercent(totals.ratio)}</span>
      </div>
      <p className="text-xs text-ink-3">
        {summary.labeled
          ? `正解の欠けた行: ${UNLABELED_TEXT[summary.unlabeled]}. `
          : '正解の列が無いので, 全ての行を正常と見なします. '}
        異常の割合は, 正常の行 (正解が正常と, 正常と見なした行) と異常の行に対する異常の行の割合です
        (正解なしの行は数えません). 学習用 (train) は正常の行だけです. 行の id の列:{' '}
        <span className="font-mono">{summary.id}</span>
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <caption className="sr-only">
            分割ごとの正常, 正常と見なした, 異常, 正解なしの行の数
          </caption>
          <thead className="text-ink-3">
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-normal">
                分割
              </th>
              {COLUMNS.map(([key, label]) => (
                <th key={key} scope="col" className="pr-3 text-right font-normal">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(summary.rows).map(([split, rows]) => (
              <tr key={split} className="border-t border-line">
                <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                  {splitLabel(split)}
                </th>
                {COLUMNS.map(([key]) => (
                  <td key={key} className="tabular pr-3 text-right font-mono">
                    {formatNumber(rows[key] ?? 0)}
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
