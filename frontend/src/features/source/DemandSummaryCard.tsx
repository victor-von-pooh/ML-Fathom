import { useQuery } from '@tanstack/react-query'

import { api } from '../../api/client'
import type { DemandRequest, Recipe } from '../../api/types'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import { formatNumber, formatPercent } from '../../lib/format'
import { DEMAND_HORIZON } from '../../lib/recipe'
import { Findings } from './Findings'

/** 曜日の名前 (ML-EDA の weekday. 0 が月曜) */
const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日']

/** 記録の短い商品とみなす, 先の期間の日数に対する記録の日数の倍 (ML-EDA の short_history と同じ) */
const SHORT = 4

/** 商品の表に並べる行の数の上限 */
const TABLE_ROWS = 20

/** 表の見出しの欄 */
function Head({ names, right = [] }: { names: string[]; right?: string[] }) {
  return (
    <thead className="text-ink-3">
      <tr>
        {names.map((name) => (
          <th
            key={name}
            scope="col"
            className={
              right.includes(name)
                ? 'py-1 pr-3 text-right font-normal'
                : 'py-1 pr-3 text-left font-normal'
            }
          >
            {name}
          </th>
        ))}
      </tr>
    </thead>
  )
}

/** 数の欄 (warn なら注意の色) */
function Num({ value, warn = false }: { value: unknown; warn?: boolean }) {
  return (
    <td
      className={
        warn
          ? 'tabular pr-3 text-right font-mono text-warning-text'
          : 'tabular pr-3 text-right font-mono'
      }
    >
      {formatNumber(value)}
    </td>
  )
}

/**
 * 需要の記録の要約 (ML-EDA の describe_demand). 日付の範囲, 売れた数, 曜日ごとの売れた数,
 * 商品ごとの記録の日数と抜けの日, 在庫が 0 の日と気付きを, 読み込んだ元の日ごとの表で数えて出す
 */
