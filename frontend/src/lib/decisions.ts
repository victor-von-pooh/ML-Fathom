import type { Profile, Recipe, RecipeStep } from '../api/types'
import { autoItemSteps, unreadableFilter } from './suggest'

/** 選んだときにすること (レシピを置き換える, データの設定を変える, このままにする) */
export type DecisionAction =
  | { kind: 'recipe'; recipe: Recipe }
  | { kind: 'source'; target?: string | null; options?: Record<string, unknown> }
  | { kind: 'dismiss' }

export interface DecisionChoice {
  label: string
  action: DecisionAction
  /** 勧める選択肢 (目立たせる) */
  primary?: boolean
  /**
   * 選んだことをブラウザに覚え, 次から出さない. 「このまま」 (dismiss) は
   * いつも覚える. 他は, 選んだ結果で当てはまらなくなれば消える
   */
  remember?: boolean
}

/** 自動では決めきれず, 利用者に選んでもらうこと */
export interface Decision {
  id: string
  title: string
  message: string
  choices: DecisionChoice[]
}

// 読み方を選べる表の読み込み
const TABLE_LOADERS = new Set(['csv', 'json', 'parquet', 'excel'])

// 目的の列によく使う名前
const TARGET_NAMES =
  /^(label|labels|target|y|class|category|sentiment|price|sales|churn|survived)$/i

const UNITS: Record<string, string> = { char: '文字', word: '語', subword: '部分語' }

/** 中身の手順を分析から作り, 読めない件を除く手順を先頭に足したレシピ */
export function withAutoItems(recipe: Recipe, kind: string, profile: Profile): Recipe {
  const filter = unreadableFilter(kind, profile)
  const has = recipe.steps.some((step) => JSON.stringify(step) === JSON.stringify(filter))
  return {
    ...recipe,
    steps: filter && !has ? [filter, ...recipe.steps] : recipe.steps,
    item_steps: autoItemSteps(kind, profile),
  }
}

/** 時刻の間隔 (秒) を lag の freq にする (1D, 1h, 30min, 15s) */
export function toFreq(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}D`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}min`
  if (Number.isInteger(seconds)) return `${seconds}s`
  // 1 秒の端数はミリ秒 (それより細かければマイクロ秒) で
  const ms = seconds * 1000
  return Number.isInteger(ms) ? `${ms}ms` : `${Math.max(1, Math.round(ms * 1000))}us`
}

// 長さの変わる間隔 (月や年. 28 日以上) は日付でずらせない
const MONTHLY = 28 * 86400

