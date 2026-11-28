/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// README の画面の例を撮る (CI には入れない).
// 先に別の端末で `pnpm build && bash e2e/serve.sh` を起動し,
// `node e2e/shots.mts` で docs/images/ に 1600x900 の PNG を書く.
// 手元の場所は写さないように, 作業用の置き場を ~/data と ~/.ml-fathom に置き換える
import path from 'node:path'

import { chromium, type Page } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 8793)
const base = `http://127.0.0.1:${port}`
const work = path.resolve(import.meta.dirname, '.work')
const out = path.resolve(import.meta.dirname, '..', '..', 'docs', 'images')

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  extraHTTPHeaders: { 'x-fathom-token': 'e2e-token' },
})
const page = await context.newPage()

/** 画面の文と欄の中の作業用の置き場を, 利用者の置き場らしい名前にして撮る */
async function shot(target: Page, name: string) {
  await target.waitForTimeout(1500)
  await target.evaluate(
    ([root]) => {
      const swap = (text: string) =>
        text.replaceAll(`${root}/home`, '~/.ml-fathom').replaceAll(root, '~/data')
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeValue?.includes(root)) node.nodeValue = swap(node.nodeValue)
      }
      for (const field of document.querySelectorAll('input, textarea')) {
        const input = field as HTMLInputElement
        if (input.value.includes(root)) input.value = swap(input.value)
        if (input.placeholder.includes(root)) input.placeholder = swap(input.placeholder)
      }
    },
    [work],
  )
  await target.screenshot({ path: path.join(out, `${name}.png`) })
  console.log(name)
}

/** 名前の登録したデータを返す (無ければ場所から登録する) */
async function source(name: string, place?: string): Promise<string> {
  const listed = (await (await page.request.get(`${base}/api/sources`)).json()) as {
    id: string
    name: string
  }[]
  const found = listed.find((entry) => entry.name === name)
  if (found) return found.id
  const created = await page.request.post(`${base}/api/sources`, {
    data: { path: place, name },
  })
  return ((await created.json()) as { id: string }).id
}

// 見本のデータ (表, 時系列, 画像, 文, 点群) を入れる
await page.request.post(`${base}/api/samples`)

// 1. 概要と気付き, 2. 関係 (顧客の解約の表)
const customers = await source('顧客の解約 (表)')
await page.goto(`${base}/sources/${customers}`)
await page.getByText('id_like').waitFor()
await shot(page, 'overview')
await page.getByRole('tab', { name: '関係' }).click()
await page.locator('canvas').first().waitFor()
await shot(page, 'relations')

// 3. 時系列 (電力の使用量)
const power = await source('電力の使用量 (時系列)')
await page.goto(`${base}/sources/${power}`)
await page.getByRole('tab', { name: '時系列' }).click()
await page.locator('canvas').first().waitFor()
await shot(page, 'timeseries')

// 4. 画像, 5. 点群 (中身を見る)
const shapes = await source('図形 (画像)')
await page.goto(`${base}/sources/${shapes}`)
await page.getByRole('tab', { name: '中身を見る' }).click()
await shot(page, 'images')
const objects = await source('物体 (点群)')
await page.goto(`${base}/sources/${objects}`)
await page.getByRole('tab', { name: '中身を見る' }).click()
await page.getByRole('list', { name: '点群' }).getByRole('button').first().click()
await page.locator('canvas').first().waitFor()
await shot(page, 'pointcloud')

// 6. 音声 (1 件ずつの再生と波形)
const sounds = await source('sounds', path.join(work, 'sounds'))
await page.goto(`${base}/sources/${sounds}`)
await page.getByRole('tab', { name: '中身を見る' }).click()
await page
  .getByRole('list', { name: '音声' })
  .getByRole('button', { name: /low\.wav/ })
  .click()
await page.getByRole('img', { name: /番目の音声の波形/ }).waitFor()
await shot(page, 'audio')

// 7. 問題の設定から始めた前処理と書き出し (ML-Pathfinder の置き場から選ぶ)
await page.goto(`${base}/`)
await page.getByRole('button', { name: '問題から始める' }).click()
const stored = page.getByRole('list', { name: '保存した問題' })
await stored.getByRole('button', { name: /総菜の問題/ }).click()
await page.getByRole('button', { name: 'この問題から始める' }).click()
await page.getByRole('tab', { name: '前処理と書き出し' }).click()
await page.getByRole('button', { name: '学習のプロジェクトへ書き出す' }).waitFor()
await shot(page, 'recipe')

// 8. 正解が画像の領域の問題の設定から開く, ファイルの組の書き出し
await page.goto(`${base}/`)
await page.getByRole('button', { name: '問題から始める' }).click()
await stored.getByRole('button', { name: /領域の問題/ }).click()
await page.getByRole('button', { name: 'この問題から始める' }).click()
await page.getByLabel('作った処理の名前').waitFor()
await shot(page, 'pairs')

await browser.close()