export function DemandSummaryCard({ sourceId, recipe }: { sourceId: string; recipe: Recipe }) {
  // 売れた数, 商品の id, 日付の列を選ぶまでは求めない
  const horizon = recipe.horizon ?? DEMAND_HORIZON
  const body: DemandRequest | null =
    recipe.target && recipe.product && recipe.date
      ? {
          product: recipe.product,
          date: recipe.date,
          units: recipe.target,
          ...(recipe.stock ? { stock: recipe.stock } : {}),
          horizon,
        }
      : null
  const summary = useQuery({
    queryKey: ['demand', sourceId, JSON.stringify(body)],
    queryFn: () => api.demand(sourceId, body!),
    enabled: body !== null,
    retry: false,
  })
  const data = summary.data
  const products = data?.products.rows.slice(0, TABLE_ROWS) ?? []
  return (
    <Card title="需要の記録の要約">
      {body === null && (
        <p className="text-sm text-ink-3">
          {recipe.target
            ? '商品の id の列と日付の列を選ぶと, 商品ごとの記録の日数と抜けの日, 曜日ごとの売れた数, 在庫が 0 の日と気付きを出します.'
            : '上で日ごとの売れた数の列 (目的の列) を選び, 商品の id の列と日付の列を選ぶと, 商品ごとの記録の日数と抜けの日, 曜日ごとの売れた数, 在庫が 0 の日と気付きを出します.'}
        </p>
      )}
      {summary.isFetching && <Spinner label="需要の記録を要約しています" />}
      {summary.error && <ErrorBox error={summary.error} />}
      {data && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-x-4">
            <span>使う行 {formatNumber(data.rows)}</span>
            <span>
              日付 {data.dates.min ?? '—'} 〜 {data.dates.max ?? '—'} (
              {formatNumber(data.dates.days)} 日)
            </span>
            <span>商品 {formatNumber(data.products.count)}</span>
          </div>
          <div className="flex flex-wrap gap-x-4">
            <span>
              売れた数 {formatNumber(data.unit_stats.min)} 〜 {formatNumber(data.unit_stats.max)}{' '}
              (平均 {formatNumber(data.unit_stats.mean)})
            </span>
            <span>売れた数が 0 の日 {formatPercent(data.unit_stats.zero_rate)}</span>
          </div>
          <div className="flex flex-wrap gap-x-4">
            <span className={data.products.short > 0 ? 'text-warning-text' : undefined}>
              記録の短い商品 {formatNumber(data.products.short)}
            </span>
            <span className={data.products.gaps > 0 ? 'text-warning-text' : undefined}>
              抜けの日のある商品 {formatNumber(data.products.gaps)} (抜けの日は計{' '}
              {formatNumber(data.products.missing_days)} 日)
            </span>
            {data.stockout && (
              <span className={data.stockout.rows > 0 ? 'text-warning-text' : undefined}>
                在庫が 0 の日 {formatNumber(data.stockout.rows)} (
                {formatPercent(data.stockout.rate)}, {formatNumber(data.stockout.products)} 商品)
              </span>
            )}
          </div>
          <p className="text-xs text-ink-3">
            {`先の期間は ${formatNumber(horizon)} 日です. 記録の短い商品は, 記録の日数が先の期間の ${SHORT} 倍 (${formatNumber(horizon * SHORT)} 日) 未満の商品です (前の期間と先の期間で ${formatNumber(horizon * 2)} 日を使うので, 書き出す行がわずかか, 作れません). 抜けの日は, 商品の最初の日から最後の日の間で行の無い日で, 抜けの日を含む期間は合計を作らず書き出しの行が減ります. 売れなかった日なら, 読み込む前の表に売れた数 0 の行を足してください. `}
            {data.stockout
              ? '在庫が 0 の日の売れた数は需要より少なく記録される (品切れで抑えられた) ので, 学んだ需要が少なめになります. '
              : '在庫の数の列を選ぶと, 在庫が 0 の日 (品切れで売れた数が抑えられた日) を数えます. '}
            {`使う行は, 商品の id と日付が分かり, 売れた数が 0 以上の数の行で, 前処理の手順をかける前の表で数えます. 欠けた行: 商品の id ${formatNumber(data.missing.product)} 行, 日付 ${formatNumber(data.missing.date)} 行, 売れた数 ${formatNumber(data.missing.units)} 行. 値の誤り: 日付 ${formatNumber(data.invalid.date)} 行, 売れた数 ${formatNumber(data.invalid.units)} 行. 同じ商品の同じ日の行: ${formatNumber(data.duplicates)} 行.`}
          </p>
          <Findings findings={data.findings} />
          {data.weekdays.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <caption className="mb-1 text-left text-ink-3">
                  {
                    '曜日ごとの売れた数. 曜日で平均が違えば, 曜日の列 (datetime_parts の weekday) が手がかりになります'
                  }
                </caption>
                <Head names={['曜日', '行', '売れた数の平均']} right={['行', '売れた数の平均']} />
                <tbody>
                  {data.weekdays.map((item) => (
                    <tr key={item.weekday} className="border-t border-line">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">
                        {WEEKDAYS[item.weekday] ?? item.weekday}
                      </th>
                      <Num value={item.rows} />
                      <Num value={item.units_mean} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {products.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <caption className="mb-1 text-left text-ink-3">
                  {`商品ごとの記録. 記録の日数の少ない順に ${TABLE_ROWS} 商品まで. 記録の短い商品と抜けの日と在庫が 0 の日のある商品の数を注意の色で出します`}
                </caption>
                <Head
                  names={[
                    '商品',
                    '記録の日数',
                    '最初の日',
                    '最後の日',
                    '抜けの日',
                    '在庫が 0 の日',
                    '売れた数の平均',
                  ]}
                  right={['記録の日数', '抜けの日', '在庫が 0 の日', '売れた数の平均']}
                />
                <tbody>
                  {products.map((item) => (
                    <tr key={item.product} className="border-t border-line">
                      <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                        {item.product}
                      </th>
                      <Num value={item.days} warn={item.days < horizon * SHORT} />
                      <td className="tabular pr-3 font-mono">{item.first}</td>
                      <td className="tabular pr-3 font-mono">{item.last}</td>
                      <Num value={item.gaps} warn={item.gaps > 0} />
                      <Num value={item.stockout} warn={(item.stockout ?? 0) > 0} />
                      <Num value={item.units_mean} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
