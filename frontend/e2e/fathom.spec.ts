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

  // 前処理のタブの外で目的の列を外して戻しても, 残すには戻らない
  // (外したときに編集中のレシピから消し, 保存するまで編集中の印が出る)
  const target = page.getByRole('combobox', { name: '目的の列' })
  await page.getByRole('tab', { name: '概要と気付き' }).click()
  await target.selectOption('')
  await expect(target).toHaveValue('')
  await target.selectOption('status')
  await expect(target).toHaveValue('status')
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(unlabeled).toHaveValue('drop', { timeout: 20_000 })
  await expect(page.getByText(/unlabeled: keep/)).toHaveCount(0)
  await expect(page.getByText(/保存していない変更があります/)).toBeVisible()
  await expect(page.getByText(/unlabeled \(正解なし\)/)).toHaveCount(0, { timeout: 20_000 })

  // 前処理のタブで外すと欄が消える. 戻して, 落とすのまま保存すると項目ごと消える
  await target.selectOption('')
  await expect(unlabeled).toHaveCount(0)
  await target.selectOption('status')
  await expect(unlabeled).toHaveValue('drop')
  await page.getByRole('button', { name: 'レシピを保存' }).click()
  await expect(page.getByText('保存しました')).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(unlabeled).toHaveValue('drop', { timeout: 20_000 })
  await expect(page.getByText(/unlabeled:/)).toHaveCount(0)
})

