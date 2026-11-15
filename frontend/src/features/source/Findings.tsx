import clsx from 'clsx'
import { AlertTriangle, Info } from 'lucide-react'

import type { Finding } from '../../api/types'

/** 気付きの一覧 (重要度ごとの印と文字, 押すと列を選ぶ) */
export function Findings({
  findings,
  onColumn,
}: {
  findings: Finding[]
  onColumn?: (column: string) => void
}) {
  if (findings.length === 0) {
    return (
      <p className="text-sm text-good-text">
        学習の前に確かめた方がよいことは見つかりませんでした.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-line">
      {findings.map((item, index) => {
        const Icon = item.severity === 'warning' ? AlertTriangle : Info
        return (
          <li key={`${item.code}-${index}`} className="flex gap-3 py-2.5">
            <Icon
              size={16}
              aria-hidden
              className={clsx(
                'mt-0.5 shrink-0',
                item.severity === 'warning' ? 'text-warning-text' : 'text-accent-text',
              )}
            />
            <div className="min-w-0 text-sm">
              <div className="mb-0.5 flex flex-wrap items-center gap-2">
                <span
                  className={clsx(
                    'text-xs font-semibold',
                    item.severity === 'warning' ? 'text-warning-text' : 'text-accent-text',
                  )}
                >
                  {item.severity === 'warning' ? '注意' : '参考'}
                </span>
                <code className="text-xs text-ink-3">{item.code}</code>
                {item.columns.map((column) => (
                  <button
                    key={column}
                    type="button"
                    disabled={!onColumn}
                    onClick={() => onColumn?.(column)}
                    className="rounded bg-surface-2 px-1.5 font-mono text-xs hover:underline disabled:no-underline"
                  >
                    {column}
                  </button>
                ))}
              </div>
              <p className="text-ink-2">{item.message}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
