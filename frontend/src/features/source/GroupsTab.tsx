import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, FolderOutput, Shapes, Upload } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'

import { ApiError, useApi } from '../../api/client'
import type {
  GroupAnswers,
  GroupChoice,
  GroupProblem,
  GroupSummary,
  GroupWritten,
  Profile,
  Source,
} from '../../api/types'
import { Button, Card, ErrorBox, Spinner, StatTile } from '../../components/ui'
import { defaultDatasetName, formatNumber, formatPercent, TYPE_LABELS } from '../../lib/format'
import {
  answerColumns,
  answerId,
  answerK,
  answersKey,
  cellText,
  defaultGroupColumns,
  differsFromAnswers,
  groupLabel,
  groupUsage,
  MAX_GROUPS,
  MIN_GROUPS,
  summaryColumns,
} from '../../lib/groups'
import { useDebounced } from '../../lib/useDebounced'
import { Stat } from './ColumnsTab'
import { Notes } from './TrajectoryView'

/** 返した数え方での作り直し方 (標本を変えるなら, 引く行の割合も) */
function remade(stability: GroupSummary['stability']): string {
  if (stability?.method !== 'sample') return '乱数の種を変えて'
  return `乱数の種を変えて全ての行から ${formatPercent(stability.fraction, 0)} の行を引き直し, 引いた行で`
}

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
        調整ランド指数は, {remade(stability)}群を {formatNumber(stability?.repeats ?? null)}{' '}
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

/**
 * 始めた問題の設定の名前と場所と, まとめるの答え. 欄を答えと違う選び方にすると,
 * 骨組みは問題の設定の答えで群を作ることを知らせ, 書き戻す所 (children) を出す
 */
function ProblemAnswersCard({
  problem,
  differs,
  children,
}: {
  problem: GroupProblem
  differs: boolean
  children?: ReactNode
}) {
  const answers = problem.group
  return (
    <Card title="問題">
      <p className="truncate text-xs text-ink-3" title={problem.path}>
        {problem.name ?? '名前なし'} · <span className="font-mono">{problem.path}</span>
      </p>
      {answers ? (
        <>
          <Stat
            label="群を作る列"
            value={answers.columns.length > 0 ? answers.columns.join(', ') : '答えていません'}
          />
          <Stat label="行を見分ける列" value={answers.id ?? 'なし (行の番号)'} />
          <Stat label="群の数" value={answers.k === null ? '答えていません' : String(answers.k)} />
          <Stat label="安定性の数え方" value={answers.stability_label ?? '答えていません'} />
          {answers.stability === 'sample' && (
            <p className="mt-2 text-xs text-ink-3">
              ここの調整ランド指数も骨組みと同じく標本を変えて数えます. 骨組みは学習用の行から引き,
              ここは全ての行から引きます.
            </p>
          )}
          {/* 読み上げに知らせるため, 枠は常に置いて中身だけ変える (空の間は見た目だけ隠し, 読み上げの木に残す) */}
          <p role="status" className="mt-2 text-xs text-warning-text empty:sr-only">
            {differs &&
              '群を作る列, 行を見分ける列か群の数が問題の答えと違います. 学習のプロジェクトの骨組みは問題の答えで群を作ります. この選び方にするなら, 問題に書き戻してください.'}
          </p>
          {children}
        </>
      ) : (
        <p className="mt-2 text-xs text-warning-text">
          この問題は, まとめるで学習する受け持ちではなくなりました. 問題の答えで欄を埋めず,
          学習のプロジェクトへも書き出しません.
        </p>
      )}
    </Card>
  )
}

/**
 * 欄の選び方を問題の設定に試しに書き戻して変わる点を出し (保存はしない),
 * 「問題の設定に書き戻す」で確かめたときの中身の印とともに保存する.
 * 書き戻した後は問題の設定を読み直す (前処理のタブのレシピの書き戻しと同じ流れ)
 */
