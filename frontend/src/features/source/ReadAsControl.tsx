import { useIsFetching, useMutation, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'

import { useApi } from '../../api/client'
import type { Profile, Source } from '../../api/types'
import { ErrorBox } from '../../components/common'
import { clearDraft } from '../../lib/drafts'

// 表の読み込み (読み方を選べるもの)
const TABLE_LOADERS = new Set(['csv', 'json', 'parquet', 'excel'])

/** 今の読み込みの設定から, 読み方の選択肢の値を作る */
function currentValue(options: Record<string, unknown>): string {
  if (typeof options.text_column === 'string') return `text:${options.text_column}`
  if (typeof options.time_column === 'string') return `time:${options.time_column}`
  if (options.kind === 'table') return 'table'
  return 'auto'
}

/** 表を, 表, 時系列 (日時の列), 文 (文の列) のどれとして読むかを選ぶ */
export function ReadAsControl({ source, profile }: { source: Source; profile: Profile }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const change = useMutation({
    mutationFn: (value: string) => {
      // 読み方の設定を入れ替える (区切り文字などの他の設定は残す)
      const rest = Object.fromEntries(
        Object.entries(source.options).filter(
          ([key]) => !['kind', 'text_column', 'time_column'].includes(key),
        ),
      )
      const [mode, column] = value.split(/:(.*)/s)
      const options =
        mode === 'text'
          ? { ...rest, text_column: column }
          : mode === 'time'
            ? { ...rest, time_column: column }
            : mode === 'table'
              ? { ...rest, kind: 'table' }
              : rest
      return api.updateSource(source.id, { options })
    },
    onSuccess: () => {
      // このデータの分析, 表, 前と後, 中身を全て読み直し, 編集中の手順を捨てる
      clearDraft(source.id)
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'sources' || query.queryKey[1] === source.id,
      })
    },
  })
  const fetching = useIsFetching({ queryKey: ['profile', source.id] }) > 0
  const helpId = useId()
  if (!TABLE_LOADERS.has(source.loader)) return null
  // 文字の列 (文と時刻の候補. 読み方によって型が変わるので広く出し,
  // 読めない列は保存のときに誤りになる). 長さと語の数の列は除く
  const roles = profile.overview.roles
  const derived = new Set([roles.length, roles.words])
  const strings = Object.entries(profile.columns)
    .filter(
      ([name, info]) =>
        !derived.has(name) && ['text', 'id', 'categorical', 'datetime'].includes(info.type),
    )
    .map(([name]) => name)
  const times = strings.filter((name) => profile.columns[name]?.type !== 'text')
  const value = currentValue(source.options)
  const known = [
    'auto',
    'table',
    ...times.map((n) => `time:${n}`),
    ...strings.map((n) => `text:${n}`),
  ]
  return (
    <div>
      <label className="flex items-center gap-2 text-sm">
        読み方
        <select
          value={value}
          disabled={change.isPending || fetching}
          aria-busy={change.isPending || fetching}
          aria-describedby={helpId}
          onChange={(event) => change.mutate(event.target.value)}
          className="h-8 rounded-lg border border-line bg-surface px-2"
        >
          <option value="auto">自動</option>
          <option value="table">表 (時系列にしない)</option>
          {times.map((name) => (
            <option key={name} value={`time:${name}`}>
              時系列 (時刻: {name})
            </option>
          ))}
          {!known.includes(value) && <option value={value}>{value}</option>}
          {strings.map((name) => (
            <option key={name} value={`text:${name}`}>
              文 (文の列: {name})
            </option>
          ))}
        </select>
      </label>
      <span id={helpId} className="sr-only">
        日時の列があると時系列として読みます. 1 行 1 件の表として扱う場合や,
        文の列を語の番号の並びにして学習する場合に変えます. 変えると編集中の前処理の手順は捨てます
      </span>
      {change.isSuccess && (
        <p role="status" className="mt-1 text-xs text-warning-text">
          読み方を変えました. 前処理と書き出しの手順が合っているか確かめてください
        </p>
      )}
      {change.error && <ErrorBox error={change.error} />}
    </div>
  )
}
