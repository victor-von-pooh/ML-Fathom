import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useState } from 'react'

import { useApi } from '../../api/client'
import { useDebounced } from '../../lib/useDebounced'
import { Button, ErrorBox, Spinner } from '../../components/common'
import { formatNumber } from '../../lib/format'

// 1 ページの行の数
const PAGE = 50

/** 表の中身 (並べ替え, 絞り込み, ページ送り) */
export function DataTab({ sourceId }: { sourceId: string }) {
  const api = useApi()
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ column: string; descending: boolean } | null>(null)
  const [query, setQuery] = useState('')
  // 打つたびに絞り込まないように, 少し待ってから
  const search = useDebounced(query)
  const rows = useQuery({
    queryKey: ['rows', sourceId, offset, sort, search],
    queryFn: () =>
      api.rows(sourceId, {
        offset,
        limit: PAGE,
        sort: sort?.column,
        descending: sort?.descending,
        query: search,
      }),
    placeholderData: keepPreviousData,
  })
  const toggleSort = (column: string) => {
    setOffset(0)
    setSort((current) =>
      current?.column === column
        ? current.descending
          ? null
          : { column, descending: true }
        : { column, descending: false },
    )
  }
  const data = rows.data
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="row-query">
          行を絞り込む
        </label>
        <input
          id="row-query"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOffset(0)
          }}
          placeholder="どれかの列に含む文字で絞り込む"
          className="h-8 w-80 rounded-lg border border-line bg-surface px-2 text-sm"
        />
        {data && data.total === 0 && <span className="text-sm text-ink-3">合う行がありません</span>}
        {data && data.total > 0 && (
          <span className="text-sm text-ink-3">
            {formatNumber(data.total)} 行のうち {formatNumber(data.total ? offset + 1 : 0)}–
            {formatNumber(Math.min(offset + PAGE, data.total))}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            前へ
          </Button>
          <Button
            disabled={!data || offset + PAGE >= data.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            次へ
          </Button>
        </div>
      </div>
      {rows.isPending && <Spinner />}
      {rows.error && <ErrorBox error={rows.error} />}
      {data && (
        <div className="overflow-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                <th className="px-2 py-1.5 text-right text-xs font-medium text-ink-3">#</th>
                {data.columns.map((column) => (
                  <th
                    key={column.name}
                    className="px-2 py-1.5 text-left whitespace-nowrap"
                    aria-sort={
                      sort?.column === column.name
                        ? sort.descending
                          ? 'descending'
                          : 'ascending'
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.name)}
                      className="flex items-center gap-1 font-mono text-xs font-semibold"
                    >
                      {column.name}
                      {sort?.column === column.name &&
                        (sort.descending ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                    </button>
                    <span className="block text-[10px] font-normal text-ink-3">{column.dtype}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, index) => (
                <tr key={data.index[index]} className="border-t border-line">
                  <td className="tabular-nums px-2 py-1 text-right text-xs text-ink-3">
                    {data.index[index]}
                  </td>
                  {row.map((value, column) => (
                    <td
                      key={column}
                      className="max-w-xs truncate px-2 py-1 font-mono text-xs"
                      title={value === null ? '' : String(value)}
                    >
                      {value === null ? (
                        <span className="text-ink-3 italic">欠損</span>
                      ) : (
                        formatNumber(value)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
