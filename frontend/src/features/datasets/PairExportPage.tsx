import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'

import { ApiError, useApi } from '../../api/client'
import type {
  PairExportBase,
  ExportNotice,
  PairExportResult,
  PairSettings,
  PairSteps,
  ProblemPairs,
  ProblemPairsResult,
} from '../../api/types'
import { FolderField } from '../../components/FolderField'
import {
  Button,
  Card,
  ErrorBox,
  PageHeader,
  Spinner,
  Tabs,
  type TabItem,
} from '../../components/ui'
import { itemStepsBody, itemStepsDrafts, stepText, type EntryDrafts } from '../../lib/entrySteps'
import { formatNumber } from '../../lib/format'
import {
  classesText,
  groupsText,
  itemsSnippet,
  numberText,
  ORIGIN_LABELS,
  originNote,
  parseClasses,
  parseGroups,
  parseSettings,
  settingsText,
} from '../../lib/pairs'
import { splitLabel } from '../../lib/recipe'
import { EntryStepsField } from './EntryStepsField'
import { ModelNeeds } from './ModelNeeds'

type FormId = 'image_masks' | 'capture_clouds'

const TABS: TabItem<FormId>[] = [
  { id: 'image_masks', label: '画像と領域' },
  { id: 'capture_clouds', label: '撮影と点群' },
]

/** 点群の単位 (ML-EDA の cloud_units) */
const CLOUD_UNITS: Record<string, string> = {
  meter: 'メートル',
  centimeter: 'センチメートル',
  millimeter: 'ミリメートル',
}

/** 2 つの書き出しに共通の欄の値 */
interface CommonFields {
  name: string
  overwrite: boolean
  method: '' | 'random' | 'group' | 'none'
  /** 正解の無い件を除くか, unlabeled の分割に書くか (ML-EDA の split.unlabeled) */
  unlabeled: 'drop' | 'keep'
  /** 外を指すリンクの先も写すか (ML-EDA の follow_links. 問題の設定には書き戻さない) */
  followLinks: boolean
  valid: string
  test: string
  seed: string
  groups: string
  originType: string
  originName: string
  originSettings: string
}

const INITIAL: CommonFields = {
  name: '',
  overwrite: false,
  method: '',
  unlabeled: 'drop',
  followLinks: false,
  valid: '0.2',
  test: '0',
  seed: '0',
  groups: '',
  originType: 'unknown',
  originName: '',
  originSettings: '',
}

/**
 * 問題の設定から始めた場合の, 書き出しの設定の下書きと書き出し先.
 * 名前の代わりにプロジェクトの書き出し先へ書き出し, 設定を問題の設定に書き戻す
 */
interface Linked {
  pairs: ProblemPairs
  /** 書き出すときに送り返す中身の印 (書き戻すたびに変わる) */
  version: string
  onWritten: (result: ProblemPairsResult) => void
}

/** 書き出しの設定の下書きから, 共通の欄の値を作る (名前は使わない) */
function linkedFields(settings: PairSettings): CommonFields {
  const split = settings.split
  return {
    ...INITIAL,
    method: split.method ?? '',
    unlabeled: split.unlabeled === 'keep' ? 'keep' : 'drop',
    valid: numberText(split.valid, INITIAL.valid),
    test: numberText(split.test, INITIAL.test),
    seed: numberText(split.seed, INITIAL.seed),
    groups: groupsText(settings.groups),
    originType: settings.origin.type ?? INITIAL.originType,
    originName: settings.origin.name ?? '',
    originSettings: settingsText(settings.origin.settings),
  }
}

/** 共通の欄の要求と書き出しごとの値を, 問題の設定に書き戻す設定にする */
function linkedSettings(
  name: PairSettings['function'],
  body: PairExportBase,
  inputs: string,
  targets: string,
  options: PairSettings['options'],
): PairSettings {
  return {
    function: name,
    inputs,
    targets,
    split: body.split,
    groups: body.groups ?? null,
    origin: body.origin,
    options,
  }
}

