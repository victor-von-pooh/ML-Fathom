/** 配置の図の大きさ (画素) と, カメラの最も遠い位置を描く半径 */
export const MAP = { size: 280, radius: 110 }

/** 方位 (度. 上から見て反時計回り) と半径の点を, 図の座標にする (画面の y は下向き) */
export function polar(degrees: number, radius: number): [number, number] {
  const angle = (degrees * Math.PI) / 180
  const center = MAP.size / 2
  return [center + radius * Math.cos(angle), center - radius * Math.sin(angle)]
}

/**
 * 最も大きい隙間の扇形の道筋 (from から反時計回りに gap 度).
 * ほぼ一周の隙間は, 始まりと終わりが重なって弧を描けないので円にする
 */
export function gapPath(from: number, gap: number): string {
  const radius = MAP.radius + 14
  const center = MAP.size / 2
  if (gap >= 359.9) {
    return `M ${center - radius} ${center} A ${radius} ${radius} 0 1 0 ${center + radius} ${center} A ${radius} ${radius} 0 1 0 ${center - radius} ${center} Z`
  }
  const [x0, y0] = polar(from, radius)
  const [x1, y1] = polar(from + gap, radius)
  const large = gap > 180 ? 1 : 0
  // 画面の y は下向きなので, 反時計回りは掃く向き 0
  return `M ${center} ${center} L ${x0} ${y0} A ${radius} ${radius} 0 ${large} 0 ${x1} ${y1} Z`
}
