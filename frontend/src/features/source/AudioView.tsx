import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'

import { api } from '../../api/client'
import type { AudioItem } from '../../api/types'
import { ErrorBox, Spinner } from '../../components/ui'
import { formatNumber } from '../../lib/format'
import { formatSeconds, WAVE, waveformPath } from '../../lib/waveform'

/** 1 つの音声の再生と波形 (どちらも先頭の決まった秒まで) */
export function AudioView({ sourceId, index }: { sourceId: string; index: number }) {
  const item = useQuery({
    queryKey: ['item', sourceId, index],
    queryFn: () => api.item<AudioItem>(sourceId, index),
  })
  if (item.isPending) return <Spinner label="音声を読み込み中" />
  if (item.error) return <ErrorBox error={item.error} />
  return (
    <AudioPlayer
      audio={item.data}
      src={api.itemAudioUrl(sourceId, index)}
      name={`${index} 番目の音声`}
    />
  )
}

/** 読んだ音声の再生の部品と波形 (name は読み上げの名前. 「3 番目の音声」など) */
export function AudioPlayer({
  audio,
  src,
  name,
  height = 'h-40',
}: {
  audio: AudioItem
  src: string
  name: string
  /** 波形の高さ (Tailwind の class) */
  height?: string
}) {
  // 再生した位置 (秒) と, 鳴らせなかったか
  const [position, setPosition] = useState(0)
  const [failed, setFailed] = useState(false)
  const at = audio.seconds > 0 ? Math.min(position / audio.seconds, 1) * WAVE.width : 0
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-3">
        {formatNumber(audio.sample_rate)} Hz · {audio.channels} チャンネル · 長さ{' '}
        {formatSeconds(audio.duration ?? audio.seconds)}
        {audio.truncated && ` (再生と波形は先頭の ${formatSeconds(audio.seconds)}だけ)`}
      </p>
      {failed ? (
        <p className="text-sm text-warning-text">このブラウザでは再生できませんでした.</p>
      ) : (
        <audio
          controls
          preload="metadata"
          src={src}
          aria-label={`${name}の再生`}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onError={() => setFailed(true)}
          className="w-full"
        />
      )}
      <figure>
        <svg
          role="img"
          aria-label={`${name}の波形 (${formatSeconds(audio.seconds)})`}
          viewBox={`0 0 ${WAVE.width} ${WAVE.height}`}
          preserveAspectRatio="none"
          className={clsx(height, 'w-full rounded-lg bg-surface-2')}
        >
          <line
            x1={0}
            y1={WAVE.height / 2}
            x2={WAVE.width}
            y2={WAVE.height / 2}
            className="stroke-line"
            vectorEffect="non-scaling-stroke"
          />
          <path d={waveformPath(audio.waveform.min, audio.waveform.max)} className="fill-accent" />
          {position > 0 && (
            <line
              x1={at}
              y1={0}
              x2={at}
              y2={WAVE.height}
              className="stroke-ink"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <figcaption className="mt-1 text-xs text-ink-3">
          チャンネルを平均した振幅. 縦は -1 から 1 (満点), 横は 0 から{' '}
          {formatSeconds(audio.seconds)}. 縦の線が再生した位置
        </figcaption>
      </figure>
    </div>
  )
}