/** 割合の欄を数にする (0 以上 1 未満. 誤りは null) */
function ratio(text: string): number | null {
  const value = Number(text)
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 && value < 1 ? value : null
}

/**
 * 共通の欄を書き出しの要求にする. 誤りがあれば理由の並び
 */
function commonBody(
  fields: CommonFields,
  named = true,
): { body: PairExportBase | null; errors: string[] } {
  const errors: string[] = []
  // 問題の設定から始めた場合は名前の代わりにプロジェクトの書き出し先
  if (named && !fields.name.trim()) errors.push('データセットの名前を入れてください')
  // 分けない場合は割合の欄を使わない (止めた欄の誤りで書き出せなくならないように)
  const none = fields.method === 'none'
  const valid = none ? 0 : ratio(fields.valid)
  const test = none ? 0 : ratio(fields.test)
  const seed = Number(fields.seed)
  if (valid === null) errors.push('検証用の割合は 0 以上 1 未満にしてください')
  if (test === null) errors.push('テスト用の割合は 0 以上 1 未満にしてください')
  if (valid !== null && test !== null && valid + test >= 1) {
    errors.push('検証用とテスト用の割合の和は 1 未満にしてください')
  }
  if (fields.seed.trim() === '' || !Number.isInteger(seed) || seed < 0) {
    errors.push('乱数の種は 0 以上の整数にしてください')
  }
  const groups = parseGroups(fields.groups)
  if (groups.error) errors.push(groups.error)
  const settings = parseSettings(fields.originSettings)
  if (settings.error) errors.push(settings.error)
  if (fields.method === 'group' && !groups.value) {
    errors.push('グループごとの分割にはグループが要ります')
  }
  if (errors.length > 0) return { body: null, errors }
  const body: PairExportBase = {
    name: fields.name.trim(),
    overwrite: fields.overwrite,
    split: {
      ...(fields.method ? { method: fields.method } : {}),
      // 除く (drop) は既定と同じなので渡さない
      ...(fields.unlabeled === 'keep' ? { unlabeled: 'keep' as const } : {}),
      valid: valid!,
      test: test!,
      seed,
    },
    groups: groups.value ?? undefined,
    origin: {
      type: fields.originType,
      name: fields.originName.trim() || null,
      settings: settings.value ?? {},
    },
    // 写さない (false) は既定と同じなので渡さない
    ...(fields.followLinks ? { follow_links: true } : {}),
  }
  return { body, errors }
}

/** ラベルと入力の 1 行 */
function Row({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <>
      <label htmlFor={id} className="text-ink-3">
        {label}
      </label>
      {children}
    </>
  )
}

const inputClass = 'h-8 rounded border border-line bg-surface px-2 font-mono'
const areaClass = 'min-h-16 rounded border border-line bg-surface px-2 py-1 font-mono text-xs'

/** 外を指すリンクの先も写すかの欄 (入力と正解のディレクトリの欄の下) */
function LinksField({
  prefix,
  fields,
  setFields,
}: {
  prefix: string
  fields: CommonFields
  setFields: (fields: CommonFields) => void
}) {
  return (
    <>
      <span />
      <label className="flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={fields.followLinks}
          aria-describedby={`${prefix}-links-note`}
          onChange={(event) => setFields({ ...fields, followLinks: event.target.checked })}
        />
        外を指すリンクの先も写す
      </label>
      <p id={`${prefix}-links-note`} className="col-start-2 text-xs text-ink-3">
        {fields.followLinks
          ? 'ディレクトリの外を指すリンクの先 (共有の保存先など) も, データセットの中に写します. 書き出し先は変わりません.'
          : 'ディレクトリの外を指すリンクの先は写さず, 数と例を書き出しの注意に書きます.'}
      </p>
    </>
  )
}

/** 書き出しの注意に外を指すリンクで除いた件があるか (ML-EDA の注意の印の種類で見分ける) */
function skippedLinks(notices: ExportNotice[]): boolean {
  return notices.some((notice) => notice.code === 'outside_links' && notice.count > 0)
}

