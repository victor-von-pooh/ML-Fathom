import type { AnomalyProfile, Profile } from '../../api/types'
import { Card, StatTile } from '../../components/common'
import {
  formatBytes,
  formatCount,
  formatNumber,
  formatPercent,
  KIND_LABELS,
  TYPE_LABELS,
} from '../../lib/format'
import { Findings } from './Findings'

/** 異常の検知の正解の付いた行, 異常の行の数と割合 (全ての行で数えたもの) */
function AnomalyCounts({ anomaly }: { anomaly: AnomalyProfile }) {
  if (!anomaly.labeled) {
    return (
      <p className="text-sm text-ink-2">
        目的の列 (異常の正解の列) を選んでいないので, 全ての {formatNumber(anomaly.rows)}{' '}
        行を正常と見なします.
      </p>
    )
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="正解の付いた行" value={formatNumber(anomaly.labeled_rows)} />
        <StatTile label="異常の行" value={formatNumber(anomaly.anomaly)} />
        <StatTile
          label="異常の割合 (0 か 1 の正解の行のうち)"
          value={formatPercent(anomaly.ratio)}
        />
        <StatTile label="正解の欠けた行" value={formatNumber(anomaly.missing)} />
        <StatTile
          label="欠けた行も正常と見なした異常の割合"
          value={formatPercent(anomaly.presumed_ratio)}
        />
      </div>
      <p className="text-xs text-ink-3">
        正解の列 <span className="font-mono">{anomaly.column}</span> (異常は 1 か真, 正常は 0 か偽)
        を, 見本ではなく全ての {formatNumber(anomaly.rows)} 行で数えました. 正解が正常の行は{' '}
        {formatNumber(anomaly.normal)} 行です. 異常の行にだけ印を付けた表は,
        前処理で正解の欠けた行を「正常と見なす」と, 欠けた行も正常と見なした割合で書き出します.
      </p>
      {!anomaly.valid && (
        <p className="text-sm text-warning-text">
          0 と 1 か真偽値に収まらない値の行が {formatNumber(anomaly.invalid)} 行あります (例:{' '}
          {anomaly.invalid_examples.join(', ')}).
        </p>
      )}
    </div>
  )
}

/** 概要と気付き */
export function OverviewTab({
  profile,
  onColumn,
}: {
  profile: Profile
  onColumn: (column: string) => void
}) {
  const overview = profile.overview
  // 型ごとの列の数
  const types: Record<string, number> = {}
  for (const info of Object.values(profile.columns)) {
    types[info.type] = (types[info.type] ?? 0) + 1
  }
  const warnings = profile.findings.filter((item) => item.severity === 'warning').length
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="種類" value={KIND_LABELS[overview.kind] ?? overview.kind} />
        <StatTile label="行" value={formatCount(overview.rows)} />
        <StatTile label="列" value={formatCount(overview.columns)} />
        <StatTile label="欠損したセル" value={formatCount(overview.missing_cells)} />
        <StatTile label="重複した行" value={formatCount(overview.duplicate_rows)} />
        <StatTile label="メモリ" value={formatBytes(overview.memory_bytes)} />
      </div>
      {overview.sampled && (
        <p className="text-xs text-ink-3">
          行が多いので, 無作為に選んだ {formatCount(overview.sample_rows)} 行で分析しています.
        </p>
      )}
      {profile.anomaly && (
        <Card title="異常の正解の数">
          <AnomalyCounts anomaly={profile.anomaly} />
        </Card>
      )}
      <Card
        name="気付き"
        title={`気付き (注意 ${warnings} 件, 参考 ${profile.findings.length - warnings} 件)`}
      >
        <Findings findings={profile.findings} onColumn={onColumn} />
      </Card>
      <Card title="列の型">
        <div className="flex flex-wrap gap-2">
          {Object.entries(types).map(([type, count]) => (
            <span key={type} className="rounded-full bg-surface-2 px-2.5 py-1 text-sm">
              {TYPE_LABELS[type] ?? type} <span className="tabular-nums text-ink-3">{count}</span>
            </span>
          ))}
        </div>
        {Object.keys(overview.roles).length > 0 && (
          <p className="mt-3 text-xs text-ink-3">
            役割:{' '}
            {Object.entries(overview.roles)
              .map(([role, column]) => `${role} = ${column}`)
              .join(', ')}
          </p>
        )}
      </Card>
    </div>
  )
}
