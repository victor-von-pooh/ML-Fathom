import type { DemandSplits } from '../../api/types'
import { formatNumber } from '../../lib/format'
import { splitLabel } from '../../lib/recipe'

/** 先の期間の合計の分からない行の扱いの言葉 */
const UNLABELED_TEXT: Record<DemandSplits['unlabeled'], string> = {
  drop: '落とす',
  keep: 'unlabeled の分割に残す',
}

/**
 * 時間をまたぐ量の判断の列と期間, 落とした行の数と, 分割ごとの行と商品の数, 発注を決める日の範囲,
 * 先の期間と前の期間の合計の平均, 先の期間に在庫が 0 の日を含む行の数 (ML-EDA の説明の demand.
 * 前処理の様子, 書き出しの結果, データセットの一覧で同じ形)
 */
export function DemandRows({ summary }: { summary: DemandSplits }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs text-ink-3">
        1 行は (商品, 発注を決める日) で, 正解の列{' '}
        <span className="font-mono">{summary.target}</span> はその日から{' '}
        {formatNumber(summary.horizon)} 日 (先の期間) の売れた数の合計, 比べる相手の列{' '}
        <span className="font-mono">{summary.previous}</span> はその日の前の{' '}
        {formatNumber(summary.horizon)} 日 (前の期間) の合計です. 発注を決める日は{' '}
        {formatNumber(summary.interval)} 日ごと. 商品の id の列:{' '}
        <span className="font-mono">{summary.product}</span>. 日付の列:{' '}
        <span className="font-mono">{summary.date}</span>. 日ごとの売れた数の列:{' '}
        <span className="font-mono">{summary.units}</span>. 在庫の数の列:{' '}
        <span className="font-mono">{summary.stock ?? 'なし'}</span>. 行の id の列:{' '}
        <span className="font-mono">{summary.id}</span>. 先の期間の合計の分からない行:{' '}
        {UNLABELED_TEXT[summary.unlabeled] ?? summary.unlabeled}. 落とした行: 前の期間が揃わない{' '}
        {formatNumber(summary.skipped.previous)} 行, 先の期間が分割の境目をまたぐ{' '}
        {formatNumber(summary.skipped.boundary)} 行 (unlabeled
        の分割は先の期間の合計の平均を出しません).
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <caption className="sr-only">
            分割ごとの行と商品の数, 発注を決める日の範囲, 先の期間と前の期間の合計の平均,
            先の期間に在庫が 0 の日を含む行の数
          </caption>
          <thead className="text-ink-3">
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-normal">
                分割
              </th>
              {['行', '商品', '最初の日', '最後の日'].map((name) => (
                <th key={name} scope="col" className="pr-3 text-right font-normal">
                  {name}
                </th>
              ))}
              {['先の期間の合計の平均', '前の期間の合計の平均', '在庫が 0 の日を含む行'].map(
                (name) => (
                  <th key={name} scope="col" className="pr-3 text-right font-normal">
                    {name}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {Object.entries(summary.splits).map(([split, rows]) => (
              <tr key={split} className="border-t border-line">
                <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                  {splitLabel(split)}
                </th>
                {[rows.rows, rows.products].map((value, index) => (
                  <td key={index} className="tabular pr-3 text-right font-mono">
                    {formatNumber(value)}
                  </td>
                ))}
                {[rows.date_min, rows.date_max].map((value, index) => (
                  <td key={index} className="tabular pr-3 text-right font-mono">
                    {value ?? '—'}
                  </td>
                ))}
                {[rows.demand_mean, rows.previous_mean, rows.stockout].map((value, index) => (
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
