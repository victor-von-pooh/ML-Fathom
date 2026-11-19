import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'

import { api, ApiError } from '../../api/client'
import type { PairExportBase, PairExportResult } from '../../api/types'
import { FolderField } from '../../components/FolderField'
import { Button, Card, ErrorBox, PageHeader, Tabs, type TabItem } from '../../components/ui'
import { formatNumber } from '../../lib/format'
import {
  itemsSnippet,
  ORIGIN_LABELS,
  originNote,
  parseClasses,
  parseGroups,
  parseSettings,
} from '../../lib/pairs'
import { splitLabel } from '../../lib/recipe'

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
  valid: '0.2',
  test: '0',
  seed: '0',
  groups: '',
  originType: 'unknown',
  originName: '',
  originSettings: '',
}

/** 割合の欄を数にする (0 以上 1 未満. 誤りは null) */
function ratio(text: string): number | null {
  const value = Number(text)
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 && value < 1 ? value : null
}

/**
 * 共通の欄を書き出しの要求にする. 誤りがあれば理由の並び
 */
function commonBody(fields: CommonFields): { body: PairExportBase | null; errors: string[] } {
  const errors: string[] = []
  if (!fields.name.trim()) errors.push('データセットの名前を入れてください')
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

/** 分割, グループ, 正解の出どころの欄 */
function CommonCard({
  prefix,
  fields,
  setFields,
  groupHint,
}: {
  prefix: string
  fields: CommonFields
  setFields: (fields: CommonFields) => void
  groupHint: string
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

/** 名前, 置き換え, 書き出す押しボタンと結果 */
function ExportCard({
  prefix,
  fields,
  setFields,
  errors,
  onExport,
  mutation,
}: {
  prefix: string
  fields: CommonFields
  setFields: (fields: CommonFields) => void
  errors: string[]
  onExport: () => void
  mutation: {
    isPending: boolean
    error: Error | null
    data: PairExportResult | undefined
  }
}) {
  const result = mutation.data
  const info = result?.info as
    | {
        splits?: Record<string, { items?: number } | undefined>
        target?: { entries?: string[] }
        entries?: Record<string, unknown>
        normalization?: unknown
      }
    | undefined
  const splits = info?.splits ?? {}
  return (
    <Card title="書き出し">
      <div className="grid grid-cols-[9rem_1fr] items-center gap-2 text-sm">
        <Row id={`${prefix}-name`} label="データセットの名前">
          <input
            id={`${prefix}-name`}
            value={fields.name}
            onChange={(event) => setFields({ ...fields, name: event.target.value })}
            className={inputClass}
          />
        </Row>
        <span />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={fields.overwrite}
            onChange={(event) => setFields({ ...fields, overwrite: event.target.checked })}
          />
          同じ名前があれば置き換える
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
        {mutation.isPending ? '書き出し中…' : 'ファイルの組を書き出す'}
      </Button>
      {mutation.error && (
        <ErrorBox error={mutation.error}>
          {mutation.error instanceof ApiError &&
            mutation.error.status === 409 &&
            !fields.overwrite && (
              <p className="mt-1 text-xs">
                置き換える場合は「同じ名前があれば置き換える」に印を付けてください.
              </p>
            )}
        </ErrorBox>
      )}
      {/* 書き出しの結果と注意は, 常にある枠に入れて読み上げる */}
      <div role="status" aria-live="polite" className="mt-3 space-y-2 text-sm">
        {result && (
          <>
            <p className="text-good-text">書き出しました: {result.path}</p>
            <p>
              分割:{' '}
              {Object.entries(splits)
                .map(
                  ([split, value]) =>
                    `${splitLabel(split)} ${formatNumber(value?.items ?? null)} 件`,
                )
                .join(', ')}
            </p>
            {result.notes.length > 0 ? (
              <>
                <p className="text-xs text-ink-3">書き出しの注意:</p>
                <ul className="list-disc pl-5 text-warning-text">
                  {result.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
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

/** 画像と領域の対の書き出し */
function ImageMasksForm() {
  const client = useQueryClient()
  const [images, setImages] = useState('')
  const [masks, setMasks] = useState('')
  const [classes, setClasses] = useState('')
  const [suffix, setSuffix] = useState('')
  const [fields, setFields] = useState<CommonFields>(INITIAL)
  const common = commonBody(fields)
  const named = parseClasses(classes)
  const errors = [...common.errors, ...(named.error ? [named.error] : [])]
  if (!images.trim() || !masks.trim()) errors.push('画像と領域のディレクトリを選んでください')
  const exporter = useMutation({
    mutationFn: () =>
      api.exportImageMasks({
        ...common.body!,
        images: images.trim(),
        masks: masks.trim(),
        classes: named.value ?? undefined,
        mask_suffix: suffix,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['datasets'] }),
  })
  // 欄を変えたら前の結果と誤りを消す (古い場所や使い方を出したままにしない)
  const { reset } = exporter
  const inputs = JSON.stringify([images, masks, classes, suffix, fields])
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
        <CommonCard
          prefix="masks"
          fields={fields}
          setFields={setFields}
          groupHint={'sample_000,site_a\nsample_001,site_b'}
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
        />
      </div>
    </div>
  )
}

/** 多視点の撮影と正解の点群の対の書き出し */
function CaptureCloudsForm() {
  const client = useQueryClient()
  const [captures, setCaptures] = useState('')
  const [clouds, setClouds] = useState('')
  const [units, setUnits] = useState('meter')
  const [fields, setFields] = useState<CommonFields>(INITIAL)
  const common = commonBody(fields)
  const errors = [...common.errors]
  if (!captures.trim() || !clouds.trim()) errors.push('撮影と点群のディレクトリを選んでください')
  const exporter = useMutation({
    mutationFn: () =>
      api.exportCaptureClouds({
        ...common.body!,
        captures: captures.trim(),
        clouds: clouds.trim(),
        cloud_units: units,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['datasets'] }),
  })
  // 欄を変えたら前の結果と誤りを消す
  const { reset } = exporter
  const inputs = JSON.stringify([captures, clouds, units, fields])
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
        <CommonCard
          prefix="clouds"
          fields={fields}
          setFields={setFields}
          groupHint={'scan_001,object_a\nscan_002,object_a'}
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
        />
      </div>
    </div>
  )
}

/** 入力と正解がファイルの組のデータセット (版 2) を書き出す画面 */
export function PairExportPage() {
  const [params, setParams] = useSearchParams()
  const form: FormId = params.get('form') === 'capture_clouds' ? 'capture_clouds' : 'image_masks'
  return (
    <>
      <PageHeader
        title="ファイルの組を書き出す"
        subtitle="正解が列でなくファイルのデータを, load_items で読める形 (dataset.yaml の版 2) に書き出します"
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
