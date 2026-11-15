import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api/client'
import type { Profile, Source } from '../../api/types'
import { ErrorBox } from '../../components/ui'

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
      void queryClient.invalidateQueries({ queryKey: ['sources'] })
      void queryClient.invalidateQueries({ queryKey: ['profile', source.id] })
      void queryClient.invalidateQueries({ queryKey: ['rows', source.id] })
    },
  })
  if (!TABLE_LOADERS.has(source.loader)) return null
  const columns = Object.entries(profile.columns)
  const texts = columns.filter(([, info]) => info.type === 'text').map(([name]) => name)
  const times = columns.filter(([, info]) => info.type === 'datetime').map(([name]) => name)
  return (
    <div>
      <label className="flex items-center gap-2 text-sm">
        読み方
        <select
          value={currentValue(source.options)}
          disabled={change.isPending}
          onChange={(event) => change.mutate(event.target.value)}
          title="日時の列があると時系列として読みます. 1 行 1 件の表として扱う場合や, 文の列を語の番号の並びにして学習する場合に変えます"
          className="h-8 rounded-lg border border-line bg-surface px-2"
        >
          <option value="auto">自動</option>
          <option value="table">表 (時系列にしない)</option>
          {times.map((name) => (
            <option key={name} value={`time:${name}`}>
              時系列 (時刻: {name})
            </option>
          ))}
          {texts.map((name) => (
            <option key={name} value={`text:${name}`}>
              文 (文の列: {name})
            </option>
          ))}
        </select>
      </label>
      {change.error && <ErrorBox error={change.error} />}
    </div>
  )
}
