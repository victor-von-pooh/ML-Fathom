import { useMutation } from '@tanstack/react-query'
import { Shapes, Upload } from 'lucide-react'
import { useId, useState } from 'react'

import { api } from '../../api/client'
import type { GroupSummary, Profile, Source } from '../../api/types'
import { Button, Card, ErrorBox, StatTile } from '../../components/ui'
import { defaultDatasetName, formatNumber, formatPercent, TYPE_LABELS } from '../../lib/format'
import {
  cellText,
  defaultGroupColumns,
  groupLabel,
  groupUsage,
  MAX_GROUPS,
  MIN_GROUPS,
  summaryColumns,
} from '../../lib/groups'
import { Stat } from './ColumnsTab'
import { Notes } from './TrajectoryView'

/** 群の数, 安定性, まとまりの数と, 指標の意味 */
function Measures({ summary }: { summary: GroupSummary }) {
  const stability = summary.stability
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="群の数" value={formatNumber(summary.k)} />
        <StatTile label="行" value={formatNumber(summary.rows)} />
        <StatTile
          label="調整ランド指数 (安定性)"
          value={formatNumber(stability?.ari ?? null)}
          hint={`最も低い回 ${formatNumber(stability?.ari_min ?? null)}`}
        />
        <StatTile label="シルエット係数 (まとまり)" value={formatNumber(summary.silhouette)} />
      </div>
      <p className="text-xs text-ink-3">
        調整ランド指数は, 乱数の種を変えて群を {formatNumber(stability?.repeats ?? null)}{' '}
        回作り直したときに, 行の分かれ方が今の群とどれだけ一致するかの平均です. 1
        で全く同じ分かれ方, 0 で偶然と同じ程度です. シルエット係数は群のまとまりで, -1 から 1
        の値を取り, 1 に近いほど同じ群の行どうしが近く, 他の群から離れています.
      </p>
    </div>
  )
}

