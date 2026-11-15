import type { Profile, Source } from '../../api/types'

/** 画像, 文, 点群の中身を 1 件ずつ見る (種類ごとの表示は後で加える) */
export function SamplesTab({ source, profile }: { source: Source; profile: Profile }) {
  return (
    <p className="text-sm text-ink-3">
      {source.name} ({profile.overview.rows} 件) の中身の表示は準備中です.
    </p>
  )
}
