import type { EntryDrafts, StepDraft } from './entrySteps'

/** ファイルの組の書き出しの種類 (画面のタブ) */
export type PairForm = 'image_masks' | 'capture_clouds'

/**
 * 手で始めたファイルの組の書き出しの, 打ち直すのに手間のかかる欄の下書き.
 * 名前, 上書きの印, 外を指すリンクの印, 点群の単位は持たない (選ぶだけか,
 * 書き出すたびにその場で決める欄のため)
 */
export interface PairDraft {
  /** 入力のディレクトリ (画像か撮影) */
  inputs: string
  /** 正解のディレクトリ (領域か点群) */
  targets: string
  /** 領域の名前の終わり (画像と領域だけ) */
  suffix: string
  /** 値の名前の文 (画像と領域だけ) */
  classes: string
  method: string
  unlabeled: string
  valid: string
  test: string
  seed: string
  groups: string
  originType: string
  originName: string
  originSettings: string
  /** 項目ごとの組み立て中の中身の手順 */
  steps: EntryDrafts
}

const TEXT_KEYS = [
  'inputs',
  'targets',
  'suffix',
  'classes',
  'method',
  'unlabeled',
  'valid',
  'test',
  'seed',
  'groups',
  'originType',
  'originName',
  'originSettings',
] as const satisfies readonly (keyof PairDraft)[]

/** ブラウザに覚える鍵 (書き出しの種類ごと) */
export function pairDraftKey(form: PairForm): string {
  return `ml-fathom:pairs:${form}`
}

/** 組み立て中の手順の 1 つとして読めるか */
function isStep(value: unknown): value is StepDraft {
  if (typeof value !== 'object' || value === null) return false
  const step = value as StepDraft
  return (
    typeof step.op === 'string' &&
    typeof step.values === 'object' &&
    step.values !== null &&
    Object.values(step.values).every((item) => typeof item === 'string')
  )
}

/**
 * 覚えた下書きを読む. 文でない欄と読めない手順の並びは捨て, 空の値で返す
 * (残りの欄は戻すため). 無いか読めなければ null
 */
export function readPairDraft(form: PairForm): Partial<PairDraft> | null {
  let value: unknown
  try {
    const text = window.localStorage.getItem(pairDraftKey(form))
    if (!text) return null
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const draft: Partial<PairDraft> = {}
  for (const key of TEXT_KEYS) {
    if (typeof raw[key] === 'string') draft[key] = raw[key]
  }
  if (typeof raw.steps === 'object' && raw.steps !== null) {
    const steps: EntryDrafts = {}
    for (const [entry, list] of Object.entries(raw.steps)) {
      if (Array.isArray(list)) steps[entry] = list.filter(isStep)
    }
    draft.steps = steps
  }
  return draft
}

/** 下書きを覚える (null で消す. 覚えられない環境では何もしない) */
export function writePairDraft(form: PairForm, draft: PairDraft | null): void {
  try {
    if (draft) window.localStorage.setItem(pairDraftKey(form), JSON.stringify(draft))
    else window.localStorage.removeItem(pairDraftKey(form))
  } catch {
    // 覚えられなくても, 開いている間は欄に残る
  }
}