function GroupWriteBack({
  sourceId,
  choice,
  differs,
  onWritten,
}: {
  sourceId: string
  /** 欄の選び方 (欄に誤りがあれば null) */
  choice: GroupChoice | null
  differs: boolean
  onWritten: (result: GroupWritten) => void
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  // 群の数を打つたびに確かめないよう, 少し待った選び方で確かめる
  const pending = useDebounced(choice)
  const latest = JSON.stringify(choice)
  const check = useQuery({
    queryKey: ['group-check', sourceId, JSON.stringify(pending)],
    queryFn: () => api.checkGroupProblem(sourceId, pending!),
    enabled: differs && pending !== null,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const write = useMutation({
    mutationFn: ({ sent, version }: { sent: GroupChoice; version: string }) =>
      api.writeGroupProblem(sourceId, sent, version),
    onSuccess: (result) => {
      onWritten(result)
      // 答えを読み直す (欄と同じになるので知らせと書き戻しが消える)
      void queryClient.invalidateQueries({ queryKey: ['group_problem', sourceId] })
      void queryClient.invalidateQueries({ queryKey: ['group-check', sourceId] })
    },
    // 他で変わった (409) ら確かめ直す (古い印のまま押し続けないように)
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['group-check', sourceId] })
      }
    },
  })
  const data = check.data
  // 確かめが最新の欄に追いついていない間は書き戻さない
  const settling = check.isFetching || JSON.stringify(pending) !== latest
  const blocked =
    !data || !choice || settling || check.isError || data.changes.length === 0 || write.isPending
  // 書き戻した後に欄を変えたら, 書き戻しましたの表示を消す
  const written = write.data && JSON.stringify(write.variables?.sent) === latest ? write.data : null
  return (
    <div className="mt-3 space-y-2 text-sm">
      {differs && (
        <>
          {!choice && <p className="text-xs text-ink-3">欄の誤りを直すと, 問題に書き戻せます</p>}
          {check.isPending && check.fetchStatus !== 'idle' && (
            <Spinner label="問題と比べています" />
          )}
          {check.error && <ErrorBox error={check.error} />}
          {data && !check.isError && data.changes.length > 0 && (
            <section aria-label="書き戻すと変わる点">
              <h3 className="text-xs font-semibold text-ink-2">書き戻すと変わる点</h3>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {data.changes.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </section>
          )}
          <Button
            variant="primary"
            icon={ClipboardCheck}
            disabled={blocked}
            onClick={() => {
              if (data && choice) write.mutate({ sent: choice, version: data.version })
            }}
          >
            {write.isPending ? '書き戻しています…' : '問題に書き戻す'}
          </Button>
        </>
      )}
      {write.error && <ErrorBox error={write.error} />}
      {/* 読み上げに知らせるため, 枠は常に置いて中身だけ変える (空の間は見た目だけ隠し, 読み上げの木に残す) */}
      <div role="status" className="text-xs text-good-text empty:sr-only">
        {written && (
          <>
            問題に書き戻しました.
            {written.changes.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {written.changes.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 表を前処理せず, ファイル 1 つのまま, 問題の設定に記録したプロジェクトの骨組みが読む場所へ
 * 写す. 前に置いたファイルは確かめてから置き換え, ファイルでないものは置き換えない
 */
function ProjectExportCard({
  sourceId,
  problem,
  fetching,
}: {
  sourceId: string
  problem: GroupProblem
  fetching: boolean
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const exporter = useMutation({
    mutationFn: (overwrite: boolean) => api.exportGroupProject(sourceId, overwrite),
    onSettled: (_, error) => {
      // 書き出した後と, 他で書き出し先が変わった (409) ときは様子を読み直す
      if (!error || (error instanceof ApiError && error.status === 409)) {
        void queryClient.invalidateQueries({ queryKey: ['group_problem', sourceId] })
      }
    },
  })
  const place = problem.project
  if (!place) return null
  const run = () => {
    const replace = place.state === 'file'
    if (
      replace &&
      !window.confirm(`${place.dataset} には前に置いた表があります. 上書きしますか?`)
    ) {
      return
    }
    exporter.mutate(replace)
  }
  const done = exporter.data
  return (
    <Card title="学習のプロジェクトへ書き出す">
      <p className="text-sm text-ink-2">
        表を前処理せず, ファイル 1 つのまま, 問題に記録した学習のプロジェクトの骨組みが読む場所
        (config の data.dataset) に写します. 骨組みは問題の読み方で表を読み,
        答えた群を作る列と行を見分ける列だけを使い, 学習用と検証用に分けます.
        学習のプロジェクトへ渡すのはこの書き出しです (下の「群分けの表を分析用に書き出す」は
        分析用の書き出しで, 骨組みは読みません).
      </p>
      {place.dataset && (
        <p className="mt-2 truncate font-mono text-xs" title={place.dataset}>
          {place.dataset}
        </p>
      )}
      {place.state === 'file' && (
        <p className="text-xs text-ink-3">
          前に置いたファイルがあります (書き出すと, 確かめてから上書きします)
        </p>
      )}
      {place.reason && <p className="mt-1 text-xs text-warning-text">{place.reason}</p>}
      {place.ready && (
        <Button
          variant="primary"
          icon={FolderOutput}
          className="mt-3"
          // 書き出し先の様子を読み直す間は押せない (古い様子で置き換えを決めないように)
          disabled={exporter.isPending || fetching}
          onClick={run}
        >
          {exporter.isPending ? '書き出し中…' : '学習のプロジェクトへ書き出す'}
        </Button>
      )}
      {exporter.error && <ErrorBox error={exporter.error} />}
      {/* 読み上げに知らせるため, 枠は常に置いて中身だけ変える (空の間は見た目だけ隠し, 読み上げの木に残す) */}
      <p role="status" className="mt-3 text-sm text-good-text empty:sr-only">
        {done &&
          `${
            done.copied
              ? `学習のプロジェクトへ書き出しました: ${done.path}`
              : `書き出し先は登録した表そのものなので, 写さずにそのまま使います: ${done.path}`
          } (${formatNumber(done.rows)} 行. 骨組みが群を作る列 ${done.columns.join(', ')}${
            done.id ? `, 行を見分ける列 ${done.id}` : ''
          })`}
      </p>
    </Card>
  )
}

/**
 * 群を作る列で, 群分けの表を分析用の書き出しとしてデータセット (版 2) に書き出す (学習には使わず,
 * 学習のプロジェクトへは「プロジェクトへ書き出す」で表のファイルを写す)
 */
function ExportCard({
  source,
  columns,
  ids,
  chosenId,
  onIdChange,
  k,
}: {
  source: Source
  columns: string[]
  /** 行を見分ける列の候補 (群を作る列の他) */
  ids: string[]
  /** 選んだ行を見分ける列 (候補に無ければ空の文字. 問題の設定への書き戻しと同じ欄) */
  chosenId: string
  onIdChange: (id: string) => void
  k: number
}) {
  const api = useApi()
  const [name, setName] = useState(() => `${defaultDatasetName(source.name, source.path)}_groups`)
  const [overwrite, setOverwrite] = useState(false)
  const [method, setMethod] = useState<'random' | 'none'>('random')
  const [valid, setValid] = useState(0.2)
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
    <Card title="群分けの表を分析用に書き出す">
      <p className="text-sm text-ink-2">
        選んだ列を, 後で群の要約を見直すために, 分析用として書き出します. 学習には使えません.
        学習のプロジェクトへ表を渡すには, まとめるの問題から始めて
        「学習のプロジェクトへ書き出す」を使います. 書き出すのは群を作る列 (上で選んだ列) と
        行を見分ける列だけで, データセットの一覧に群分けの表として並びます.
      </p>
      <div className="mt-3 grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
        <label htmlFor="group-id" className="text-ink-3">
          行を見分ける列
        </label>
        <select
          id="group-id"
          value={chosenId}
          onChange={(event) => {
            onIdChange(event.target.value)
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
          同じ名前があれば上書きする
        </label>
      </div>
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
        {exporter.isPending ? '書き出し中…' : '群分けの表を分析用に書き出す'}
      </Button>
      {exporter.error && (
        <ErrorBox error={exporter.error}>
          {String(exporter.error).includes('既にあります') && (
            <p className="mt-1 text-xs">
              上書きする場合は「同じ名前があれば上書きする」に印を付けてください.
            </p>
          )}
        </ErrorBox>
      )}
      {/* 読み上げに知らせるため, 枠は常に置いて中身だけ変える (空の間は見た目だけ隠し, 読み上げの木に残す) */}
      <p role="status" className="mt-3 text-sm text-good-text empty:sr-only">
        {done && `書き出しました: ${done.path}`}
      </p>
      {done && (
        <div className="mt-2 space-y-2 text-sm">
          {done.notes.length > 0 && (
            <ul className="list-disc pl-4 text-xs text-warning-text">
              {done.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-3">読み直して群の要約を求める例:</p>
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
 * (ML-EDA の describe_groups) を見て, 群分けの表を分析用に書き出す. 問題の設定から始めたデータは,
 * 開くたびに問題の設定を読み直し, まとめるの答えで欄を埋める
 */
export function GroupsTab({ source, profile }: { source: Source; profile: Profile }) {
  const api = useApi()
  const linked = Boolean(source.problem)
  const problem = useQuery({
    queryKey: ['group_problem', source.id],
    queryFn: () => api.groupProblem(source.id),
    enabled: linked,
    retry: false,
  })
  // 自分で書き戻した答えでは欄を埋め直さない (欄と群の要約を残す). from は書き戻した
  // ときの欄の鍵, to は書き戻した後の答えの鍵
  const [own, setOwn] = useState<{ from: string; to: string } | null>(null)
  if (linked && problem.isPending) return <Spinner label="問題を読んでいます" />
  // 読み直しが失敗したら前の答えを使わない (react-query は前の data を残すので,
  // 読めない答えの数え方で群を作らないように. 答えが無いのと同じく種を変えて数える)
  const read = problem.error ? null : (problem.data ?? null)
  const answers = read?.group ?? null
  const current = answersKey(answers)
  const key = own && own.to === current ? own.from : current
  return (
    <>
      {/* 問題の設定を読めなくても, 群分けは続けられる */}
      {problem.error && (
        <div className="mb-4">
          <ErrorBox error={problem.error} />
        </div>
      )}
      <GroupsBody
        // 答えが他で変わったら, 答えで欄を埋め直す
        key={key}
        source={source}
        profile={profile}
        problem={read}
        fetching={problem.isFetching}
        onWritten={(result) => setOwn({ from: key, to: answersKey(result.group) })}
      />
    </>
  )
}

function GroupsBody({
  source,
  profile,
  problem,
  fetching,
  onWritten,
}: {
  source: Source
  profile: Profile
  problem: GroupProblem | null
  fetching: boolean
  onWritten: (result: GroupWritten) => void
}) {
  const api = useApi()
  const all = Object.keys(profile.columns)
  const answers: GroupAnswers | null = problem?.group ?? null
  const [columns, setColumns] = useState(() =>
    answers ? answerColumns(answers, all) : defaultGroupColumns(profile.columns, source.target),
  )
  const [k, setK] = useState(() => (answers ? answerK(answers) : 3))
  const [idColumn, setIdColumn] = useState(() => (answers ? answerId(answers, all) : ''))
  // 行を見分ける列は群を作る列の他から選ぶ (群を作る列に入れた列は「なし」に戻して見せ,
  // 送る値も見せる値にそろえる)
  const ids = all.filter((column) => !columns.includes(column))
  const chosenId = ids.includes(idColumn) ? idColumn : ''
  const [seed, setSeed] = useState(0)
  const grouping = useMutation({
    // 安定性は問題の設定の答えの数え方で数える (タブでは選ばない. 答えが無ければ種を変える)
    mutationFn: () =>
      api.groups(source.id, { columns, k, seed, stability: answers?.stability ?? 'seed' }),
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
  // 問題の設定を読み直している間は, 古い答えの数え方で群を作らない
  const waiting = fetching ? '問題を読み直しています' : null
  const summary = grouping.data
  const differs = answers !== null && differsFromAnswers(answers, columns, k, chosenId)
  return (
    <div className="space-y-4">
      {problem && (
        <ProblemAnswersCard problem={problem} differs={differs}>
          <GroupWriteBack
            sourceId={source.id}
            choice={reason === null ? { columns, id: chosenId || null, k } : null}
            differs={differs}
            onWritten={onWritten}
          />
        </ProblemAnswersCard>
      )}
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
            disabled={grouping.isPending || reason !== null || waiting !== null}
            aria-describedby={reason || waiting ? reasonId : undefined}
            onClick={() => grouping.mutate()}
          >
            {grouping.isPending ? '群を作っています…' : '群を作る'}
          </Button>
        </div>
        {(reason || waiting) && (
          <p id={reasonId} className="mt-2 text-xs text-warning-text">
            {reason ?? waiting}
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
      {problem?.group && (
        <ProjectExportCard sourceId={source.id} problem={problem} fetching={fetching} />
      )}
      <ExportCard
        source={source}
        columns={columns}
        ids={ids}
        chosenId={chosenId}
        onIdChange={setIdColumn}
        k={k}
      />
    </div>
  )
}