/** 分割, グループ, 正解の出どころの欄 */
function CommonCard({
  prefix,
  fields,
  setFields,
  groupHint,
  unlabeledHint,
}: {
  prefix: string
  fields: CommonFields
  setFields: (fields: CommonFields) => void
  groupHint: string
  /** 正解の無い件の例 (領域の無い画像, 点群の無い撮影) */
  unlabeledHint: string
}) {
  const set = <K extends keyof CommonFields>(key: K, value: CommonFields[K]) =>
    setFields({ ...fields, [key]: value })
  const note = originNote({ type: fields.originType, name: fields.originName.trim() || null })
  return (
    <>
      <Card title="分割とグループ">
        <div className="grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
          <Row id={`${prefix}-method`} label="分割">
            <select
              id={`${prefix}-method`}
              value={fields.method}
              onChange={(event) => set('method', event.target.value as CommonFields['method'])}
              className="h-8 rounded border border-line bg-surface px-2"
            >
              <option value="">自動 (グループがあればグループごと, 無ければ無作為)</option>
              <option value="random">無作為</option>
              <option value="group">グループごと</option>
              <option value="none">分けない (全て学習用)</option>
            </select>
          </Row>
          <Row id={`${prefix}-unlabeled`} label="正解の無い件">
            <select
              id={`${prefix}-unlabeled`}
              value={fields.unlabeled}
              aria-describedby={`${prefix}-unlabeled-note`}
              onChange={(event) =>
                set('unlabeled', event.target.value as CommonFields['unlabeled'])
              }
              className="h-8 rounded border border-line bg-surface px-2"
            >
              <option value="drop">除く (数と例を書き出しの注意に書く)</option>
              <option value="keep">unlabeled の分割に書く</option>
            </select>
          </Row>
          <p id={`${prefix}-unlabeled-note`} className="col-start-2 text-xs text-ink-3">
            正解の無い件は{unlabeledHint}です.{' '}
            {fields.unlabeled === 'keep'
              ? '除かずに unlabeled という名前の分割に書きます (正解の項目は空). 半教師ありの学習や推論の確かめに使えます. 正解の付いた件の分割と中身は除く場合と同じで, 分割の割合とグループの確かめにも入りません.'
              : '書き出さず, 数と例を書き出しの注意に書きます.'}
          </p>
          <Row id={`${prefix}-valid`} label="検証用の割合">
            <input
              id={`${prefix}-valid`}
              value={fields.valid}
              inputMode="decimal"
              disabled={fields.method === 'none'}
              onChange={(event) => set('valid', event.target.value)}
              className={inputClass}
            />
          </Row>
          <Row id={`${prefix}-test`} label="テスト用の割合">
            <input
              id={`${prefix}-test`}
              value={fields.test}
              inputMode="decimal"
              disabled={fields.method === 'none'}
              onChange={(event) => set('test', event.target.value)}
              className={inputClass}
            />
          </Row>
          <Row id={`${prefix}-seed`} label="乱数の種">
            <input
              id={`${prefix}-seed`}
              value={fields.seed}
              inputMode="numeric"
              onChange={(event) => set('seed', event.target.value)}
              className={inputClass}
            />
          </Row>
          <Row id={`${prefix}-groups`} label="グループ (任意)">
            <textarea
              id={`${prefix}-groups`}
              value={fields.groups}
              placeholder={groupHint}
              onChange={(event) => set('groups', event.target.value)}
              className={areaClass}
            />
          </Row>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          1 行に「件の id,グループ」. 同じ物や現場の件が学習用と検証用に分かれると力を甘く測るので,
          グループごとに分けます.
        </p>
      </Card>
      <Card title="正解の出どころ">
        <div className="grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
          <Row id={`${prefix}-origin-type`} label="種類">
            <select
              id={`${prefix}-origin-type`}
              value={fields.originType}
              onChange={(event) => set('originType', event.target.value)}
              className="h-8 rounded border border-line bg-surface px-2"
            >
              {Object.entries(ORIGIN_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label} ({value})
                </option>
              ))}
            </select>
          </Row>
          <Row id={`${prefix}-origin-name`} label="作った処理の名前">
            <input
              id={`${prefix}-origin-name`}
              value={fields.originName}
              onChange={(event) => set('originName', event.target.value)}
              className={inputClass}
            />
          </Row>
          <Row id={`${prefix}-origin-settings`} label="設定 (YAML)">
            <textarea
              id={`${prefix}-origin-settings`}
              value={fields.originSettings}
              placeholder="threshold: 0.5"
              onChange={(event) => set('originSettings', event.target.value)}
              className={areaClass}
            />
          </Row>
        </div>
        {note && <p className="mt-2 text-xs text-warning-text">{note}</p>}
      </Card>
    </>
  )
}

