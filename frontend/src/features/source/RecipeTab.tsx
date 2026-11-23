import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Plus, Save, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useRecipeDraft } from '../../lib/drafts'
import { useDebounced } from '../../lib/useDebounced'
import YAML from 'yaml'

import { api } from '../../api/client'
import type {
  FrameView,
  ItemStepInfo,
  Profile,
  Recipe,
  RecipeStep,
  StepInfo,
} from '../../api/types'
import { Button, Card, ErrorBox, Spinner } from '../../components/ui'
import { defaultDatasetName, formatNumber, TASK_LABELS } from '../../lib/format'
import { findDecisions, withAutoItems } from '../../lib/decisions'
import {
  canKeepUnlabeled,
  fitUnlabeled,
  itemLimitErrors,
  looksLikeDatetime,
  splitLabel,
  untargetedDraft,
  usageSnippet,
  withUnlabeled,
} from '../../lib/recipe'
import { autoRecipe, ITEM_KINDS, suggestSteps } from '../../lib/suggest'
import { useDecided } from '../../lib/useDecided'
import { DecisionsCard } from './DecisionsCard'
import { Findings } from './Findings'
import { ProblemCard } from './ProblemCard'
import { ProjectExport } from './ProjectExport'
import { ItemPreviewCard } from './ItemPreviewCard'
import { ModelHintsView } from './ModelHintsView'
import { TokenizerTable } from './TokenizerTable'

/** 手順の引数の値を, 入力の文字にする */
function toText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return YAML.stringify(value, { flow: true } as never).trim()
}

/** 入力の文字を, YAML として値にする (読めなければ文字のまま) */
function fromText(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return YAML.parse(text) as unknown
  } catch {
    return text
  }
}

/** 列の指定 (auto か列の名前の並び) を選ぶ欄 */
function ColumnsField({
  value,
  columns,
  onChange,
  id,
  allowAuto,
}: {
  value: unknown
  columns: string[]
  onChange: (value: unknown) => void
  id: string
  /** auto (型から選ぶ) を使える手順か (列を落とすなどは名前で選ぶだけ) */
  allowAuto: boolean
}) {
  const auto = allowAuto && (value === 'auto' || value === undefined)
  const chosen = Array.isArray(value) ? (value as string[]) : []
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {allowAuto && (
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => onChange(event.target.checked ? 'auto' : [])}
          />
          auto (型から選ぶ)
        </label>
      )}
      {!auto &&
        chosen.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onChange(chosen.filter((item) => item !== name))}
            className="rounded bg-accent-soft px-1.5 font-mono text-xs text-accent-text"
            aria-label={`${name} を外す`}
          >
            {name} ×
          </button>
        ))}
      {!auto && (
        <select
          id={id}
          aria-label="列を加える"
          value=""
          onChange={(event) => event.target.value && onChange([...chosen, event.target.value])}
          className="h-7 rounded border border-line bg-surface px-1 font-mono text-xs"
        >
          <option value="">列を加える…</option>
          {columns
            .filter((name) => !chosen.includes(name))
            .map((name) => (
              <option key={name}>{name}</option>
            ))}
        </select>
      )}
    </div>
  )
}

