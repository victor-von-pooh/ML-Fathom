import * as echarts from 'echarts'
import { useEffect, useRef } from 'react'

import { baseOption } from './chartTheme'
import { useTheme } from './themeContext'

/**
 * 共通の設定とグラフの設定を合わせる. 軸は 1 段深く合わせる (グラフの軸の
 * 設定で, 暗い表示の軸の色を消さないように)
 */
function mergeOption(
  base: echarts.EChartsOption,
  option: echarts.EChartsOption,
): echarts.EChartsOption {
  const merged: echarts.EChartsOption = { ...base, ...option }
  for (const key of ['xAxis', 'yAxis'] as const) {
    const own = option[key]
    const shared = base[key]
    if (own && !Array.isArray(own) && shared && !Array.isArray(shared)) {
      merged[key] = { ...shared, ...own } as never
    }
  }
  return merged
}

/**
 * ECharts のグラフ. option を変えると描き直し, 大きさの変化に合わせる
 *
 * CSS の変数 (`cssVar`) から色を読む設定は, option を設定を返す関数で渡す. 関数は描く時
 * (明暗の html のクラスを替えた後) に呼ぶので, 切り替えた後は新しい色で描き直す
 */
export function Chart({
  option,
  height = 240,
  label,
  onClick,
}: {
  option: echarts.EChartsOption | (() => echarts.EChartsOption)
  height?: number
  label: string
  onClick?: (params: echarts.ECElementEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const { theme } = useTheme()

  // 作成と破棄, 大きさの変化への追従
  useEffect(() => {
    if (!ref.current) return
    const instance = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chart.current = instance
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [])

  // 設定 (と明るさ) が変わったら描き直す. 色は描画の中でなくここで読む (単独では描画の
  // 後に html のクラスを替えるため)
  useEffect(() => {
    const own = typeof option === 'function' ? option() : option
    chart.current?.setOption(mergeOption(baseOption(), own), { notMerge: true })
  }, [option, theme])

  // 押したときの処理
  useEffect(() => {
    const instance = chart.current
    if (!instance || !onClick) return
    instance.on('click', onClick)
    return () => {
      instance.off('click', onClick)
    }
  }, [onClick])

  return <div ref={ref} role="img" aria-label={label} style={{ height }} className="w-full" />
}
