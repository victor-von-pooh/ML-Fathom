import path from 'node:path'

import { expect, test } from '@playwright/test'

// e2e/serve.sh が作った表
const TABLE = path.resolve(import.meta.dirname, '.work', 'people.csv')

test.describe.configure({ mode: 'serial' })

test('ディレクトリをたどって表を登録し, 気付きと列を見る', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page.getByLabel('ディレクトリのパス').fill(path.dirname(TABLE))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /people\.csv/ }).click()
  await expect(page.getByLabel('読み込み', { exact: true })).toHaveValue('csv')
  await page.getByRole('button', { name: '追加', exact: true }).click()

  // 概要に気付き (ID らしい列, 欠損の多い列) が出る
  await expect(page.getByRole('heading', { name: 'people.csv' })).toBeVisible()
  await expect(page.getByText('id_like')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('high_missing')).toBeVisible()

  // 気付きの列の名前を押すと, 列の詳細に移る
  await page.getByRole('button', { name: 'age', exact: true }).first().click()
  await expect(page.getByRole('tab', { name: /列/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('中央値')).toBeVisible()
})

test('目的の列を選び, 手順を作って書き出す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'people.csv' }).first().click()
  await page.getByRole('combobox', { name: '目的の列' }).selectOption('bought')
  await page.getByRole('tab', { name: '関係' }).click()
  await expect(page.getByText(/目的の列 bought \(分類\)/)).toBeVisible({ timeout: 20_000 })

  // 列の型から手順を作ると, 学習の前に直すことの注意が無くなる
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await page.getByRole('button', { name: '学習できる形にする手順を作る' }).click()
  await expect(page.getByText('学習に使う列')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/数値ではありません/)).toHaveCount(0)

  // 書き出すとデータセットの一覧に並ぶ
  await page.getByLabel('データセットの名前').fill('people')
  await page.getByRole('button', { name: '学習用に書き出す' }).click()
  await expect(page.getByText(/書き出しました/)).toBeVisible()
  await page.getByRole('link', { name: 'データセット' }).click()
  await expect(page.getByText('people', { exact: true })).toBeVisible()
})

test('問題の設定から始め, 分からない列を使うと選んで書き戻す', async ({ page }) => {
  // 問題の設定のディレクトリを選ぶと, 決めた状態で始まる
  await page.goto('/')
  await page.getByRole('button', { name: '問題の設定から始める' }).click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'problem'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: 'このディレクトリを選ぶ' }).click()
  await page.getByRole('button', { name: 'この問題の設定から始める' }).click()
  await expect(page.getByRole('heading', { name: '総菜の作る量' })).toBeVisible()
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  const card = page.getByText(/^問題の設定: 総菜の作る量/)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('問題の設定との食い違いはありません.')).toBeVisible()

  // 客数を落とす手順を消すと, どう扱うかを選ぶまで書き戻せない
  await page.getByRole('button', { name: '手順 1 を消す' }).click()
  await expect(page.getByText(/customers は予測の時点で分からない列/)).toBeVisible()
  const write = page.getByRole('button', { name: '問題の設定に書き戻す' })
  await expect(write).toBeDisabled()
  await page.getByRole('button', { name: 'レシピで落とす' }).click()
  await write.click()
  await expect(page.getByText(/書き戻しました/)).toBeVisible()
  await expect(page.getByText('customers をレシピで落とした')).toBeVisible()
})

test('多視点の撮影を登録し, カメラの配置と各枚の深度を見る', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'captures'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: 'このディレクトリを選ぶ' }).click()
  await expect(page.getByLabel('読み込み', { exact: true })).toHaveValue('capture')
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByText('多視点の撮影 · capture')).toBeVisible({ timeout: 20_000 })

  // 中身を見る: 一周 6 枚なので隙間は 60 度
  await page.getByRole('tab', { name: '中身を見る' }).click()
  await page.getByRole('list', { name: '撮影' }).getByRole('button').first().click()
  await expect(page.getByRole('img', { name: /カメラ 6 台の配置.*隙間 60 度/ })).toBeVisible()
  await page.getByRole('radio', { name: '深度' }).check()
  await expect(page.getByRole('img', { name: '0 枚目の深度' })).toBeVisible()

  // 前処理は今は扱わないと知らせる
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(page.getByText(/多視点の撮影は, 今は読み込みと分析だけです/)).toBeVisible()
})
