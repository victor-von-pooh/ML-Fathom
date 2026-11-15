import { useEffect, useRef, useState } from 'react'

import type { PointsItem } from '../../api/types'
import { cssVar } from '../../lib/chartTheme'

/** 点群の 3D 表示 (ドラッグで回し, ホイールで拡大する. 色が無ければ高さで色付け) */
export function PointCloudView({ item, label }: { item: PointsItem; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [angles, setAngles] = useState({ yaw: 0.6, pitch: 0.4 })
  const [zoom, setZoom] = useState(1)
  const drag = useRef<{ x: number; y: number } | null>(null)

  // 回転と拡大が変わるたびに描き直す
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const context = element.getContext('2d')
    if (!context) return
    const { width, height } = element
    context.fillStyle = cssVar('--surface-2')
    context.fillRect(0, 0, width, height)
    const values = item.points
    const count = values.length / 3
    if (count === 0) return

    // 中心と大きさをそろえる
    const center = [0, 0, 0]
    for (let i = 0; i < count; i += 1) {
      for (let axis = 0; axis < 3; axis += 1) center[axis]! += values[i * 3 + axis]! / count
    }
    let radius = 0
    for (let i = 0; i < count; i += 1) {
      const dx = values[i * 3]! - center[0]!
      const dy = values[i * 3 + 1]! - center[1]!
      const dz = values[i * 3 + 2]! - center[2]!
      radius = Math.max(radius, Math.hypot(dx, dy, dz))
    }
    const scale = ((Math.min(width, height) / 2) * 0.9 * zoom) / (radius || 1)
    const cy = Math.cos(angles.yaw)
    const sy = Math.sin(angles.yaw)
    const cp = Math.cos(angles.pitch)
    const sp = Math.sin(angles.pitch)

    // 回した後の奥行きの順に, 奥から描く
    const projected: { x: number; y: number; depth: number; index: number }[] = []
    let low = Infinity
    let high = -Infinity
    for (let i = 0; i < count; i += 1) {
      const x = values[i * 3]! - center[0]!
      const y = values[i * 3 + 1]! - center[1]!
      const z = values[i * 3 + 2]! - center[2]!
      const x1 = cy * x + sy * y
      const y1 = -sy * x + cy * y
      const depth = cp * y1 + sp * z
      const up = -sp * y1 + cp * z
      projected.push({ x: width / 2 + x1 * scale, y: height / 2 - up * scale, depth, index: i })
      low = Math.min(low, z)
      high = Math.max(high, z)
    }
    projected.sort((a, b) => b.depth - a.depth)
    const size = count > 20000 ? 1 : count > 5000 ? 1.5 : 2
    for (const point of projected) {
      const colors = item.colors
      if (colors) {
        const k = point.index * 3
        context.fillStyle = `rgb(${colors[k]},${colors[k + 1]},${colors[k + 2]})`
      } else {
        const t =
          high > low ? (values[point.index * 3 + 2]! - center[2]! - low) / (high - low) : 0.5
        context.fillStyle = `hsl(${220 - 200 * t} 70% 50%)`
      }
      context.fillRect(point.x, point.y, size, size)
    }
  }, [item, angles, zoom])

  return (
    <canvas
      ref={canvas}
      width={640}
      height={420}
      role="img"
      aria-label={label}
      tabIndex={0}
      className="w-full max-w-[640px] cursor-grab rounded-lg border border-line"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        const dx = event.clientX - drag.current.x
        const dy = event.clientY - drag.current.y
        drag.current = { x: event.clientX, y: event.clientY }
        setAngles((current) => ({
          yaw: current.yaw + dx * 0.01,
          pitch: Math.max(-1.5, Math.min(1.5, current.pitch + dy * 0.01)),
        }))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onWheel={(event) =>
        setZoom((current) => Math.max(0.2, Math.min(8, current * (event.deltaY < 0 ? 1.1 : 0.9))))
      }
      onKeyDown={(event) => {
        const steps: Record<string, [number, number]> = {
          ArrowLeft: [-0.1, 0],
          ArrowRight: [0.1, 0],
          ArrowUp: [0, -0.1],
          ArrowDown: [0, 0.1],
        }
        const step = steps[event.key]
        if (!step) return
        event.preventDefault()
        setAngles((current) => ({ yaw: current.yaw + step[0], pitch: current.pitch + step[1] }))
      }}
    />
  )
}