/** 時刻の間隔 (秒) を画面の言葉にする */
function freqLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 日`
  if (seconds % 3600 === 0) return `${seconds / 3600} 時間`
  if (seconds % 60 === 0) return `${seconds / 60} 分`
  return `${seconds} 秒`
}

/** 列を落とす手順に列を足す (無ければ先頭に手順を作る) */
function addDrop(recipe: Recipe, column: string): Recipe {
  const index = recipe.steps.findIndex((step) => step.op === 'drop_columns')
  if (index < 0) {
    return { ...recipe, steps: [{ op: 'drop_columns', columns: [column] }, ...recipe.steps] }
  }
  const step = recipe.steps[index]!
  const columns = Array.isArray(step.columns) ? (step.columns as string[]) : []
  if (columns.includes(column)) return recipe
  const steps = [...recipe.steps]
  steps[index] = { ...step, columns: [...columns, column] }
  return { ...recipe, steps }
}

/** 列を落とす手順から列を外す (空になった手順は消す) */
function removeDrop(recipe: Recipe, column: string): Recipe {
  const steps: RecipeStep[] = []
  for (const step of recipe.steps) {
    if (step.op !== 'drop_columns' || !Array.isArray(step.columns)) {
      steps.push(step)
      continue
    }
    const columns = (step.columns as string[]).filter((name) => name !== column)
    if (columns.length) steps.push({ ...step, columns })
  }
  return { ...recipe, steps }
}

/** 目的の列の候補 (よくある名前, 無ければ後ろの方の数値かカテゴリの列) */
function targetCandidates(profile: Profile): string[] {
  const reserved = new Set(Object.values(profile.overview.roles ?? {}))
  const usable = Object.entries(profile.columns).filter(
    ([name, info]) =>
      !reserved.has(name) && ['numeric', 'categorical', 'boolean'].includes(info.type),
  )
  const named = usable.filter(([name]) => TARGET_NAMES.test(name)).map(([name]) => name)
  const rest = usable
    .map(([name]) => name)
    .filter((name) => !named.includes(name))
    .reverse()
  return [...named, ...rest].slice(0, 3)
}

/**
 * 分析とレシピから, 利用者に決めてほしいことを挙げる
 *
 * 既に決めたもの (decided) と, 状況が変わって当てはまらないものは出さない
 */
export function findDecisions({
  profile,
  recipe,
  kind,
  target,
  loader,
  options,
  decided,
}: {
  profile: Profile
  recipe: Recipe
  kind: string
  target: string | null
  loader: string
  options: Record<string, unknown>
  decided: ReadonlySet<string>
}): Decision[] {
  const found: Decision[] = []
  const codes = (code: string) => profile.findings.filter((item) => item.code === code)
  const keep: DecisionChoice = { label: 'このまま', action: { kind: 'dismiss' } }

  // Excel の他のシート (読み込みの設定でシートを選んでいない場合. 他の
  // 判断が全て変わるので先頭)
  const sheets = profile.overview.sheets ?? []
  if (sheets.length > 1 && options.sheet === undefined) {
    const current = profile.overview.sheet ?? sheets[0]!
    found.push({
      id: `sheet:${sheets.join('|')}`,
      title: `シートが ${sheets.length} 枚あります`,
      message: `今は最初のシート ${current} を読んでいます. 分析したいデータが別のシートにあれば選びます (読み込みの設定の sheet と同じ).${sheets.length > 7 ? ` ここには 6 枚まで出すので, 他のシートは「読み込みの設定」の sheet に名前を書きます.` : ''}`,
      choices: [
        { label: `${current} (このまま)`, primary: true, action: { kind: 'dismiss' } },
        ...sheets
          .filter((name) => name !== current)
          .slice(0, 6)
          .map((name) => ({
            label: name,
            action: { kind: 'source' as const, options: { ...options, sheet: name } },
          })),
      ],
    })
  }

  // 目的の列
  if (!target) {
    const candidates = targetCandidates(profile)
    found.push({
      id: 'target',
      title: '目的の列を選んでください',
      message:
        '予測する列 (正解) が決まっていません. 決めると, 列との関係の分析と, 分類か回帰かの推定, 層別の分割が使えます. 候補に無ければ, 上の「目的の列」で選びます.',
      choices: [
        ...candidates.map((name, index) => ({
          label: name,
          primary: index === 0,
          action: { kind: 'source' as const, target: name },
        })),
        { label: '目的なしで進める', action: { kind: 'dismiss' } },
      ],
    })
  }

  // 表の中の文の列 (表のままでは学習できる形にする手順で落とす)
  if ((kind === 'table' || kind === 'timeseries') && TABLE_LOADERS.has(loader)) {
    const roles = new Set(Object.values(profile.overview.roles ?? {}))
    for (const [name, info] of Object.entries(profile.columns)) {
      if (info.type !== 'text' || roles.has(name) || name === target) continue
      const rest = Object.fromEntries(
        Object.entries(options).filter(
          ([key]) => !['kind', 'text_column', 'time_column'].includes(key),
        ),
      )
      found.push({
        id: `text_column:${name}`,
        title: `列 ${name} は文です`,
        message:
          '表のままでは, 学習できる形にする手順で落とします. 文として読むと, 区切り方 (文字, 語, 部分語) を比べて番号の並びにし, 文のモデルで学習できます. 他の列は表に残りますが, 学習に使うのは文と目的の列だけになり, 時刻の順の並べ替えもしません.',
        choices: [
          {
            label: '文として読む',
            primary: true,
            action: { kind: 'source', options: { ...rest, text_column: name } },
          },
          { label: '落としてよい', action: { kind: 'dismiss' } },
        ],
      })
    }
  }

  // 目的の列とほぼ同じ情報を持つ列 (今の目的の列についての気付きだけ.
  // 時刻や系列のような役割の列は落とせないので出さない). どちらを選んでも
  // 目的の列ごとに覚える (自動の手順は疑いの列を落とすので, 条件では消せない)
  if (target) {
    const roles = new Set(Object.values(profile.overview.roles ?? {}))
    for (const item of codes('target_leak')) {
      if (!item.columns.includes(target)) continue
      for (const name of item.columns) {
        if (name === target || roles.has(name)) continue
        found.push({
          id: `leak:${target}:${name}`,
          title: `列 ${name} は目的の列とほぼ同じです`,
          message: `${item.message.replace(/[.。]?$/, '.')} 予測のときに使えない (正解の後に決まる) 列なら落とし, 使える列なら残します.`,
          choices: [
            {
              label: '落とす',
              primary: true,
              remember: true,
              action: { kind: 'recipe', recipe: addDrop(recipe, name) },
            },
            {
              label: '残す',
              remember: true,
              action: { kind: 'recipe', recipe: removeDrop(recipe, name) },
            },
          ],
        })
      }
    }
  }

  // 分割の方法
  const split = (method: string): Recipe => ({ ...recipe, split: { ...recipe.split, method } })
  if (kind === 'timeseries' && recipe.split.method !== 'time') {
    found.push({
      id: 'split:time',
      title: '時系列の分割が時刻の順ではありません',
      message:
        '無作為に分けると, 検証用の期間の前後が学習用に入り, 未来の値で学ぶので検証の誤差が甘くなります.',
      choices: [
        {
          label: '時刻の順にする',
          primary: true,
          action: { kind: 'recipe', recipe: split('time') },
        },
        keep,
      ],
    })
  }
  if (
    recipe.task === 'classification' &&
    recipe.split.method === 'random' &&
    codes('class_imbalance').length > 0
  ) {
    found.push({
      id: 'split:stratified',
      title: 'クラスが偏っているのに無作為に分けています',
      message:
        '少ないクラスが検証用やテスト用でさらに少なくなり, 評価がぶれます. 層別にすると, 分割ごとのクラスの割合がそろいます.',
      choices: [
        {
          label: '層別にする',
          primary: true,
          action: { kind: 'recipe', recipe: split('stratified') },
        },
        keep,
      ],
    })
  }

  // 時刻の抜けと, 行でずらす過去の値の列 (時刻でずらす lag は除く)
  const rowLags = recipe.steps.filter((step) => step.op === 'lag' && !step.time)
  const timeColumn = profile.overview.roles?.time
  const step = profile.timeseries?.interval_seconds ?? null
  if (kind === 'timeseries' && rowLags.length > 0 && codes('irregular_interval').length > 0) {
    const choices: DecisionChoice[] = [
      { label: 'このまま (行でずらす)', primary: true, action: { kind: 'dismiss' } },
    ]
    if (timeColumn && step && step > 0 && step < MONTHLY) {
      choices.push({
        label: `日付でずらす (1 つ = ${freqLabel(step)})`,
        action: {
          kind: 'recipe',
          recipe: {
            ...recipe,
            steps: recipe.steps.map((item) =>
              item.op === 'lag' && !item.time
                ? { ...item, time: timeColumn, freq: toFreq(step) }
                : item,
            ),
          },
        },
      })
    }
    choices.push({
      label: '過去の値の列を外す',
      action: {
        kind: 'recipe',
        recipe: {
          ...recipe,
          steps: recipe.steps.filter((item) => item.op !== 'lag' || item.time),
        },
      },
    })
    found.push({
      id: 'gaps',
      title: '時刻の抜けがあり, 過去の値の列は行でずらします',
      message:
        '過去の値の列 (lag) は行でずらすので, 休みの日のような抜けを挟むと「7 つ前」が暦の 7 日前になりません. 日付でずらすと暦どおりの過去 (その日が無ければ前で最も近い日) を使います. どちらが良いかはデータによる (抜けが少なければ差は小さい) ので, 書き出して学習で比べるのが確かです.',
      choices,
    })
  }

  // 画像, 文, 点群の中身の手順
  const items = recipe.item_steps ?? []
  if (['image', 'text', 'pointcloud'].includes(kind) && items.length === 0) {
    found.push({
      id: 'items',
      title: '中身を配列にする手順がありません',
      message:
        '画像, 文, 点群は, 1 件ずつの中身を同じ形の配列にしないと書き出せません. 分析 (大きさ, 文の区切り方, 点の数) から作れます.',
      choices: [
        {
          label: '分析から作る',
          primary: true,
          action: { kind: 'recipe', recipe: withAutoItems(recipe, kind, profile) },
        },
      ],
    })
  }

  // 文の区切り方 (分析が比べて勧めたものと違う場合)
  const comparison = profile.items?.tokenizers
  const recommended = comparison?.recommended
  const index = items.findIndex((step) => step.op === 'vocabulary')
  if (kind === 'text' && recommended && index >= 0) {
    const current = String(items[index]!.unit ?? 'word')
    const wanted = String(recommended.unit)
    if (current !== wanted) {
      const next = [...items]
      next[index] = {
        ...items[index]!,
        unit: wanted,
        length: recommended.length,
        max_tokens: recommended.max_tokens,
      }
      found.push({
        id: `tokenizer:${current}->${wanted}`,
        title: `文の区切り方は${UNITS[wanted] ?? wanted}を勧めます`,
        message: `今の手順は${UNITS[current] ?? current}で区切ります. ${comparison.reason}.`,
        choices: [
          {
            label: `${UNITS[wanted] ?? wanted}にする`,
            primary: true,
            action: { kind: 'recipe', recipe: { ...recipe, item_steps: next } },
          },
          keep,
        ],
      })
    }
  }

  return found.filter((item) => !decided.has(item.id))
}
