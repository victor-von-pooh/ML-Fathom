import { useQuery } from '@tanstack/react-query'

import { api } from '../../api/client'
import type { PriceRequest, Recipe } from '../../api/types'
import { Card, ErrorBox, Spinner } from '../../components/ui'
import { formatNumber, formatPercent } from '../../lib/format'
import { Findings } from './Findings'

/** 値段と強く関わるとみなす関わりの強さ (ML-EDA の price_confounded と同じ) */
const CONFOUNDED = 0.3

/** 関わりの表と商品の表に並べる行の数の上限 */
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

/** 数の欄 */
function Num({ value }: { value: unknown }) {
  return <td className="tabular pr-3 text-right font-mono">{formatNumber(value)}</td>
}

/**
 * 値段を変えた記録の要約 (ML-EDA の describe_price). 値段の幅と数, 売れた数, 値段と売れた数の
 * 関わり (順位の相関と弾力性の目安, 値段の段ごとの売れた数), 商品ごとの試した値段, 原価, 値段と
 * 他の列の関わりと気付きを, 読み込んだ元の表で数えて出す
 */
export function PriceSummaryCard({ sourceId, recipe }: { sourceId: string; recipe: Recipe }) {
  // 売れた数の列と値段の列を選ぶまでは求めない
  const body: PriceRequest | null =
    recipe.target && recipe.price
      ? {
          price: recipe.price,
          units: recipe.target,
          ...(recipe.cost ? { cost: recipe.cost } : {}),
          ...(recipe.product ? { product: recipe.product } : {}),
          ...(recipe.id ? { id: recipe.id } : {}),
        }
      : null
  const summary = useQuery({
    queryKey: ['price', sourceId, JSON.stringify(body)],
    queryFn: () => api.price(sourceId, body!),
    enabled: body !== null,
    retry: false,
  })
  const data = summary.data
  const confounding = data?.confounding.slice(0, TABLE_ROWS) ?? []
  const products = data?.products?.rows.slice(0, TABLE_ROWS) ?? []
  const elasticity = data?.relation.elasticity ?? null
  return (
    <Card title="値段を変えた記録の要約">
      {body === null && (
        <p className="text-sm text-ink-3">
          {recipe.target
            ? '値段の列を選ぶと, 値段の幅と数, 値段と売れた数の関わり, 商品ごとの試した値段と気付きを出します.'
            : '上で売れた数の列 (目的の列) を選び, 値段の列を選ぶと, 値段の幅と数, 値段と売れた数の関わり, 商品ごとの試した値段と気付きを出します.'}
        </p>
      )}
      {summary.isFetching && <Spinner label="値段を変えた記録を要約しています" />}
      {summary.error && <ErrorBox error={summary.error} />}
      {data && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-x-4">
            <span>使う行 {formatNumber(data.rows)}</span>
            <span>値段の種類 {formatNumber(data.price_stats.distinct)}</span>
            <span>
              値段 {formatNumber(data.price_stats.min)} 〜 {formatNumber(data.price_stats.max)}{' '}
              (中央値 {formatNumber(data.price_stats.median)})
            </span>
            <span>値段の幅 {formatPercent(data.price_stats.width)}</span>
          </div>
          <div className="flex flex-wrap gap-x-4">
            <span>
              売れた数 {formatNumber(data.unit_stats.min)} 〜 {formatNumber(data.unit_stats.max)}{' '}
              (平均 {formatNumber(data.unit_stats.mean)})
            </span>
            <span>売れた数が 0 の行 {formatPercent(data.unit_stats.zero_rate)}</span>
          </div>
          <div className="flex flex-wrap gap-x-4">
            <span className="font-semibold">弾力性の目安 {formatNumber(elasticity)}</span>
            <span>値段と売れた数の順位の相関 {formatNumber(data.relation.correlation)}</span>
          </div>
          <p className="text-xs text-ink-3">
            弾力性は, 値段を 1 % 上げたときに売れた数が何 % 変わるかの目安です
            {elasticity !== null &&
              (elasticity < 0
                ? ` (この記録では, 値段を 1 % 上げると売れた数がおよそ ${formatNumber(Math.abs(elasticity))} % 減ります)`
                : ' (この記録では, 値段を上げても売れた数が減っていません. 値段の変え方を確かめてください)')}
            . 負なら値段を上げると売れた数が減ります. 順位の相関は -1 から 1 で,
            負なら値段の高い行ほど売れた数が少なめです. 値段の幅は (最大 − 最小) / 中央値で
            {data.products ? ', 商品ごとの幅の中央値です' : ''}. 使う行は, 値段 (0 より大きい数)
            と売れた数 (0 以上の数){data.products ? 'と商品の id ' : ''}が分かる行で,
            前処理の手順をかける前の表で数えます. 欠けた行: 値段 {formatNumber(data.missing.price)}{' '}
            行, 売れた数 {formatNumber(data.missing.units)} 行. 値の誤り: 値段{' '}
            {formatNumber(data.invalid.price)} 行, 売れた数 {formatNumber(data.invalid.units)} 行.
          </p>
          {data.cost_stats && (
            <div className="flex flex-wrap gap-x-4">
              <span>原価の平均 {formatNumber(data.cost_stats.mean)}</span>
              <span>利幅の平均 {formatPercent(data.cost_stats.margin)}</span>
              <span>値段が原価より低い行 {formatNumber(data.cost_stats.below)}</span>
            </div>
          )}
          {data.cost_stats && (
            <p className="text-xs text-ink-3">
              利幅は, 値段に対する (値段 − 原価) の割合です. 利益は (値段 − 原価) ×
              売れた数で数えます.
            </p>
          )}
          <Findings findings={data.findings} />
          {data.relation.bins.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <caption className="mb-1 text-left text-ink-3">
                  {
                    '値段の段ごとの売れた数. 段は, 行を値段の安い順に 5 つに等しく分けたもの (書き出しの分割の層と同じ) です. 段ごとに売れた数の平均が違えば, 値段で売れ行きが変わることが見えます. 値段の高い段ほど平均が下がるのが, 値段を上げると売れにくくなる記録です'
                  }
                </caption>
                <Head
                  names={['段', '行', '値段の範囲', '値段の平均', '売れた数の平均']}
                  right={['行', '値段の平均', '売れた数の平均']}
                />
                <tbody>
                  {data.relation.bins.map((item) => (
                    <tr key={item.bin} className="border-t border-line">
                      <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                        {item.bin + 1}
                      </th>
                      <Num value={item.rows} />
                      <td className="tabular pr-3 font-mono">
                        {formatNumber(item.price_min)} 〜 {formatNumber(item.price_max)}
                      </td>
                      <Num value={item.price_mean} />
                      <Num value={item.units_mean} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.products && (
            <div className="flex flex-wrap gap-x-4">
              <span>商品 {formatNumber(data.products.count)}</span>
              <span>試した値段が 1 つの商品 {formatNumber(data.products.single_price)}</span>
            </div>
          )}
          {products.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <caption className="mb-1 text-left text-ink-3">
                  商品ごとの試した値段. 試した値段の少ない順に {TABLE_ROWS} 商品まで. 試した値段が 1
                  つの商品は, 値段を変えたときの売れ行きを他の商品からしか学べません
                </caption>
                <Head
                  names={['商品', '行', '試した値段', '値段の範囲', '売れた数の平均']}
                  right={['行', '試した値段', '売れた数の平均']}
                />
                <tbody>
                  {products.map((item) => (
                    <tr key={item.product} className="border-t border-line">
                      <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                        {item.product}
                      </th>
                      <Num value={item.rows} />
                      <td
                        className={
                          item.prices < 2
                            ? 'tabular pr-3 text-right font-mono text-warning-text'
                            : 'tabular pr-3 text-right font-mono'
                        }
                      >
                        {formatNumber(item.prices)}
                      </td>
                      <td className="tabular pr-3 font-mono">
                        {formatNumber(item.price_min)} 〜 {formatNumber(item.price_max)}
                      </td>
                      <Num value={item.units_mean} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!recipe.product && (
            <p className="text-xs text-ink-3">
              {
                '商品の id の列を選ぶと, 商品ごとの試した値段を出し, 値段の幅と他の列の関わりを, 商品ごとの値段の高さの違いを除いて数えます.'
              }
            </p>
          )}
          {confounding.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <caption className="mb-1 text-left text-ink-3">
                  {`値段と他の列の関わり. 強さは, 値段とその列の関わりの強さ (0 から 1) です. 0 に近いほど, 値段を無作為に近く変えた記録に見えます (目安: ${CONFOUNDED} 以上なら, その列に合わせて値段を決めた記録かもしれません). 強い順に ${TABLE_ROWS} 列まで`}
                </caption>
                <Head names={['列', '型', '強さ']} right={['強さ']} />
                <tbody>
                  {confounding.map((item) => {
                    const strong = item.strength !== null && item.strength >= CONFOUNDED
                    return (
                      <tr key={item.column} className="border-t border-line">
                        <th scope="row" className="py-1 pr-3 text-left font-mono font-normal">
                          {item.column}
                        </th>
                        <td className="pr-3">{item.type}</td>
                        <td
                          className={
                            strong
                              ? 'tabular pr-3 text-right font-mono text-warning-text'
                              : 'tabular pr-3 text-right font-mono'
                          }
                        >
                          {formatNumber(item.strength)}
                          {strong && ' (値段と強く関わる)'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
