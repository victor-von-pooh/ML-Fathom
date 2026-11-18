import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'

import { api } from '../../api/client'
import type { CaptureItem } from '../../api/types'
import { Button, ErrorBox, Spinner } from '../../components/ui'
import { PointCloudView } from './PointCloudView'

/** 配置の図の大きさ (画素) と, カメラの最も遠い位置を描く半径 */
const MAP = { size: 280, radius: 110 }

/** 一覧の 1 枚の長い辺 (画素) */
const THUMBNAIL = 192

/** 1 枚の層の名前 */
const LAYERS = {
  image: '画像',
  depth: '深度',
  confidence: '信頼度',
} as const

type Layer = keyof typeof LAYERS

/** 方位 (度. 上から見て反時計回り) と半径の点を, 図の座標にする (画面の y は下向き) */
function polar(degrees: number, radius: number): [number, number] {
  const angle = (degrees * Math.PI) / 180
  const center = MAP.size / 2
  return [center + radius * Math.cos(angle), center - radius * Math.sin(angle)]
}

/** 最も大きい隙間の扇形の道筋 */
function gapPath(from: number, gap: number): string {
  const [x0, y0] = polar(from, MAP.radius + 14)
  const [x1, y1] = polar(from + gap, MAP.radius + 14)
  const center = MAP.size / 2
  const large = gap > 180 ? 1 : 0
  // 画面の y は下向きなので, 反時計回りは掃く向き 0
  return `M ${center} ${center} L ${x0} ${y0} A ${MAP.radius + 14} ${MAP.radius + 14} 0 ${large} 0 ${x1} ${y1} Z`
}

/** 物の中心から上から見たカメラの配置と, 周回の最も大きい隙間 */
function OrbitMap({ layout }: { layout: CaptureItem['layout'] }) {
  const placed = layout.cameras.filter((camera) => camera.x !== null && camera.y !== null)
  if (!layout.orbit || placed.length === 0) {
    return (
      <p className="text-sm text-ink-3">
        物の周りを回った撮影と見なせないので, 配置を描いていません (視線がほぼ平行,
        物の中心が多くのカメラの後ろ, その場で向きだけを変えた, のどれか).
      </p>
    )
  }
  const far = Math.max(...placed.map((camera) => Math.hypot(camera.x!, camera.y!)), 1e-9)
  const scale = MAP.radius / far
  const center = MAP.size / 2
  const label = `上から見たカメラ ${placed.length} 台の配置. 最も大きい方位の隙間 ${(layout.gap ?? 0).toFixed(0)} 度`
  return (
    <figure>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${MAP.size} ${MAP.size}`}
        className="h-auto w-full max-w-72"
      >
        <circle
          cx={center}
          cy={center}
          r={MAP.radius}
          className="fill-none stroke-line"
          strokeDasharray="4 4"
        />
        {layout.gap !== null && layout.gap_from !== null && (
          <path d={gapPath(layout.gap_from, layout.gap)} className="fill-warning/15" />
        )}
        <line x1={center - 6} y1={center} x2={center + 6} y2={center} className="stroke-ink-3" />
        <line x1={center} y1={center - 6} x2={center} y2={center + 6} className="stroke-ink-3" />
        {placed.map((camera) => {
          const x = center + camera.x! * scale
          const y = center - camera.y! * scale
          return (
            <g key={camera.frame}>
              <circle
                cx={x}
                cy={y}
                r={5}
                className={camera.tracked ? 'fill-accent' : 'fill-surface stroke-warning'}
                strokeWidth={camera.tracked ? 0 : 2}
              >
                <title>
                  {camera.frame} 枚目{camera.tracked ? '' : ' (追跡できなかった)'}
                </title>
              </circle>
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-1 text-xs text-ink-3">
        十字が物の中心, 点がカメラ (白抜きは追跡できなかった枚). 破線の円は中心から {far.toFixed(2)}{' '}
        m. 色を付けた扇形が, 方位の最も大きい隙間 ({(layout.gap ?? 0).toFixed(0)} 度.
        その向きから見た形は, 撮った画像からは分かりません)
      </figcaption>
    </figure>
  )
}

/** 撮影の点群を読んで 3D で描く */
function CaptureCloud({ sourceId, index }: { sourceId: string; index: number }) {
  const cloud = useQuery({
    queryKey: ['capture-cloud', sourceId, index],
    queryFn: () => api.captureCloud(sourceId, index),
  })
  if (cloud.isPending) return <Spinner label="点群を読み込み中" />
  if (cloud.error) return <ErrorBox error={cloud.error} />
  return <PointCloudView item={cloud.data} label={`${index} 番目の撮影の点群`} />
}

/** 多視点の撮影の 1 件 (配置, 各枚の画像と深度と信頼度, 点群) */
export function CaptureView({ sourceId, index }: { sourceId: string; index: number }) {
  const [layer, setLayer] = useState<Layer>('image')
  const [showCloud, setShowCloud] = useState(false)
  const item = useQuery({
    queryKey: ['item', sourceId, index],
    queryFn: () => api.item<CaptureItem>(sourceId, index),
  })
  if (item.isPending) return <Spinner label="撮影を読み込み中" />
  if (item.error) return <ErrorBox error={item.error} />
  const data = item.data
  return (
    <div className="space-y-4">
      <OrbitMap layout={data.layout} />
      <section aria-label="各枚">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h3 className="text-xs font-semibold text-ink-2">各枚 ({data.frames.length})</h3>
          <div role="radiogroup" aria-label="見る層" className="flex gap-3 text-sm">
            {(Object.keys(LAYERS) as Layer[]).map((name) => (
              <label key={name} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`layer-${sourceId}-${index}`}
                  checked={layer === name}
                  onChange={() => setLayer(name)}
                />
                {LAYERS[name]}
              </label>
            ))}
          </div>
          {layer !== 'image' && (
            <span className="text-xs text-ink-3">
              深度は枚ごとの 2 % 点から 98 % 点で明るさにしています (明るいほど遠い. 黒は欠け).
              信頼度は明るいほど信頼できる
            </span>
          )}
        </div>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {data.frames.map((frame) => {
            const tracked = frame.tracking === null || frame.tracking === 'TRACKING'
            const has = frame[layer]
            return (
              <li key={frame.index}>
                <figure
                  className={clsx(
                    'rounded-lg border bg-surface p-1',
                    tracked ? 'border-line' : 'border-warning',
                  )}
                >
                  {has ? (
                    <img
                      src={api.captureFrameUrl(sourceId, index, frame.index, layer, THUMBNAIL)}
                      alt={`${frame.index} 枚目の${LAYERS[layer]}`}
                      loading="lazy"
                      className="aspect-video w-full rounded bg-surface-2 object-contain"
                    />
                  ) : (
                    <div className="flex aspect-video w-full items-center justify-center rounded bg-surface-2 text-xs text-ink-3">
                      {LAYERS[layer]}がありません
                    </div>
                  )}
                  <figcaption className="mt-0.5 text-xs text-ink-3">
                    {frame.index} 枚目{tracked ? '' : ' · 追跡できなかった'}
                  </figcaption>
                </figure>
              </li>
            )
          })}
        </ul>
      </section>
      {data.point_cloud && (
        <section aria-label="撮影の点群">
          {showCloud ? (
            <CaptureCloud sourceId={sourceId} index={index} />
          ) : (
            <Button onClick={() => setShowCloud(true)}>撮影の点群を見る</Button>
          )}
        </section>
      )}
    </div>
  )
}
