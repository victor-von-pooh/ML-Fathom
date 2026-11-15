import * as echarts from 'echarts'
import { useEffect, useRef } from 'react'

import { baseOption } from './chartTheme'
import { useTheme } from './themeContext'

/** ECharts のグラフ. option を変えると描き直し, 大きさの変化に合わせる */
export function Chart({
  option,
  height = 240,
  label,
  onClick,
}: {
  option: echarts.EChartsOption
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

  // 設定 (と明るさ) が変わったら描き直す
  useEffect(() => {
    chart.current?.setOption({ ...baseOption(), ...option }, { notMerge: true })
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
