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

test('無作為の分割でもグループの列を選ぶと, 分割をまたぐ重なりを注意する', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page.getByLabel('ディレクトリのパス').fill(path.dirname(TABLE))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /visits\.csv/ }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'visits.csv' })).toBeVisible()

  // 無作為の分割に, 同じ会員が複数の行にいる列をグループの列として選ぶ
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  const split = page.getByRole('combobox', { name: '分割', exact: true })
  await split.selectOption('random')
  const group = page.getByRole('combobox', { name: /グループの列 \(任意/ })
  await expect(group).toHaveValue('')
  await group.selectOption('member_id')
  await expect(page.getByText('group_overlap')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/member_id の同じ値が .* 複数の分割にまたがります/)).toBeVisible()

  // 空を選ぶと列の指定が消え, 気付きも消える
  const cleared = page.waitForResponse(
    (response) =>
      response.url().includes('/preview') &&
      !(response.request().postData() ?? '').includes('"column"'),
  )
  await group.selectOption('')
  await cleared
  await expect(page.getByText('学習に使う列')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('group_overlap')).toHaveCount(0)

  // 分けないにすると欄が隠れ, 列の指定も消える
  await group.selectOption('member_id')
  await expect(page.getByText('group_overlap')).toBeVisible({ timeout: 20_000 })
  await split.selectOption('none')
  await expect(page.getByRole('combobox', { name: /グループの列/ })).toHaveCount(0)
  await split.selectOption('random')
  await expect(page.getByRole('combobox', { name: /グループの列 \(任意/ })).toHaveValue('')

  // group の分割では同じ欄が分割に使う列になる
  await split.selectOption('group')
  await expect(page.getByRole('combobox', { name: 'グループの列', exact: true })).toBeVisible()
})

test('正解の欠けた行を unlabeled の分割に残し, 保存して読み直す', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page.getByLabel('ディレクトリのパス').fill(path.dirname(TABLE))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /sensors\.csv/ }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'sensors.csv' })).toBeVisible()

  // 目的の列が無ければ欄を出さない
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  const unlabeled = page.getByRole('combobox', { name: '正解の欠けた行' })
  await expect(page.getByRole('combobox', { name: 'タスク' })).toBeVisible({ timeout: 20_000 })
  await expect(unlabeled).toHaveCount(0)

  // 目的の列を選ぶと, 欠けた行の数と使いどころを添えて出る (既定は落とす)
  await page.getByRole('combobox', { name: '目的の列' }).selectOption('status')
  await expect(unlabeled).toHaveValue('drop')
  await expect(unlabeled).toBeEnabled()
  await expect(page.getByText(/目的の列の欠けた行: 40 行/)).toBeVisible()
  await expect(page.getByText(/分割: train 48 行, valid 12 行$/)).toBeVisible({
    timeout: 20_000,
  })

  // 残すと, 正解の付いた分割は同じまま unlabeled の分割が足される
  await unlabeled.selectOption('keep')
  await expect(page.getByText(/unlabeled \(正解なし\) 40 行/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/train 48 行, valid 12 行/)).toBeVisible()
  await expect(page.getByText(/unlabeled: keep/)).toBeVisible()

  // 保存して読み込み直しても残すのまま
  // (保存すると編集中のレシピを消すので, 読み直した値は保存したレシピのもの)
  await page.getByRole('button', { name: 'レシピを保存' }).click()
  await expect(page.getByText('保存しました')).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(unlabeled).toHaveValue('keep', { timeout: 20_000 })
  await expect(page.getByText(/保存していない変更があります/)).toHaveCount(0)

  // 落とすに戻して保存すると, 項目ごと消える
  await unlabeled.selectOption('drop')
  await expect(page.getByText(/unlabeled: keep/)).toHaveCount(0)
  await expect(page.getByText(/unlabeled \(正解なし\)/)).toHaveCount(0, { timeout: 20_000 })
  await page.getByRole('button', { name: 'レシピを保存' }).click()
  await expect(page.getByText('保存しました')).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(unlabeled).toHaveValue('drop', { timeout: 20_000 })
  await expect(page.getByText(/unlabeled:/)).toHaveCount(0)
})

test('目的の列の欠けた行が無いデータでは, 正解の欠けた行を残す欄を選べない', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'people.csv' }).first().click()
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(page.getByRole('combobox', { name: '正解の欠けた行' })).toBeDisabled({
    timeout: 20_000,
  })
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