/** 1 つの手順の編集 */
function StepEditor({
  step,
  index,
  info,
  columns,
  active,
  count,
  onChange,
  onMove,
  onRemove,
  onSelect,
}: {
  step: RecipeStep
  index: number
  info: StepInfo | undefined
  columns: string[]
  active: boolean
  count: number
  onChange: (step: RecipeStep) => void
  onMove: (delta: number) => void
  onRemove: () => void
  onSelect: () => void
}) {
  return (
    <li
      className={clsx(
        'rounded-lg border p-3',
        active ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={`手順 ${index + 1} の前と後を見る`}
        >
          <span className="tabular rounded-full bg-surface-2 px-2 text-xs">{index + 1}</span>
          <code className="text-sm font-semibold">{step.op}</code>
          <span className="truncate text-xs text-ink-3">{info?.description}</span>
          {info?.fits && (
            <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-ink-3">
              学習用で当てはめ
            </span>
          )}
        </button>
        <Button
          variant="ghost"
          aria-label={`手順 ${index + 1} を上へ`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={14} />
        </Button>
        <Button
          variant="ghost"
          aria-label={`手順 ${index + 1} を下へ`}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={14} />
        </Button>
        <Button variant="ghost" aria-label={`手順 ${index + 1} を消す`} onClick={onRemove}>
          <Trash2 size={14} />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
        {Object.entries(info?.params ?? {}).map(([name, description]) => {
          const id = `step-${index}-${name}`
          return (
            <div key={name} className="contents">
              <label htmlFor={id} className="pt-1 font-mono text-xs text-ink-2">
                {name}
              </label>
              <div>
                {name === 'columns' ? (
                  <ColumnsField
                    id={id}
                    allowAuto={description.includes('auto')}
                    value={step[name]}
                    columns={columns}
                    onChange={(value) => onChange({ ...step, [name]: value })}
                  />
                ) : (
                  <input
                    id={id}
                    defaultValue={toText(step[name])}
                    onBlur={(event) => {
                      const value = fromText(event.target.value)
                      const next = { ...step }
                      if (value === undefined) delete next[name]
                      else next[name] = value
                      onChange(next)
                    }}
                    className="h-7 w-full rounded border border-line bg-surface px-2 font-mono text-xs"
                  />
                )}
                <p className="mt-0.5 text-[11px] text-ink-3">{description}</p>
              </div>
            </div>
          )
        })}
      </div>
    </li>
  )
}

/** 表の先頭の行 */
function FramePreview({ view, highlight }: { view: FrameView; highlight: string[] }) {
  return (
    <div className="overflow-auto rounded-lg border border-line">
      <table className="text-xs">
        <thead className="bg-surface-2">
          <tr>
            {view.columns.map((column) => (
              <th
                key={column.name}
                className={clsx(
                  'px-2 py-1 text-left font-mono whitespace-nowrap',
                  highlight.includes(column.name) && 'bg-accent-soft text-accent-text',
                )}
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.head.slice(0, 8).map((row, index) => (
            <tr key={index} className="border-t border-line">
              {row.map((value, column) => (
                <td key={column} className="max-w-[10rem] truncate px-2 py-0.5 font-mono">
                  {value === null ? <span className="text-ink-3">–</span> : formatNumber(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 前処理のレシピの編集, 1 段ずつの前と後, 書き出し */
export function RecipeTab({
  sourceId,
  sourceName,
  sourcePath,
  profile,
  target,
  steps,
  kind,
  itemSteps,
  loader,
  options,
  problem,
  problemNotes = [],
}: {
  sourceId: string
  sourceName: string
  /** 元のデータの場所 (名前が日本語ならファイルの名前を書き出しの名前に) */
  sourcePath: string
  profile: Profile
  target: string | null
  steps: StepInfo[]
  /** データの種類 (画像, 文, 点群, 音声は中身の手順も組み立てる) */
  kind: string
  itemSteps: ItemStepInfo[]
  /** 読み込みと読み込みの設定 (決めてほしいことで読み方を変えるため) */
  loader: string
  options: Record<string, unknown>
  /** 問題の設定から始めた場合の problem.yaml の場所 */
  problem?: string | null
  /** 問題の設定から始めたときの知らせ */
  problemNotes?: string[]
}) {
  const media = ITEM_KINDS.includes(kind)
  const [addingItem, setAddingItem] = useState('')
  const queryClient = useQueryClient()
  const saved = useQuery({ queryKey: ['recipe', sourceId], queryFn: () => api.recipe(sourceId) })
  // 編集中のレシピ (編集するまでは保存したもの. タブを移っても残す).
  // 目的の列は上の指定に合わせる
  const [draft, setDraft] = useRecipeDraft(sourceId)
  const base = draft ?? saved.data ?? null
  // 目的の列が無いのに正解の欠けた行を残す指定があれば, 編集中のレシピから消す
  // (目的の列を外すときにも消す. ここは別の経路で外れた場合のため)
  useEffect(() => {
    if (target) return
    const next = untargetedDraft(draft, saved.data ?? null)
    if (next) setDraft(next)
  }, [target, draft, saved.data, setDraft])
  // タスクを決めていない場合は, 分析で推定したタスク (分類か回帰) にする.
  // 目的の列が無ければ, 上で消すまでの間も正解の欠けた行を残す指定を外して試す
  const guessed = profile.target?.task ?? 'none'
  const recipe = useMemo(
    () =>
      base
        ? fitUnlabeled(
            {
              ...base,
              target,
              task: base.task === 'none' && target && !draft ? guessed : base.task,
            },
            target,
          )
        : null,
    [base, target, guessed, draft],
  )
  const [selected, setSelected] = useState<number | null>(null)
  const [adding, setAdding] = useState('')
  const [name, setName] = useState(defaultDatasetName(sourceName, sourcePath))
  const [overwrite, setOverwrite] = useState(false)

  const columns = Object.keys(profile.columns)
  const upto = recipe ? (selected === null ? recipe.steps.length : selected + 1) : 0
  // 打つたびに前処理を試さないように, 少し待ってから試す
  const pending = useDebounced({ recipe, upto })
  const preview = useQuery({
    queryKey: ['preview', sourceId, JSON.stringify(pending.recipe), pending.upto],
    queryFn: () => api.preview(sourceId, pending.recipe!, pending.upto),
    enabled: pending.recipe !== null,
    retry: false,
  })
  // 保存したレシピを読み終えるまでは, 変更の印を出さない
  const dirty =
    draft !== null &&
    saved.data !== undefined &&
    JSON.stringify(draft) !== JSON.stringify(saved.data)
  // 保存と書き出しはレシピも保存するので, 編集中の印を外す
  const save = useMutation({
    mutationFn: () => api.saveRecipe(sourceId, recipe!),
    onSuccess: (data) => {
      queryClient.setQueryData(['recipe', sourceId], data)
      setDraft(null)
    },
  })
  const exporter = useMutation({
    mutationFn: () => api.exportDataset(sourceId, recipe!, name, overwrite),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['datasets'] })
      void queryClient.invalidateQueries({ queryKey: ['recipe', sourceId] })
      setDraft(null)
    },
  })
  // 既にある手順は候補から除く (押すたびに同じ手順が増えないように)
  const suggestions = useMemo(() => {
    // 手順の名前と対象の列が同じものは, 引数が違っても既にあるとみなす
    const keyOf = (step: RecipeStep) =>
      JSON.stringify([step.op, step.columns ?? step.column ?? null])
    const present = new Set((recipe?.steps ?? []).map(keyOf))
    return suggestSteps(profile.findings, target, profile.columns, profile.overview.roles).filter(
      (step) => !present.has(keyOf(step)),
    )
  }, [profile, target, recipe])
  const infoOf = (op: string) => steps.find((item) => item.op === op)
  const [decided, decide] = useDecided(sourceId)
  const decisions = useMemo(
    () =>
      recipe ? findDecisions({ profile, recipe, kind, target, loader, options, decided }) : [],
    [profile, recipe, kind, target, loader, options, decided],
  )

  if (saved.error) return <ErrorBox error={saved.error} />
  if (recipe === null) return <Spinner />

  const update = (next: Recipe) => {
    setDraft(next)
    save.reset()
    exporter.reset()
  }
  const setSteps = (next: RecipeStep[]) => update({ ...recipe, steps: next })
  const items = recipe.item_steps ?? []
  const setItems = (next: RecipeStep[]) => update({ ...recipe, item_steps: next })
  const kindSteps = itemSteps.filter((item) => item.kind === kind)
  // 中身の手順の引数が上限を超えていれば, 送る前に理由を出して試すと書き出すを止める
  // (ファイルの組の書き出しの欄と同じ. API も 422 で止める)
  const limitErrors = media ? itemLimitErrors(items, kindSteps) : []
  const reasons = limitErrors.length > 0 ? 'item-step-reasons' : undefined
  // 選んでいる手順は, 動かした先でも選んだままにする
  const move = (index: number, delta: number) => {
    const next = [...recipe.steps]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item!)
    if (selected === index) setSelected(index + delta)
    else if (selected === index + delta) setSelected(index)
    setSteps(next)
  }
  const result = preview.data
  const isFinal = upto === recipe.steps.length
  // グループの列で分ける分割 (列が要る). グループの層化は目的の値で層を作るので, 回帰と時系列の
  // 予測では使えない (ML-EDA の load_recipe が止める)
  const grouped = ['group', 'group_time', 'stratified_group'].includes(recipe.split.method)
  const stratifiable = !['regression', 'forecasting'].includes(recipe.task)
  // 時刻で分ける分割を, 時刻の列の無い読み方 (表) で選んだか. 日時の型の列があれば読み方を案内する
  const timeSplit =
    ['time', 'group_time'].includes(recipe.split.method) && !profile.overview.roles?.time
  const datetimes = Object.entries(profile.columns)
    .filter(([, info]) => looksLikeDatetime(info))
    .map(([name]) => name)
  // 分割の後の気付きは重要度つきで出し, 同じ文は注意の並びから除く
  const findings = result?.findings ?? []
  const notes = (result?.notes ?? []).filter(
    (note) => !findings.some((item) => item.message === note),
  )
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,30rem)_1fr]">
      <div className="space-y-4">
        {problem && (
          <ProblemCard
            sourceId={sourceId}
            notes={problemNotes}
            recipe={pending.recipe}
            latest={recipe}
            onWritten={() => {
              // 書き戻したレシピはここにも保存したので, 編集中の印を外す
              setSelected(null)
              setDraft(null)
              save.reset()
              exporter.reset()
            }}
          />
        )}
        <DecisionsCard
          sourceId={sourceId}
          decisions={decisions}
          onRecipe={(next) => {
            // 変わらない選択 (落とす手順の無い列を残すなど) は下書きにしない
            if (JSON.stringify(next) === JSON.stringify(recipe)) return
            setSelected(null)
            update(next)
          }}
          onDecide={decide}
        />
        <Card title="目的と分割">
          {/* 長い選択肢の文で欄がカードの外へ広がらないように, 右の列は幅を超えない */}
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 text-sm">
            <span className="text-ink-3">目的の列</span>
            <span className="font-mono">{target ?? 'なし (上で選ぶ)'}</span>
            <label htmlFor="task" className="text-ink-3">
              タスク
            </label>
            <select
              id="task"
              value={recipe.task}
              onChange={(event) => update({ ...recipe, task: event.target.value })}
              className="h-8 rounded border border-line bg-surface px-2 min-w-0 max-w-full"
            >
              {Object.entries(TASK_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="split" className="text-ink-3">
              分割
            </label>
            <select
              id="split"
              value={recipe.split.method}
              onChange={(event) => {
                const split: Recipe['split'] = { ...recipe.split, method: event.target.value }
                // 分けないときはグループの列の欄を出さないので, 隠れたまま残さない
                if (split.method === 'none') delete split.column
                update({ ...recipe, split })
              }}
              className="h-8 rounded border border-line bg-surface px-2 min-w-0 max-w-full"
            >
              <option value="random">無作為</option>
              <option value="stratified">層化 (クラスの割合を保つ)</option>
              <option value="time">時刻の順 (最後を検証用に)</option>
              <option value="group">グループごと</option>
              <option value="group_time">グループと時刻の組 (新しい相手を検証用に)</option>
              <option
                value="stratified_group"
                disabled={!stratifiable && recipe.split.method !== 'stratified_group'}
              >
                {stratifiable
                  ? 'グループの層化 (クラスの割合を保つ)'
                  : 'グループの層化 (回帰と時系列では使えない)'}
              </option>
              <option value="none">分けない</option>
            </select>
            {/* タスクを変えてグループの層化が残った場合 (ML-EDA は load_recipe で止める) */}
            {recipe.split.method === 'stratified_group' && !stratifiable && (
              <p role="alert" className="col-start-2 text-xs text-critical-text">
                グループの層化は, 回帰と時系列の予測では使えません (目的の値で層を作れないため).
                グループごとかグループと時刻の組を選ぶか, タスクを分類にしてください
              </p>
            )}
            {/* 表として読むと日時の列を時刻に使わないので, 時刻で分けるなら読み方を案内する */}
            {timeSplit && datetimes.length > 0 && (
              <p className="col-start-2 text-xs text-warning-text">
                時刻で分けるには日時の列が要ります. 日時に見える列 ({datetimes.join(', ')})
                があるので, 上の「読み方」を「時系列 (時刻: {datetimes[0]})」にすると使えます
              </p>
            )}
            {(['valid', 'test'] as const).map((key) => (
              <div key={key} className="contents">
                <label htmlFor={`split-${key}`} className="text-ink-3">
                  {key === 'valid' ? '検証用の割合' : 'テスト用の割合'}
                </label>
                <input
                  id={`split-${key}`}
                  type="number"
                  step="0.05"
                  min="0"
                  max="0.9"
                  value={recipe.split[key] ?? 0}
                  onChange={(event) =>
                    update({
                      ...recipe,
                      split: {
                        ...recipe.split,
                        [key]: event.target.value === '' ? 0 : Number(event.target.value),
                      },
                    })
                  }
                  className="h-8 w-24 rounded border border-line bg-surface px-2"
                />
              </div>
            ))}
            {/* グループの列は group, group_time, stratified_group の分割に使い (要る), 他の分割では
                分割をまたぐ重なりを確かめる (任意)
                (分けないときは重なりが無いので出さない) */}
            {recipe.split.method !== 'none' && (
              <>
                <label htmlFor="split-column" className="text-ink-3">
                  グループの列
                  {!grouped && (
                    <span className="block text-xs"> (任意. 分割をまたぐ重なりを確かめる)</span>
                  )}
                </label>
                <select
                  id="split-column"
                  value={recipe.split.column ?? ''}
                  onChange={(event) => {
                    // 空を選んだら列の指定を消す (古い列で重なりを確かめ続けないように)
                    const split: Recipe['split'] = { ...recipe.split, column: event.target.value }
                    if (!split.column) delete split.column
                    update({ ...recipe, split })
                  }}
                  className="h-8 rounded border border-line bg-surface px-2 font-mono min-w-0 max-w-full"
                >
                  <option value="">{grouped ? '選ぶ…' : 'なし'}</option>
                  {columns.map((column) => (
                    <option key={column}>{column}</option>
                  ))}
                  {/* 今のデータに無い列 (読み方を変えたなど) も, 選んだままと分かるように出す */}
                  {recipe.split.column && !columns.includes(recipe.split.column) && (
                    <option value={recipe.split.column}>{recipe.split.column}</option>
                  )}
                </select>
              </>
            )}
            {/* 正解の欠けた行は目的の列がある場合だけ選ぶ (ML-EDA の split.unlabeled) */}
            {target && (
              <>
                <label htmlFor="split-unlabeled" className="text-ink-3">
                  正解の欠けた行
                </label>
                <select
                  id="split-unlabeled"
                  aria-describedby="split-unlabeled-help"
                  value={recipe.split.unlabeled === 'keep' ? 'keep' : 'drop'}
                  disabled={
                    !canKeepUnlabeled(recipe, profile.columns[target], profile.overview.sampled)
                  }
                  onChange={(event) => update(withUnlabeled(recipe, event.target.value === 'keep'))}
                  className="h-8 rounded border border-line bg-surface px-2 disabled:opacity-60"
                >
                  <option value="drop">落とす</option>
                  <option value="keep">unlabeled の分割に残す</option>
                </select>
                <p id="split-unlabeled-help" className="col-span-2 text-xs text-ink-3">
                  {profile.columns[target] &&
                    `目的の列の欠けた行: ${formatNumber(profile.columns[target].missing)} 行${
                      profile.overview.sampled ? ' (間引いて分析した行で)' : ''
                    }. `}
                  半教師あり学習や異常の検知のように, 正解の無い行も学習に使う場合は残します. train,
                  valid, test の中身は変わらず, 残した行には学習用で当てはめた前処理をかけます.
                </p>
              </>
            )}
          </div>
        </Card>
        <Card
          title={`手順 (${recipe.steps.length})`}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                icon={Wand2}
                className={clsx(media && 'hidden')}
                onClick={() => {
                  const made = autoRecipe(
                    profile.columns,
                    target,
                    profile.findings,
                    profile.overview.roles,
                    target ? (profile.timeseries?.columns[target]?.period ?? null) : null,
                    profile.timeseries?.series_by ?? null,
                    profile.timeseries?.interval_seconds ?? null,
                  )
                  if (
                    recipe.steps.length === 0 ||
                    window.confirm('今の手順を, 列の型から作った手順に置き換えますか?')
                  ) {
                    setSelected(null)
                    setSteps(made)
                  }
                }}
                title="文や ID の列を落とし, カテゴリを符号化し, 欠損を埋め, 標準化する手順を, 列の型から作る (時系列は過去の値の列も足す)"
              >
                学習できる形にする手順を作る
              </Button>
              {suggestions.length > 0 && (
                <Button
                  icon={Sparkles}
                  onClick={() => setSteps([...recipe.steps, ...suggestions])}
                  title="気付き (ID らしい列, 欠損, 偏った分布など) に合う手順を足す"
                >
                  気付きから {suggestions.length} 手順を足す
                </Button>
              )}
            </div>
          }
        >
          <ol className="space-y-2">
            {recipe.steps.map((step, index) => (
              <StepEditor
                key={`${index}-${step.op}`}
                step={step}
                index={index}
                count={recipe.steps.length}
                info={infoOf(step.op)}
                columns={columns}
                active={selected === index}
                onSelect={() => setSelected(selected === index ? null : index)}
                onChange={(next) =>
                  setSteps(recipe.steps.map((item, at) => (at === index ? next : item)))
                }
                onMove={(delta) => move(index, delta)}
                onRemove={() => {
                  setSelected(null)
                  setSteps(recipe.steps.filter((_, at) => at !== index))
                }}
              />
            ))}
          </ol>
          {recipe.steps.length === 0 && (
            <p className="text-sm text-ink-3">
              まだ手順がありません. 下で足すか, 「気付きから手順を足す」で候補を入れます.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <label className="sr-only" htmlFor="add-step">
              足す手順
            </label>
            <select
              id="add-step"
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
              className="h-8 w-0 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-sm"
            >
              <option value="">足す手順を選ぶ…</option>
              {steps.map((item) => (
                <option key={item.op} value={item.op}>
                  {item.op} — {item.description}
                </option>
              ))}
            </select>
            <Button
              icon={Plus}
              disabled={!adding}
              onClick={() => {
                setSteps([...recipe.steps, { op: adding }])
                setAdding('')
              }}
            >
              足す
            </Button>
          </div>
        </Card>
        {media && (
          <Card
            title={`中身の手順 (${items.length})`}
            actions={
              <Button
                icon={Wand2}
                onClick={() => {
                  if (
                    items.length === 0 ||
                    window.confirm('今の中身の手順を, 分析から作った手順に置き換えますか?')
                  ) {
                    // 読めない件があれば, 書き出しで止まらないように表の手順で除く
                    update(withAutoItems(recipe, kind, profile))
                  }
                }}
                title="分析 (最も多い大きさ, 語の数, 点の数, 音声の周波数とチャンネルと長さ, 読めない件) から, 学習用の配列にする手順を作る"
              >
                学習用の配列にする手順を作る
              </Button>
            }
          >
            <p className="mb-2 text-xs text-ink-3">
              1 件ずつの中身 (画像, 文, 点群, 音声) を学習用の配列にする手順.
              上の表の手順で件を絞った後に, 書き出すときにかける
              (値を学ぶ手順は学習用の件で当てはめる).
            </p>
            <ol className="space-y-2">
              {items.map((step, index) => (
                <StepEditor
                  key={`item-${index}-${step.op}`}
                  step={step}
                  index={index}
                  count={items.length}
                  info={kindSteps.find((item) => item.op === step.op)}
                  columns={[]}
                  active={false}
                  onSelect={() => undefined}
                  onChange={(next) =>
                    setItems(items.map((item, at) => (at === index ? next : item)))
                  }
                  onMove={(delta) => {
                    const next = [...items]
                    const [moved] = next.splice(index, 1)
                    next.splice(index + delta, 0, moved!)
                    setItems(next)
                  }}
                  onRemove={() => setItems(items.filter((_, at) => at !== index))}
                />
              ))}
            </ol>
            {limitErrors.length > 0 && (
              <ul id="item-step-reasons" className="mt-2 list-disc pl-5 text-xs text-critical-text">
                {limitErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            {kind === 'text' && profile.items?.tokenizers && (
              <TokenizerTable
                comparison={profile.items.tokenizers}
                current={items.find((step) => step.op === 'vocabulary')}
                onUse={(step) => {
                  const index = items.findIndex((item) => item.op === 'vocabulary')
                  const next = {
                    ...(index >= 0 ? items[index] : {}),
                    ...step,
                    op: 'vocabulary',
                  }
                  setItems(
                    index >= 0
                      ? items.map((item, at) => (at === index ? next : item))
                      : [...items, next],
                  )
                }}
              />
            )}
            <div className="mt-3 flex gap-2">
              <label className="sr-only" htmlFor="add-item-step">
                足す中身の手順
              </label>
              <select
                id="add-item-step"
                value={addingItem}
                onChange={(event) => setAddingItem(event.target.value)}
                className="h-8 w-0 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-sm"
              >
                <option value="">足す中身の手順を選ぶ…</option>
                {kindSteps.map((item) => (
                  <option key={item.op} value={item.op}>
                    {item.op} — {item.description}
                  </option>
                ))}
              </select>
              <Button
                icon={Plus}
                disabled={!addingItem}
                onClick={() => {
                  setItems([...items, { op: addingItem }])
                  setAddingItem('')
                }}
              >
                足す
              </Button>
            </div>
          </Card>
        )}
        <Card title="保存と書き出し">
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={Save} disabled={save.isPending} onClick={() => save.mutate()}>
              レシピを保存
            </Button>
            {save.isSuccess && <span className="text-xs text-good-text">保存しました</span>}
            {dirty && (
              <span className="text-xs text-warning-text">
                保存していない変更があります (タブを移っても, 読み込み直しても残ります)
              </span>
            )}
          </div>
          {save.error && <ErrorBox error={save.error} />}
          <div className="mt-4 grid grid-cols-[7rem_1fr] items-center gap-2 text-sm">
            <label htmlFor="dataset-name" className="text-ink-3">
              データセットの名前
            </label>
            <input
              id="dataset-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 rounded border border-line bg-surface px-2 font-mono"
            />
            <span />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />
              同じ名前があれば置き換える
            </label>
          </div>
          {decisions.length > 0 && (
            <p className="mt-3 text-xs text-warning-text">
              決めていないことが {decisions.length} 件あります (上の「決めてほしいこと」).
              このままでも書き出せます.
            </p>
          )}
          <Button
            variant="primary"
            icon={Upload}
            className="mt-3"
            disabled={exporter.isPending || !name || reasons !== undefined}
            aria-describedby={reasons}
            onClick={() => exporter.mutate()}
          >
            {exporter.isPending ? '書き出し中…' : '学習用に書き出す'}
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
          {exporter.data && (
            <div className="mt-3 space-y-2 text-sm">
              <p className="text-good-text">書き出しました: {exporter.data.path}</p>
              {exporter.data.hints && <ModelHintsView hints={exporter.data.hints} />}
              <p className="text-xs text-ink-3">ML-Found の学習スクリプトでの使い方:</p>
              <pre className="overflow-auto rounded bg-surface-2 p-2 text-xs">
                {usageSnippet(
                  exporter.data.path,
                  (exporter.data.info.splits as Record<string, unknown> | undefined) ?? {},
                  media,
                )}
              </pre>
            </div>
          )}
          {problem && (
            <ProjectExport
              sourceId={sourceId}
              recipe={recipe}
              reasons={reasons}
              onExported={() => {
                // 書き出しはレシピも保存するので, 編集中の印を外す
                setDraft(null)
                save.reset()
              }}
            />
          )}
        </Card>
        <Card title="レシピ (YAML)" padded>
          <pre className="max-h-72 overflow-auto text-xs">{YAML.stringify(recipe)}</pre>
        </Card>
      </div>
      <div className="min-w-0 space-y-4">
        <Card
          title={
            selected === null
              ? `全ての手順の後 (${recipe.steps.length} 手順)`
              : `手順 ${selected + 1} (${recipe.steps[selected]?.op}) の前と後`
          }
        >
          {preview.isFetching && <Spinner label="前処理を試しています" />}
          {preview.error && <ErrorBox error={preview.error} />}
          {result && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-4 text-sm">
                <span>
                  行 {formatNumber(result.before.rows)} → {formatNumber(result.after.rows)}
                </span>
                <span>
                  列 {result.before.columns.length} → {result.after.columns.length}
                </span>
                {result.added.length > 0 && (
                  <span className="text-good-text">足した列 {result.added.length}</span>
                )}
                {result.removed.length > 0 && (
                  <span className="text-critical-text">消えた列: {result.removed.join(', ')}</span>
                )}
              </div>
              {!isFinal || recipe.steps.length > 0 ? (
                <>
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-ink-3">
                      {selected === null ? '最後の手順の前' : '前'}
                    </h3>
                    <FramePreview view={result.before} highlight={result.removed} />
                  </div>
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-ink-3">後</h3>
                    <FramePreview view={result.after} highlight={result.added} />
                  </div>
                </>
              ) : (
                <FramePreview view={result.after} highlight={[]} />
              )}
              {isFinal && result.splits && (
                <div className="rounded-lg bg-surface-2 p-3 text-sm">
                  <div className="mb-1 font-semibold">学習用のデータ</div>
                  <div>
                    分割:{' '}
                    {Object.entries(result.splits)
                      .map(([split, count]) => `${splitLabel(split)} ${formatNumber(count)} 行`)
                      .join(', ')}
                  </div>
                  <div>学習に使う列: {result.features?.length ?? 0}</div>
                  {result.classes && result.classes.length > 0 && (
                    <div>クラス: {result.classes.join(', ')}</div>
                  )}
                  {/* 選んだ列などで変わる注意と気付きを, 読み上げにも知らせる */}
                  <div role="status" aria-live="polite">
                    {notes.length > 0 && (
                      <ul className="mt-2 list-disc pl-5 text-warning-text">
                        {notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                    {findings.length > 0 && (
                      <div className="mt-2">
                        <Findings findings={findings} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-ink-3">
            左の手順の番号を押すと, その手順の前と後を見られます (もう一度押すと全ての手順の後).
            値を学ぶ手順 (標準化, 補完など) は, 学習用のデータだけで当てはめます.
          </p>
        </Card>
        {media && (
          <ItemPreviewCard sourceId={sourceId} kind={kind} recipe={recipe} reasons={reasons} />
        )}
      </div>
    </div>
  )
}
