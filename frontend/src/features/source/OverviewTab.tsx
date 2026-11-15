import type { Profile } from '../../api/types'
import { Card, StatTile } from '../../components/ui'
import { formatBytes, formatCount, KIND_LABELS, TYPE_LABELS } from '../../lib/format'
import { Findings } from './Findings'

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
      <Card title={`気付き (注意 ${warnings} 件, 参考 ${profile.findings.length - warnings} 件)`}>
        <Findings findings={profile.findings} onColumn={onColumn} />
      </Card>
      <Card title="列の型">
        <div className="flex flex-wrap gap-2">
          {Object.entries(types).map(([type, count]) => (
            <span key={type} className="rounded-full bg-surface-2 px-2.5 py-1 text-sm">
              {TYPE_LABELS[type] ?? type} <span className="tabular text-ink-3">{count}</span>
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