/** 群ごとの行の数, 割合, 安定性と, 群を作った列の要約の表 */
function SummaryTable({ summary }: { summary: GroupSummary }) {
  const columns = summaryColumns(summary.groups)
  const numeric = new Set(summary.columns.numeric)
  return (
    <Card title="群の要約">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">群ごとの行の数, 割合, 安定性と列の特徴</caption>
          <thead className="text-xs text-ink-3">
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-normal">
                群
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                行
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                割合
              </th>
              <th scope="col" className="pr-3 text-right font-normal">
                安定性
              </th>
              {columns.map((name) => (
                <th key={name} scope="col" className="pr-3 text-right font-normal">
                  <span className="font-mono">{name}</span>
                  <span className="ml-1">({numeric.has(name) ? '平均' : '最も多い値'})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.groups.map((row) => (
              <tr
                key={String(row.group)}
                className={
                  row.group === '全体'
                    ? 'border-t-2 border-line font-medium'
                    : 'border-t border-line'
                }
              >
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {groupLabel(row.group)}
                </th>
                <td className="tabular pr-3 text-right font-mono">{formatNumber(row.rows)}</td>
                <td className="tabular pr-3 text-right font-mono">{formatPercent(row.share)}</td>
                <td className="tabular pr-3 text-right font-mono">{cellText(row.stability)}</td>
                {columns.map((name) => (
                  <td key={name} className="tabular pr-3 text-right font-mono break-all">
                    {cellText(row[name] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        安定性は, 作り直した群のうち最も重なる群との重なり (Jaccard 係数. 1 で同じ行の集まり)
        の平均です. 数の列は群の中の平均を, 他の列は最も多い値と割合を出します.
        最後の行は全ての行です. 群は学習に通さず, 選んだ列をそのまま k 平均法で分けたもので,
        学習のプロジェクトが比べる相手と同じ作り方です.
      </p>
    </Card>
  )
}

/** 群を作った列と, 列をそろえた後の幅 */
function UsedColumns({ summary }: { summary: GroupSummary }) {
  const { numeric, categorical } = summary.columns
  return (
    <Card title="群を作った列">
      <Stat label="数の列 (平均 0, 散らばり 1 にそろえる)" value={numeric.join(', ') || 'なし'} />
      <Stat
        label="種類の列 (値ごとに 0 と 1 の列にする)"
        value={categorical.join(', ') || 'なし'}
      />
      <Stat label="そろえた後の列の数" value={formatNumber(summary.width)} />
      <Stat label="乱数の種" value={formatNumber(summary.seed)} />
    </Card>
  )
}

/** 群を作る列で, 群分けの表をデータセット (版 2) に書き出す */
function ExportCard({
  source,
  columns,
  candidates,
  k,
}: {
  source: Source
  columns: string[]
  candidates: string[]
  k: number
}) {
  const [name, setName] = useState(() => `${defaultDatasetName(source.name, source.path)}_groups`)
  const [overwrite, setOverwrite] = useState(false)
  const [idColumn, setIdColumn] = useState('')
  const [method, setMethod] = useState<'random' | 'none'>('random')
  const [valid, setValid] = useState(0.2)
  // 行を見分ける列は群を作る列の他から選ぶ (群を作る列に入れた列は「なし」に戻して見せ,
  // 送る値も見せる値にそろえる)
  const ids = candidates.filter((column) => !columns.includes(column))
  const chosenId = ids.includes(idColumn) ? idColumn : ''
  // 変数は書き出したときの群の数 (使い方の文に使う) と, 群を作る列と群の数の選び方
  const selection = `${JSON.stringify(columns)}:${k}`
  const exporter = useMutation({
    mutationFn: (_exported: { k: number; selection: string }) =>
      api.exportGroups(source.id, {
        columns,
        id: chosenId || null,
        split: { method, valid, test: 0, seed: 0 },
        name,
        overwrite,
      }),
  })
  const reset = () => exporter.reset()
  const reason =
    columns.length === 0
      ? '群を作る列を 1 つ以上選んでください'
      : !(valid >= 0 && valid < 1)
        ? '検証用の割合は 0 以上 1 未満にしてください'
        : null
  const reasonId = useId()
  // 上の群を作る列か群の数を変えたら, 前の書き出しの結果を出さない (どの選び方で書き出した
  // かを取り違えないように)
  const done = exporter.variables?.selection === selection ? exporter.data : undefined
  return (
    <Card title="群分けの表を書き出す">
      <p className="text-sm text-ink-2">
        群を作る列 (上で選んだ列) と行を見分ける列だけを, 正解の無い群分けの表として
        学習用のデータセットに書き出します. 群の数は学習のプロジェクトで決めます.
      </p>
      <div className="mt-3 grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
        <label htmlFor="group-id" className="text-ink-3">
          行を見分ける列
        </label>
        <select
          id="group-id"
          value={chosenId}
          onChange={(event) => {
            setIdColumn(event.target.value)
            reset()
          }}
          className="h-8 rounded border border-line bg-surface px-2 font-mono"
        >
          <option value="">なし (行の位置)</option>
          {ids.map((column) => (
            <option key={column}>{column}</option>
          ))}
        </select>
        <label htmlFor="group-split" className="text-ink-3">
          分割
        </label>
        <select
          id="group-split"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value as 'random' | 'none')
            reset()
          }}
          className="h-8 rounded border border-line bg-surface px-2"
        >
          <option value="random">無作為 (学習用と検証用)</option>
          <option value="none">分けない (全て学習用)</option>
        </select>
        {method === 'random' && (
          <>
            <label htmlFor="group-valid" className="text-ink-3">
              検証用の割合
            </label>
            <input
              id="group-valid"
              type="number"
              min={0}
              max={0.9}
              step={0.05}
              value={valid}
              onChange={(event) => {
                setValid(Number(event.target.value))
                reset()
              }}
              className="h-8 w-28 rounded border border-line bg-surface px-2 font-mono"
            />
          </>
        )}
        <label htmlFor="group-name" className="text-ink-3">
          データセットの名前
        </label>
        <input
          id="group-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            reset()
          }}
          className="h-8 rounded border border-line bg-surface px-2 font-mono"
        />
        <span />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => {
              setOverwrite(event.target.checked)
              reset()
            }}
          />
          同じ名前があれば置き換える
        </label>
      </div>
      {method === 'random' && (
        <p className="mt-2 text-xs text-ink-3">
          学習のプロジェクトは, 検証用の行で群のまとまりを測ります.
        </p>
      )}
      {reason && (
        <p id={reasonId} className="mt-2 text-xs text-warning-text">
          {reason}
        </p>
      )}
      <Button
        variant="primary"
        icon={Upload}
        className="mt-3"
        disabled={exporter.isPending || !name || reason !== null}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => exporter.mutate({ k, selection })}
      >
        {exporter.isPending ? '書き出し中…' : '群分けの表を書き出す'}
      </Button>
      {exporter.error && (
        <ErrorBox error={exporter.error}>
          {String(exporter.error).includes('既にあります') && (
            <p className="mt-1 text-xs">
              置き換える場合は「同じ名前があれば置き換える」に印を付けてください.
            </p>
          )}
        </ErrorBox>
      )}
      {done && (
        <div className="mt-3 space-y-2 text-sm">
          <p role="status" className="text-good-text">
            書き出しました: {done.path}
          </p>
          {done.notes.length > 0 && (
            <ul className="list-disc pl-4 text-xs text-warning-text">
              {done.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-3">学習のスクリプトでの読み方:</p>
          <pre className="overflow-auto rounded bg-surface-2 p-2 text-xs">
            {groupUsage(done.path, exporter.variables?.k ?? k)}
          </pre>
        </div>
      )}
    </Card>
  )
}

/**
 * 群分け (まとめる): 群を作る列と群の数を選び, 学習に通さずに作った群の要約
 * (ML-EDA の describe_groups) を見て, 群分けの表を書き出す
 */
export function GroupsTab({ source, profile }: { source: Source; profile: Profile }) {
  const all = Object.keys(profile.columns)
  const [columns, setColumns] = useState(() => defaultGroupColumns(profile.columns, source.target))
  const [k, setK] = useState(3)
  const [seed, setSeed] = useState(0)
  const grouping = useMutation({
    mutationFn: () => api.groups(source.id, { columns, k, seed }),
  })
  const kId = useId()
  const seedId = useId()
  const reasonId = useId()
  // 選び方を変えたら前の群の要約を消す (どの選び方の群かを取り違えないように)
  const change = (next: () => void) => {
    next()
    grouping.reset()
  }
  const toggle = (name: string, checked: boolean) =>
    change(() =>
      setColumns((current) =>
        checked
          ? all.filter((column) => column === name || current.includes(column))
          : current.filter((column) => column !== name),
      ),
    )
  const reason =
    columns.length === 0
      ? '群を作る列を 1 つ以上選んでください'
      : !Number.isInteger(k) || k < MIN_GROUPS || k > MAX_GROUPS
        ? `群の数は ${MIN_GROUPS} から ${MAX_GROUPS} の整数にしてください`
        : !Number.isInteger(seed) || seed < 0
          ? '乱数の種は 0 以上の整数にしてください'
          : null
  const summary = grouping.data
  return (
    <div className="space-y-4">
      <Card title="群を作る列と群の数">
        <p className="text-sm text-ink-2">
          正解の無い表を, 選んだ列の値の近さで群に分けます. 学習に通さずに, 群ごとの行の数と特徴,
          群がどれだけ安定しているかを見ます. 行を見分ける列, 文と日時の列は初めは外しています.
        </p>
        <fieldset className="mt-3">
          <legend className="text-xs text-ink-3">群を作る列</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {all.map((name) => (
              <label key={name} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={columns.includes(name)}
                  onChange={(event) => toggle(name, event.target.checked)}
                />
                <span className="font-mono">{name}</span>
                <span className="text-xs text-ink-3">
                  ({TYPE_LABELS[profile.columns[name]!.type] ?? '他'})
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-end gap-4 text-sm">
          <label htmlFor={kId} className="flex flex-col gap-1">
            <span className="text-xs text-ink-3">群の数</span>
            <input
              id={kId}
              type="number"
              min={MIN_GROUPS}
              max={MAX_GROUPS}
              step={1}
              value={k}
              onChange={(event) => change(() => setK(Number(event.target.value)))}
              className="h-8 w-24 rounded border border-line bg-surface px-2 font-mono"
            />
          </label>
          <label htmlFor={seedId} className="flex flex-col gap-1">
            <span className="text-xs text-ink-3">乱数の種</span>
            <input
              id={seedId}
              type="number"
              min={0}
              step={1}
              value={seed}
              onChange={(event) => change(() => setSeed(Number(event.target.value)))}
              className="h-8 w-24 rounded border border-line bg-surface px-2 font-mono"
            />
          </label>
          <Button
            variant="primary"
            icon={Shapes}
            disabled={grouping.isPending || reason !== null}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => grouping.mutate()}
          >
            {grouping.isPending ? '群を作っています…' : '群を作る'}
          </Button>
        </div>
        {reason && (
          <p id={reasonId} className="mt-2 text-xs text-warning-text">
            {reason}
          </p>
        )}
      </Card>
      {grouping.error && <ErrorBox error={grouping.error} />}
      {summary && (
        <>
          <Measures summary={summary} />
          <Card title={`気付き (${summary.notes.length} 件)`}>
            <Notes notes={summary.notes} />
          </Card>
          <SummaryTable summary={summary} />
          <UsedColumns summary={summary} />
        </>
      )}
      <ExportCard source={source} columns={columns} candidates={all} k={k} />
    </div>
  )
}
