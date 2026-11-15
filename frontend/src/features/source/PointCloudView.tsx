import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { PointsItem } from '../../api/types'
import { cssVar } from '../../lib/chartTheme'
import { useTheme } from '../../lib/themeContext'

// 上下の回転の上限 (真上と真下で裏返らないように)
const PITCH_LIMIT = 1.5

// 拡大の範囲
const ZOOM_RANGE = [0.2, 8] as const

// 描く大きさ (CSS の画素)
const VIEW = { width: 640, height: 420 }

/** 中心を原点に, 最も遠い点を 1 にそろえた座標と, 点ごとの色 */
interface Prepared {
  coords: Float32Array
  colors: string[]
}

/** 点を中心と大きさでそろえ, 色の文字を 1 度だけ作る */
function prepare(item: PointsItem): Prepared {
  const values = item.points
  const count = values.length / 3
  const center = [0, 0, 0]
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) center[axis]! += values[i * 3 + axis]! / count
  }
  const coords = new Float32Array(count * 3)
  let radius = 0
  let low = Infinity
  let high = -Infinity
  for (let i = 0; i < count; i += 1) {
    const x = values[i * 3]! - center[0]!
    const y = values[i * 3 + 1]! - center[1]!
    const z = values[i * 3 + 2]! - center[2]!
    coords[i * 3] = x
    coords[i * 3 + 1] = y
    coords[i * 3 + 2] = z
    radius = Math.max(radius, Math.hypot(x, y, z))
    low = Math.min(low, z)
    high = Math.max(high, z)
  }
  const scale = radius || 1
  for (let i = 0; i < coords.length; i += 1) coords[i]! /= scale

  // 色が無ければ高さで青から赤へ
  const colors: string[] = []
  const source = item.colors
  for (let i = 0; i < count; i += 1) {
    if (source) {
      colors.push(`rgb(${source[i * 3]},${source[i * 3 + 1]},${source[i * 3 + 2]})`)
    } else {
      const t = high > low ? (values[i * 3 + 2]! - center[2]! - low) / (high - low) : 0.5
      colors.push(`hsl(${Math.round(220 - 200 * t)} 70% 50%)`)
    }
  }
  return { coords, colors }
}

/** 点群の 3D 表示 (ドラッグで回し, ホイールで拡大する. 色が無ければ高さで色付け) */
export function PointCloudView({ item, label }: { item: PointsItem; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [angles, setAngles] = useState({ yaw: 0.6, pitch: 0.4 })
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(VIEW.width)
  const drag = useRef<{ x: number; y: number; id: number } | null>(null)
  const { theme } = useTheme()
  const helpId = useId()
  const prepared = useMemo(() => prepare(item), [item])

  // 表示の幅に合わせて描く大きさを変える (狭い画面と高い画素密度)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(1, Math.round(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // ホイールの拡大で画面が動かないように, passive でない受け取りにする
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setZoom((current) => clampZoom(current * (event.deltaY < 0 ? 1.1 : 0.9)))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // 回転, 拡大, 大きさ, 表示の色が変わったら次の描画の機会に描き直す
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const frame = requestAnimationFrame(() => {
      const ratio = window.devicePixelRatio || 1
      const height = Math.round((width * VIEW.height) / VIEW.width)
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
      const context = element.getContext('2d')
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.fillStyle = cssVar('--surface-2')
      context.fillRect(0, 0, width, height)
      draw(context, prepared, angles, zoom, width, height)
    })
    return () => cancelAnimationFrame(frame)
  }, [prepared, angles, zoom, width, theme])

  const endDrag = () => {
    drag.current = null
  }
  return (
    <div>
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        aria-describedby={helpId}
        tabIndex={0}
        style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}` }}
        className="w-full max-w-[640px] cursor-grab touch-none rounded-lg border border-line focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          drag.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start || start.id !== event.pointerId) return
          const dx = event.clientX - start.x
          const dy = event.clientY - start.y
          drag.current = { ...start, x: event.clientX, y: event.clientY }
          setAngles((current) => turn(current, dx * 0.01, dy * 0.01))
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={(event) => {
          const steps: Record<string, [number, number]> = {
            ArrowLeft: [-0.1, 0],
            ArrowRight: [0.1, 0],
            ArrowUp: [0, -0.1],
            ArrowDown: [0, 0.1],
          }
          const step = steps[event.key]
          if (step) {
            event.preventDefault()
            setAngles((current) => turn(current, step[0], step[1]))
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            setZoom((current) => clampZoom(current * 1.1))
          } else if (event.key === '-') {
            event.preventDefault()
            setZoom((current) => clampZoom(current * 0.9))
          } else if (event.key === '0') {
            event.preventDefault()
            setAngles({ yaw: 0.6, pitch: 0.4 })
            setZoom(1)
          }
        }}
      />
      <p id={helpId} className="mt-1 text-xs text-ink-3">
        ドラッグか矢印キーで回し, ホイールか + と - で拡大, 0 で元に戻す.
        色が無い点群は高さで色付け.
      </p>
    </div>
  )
}

/** 回転を足す (上下は上限まで) */
function turn(current: { yaw: number; pitch: number }, yaw: number, pitch: number) {
  return {
    yaw: current.yaw + yaw,
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, current.pitch + pitch)),
  }
}

/** 拡大を範囲に収める */
function clampZoom(value: number) {
  return Math.max(ZOOM_RANGE[0], Math.min(ZOOM_RANGE[1], value))
}

/** 回した後の奥行きの順に, 奥から点を描く */
function draw(
  context: CanvasRenderingContext2D,
  { coords, colors }: Prepared,
  angles: { yaw: number; pitch: number },
  zoom: number,
  width: number,
  height: number,
) {
  const count = coords.length / 3
  if (count === 0) return
  const scale = (Math.min(width, height) / 2) * 0.9 * zoom
  const cy = Math.cos(angles.yaw)
  const sy = Math.sin(angles.yaw)
  const cp = Math.cos(angles.pitch)
  const sp = Math.sin(angles.pitch)
  const xs = new Float32Array(count)
  const ys = new Float32Array(count)
  const depths = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const x = coords[i * 3]!
    const y = coords[i * 3 + 1]!
    const z = coords[i * 3 + 2]!
    const x1 = cy * x + sy * y
    const y1 = -sy * x + cy * y
    depths[i] = cp * y1 + sp * z
    xs[i] = width / 2 + x1 * scale
    ys[i] = height / 2 - (-sp * y1 + cp * z) * scale
  }
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i += 1) order[i] = i
  order.sort((a, b) => depths[b]! - depths[a]!)
  const size = count > 20000 ? 1 : count > 5000 ? 1.5 : 2
  let last = ''
  for (const i of order) {
    const color = colors[i]!
    if (color !== last) {
      context.fillStyle = color
      last = color
    }
    context.fillRect(xs[i]!, ys[i]!, size, size)
  }
}