test('目的の列の欠けた行が無いデータでは, 正解の欠けた行を残す欄を選べない', async ({ page }) => {
  // 他のテストに頼らないように, 別の名前で登録して目的の列を決める
  const created = await page.request.post('/api/sources', {
    data: { path: TABLE, name: 'people-labeled' },
  })
  expect(created.ok()).toBe(true)
  const { id } = (await created.json()) as { id: string }
  const patched = await page.request.patch(`/api/sources/${id}`, { data: { target: 'bought' } })
  expect(patched.ok()).toBe(true)
  await page.goto(`/sources/${id}?tab=recipe`)
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

test('保存した問題の設定を一覧から開き, プロジェクトへ書き出して一覧で確かめる', async ({
  page,
}) => {
  // 置き換えの確かめは既定で受ける (やり直しで前の書き出しが残っていても進めるように)
  page.on('dialog', (dialog) => void dialog.accept())
  const exported = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/export_project') && response.request().method() === 'POST',
    )

  // ML-Pathfinder の置き場の問題の設定を一覧から選んで始める
  await page.goto('/')
  await page.getByRole('button', { name: '問題の設定から始める' }).click()
  const stored = page.getByRole('list', { name: '保存した問題の設定' })
  await stored.getByRole('button', { name: /総菜のプロジェクト/ }).click()
  await page.getByRole('button', { name: 'この問題の設定から始める' }).click()
  await expect(page.getByRole('heading', { name: '総菜のプロジェクト' })).toBeVisible()

  // 記録した書き出し先へ書き出すと, モデルを組むときの数が出る
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  const button = page.getByRole('button', { name: 'プロジェクトへ書き出す' })
  await expect(button).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/project\/data\/dataset$/)).toBeVisible()
  const first = exported()
  await button.click()
  expect((await first).ok()).toBe(true)
  await expect(page.getByText(/プロジェクトへ書き出しました/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('前に書き出したものがあります', { exact: false })).toBeVisible()

  // 2 回目は置き換えてよいかを確かめる (断ると送らない)
  page.removeAllListeners('dialog')
  const messages: string[] = []
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/export_project')) requests.push(request.url())
  })
  page.once('dialog', (dialog) => {
    messages.push(dialog.message())
    void dialog.dismiss()
  })
  await button.click()
  await expect.poll(() => messages.length).toBe(1)
  expect(messages[0]).toContain('置き換えますか')
  expect(requests).toHaveLength(0)
  page.once('dialog', (dialog) => void dialog.accept())
  const second = exported()
  await button.click()
  expect((await second).ok()).toBe(true)

  // データセットの一覧にプロジェクトのものとして並び, モデルに要るものが出る
  await page.getByRole('link', { name: 'データセット' }).click()
  const card = page.locator('section').filter({ hasText: 'データ 総菜のプロジェクト から' })
  await expect(card.getByText('プロジェクト', { exact: true }).first()).toBeVisible()
  await expect(card.getByText(/\[バッチ, \d+\] float32/)).toBeVisible()
  await expect(card.getByText(/1 \(値\)/)).toBeVisible()
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

  // 前処理のタブでは書き出さず, 点群と組にする書き出しへ案内する
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(page.getByText(/ここでは前処理と書き出しをしません/)).toBeVisible()
  await page.getByRole('link', { name: 'ファイルの組を書き出す' }).click()
  await expect(page.getByRole('tab', { name: '撮影と点群' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

// e2e/serve.sh が ML-EDA の合成の見本で作ったファイルの組
const PAIRS = path.resolve(import.meta.dirname, '.work', 'pairs')
const SHAPES = path.resolve(import.meta.dirname, '.work', 'shapes')

test('画像と領域の組を版 2 で書き出し, 注意と使い方を見て一覧で確かめる', async ({ page }) => {
  await page.goto('/datasets')
  await page.getByRole('link', { name: 'ファイルの組を書き出す' }).click()
  await expect(page.getByRole('tab', { name: '画像と領域' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  // 2 つの組の欄のうち, 見えている方
  const form = page.locator('#pairs-panel > div:not([hidden])')

  // 画像のディレクトリは「選ぶ」でたどり, 領域のディレクトリは書く
  await page.getByRole('button', { name: '画像のディレクトリを選ぶ' }).click()
  const dialog = page.getByRole('dialog', { name: '画像のディレクトリ' })
  await expect(dialog.getByRole('button', { name: 'このディレクトリを選ぶ' })).toBeVisible()
  await dialog.getByRole('button', { name: 'ホーム' }).click()
  await dialog.getByRole('button', { name: '閉じる' }).click()
  await form.getByLabel('画像のディレクトリ', { exact: true }).fill(PAIRS)
  await page.getByRole('button', { name: '画像のディレクトリを選ぶ' }).click()
  await dialog.getByRole('button', { name: 'images', exact: true }).click()
  await dialog.getByRole('button', { name: 'このディレクトリを選ぶ' }).click()
  await expect(form.getByLabel('画像のディレクトリ', { exact: true })).toHaveValue(
    path.join(PAIRS, 'images'),
  )
  await form.getByLabel('領域のディレクトリ', { exact: true }).fill(path.join(PAIRS, 'masks'))
  await form.getByLabel('値の名前 (任意)').fill('0: background\n1: circle\n2: square')

  // 出どころを今ある処理にすると, その処理を超えられないと添える
  await page.getByRole('combobox', { name: '種類' }).selectOption('process')
  await form.getByLabel('作った処理の名前').fill('threshold')
  await form.getByLabel('設定 (YAML)').fill('level: 0.5')
  await expect(page.getByText(/処理 threshold を超えられません/)).toBeVisible()

  // 形の誤った設定は書き出す前に止める
  const button = page.getByRole('button', { name: 'ファイルの組を書き出す' })
  await form.getByLabel('設定 (YAML)').fill('- a')
  await expect(button).toBeDisabled()
  await form.getByLabel('設定 (YAML)').fill('level: 0.5')
  await form.getByLabel('データセットの名前').fill('shapes')
  // CI の再試行でも書けるように置き換えの印を付ける
  await form.getByLabel('同じ名前があれば置き換える').check()
  await button.click()

  // 組にならなかった領域の注意と, load_items の使い方
  await expect(page.getByText(/書き出しました/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/orphan/)).toBeVisible()
  await expect(page.getByText(/dataset = load_items\(/)).toBeVisible()

  // 一覧に版 2 として並ぶ
  await page.getByRole('link', { name: 'データセットの一覧へ' }).click()
  const card = page.locator('section', { has: page.getByText('shapes', { exact: true }) })
  await expect(card.getByText('版 2 · ファイルの組')).toBeVisible()
  await expect(card.getByText(/予測する · 領域 \(mask\)/)).toBeVisible()
  await expect(card.getByText(/今ある処理の出力 \(process\)/)).toBeVisible()
  await expect(card.getByText(/全て 8 件/)).toBeVisible()
})

test('撮影と点群の組をグループで分けて書き出し, 一覧で確かめる', async ({ page }) => {
  await page.goto('/datasets/export?form=capture_clouds')
  const form = page.locator('#pairs-panel > div:not([hidden])')
  await form.getByLabel('撮影のディレクトリ', { exact: true }).fill(path.join(SHAPES, 'captures'))
  await form.getByLabel('点群のディレクトリ', { exact: true }).fill(path.join(SHAPES, 'clouds'))
  await page.getByRole('combobox', { name: '点群の単位' }).selectOption('meter')
  await form
    .getByLabel('グループ (任意)')
    .fill('sphere_a,sphere\nsphere_b,sphere\nbox_a,box\nbox_b,box')
  await form.getByLabel('検証用の割合').fill('0.5')
  await page.getByRole('combobox', { name: '種類' }).selectOption('synthetic')
  await form.getByLabel('データセットの名前').fill('objects')
  await form.getByLabel('同じ名前があれば置き換える').check()
  await page.getByRole('button', { name: 'ファイルの組を書き出す' }).click()

  await expect(page.getByText(/書き出しました/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/train 2 件, valid 2 件/)).toBeVisible()
  await expect(
    page.getByText(/normalize_capture で同じ正規化をかけて read_capture で読み/),
  ).toBeVisible()

  // 欄を変えると前の結果を消し, 同じ名前は置き換えの印が無ければ止まる
  await form.getByLabel('同じ名前があれば置き換える').uncheck()
  await expect(page.getByText(/書き出しました/)).toHaveCount(0)
  await page.getByRole('button', { name: 'ファイルの組を書き出す' }).click()
  await expect(page.getByText(/objects は既にあります/)).toBeVisible()

  await page
    .getByRole('navigation', { name: '移動' })
    .getByRole('link', { name: 'データセット', exact: true })
    .click()
  const card = page.locator('section', { has: page.getByText('objects', { exact: true }) })
  await expect(card.getByText(/予測する · 点群 \(point_cloud\)/)).toBeVisible()
  await expect(card.getByText('view_center', { exact: false })).toBeVisible()
  await expect(card.getByText(/作った正確な正解 \(synthetic\)/)).toBeVisible()
  // 深度から点に戻す決まり (合成の見本は z と +0.5)
  await expect(
    card.getByText(/深度 z \(カメラの前の軸に沿った距離\) · 画素の中心 \+0\.5/),
  ).toBeVisible()
})