/** 書き出しの種類ごとの, 項目の呼び名 (中身の手順の欄に出す順) */
const ENTRY_LABELS: Record<keyof PairSteps, Record<string, string>> = {
  image_masks: { image: '画像' },
  capture_clouds: { capture: '撮影', cloud: '点群' },
}

/**
 * 組み立て中の手順の初め. 問題の設定から始めた場合は書き戻した手順 (下書きの
 * options.item_steps), 他は項目ごとに空
 */
function initialDrafts(form: keyof PairSteps, draft: PairSettings | undefined): EntryDrafts {
  return itemStepsDrafts(draft?.options.item_steps, Object.keys(ENTRY_LABELS[form]))
}

/** 選べる中身の手順 (ML-EDA の登録簿を項目の種類で絞ったもの) を読む */
function usePairSteps(): PairSteps | undefined {
  const api = useApi()
  const info = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity })
  return info.data?.pair_steps
}

/** 項目ごとの中身の手順の欄 */
function StepsCard({
  form,
  pairSteps,
  drafts,
  setDrafts,
}: {
  form: keyof PairSteps
  pairSteps: PairSteps | undefined
  drafts: EntryDrafts
  setDrafts: (drafts: EntryDrafts) => void
}) {
  return (
    <Card title="中身の手順 (任意)">
      <p className="mb-2 text-xs text-ink-3">
        1 件ずつのファイルにかける手順 (足した順にかける). 足すと版 3 で書き出し,
        かけた手順をデータセットに残す (推論で新しい 1 件に同じ手順をかけるため).
        {form === 'image_masks' &&
          ' 領域には, 画像の resize と同じ大きさの resize_mask (最も近い画素) を書き出すときに自動でかける.'}
      </p>
      {pairSteps ? (
        <div className="space-y-3">
          {Object.entries(ENTRY_LABELS[form]).map(([entry, label]) => (
            <div key={entry}>
              <p className="mb-1 text-sm">
                {label} <span className="font-mono text-xs text-ink-3">({entry})</span>
              </p>
              <EntryStepsField
                id={`${form}-steps-${entry}`}
                label={label}
                infos={pairSteps[form][entry] ?? []}
                drafts={drafts[entry] ?? []}
                onChange={(next) => setDrafts({ ...drafts, [entry]: next })}
              />
            </div>
          ))}
        </div>
      ) : (
        <Spinner />
      )}
    </Card>
  )
}

/** 名前, 置き換え, 書き出す押しボタンと結果 */
function ExportCard({
  prefix,
  fields,
  setFields,
  errors,
  onExport,
  mutation,
  linked,
}: {
  prefix: string
  fields: CommonFields
  setFields: (fields: CommonFields) => void
  errors: string[]
  onExport: () => void
  mutation: {
    isPending: boolean
    error: Error | null
    data: PairExportResult | ProblemPairsResult | undefined
  }
  linked?: Linked
}) {
  const result = mutation.data
  const written = result && 'changes' in result ? result : null
  const project = linked?.pairs.project
  const replace = linked ? '前に書き出したデータセットを上書きする' : '同じ名前があれば上書きする'
  const label = linked ? '学習のプロジェクトへ書き出す' : 'ファイルの組を書き出す'
  const info = result?.info as
    | {
        splits?: Record<string, { items?: number } | undefined>
        target?: { entries?: string[] }
        entries?: Record<string, unknown>
        normalization?: unknown
        format_version?: number
      }
    | undefined
  // 中身の手順をかけた項目 (版 3)
  const applied = Object.entries(info?.entries ?? {}).flatMap(([entry, spec]) => {
    const steps = (spec as { steps?: { op: string }[] | null }).steps
    return steps && steps.length > 0 ? [`${entry}: ${steps.map(stepText).join(' → ')}`] : []
  })
  const splits = info?.splits ?? {}
  return (
    <Card title="書き出し">
      <div className="grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
        {linked ? (
          <>
            <span className="text-ink-3">書き出し先</span>
            <span className="break-all font-mono text-xs">{project?.dataset ?? '—'}</span>
            {project?.state === 'dataset' && (
              <>
                <span />
                <span className="text-xs text-ink-2">前に書き出したデータセットがあります.</span>
              </>
            )}
          </>
        ) : (
          <Row id={`${prefix}-name`} label="データセットの名前">
            <input
              id={`${prefix}-name`}
              value={fields.name}
              onChange={(event) => setFields({ ...fields, name: event.target.value })}
              className={inputClass}
            />
          </Row>
        )}
        <span />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={fields.overwrite}
            onChange={(event) => setFields({ ...fields, overwrite: event.target.checked })}
          />
          {replace}
        </label>
      </div>
      {errors.length > 0 && (
        <ul id={`${prefix}-reasons`} className="mt-3 list-disc pl-5 text-xs text-critical-text">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <Button
        variant="primary"
        icon={Upload}
        className="mt-3"
        disabled={mutation.isPending || errors.length > 0}
        aria-describedby={errors.length > 0 ? `${prefix}-reasons` : undefined}
        onClick={onExport}
      >
        {mutation.isPending ? '書き出し中…' : label}
      </Button>
      {mutation.error && (
        <ErrorBox error={mutation.error}>
          {mutation.error instanceof ApiError &&
            mutation.error.status === 409 &&
            !fields.overwrite && (
              <p className="mt-1 text-xs">上書きする場合は「{replace}」に印を付けてください.</p>
            )}
        </ErrorBox>
      )}
      {/* 書き出しの結果と注意は, 常にある枠に入れて読み上げる */}
      <div role="status" aria-live="polite" className="mt-3 space-y-2 text-sm">
        {result && (
          <>
            <p className="text-good-text">書き出しました: {result.path}</p>
            {written && (
              <>
                <p className="text-good-text">問題に書き戻しました.</p>
                <ul className="list-disc pl-5 text-xs">
                  {written.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                {written.conflicts.length > 0 && (
                  <ul className="list-disc pl-5 text-xs text-warning-text">
                    {written.conflicts.map((item) => (
                      <li key={item.message}>{item.message}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <p>版: {info?.format_version ?? '—'}</p>
            {applied.length > 0 && (
              <ul className="list-disc pl-5 text-xs">
                {applied.map((line) => (
                  <li key={line} className="font-mono">
                    {line}
                  </li>
                ))}
              </ul>
            )}
            <p>
              分割:{' '}
              {Object.entries(splits)
                .map(
                  ([split, value]) =>
                    `${splitLabel(split)} ${formatNumber(value?.items ?? null)} 件`,
                )
                .join(', ')}
            </p>
            {result.model !== undefined && (
              <div>
                <p className="text-xs text-ink-3">モデルに要るもの:</p>
                <ModelNeeds model={result.model} error={result.model_error} />
              </div>
            )}
            {result.notes.length > 0 ? (
              <>
                <p className="text-xs text-ink-3">書き出しの注意:</p>
                <ul className="list-disc pl-5 text-warning-text">
                  {result.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
                {!fields.followLinks && skippedLinks(result.notices ?? []) && (
                  <p className="text-xs text-ink-3">
                    外を指すリンクの先も写すなら,
                    「外を指すリンクの先も写す」に印を付けて書き出し直してください.
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-ink-3">書き出しの注意はありません.</p>
            )}
          </>
        )}
      </div>
      {result && (
        <div className="mt-2 space-y-2 text-sm">
          <p className="text-xs text-ink-3">学習のスクリプトでの使い方:</p>
          <pre className="overflow-auto rounded bg-surface-2 p-2 text-xs">
            {itemsSnippet(
              result.path,
              splits,
              Object.keys(info?.entries ?? {}),
              Boolean(info?.normalization),
              applied.length > 0,
            )}
          </pre>
          <Link to="/datasets" className="text-xs text-accent-text underline">
            データセットの一覧へ
          </Link>
        </div>
      )}
    </Card>
  )
}

/** 問題の設定から始めた場合に, 書き出せない理由 (プロジェクトの記録が無いなど) を足す */
function linkedErrors(errors: string[], linked: Linked | undefined): string[] {
  const project = linked?.pairs.project
  if (project && !project.ready) errors.push(project.reason ?? '書き出し先がありません')
  return errors
}

/** 画像と領域の対の書き出し */
function ImageMasksForm({ linked }: { linked?: Linked }) {
  const api = useApi()
  const client = useQueryClient()
  const draft = linked?.pairs.export
  const [images, setImages] = useState(draft?.inputs ?? '')
  const [masks, setMasks] = useState(draft?.targets ?? '')
  const [classes, setClasses] = useState(classesText(draft?.options.classes))
  const [suffix, setSuffix] = useState(draft?.options.mask_suffix ?? '')
  const [fields, setFields] = useState<CommonFields>(draft ? linkedFields(draft) : INITIAL)
  const pairSteps = usePairSteps()
  const [steps, setSteps] = useState<EntryDrafts>(() => initialDrafts('image_masks', draft))
  const built = itemStepsBody(steps, pairSteps?.image_masks ?? {}, ENTRY_LABELS.image_masks)
  const common = commonBody(fields, !linked)
  const named = parseClasses(classes)
  const errors = linkedErrors(
    [...common.errors, ...(named.error ? [named.error] : []), ...built.errors],
    linked,
  )
  if (!images.trim() || !masks.trim()) errors.push('画像と領域のディレクトリを選んでください')
  const exporter = useMutation({
    mutationFn: (): Promise<PairExportResult | ProblemPairsResult> => {
      if (linked) {
        const options = {
          ...(named.value ? { classes: named.value } : {}),
          ...(suffix ? { mask_suffix: suffix } : {}),
          ...(built.value ? { item_steps: built.value } : {}),
        }
        return api.exportProblemPairs({
          path: linked.pairs.path,
          version: linked.version,
          overwrite: fields.overwrite,
          follow_links: fields.followLinks,
          export: linkedSettings(
            'export_image_masks',
            common.body!,
            images.trim(),
            masks.trim(),
            options,
          ),
        })
      }
      return api.exportImageMasks({
        ...common.body!,
        images: images.trim(),
        masks: masks.trim(),
        classes: named.value ?? undefined,
        mask_suffix: suffix,
        item_steps: built.value,
      })
    },
    onSuccess: (result) => {
      if ('changes' in result) linked?.onWritten(result)
      return client.invalidateQueries({ queryKey: ['datasets'] })
    },
  })
  // 欄を変えたら前の結果と誤りを消す (古い場所や使い方を出したままにしない)
  const { reset } = exporter
  const inputs = JSON.stringify([images, masks, classes, suffix, fields, steps])
  useEffect(() => reset(), [inputs, reset])
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card title="画像と領域">
          <div className="grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
            <FolderField
              label="画像のディレクトリ"
              value={images}
              onChange={setImages}
              placeholder="~/data/images"
            />
            <FolderField
              label="領域のディレクトリ"
              value={masks}
              onChange={setMasks}
              placeholder="~/data/masks"
            />
            <LinksField prefix="masks" fields={fields} setFields={setFields} />
            <Row id="mask-suffix" label="領域の名前の終わり">
              <input
                id="mask-suffix"
                value={suffix}
                placeholder="_mask (a.png と a_mask.png を組にする場合)"
                onChange={(event) => setSuffix(event.target.value)}
                className={inputClass}
              />
            </Row>
            <Row id="mask-classes" label="値の名前 (任意)">
              <textarea
                id="mask-classes"
                value={classes}
                placeholder={'0: background\n1: object'}
                onChange={(event) => setClasses(event.target.value)}
                className={areaClass}
              />
            </Row>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            画像と領域は, ファイルの名前 (拡張子を除く) で組にします (それぞれ 2 階層まで). 領域は 1
            チャンネルの整数の画像です. EXIF の向きの付いた画像は, 向きを直して保存してから渡します.
          </p>
        </Card>
        <StepsCard form="image_masks" pairSteps={pairSteps} drafts={steps} setDrafts={setSteps} />
        <CommonCard
          prefix="masks"
          fields={fields}
          setFields={setFields}
          groupHint={'sample_000,site_a\nsample_001,site_b'}
          unlabeledHint="領域の無い画像"
        />
      </div>
      <div>
        <ExportCard
          prefix="masks"
          fields={fields}
          setFields={setFields}
          errors={errors}
          onExport={() => exporter.mutate()}
          mutation={exporter}
          linked={linked}
        />
      </div>
    </div>
  )
}

/** 多視点の撮影と正解の点群の対の書き出し */
function CaptureCloudsForm({ linked }: { linked?: Linked }) {
  const api = useApi()
  const client = useQueryClient()
  const draft = linked?.pairs.export
  const [captures, setCaptures] = useState(draft?.inputs ?? '')
  const [clouds, setClouds] = useState(draft?.targets ?? '')
  const [units, setUnits] = useState(draft?.options.cloud_units ?? 'meter')
  const [fields, setFields] = useState<CommonFields>(draft ? linkedFields(draft) : INITIAL)
  const pairSteps = usePairSteps()
  const [steps, setSteps] = useState<EntryDrafts>(() => initialDrafts('capture_clouds', draft))
  const built = itemStepsBody(steps, pairSteps?.capture_clouds ?? {}, ENTRY_LABELS.capture_clouds)
  const common = commonBody(fields, !linked)
  const errors = linkedErrors([...common.errors, ...built.errors], linked)
  if (!captures.trim() || !clouds.trim()) errors.push('撮影と点群のディレクトリを選んでください')
  const exporter = useMutation({
    mutationFn: (): Promise<PairExportResult | ProblemPairsResult> => {
      if (linked) {
        return api.exportProblemPairs({
          path: linked.pairs.path,
          version: linked.version,
          overwrite: fields.overwrite,
          follow_links: fields.followLinks,
          export: linkedSettings(
            'export_capture_clouds',
            common.body!,
            captures.trim(),
            clouds.trim(),
            { cloud_units: units, ...(built.value ? { item_steps: built.value } : {}) },
          ),
        })
      }
      return api.exportCaptureClouds({
        ...common.body!,
        captures: captures.trim(),
        clouds: clouds.trim(),
        cloud_units: units,
        item_steps: built.value,
      })
    },
    onSuccess: (result) => {
      if ('changes' in result) linked?.onWritten(result)
      return client.invalidateQueries({ queryKey: ['datasets'] })
    },
  })
  // 欄を変えたら前の結果と誤りを消す
  const { reset } = exporter
  const inputs = JSON.stringify([captures, clouds, units, fields, steps])
  useEffect(() => reset(), [inputs, reset])
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card title="撮影と点群">
          <div className="grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
            <FolderField
              label="撮影のディレクトリ"
              value={captures}
              onChange={setCaptures}
              placeholder="~/data/captures"
            />
            <FolderField
              label="点群のディレクトリ"
              value={clouds}
              onChange={setClouds}
              placeholder="~/data/clouds"
            />
            <LinksField prefix="clouds" fields={fields} setFields={setFields} />
            <Row id="cloud-units" label="点群の単位">
              <select
                id="cloud-units"
                value={units}
                onChange={(event) => setUnits(event.target.value)}
                className="h-8 rounded border border-line bg-surface px-2"
              >
                {Object.entries(CLOUD_UNITS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label} ({value})
                  </option>
                ))}
              </select>
            </Row>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            撮影 (transforms.json を持つディレクトリか, それを並べたディレクトリ) と,
            点群のディレクトリの直下の 「撮影の名前.拡張子」を組にします.
            撮影の姿勢と点群に同じ平行移動 (姿勢から求めた物の中心を原点に) をかけ, 実寸 (メートル)
            を残します.
          </p>
        </Card>
        <StepsCard
          form="capture_clouds"
          pairSteps={pairSteps}
          drafts={steps}
          setDrafts={setSteps}
        />
        <CommonCard
          prefix="clouds"
          fields={fields}
          setFields={setFields}
          groupHint={'scan_001,object_a\nscan_002,object_a'}
          unlabeledHint="点群の無い撮影"
        />
      </div>
      <div>
        <ExportCard
          prefix="clouds"
          fields={fields}
          setFields={setFields}
          errors={errors}
          onExport={() => exporter.mutate()}
          mutation={exporter}
          linked={linked}
        />
      </div>
    </div>
  )
}

/**
 * 問題の設定から始めた書き出し. 問題の設定を読み直し, 正解の種類の欄だけを下書きで埋めて出す
 */
function ProblemPairsView({ path }: { path: string }) {
  const api = useApi()
  const client = useQueryClient()
  const pairs = useQuery({
    queryKey: ['problem-pairs', path],
    queryFn: () => api.problemPairs(path),
    // 欄は開いたときの下書きで埋めるので, 書き出しの後だけ読み直す
    refetchOnWindowFocus: false,
  })
  const [version, setVersion] = useState<string | null>(null)
  if (pairs.isPending) return <Spinner />
  if (pairs.error) return <ErrorBox error={pairs.error} />
  const data = pairs.data
  const linked: Linked = {
    pairs: data,
    version: version ?? data.version,
    onWritten: (result) => {
      setVersion(result.version)
      void client.invalidateQueries({ queryKey: ['problem-pairs', path] })
    },
  }
  return (
    <>
      <Card title={`問題: ${data.name ?? ''}`} className="mb-4">
        <p className="break-all font-mono text-xs text-ink-3">{data.path}</p>
        <p className="mt-2 text-sm text-ink-2">
          問題の値で欄を埋めました. 書き出すと, 学習のプロジェクトの書き出し先に書き出し,
          欄の値を問題に書き戻します.
        </p>
        {data.notes.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-warning-text">
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </Card>
      {data.form === 'image_masks' ? (
        <ImageMasksForm linked={linked} />
      ) : (
        <CaptureCloudsForm linked={linked} />
      )}
    </>
  )
}

/** 入力と正解がファイルの組のデータセット (版 2. 中身の手順を足すと版 3) を書き出す画面 */
export function PairExportPage() {
  const [params, setParams] = useSearchParams()
  const form: FormId = params.get('form') === 'capture_clouds' ? 'capture_clouds' : 'image_masks'
  const problem = params.get('problem')
  if (problem) {
    return (
      <>
        <PageHeader
          title="ファイルの組を書き出す"
          subtitle="問題から始めた書き出し. 問題の答えで埋め, 書き出した設定を問題に書き戻します"
          breadcrumb={<Link to="/datasets">データセット</Link>}
        />
        <ProblemPairsView key={problem} path={problem} />
      </>
    )
  }
  return (
    <>
      <PageHeader
        title="ファイルの組を書き出す"
        subtitle="正解が列でなくファイルのデータを, load_items で読める形 (dataset.yaml の版 2. 中身の手順を足すと版 3) に書き出します"
        breadcrumb={<Link to="/datasets">データセット</Link>}
      />
      <div className="mb-4">
        <Tabs
          items={TABS}
          value={form}
          onChange={(id) => setParams({ form: id }, { replace: true })}
          idBase="pairs"
          label="書き出す組"
        />
      </div>
      {/* 両方の欄を残し, 選んでいない方を隠す (切り替えても入れた値と結果を残す) */}
      <div id="pairs-panel" role="tabpanel" aria-labelledby={`pairs-tab-${form}`}>
        <div hidden={form !== 'image_masks'}>
          <ImageMasksForm />
        </div>
        <div hidden={form !== 'capture_clouds'}>
          <CaptureCloudsForm />
        </div>
      </div>
    </>
  )
}
