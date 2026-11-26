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

test('グループと時刻の組とグループの層化で分け, 使えないタスクと目的の値では誤りを出す', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page.getByLabel('ディレクトリのパス').fill(path.dirname(TABLE))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /orders\.csv/ }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'orders.csv' })).toBeVisible()
  // 日付の列を時刻にして時系列として読む
  await page
    .getByRole('combobox', { name: '読み方' })
    .selectOption({ label: '時系列 (時刻: date)' })
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  const split = page.getByRole('combobox', { name: '分割', exact: true })
  await expect(split).toBeVisible({ timeout: 20_000 })

  // グループと時刻の組: グループの列は要る欄 (任意でない). 選ぶと後から現れた客を検証用に分ける
  await split.selectOption('group_time')
  const group = page.getByRole('combobox', { name: 'グループの列', exact: true })
  await expect(group).toBeVisible()
  await group.selectOption('customer')
  await expect(page.getByText(/分割: train \d+ 行, valid \d+ 行/)).toBeVisible({ timeout: 20_000 })
  // 時刻の順に分けるので, 時刻の順を勧めない
  await expect(page.getByText('時系列の分割が時刻の順ではありません')).toHaveCount(0)

  // グループの層化: 目的の列が無ければ ML-EDA の誤りが出る
  await split.selectOption('stratified_group')
  await expect(page.getByText(/目的の列が要ります/)).toBeVisible({ timeout: 20_000 })

  // 分類なら分けられる
  await page.getByRole('combobox', { name: '目的の列' }).selectOption('returned')
  await page.getByRole('combobox', { name: 'タスク' }).selectOption('classification')
  await expect(page.getByText(/分割: train \d+ 行, valid \d+ 行/)).toBeVisible({ timeout: 20_000 })

  // 回帰にすると, 選択肢は選べなくなり, 残った指定には誤りを出す
  await page.getByRole('combobox', { name: '目的の列' }).selectOption('amount')
  await page.getByRole('combobox', { name: 'タスク' }).selectOption('regression')
  await expect(
    page.getByRole('alert').filter({ hasText: /回帰と時系列の予測では使えません/ }),
  ).toBeVisible()
  await expect(page.getByText(/stratified_group/).first()).toBeVisible({ timeout: 20_000 })
  // 欄と誤りの文は左のカードの中に収まる (長い選択肢でもはみ出さない)
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '目的と分割' }) })
  const cardBox = (await card.boundingBox())!
  for (const target of [split, page.getByRole('combobox', { name: 'グループの列', exact: true })]) {
    const box = (await target.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
  }
  const alertBox = (await page
    .getByRole('alert')
    .filter({ hasText: /回帰と時系列の予測では使えません/ })
    .boundingBox())!
  expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
  await split.selectOption('group')
  await expect(split.locator('option[value="stratified_group"]')).toBeDisabled()

  // タスクを決めないと選べるが, 目的の値がほぼ全て違えば ML-EDA の誤りが出る
  await page.getByRole('combobox', { name: 'タスク' }).selectOption('none')
  await expect(split.locator('option[value="stratified_group"]')).toBeEnabled()
  await split.selectOption('stratified_group')
  await expect(page.getByText(/値がほぼ全て違う/)).toBeVisible({ timeout: 20_000 })
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

test('音声を登録し, 種類の名前と, 1 件ずつの再生と波形を見る', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'sounds'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: 'このディレクトリを選ぶ' }).click()
  await expect(page.getByLabel('読み込み', { exact: true })).toHaveValue('audio_folder')
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByText('音声 · audio_folder')).toBeVisible({ timeout: 20_000 })

  // 中身を見る: 長い録音は先頭の 30 秒だけを再生と波形にする
  await page.getByRole('tab', { name: '中身を見る' }).click()
  const list = page.getByRole('list', { name: '音声' })
  await list.getByRole('button', { name: /high\.wav/ }).click()
  await expect(page.getByRole('img', { name: /番目の音声の波形/ })).toBeVisible()
  await expect(page.getByText(/再生と波形は先頭の 30\.0 秒だけ/)).toBeVisible()
  const player = page.locator('audio')
  const source = await player.getAttribute('src')
  const played = await page.request.get(source!)
  expect(played.headers()['content-type']).toBe('audio/wav')
  // 8000 Hz, 1 チャンネル, 16 bit の 30 秒と, WAVE の頭の 44 バイト
  expect((await played.body()).length).toBe(8000 * 2 * 30 + 44)
})

test('音声で中身の手順を分析から作り, 数件で試して前と後の再生と波形を見る', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'sounds'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: 'このディレクトリを選ぶ' }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByText('音声 · audio_folder')).toBeVisible({ timeout: 20_000 })

  // 分析 (8000 Hz, 1 チャンネル, 長さの中央値 18 秒) から, 周波数, チャンネル, 長さの順の手順を作る
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await page.getByRole('button', { name: '学習用の配列にする手順を作る' }).click()
  const steps = page.locator('section', {
    has: page.getByRole('heading', { name: '中身の手順 (3)' }),
  })
  await expect(steps.locator('ol > li code')).toHaveText(['resample', 'mix_channels', 'fix_length'])
  await expect(steps.getByLabel('rate', { exact: true })).toHaveValue('8000')
  await expect(steps.getByLabel('channels', { exact: true })).toHaveValue('1')
  await expect(steps.getByLabel('seconds', { exact: true })).toHaveValue('18')

  // 数件で試すと, 選んだ 1 件の前と後の再生と波形が出る
  const preview = page.locator('section', {
    has: page.getByRole('heading', { name: '中身の手順の前と後' }),
  })
  await preview.getByRole('button', { name: '数件で試す' }).click()
  await expect(preview.getByText(/学習用の .+ 件で当てはめた/)).toBeVisible({ timeout: 20_000 })
  const sounds: Record<string, Buffer> = {}
  for (const side of ['前', '後']) {
    await expect(
      preview.getByRole('img', { name: new RegExp(`の手順の${side}の波形`) }),
    ).toBeVisible()
    const src = await preview.getByLabel(new RegExp(`の手順の${side}の再生`)).getAttribute('src')
    expect(src).toMatch(/^data:audio\/wav;base64,/)
    const sound = Buffer.from(src!.split(',')[1]!, 'base64')
    expect(sound.subarray(0, 4).toString('ascii')).toBe('RIFF')
    sounds[side] = sound
  }
  // 後は 18 秒にそろえた形で, 再生は先頭の 5 秒 (8000 Hz, 1 チャンネル, 16 bit と頭の 44 バイト)
  await expect(preview.getByText('後 (形 (1, 144000))')).toBeVisible()
  expect(sounds['後']!.length).toBe(8000 * 2 * 5 + 44)
  await expect(preview.getByText(/長さ 18\.0 秒 \(再生と波形は先頭の 5\.00 秒だけ\)/)).toBeVisible()
})

test('外を指すリンクの件は理由を出して読まず, 読み込みの設定 follow_links で読む', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'linked'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: 'このディレクトリを選ぶ' }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByText('音声 · audio_folder')).toBeVisible({ timeout: 20_000 })

  // 既定では一覧に理由が出て, 1 件の中身も理由付きで読まない
  await page.getByRole('tab', { name: '中身を見る' }).click()
  const list = page.getByRole('list', { name: '音声' })
  const outside = list.getByRole('button', { name: /outside\.wav/ })
  await expect(outside).toContainText('外を指すリンク')
  await outside.click()
  await expect(page.getByRole('alert')).toContainText('follow_links')

  // follow_links を true にして読み直すと, 一覧も中身も読む
  await page.getByRole('button', { name: '読み込みの設定', exact: true }).click()
  await page.getByLabel('follow_links').selectOption('true')
  await page.getByRole('button', { name: '読み直す' }).click()
  await page.getByRole('tab', { name: '中身を見る' }).click()
  await expect(outside).toContainText('8,000 Hz', { timeout: 20_000 })
  await outside.click()
  await expect(page.getByRole('img', { name: /番目の音声の波形/ })).toBeVisible()
})

test('中身の手順の引数が上限を超えると, 理由を出して試すと書き出すを止める', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'sounds'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: 'このディレクトリを選ぶ' }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByText('音声 · audio_folder')).toBeVisible({ timeout: 20_000 })

  // 周波数を上限 (192000 Hz) より大きくすると, 理由が出て試すと書き出すを押せない
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await page.getByRole('button', { name: '学習用の配列にする手順を作る' }).click()
  const steps = page.locator('section', {
    has: page.getByRole('heading', { name: /^中身の手順 \(/ }),
  })
  const rate = steps.getByLabel('rate', { exact: true })
  await rate.fill('200000')
  await rate.blur()
  const reason = '中身の手順 1 (resample) の rate は 192000 以下にしてください'
  await expect(steps.getByText(reason)).toBeVisible()
  const trial = page.getByRole('button', { name: '数件で試す' })
  const exporter = page.getByRole('button', { name: '学習用に書き出す' })
  await expect(trial).toBeDisabled()
  await expect(exporter).toBeDisabled()
  await expect(exporter).toHaveAccessibleDescription(reason)

  // 上限ちょうどに戻すと, 理由が消えて押せる
  await rate.fill('192000')
  await rate.blur()
  await expect(steps.getByText(reason)).toHaveCount(0)
  await expect(trial).toBeEnabled()
  await expect(exporter).toBeEnabled()
})

// e2e/serve.sh が ML-EDA の合成の見本で作ったファイルの組
const PAIRS = path.resolve(import.meta.dirname, '.work', 'pairs')
const SHAPES = path.resolve(import.meta.dirname, '.work', 'shapes')

test('正解の無い件は既定で除き, unlabeled の分割に書くこともできる', async ({ page }) => {
  await page.goto('/datasets')
  await page.getByRole('link', { name: 'ファイルの組を書き出す' }).click()
  const form = page.locator('#pairs-panel > div:not([hidden])')
  const partial = path.join(path.dirname(TABLE), 'partial')
  await form.getByLabel('画像のディレクトリ', { exact: true }).fill(path.join(partial, 'images'))
  await form.getByLabel('領域のディレクトリ', { exact: true }).fill(path.join(partial, 'masks'))
  await form.getByLabel('同じ名前があれば置き換える').check()
  const button = page.getByRole('button', { name: 'ファイルの組を書き出す' })

  // 既定は除く. 何が正解の無い件で, どうなるかを添える
  const unlabeled = form.getByRole('combobox', { name: '正解の無い件' })
  await expect(unlabeled).toHaveValue('drop')
  await expect(unlabeled).toHaveAccessibleDescription(/領域の無い画像です. 書き出さず/)
  await form.getByLabel('データセットの名前').fill('partial_drop')
  await button.click()
  await expect(page.getByText(/書き出しました/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/lonely/)).toBeVisible()
  await expect(page.getByText(/unlabeled \(正解なし\)/)).toHaveCount(0)

  // unlabeled の分割に書くと, 分割に「正解なし」が足される
  await unlabeled.selectOption('keep')
  await expect(unlabeled).toHaveAccessibleDescription(/unlabeled という名前の分割に書きます/)
  await form.getByLabel('データセットの名前').fill('partial_keep')
  await button.click()
  await expect(page.getByText(/unlabeled \(正解なし\) 1 件/)).toBeVisible({ timeout: 20_000 })
  // 学習のスクリプトでの使い方に, 正解の無い件の分割の読み方が足される
  await expect(page.getByText(/unlabeled = dataset\.split\("unlabeled"\)/)).toBeVisible()
})

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

// e2e/serve.sh が大きさの混ざった画像と領域を作った場所
const MIXED = path.resolve(import.meta.dirname, '.work', 'mixed')

test('大きさの混ざった画像を中身の手順でそろえて版 3 で書き出し, 一覧で手順を見る', async ({
  page,
}) => {
  await page.goto('/datasets/export')
  const form = page.locator('#pairs-panel > div:not([hidden])')
  await form.getByLabel('画像のディレクトリ', { exact: true }).fill(path.join(MIXED, 'images'))
  await form.getByLabel('領域のディレクトリ', { exact: true }).fill(path.join(MIXED, 'masks'))
  await form.getByLabel('データセットの名前').fill('resized')
  await form.getByLabel('同じ名前があれば置き換える').check()

  // 画像に選べる手順は resize, grayscale, rgb だけで, 領域の欄は無い
  const adding = form.getByLabel('画像に足す中身の手順')
  await expect(adding.locator('option')).toHaveText([
    '足す手順を選ぶ…',
    /^resize — /,
    /^grayscale — /,
    /^rgb — /,
  ])
  await expect(form.getByLabel('領域に足す中身の手順')).toHaveCount(0)

  // resize を足すと, 大きさを入れるまで書き出せない
  await adding.selectOption('resize')
  await form.getByRole('button', { name: '画像に手順を足す' }).click()
  const button = page.getByRole('button', { name: 'ファイルの組を書き出す' })
  await expect(button).toBeDisabled()
  await expect(form.getByText('画像の手順 1 (resize) の width を入れてください')).toBeVisible()
  await form.getByLabel('画像の手順 1 の width').fill('20')
  await form.getByLabel('画像の手順 1 の height').fill('16')
  await button.click()

  // 版 3 で書き出し, 領域には同じ大きさの resize_mask がかかる
  await expect(page.getByText(/書き出しました/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('版: 3')).toBeVisible()
  await expect(page.getByText('image: resize (width 20, height 16)')).toBeVisible()
  await expect(page.getByText('mask: resize_mask (width 20, height 16)')).toBeVisible()
  await expect(page.getByText(/transform_entry\(dataset, 項目の名前, 中身\)/)).toBeVisible()

  // 一覧に版 3 として並び, 項目ごとの手順が出る
  await page.getByRole('link', { name: 'データセットの一覧へ' }).click()
  const card = page.locator('section', { has: page.getByText('resized', { exact: true }) })
  await expect(card.getByText('版 3 · ファイルの組')).toBeVisible()
  await expect(card.getByText('resize (width 20, height 16)', { exact: true })).toBeVisible()
  await expect(card.getByText('resize_mask (width 20, height 16)', { exact: true })).toBeVisible()
  await expect(card.getByText(/全て 6 件/)).toBeVisible()
})

test('撮影と点群の組を中身の手順でそろえ, グループで分けて書き出し, 一覧で確かめる', async ({
  page,
}) => {
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
  // 撮影の大きさと点群の点の数を中身の手順でそろえる (上限を超えると書き出せない)
  await form.getByLabel('撮影に足す中身の手順').selectOption('resize')
  await form.getByRole('button', { name: '撮影に手順を足す' }).click()
  await form.getByLabel('撮影の手順 1 の width').fill('4097')
  await form.getByLabel('撮影の手順 1 の height').fill('24')
  await expect(
    form.getByText('撮影の手順 1 (resize) の width は 4096 以下にしてください'),
  ).toBeVisible()
  await form.getByLabel('撮影の手順 1 の width').fill('32')
  await form.getByLabel('点群に足す中身の手順').selectOption('sample_points')
  await form.getByRole('button', { name: '点群に手順を足す' }).click()
  await form.getByLabel('点群の手順 1 の points').fill('50')
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
  await expect(card.getByText('版 3 · ファイルの組')).toBeVisible()
  await expect(card.getByText('resize (width 32, height 24)', { exact: true })).toBeVisible()
  await expect(card.getByText('sample_points (points 50)', { exact: true })).toBeVisible()
  // 深度から点に戻す決まり (合成の見本は z と +0.5)
  await expect(
    card.getByText(/深度 z \(カメラの前の軸に沿った距離\) · 画素の中心 \+0\.5/),
  ).toBeVisible()
})

test('領域の問題の設定から始め, 下書きのままプロジェクトへ書き出して書き戻す', async ({ page }) => {
  // 一覧から選ぶと, データを登録せずにファイルの組の書き出しへ移る
  await page.goto('/')
  await page.getByRole('button', { name: '問題の設定から始める' }).click()
  const stored = page.getByRole('list', { name: '保存した問題の設定' })
  await stored.getByRole('button', { name: /領域のプロジェクト/ }).click()
  await page.getByRole('button', { name: 'この問題の設定から始める' }).click()
  await expect(page.getByText('問題の設定: 領域のプロジェクト')).toBeVisible()
  await expect(page.getByRole('tab', { name: '撮影と点群' })).toHaveCount(0)

  // 欄は問題の設定の下書き (入れたディレクトリ, 分割, 正解の出どころ) で埋まる
  await expect(page.getByLabel('画像のディレクトリ', { exact: true })).toHaveValue(
    path.join(PAIRS, 'images'),
  )
  await expect(page.getByLabel('領域のディレクトリ', { exact: true })).toHaveValue(
    path.join(PAIRS, 'masks'),
  )
  await expect(page.getByLabel('検証用の割合')).toHaveValue('0.15')
  await expect(page.getByLabel('作った処理の名前')).toHaveValue('塗り分け')
  await expect(page.getByText(/mask_project\/outputs\/dataset$/)).toBeVisible()

  // 中身の手順も選べ, 書き出しにかけて問題の設定に書き戻す (手順が無ければ空)
  await expect(page.getByText('手順なし (ファイルをそのまま写す)')).toBeVisible()
  await page.getByLabel('画像に足す中身の手順').selectOption('grayscale')
  await page.getByRole('button', { name: '画像に手順を足す' }).click()

  // 書き出すとプロジェクトに入り, 問題の設定に書き戻る
  await page.getByLabel('前に書き出したデータセットを置き換える').check()
  await page.getByRole('button', { name: 'プロジェクトへ書き出す' }).click()
  await expect(page.getByText(/書き出しました: .*mask_project/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('問題の設定に書き戻しました.')).toBeVisible()
  await expect(page.getByText(/orphan/)).toBeVisible()
  await expect(page.getByText('image: grayscale')).toBeVisible()

  // 開き直すと書き戻した設定で, データセットの一覧にプロジェクトとして並ぶ
  const problem = path.resolve(
    import.meta.dirname,
    '.work',
    'pathfinder',
    'problems',
    'masks',
    'problem.yaml',
  )
  const reopened = await page.request.get(`/api/problems/pairs?path=${encodeURIComponent(problem)}`)
  const draft = (await reopened.json()) as {
    export: { inputs: string; options: { item_steps?: unknown } }
    notes: string[]
  }
  expect(draft.export.inputs).toBe(path.join(PAIRS, 'images'))
  expect(draft.export.options.item_steps).toEqual({ image: [{ op: 'grayscale' }] })
  expect(draft.notes).toEqual([])

  // 画面を開き直すと, 中身の手順の欄も書き戻した手順で埋まる
  await page.reload()
  await expect(
    page.getByRole('list', { name: '画像の中身の手順' }).getByText('grayscale', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('navigation', { name: '移動' })
    .getByRole('link', { name: 'データセット', exact: true })
    .click()
  const card = page
    .locator('section')
    .filter({ hasText: '問題の設定 領域のプロジェクト からプロジェクトへ書き出したもの' })
  await expect(card.getByText('版 3 · ファイルの組')).toBeVisible()
  await expect(card.getByText('プロジェクト', { exact: true }).first()).toBeVisible()
})

test('表として読んだデータで時刻の分割を選ぶと, 日時の列を時刻にする読み方を案内する', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page.getByLabel('ディレクトリのパス').fill(path.dirname(TABLE))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /sozai\.csv/ }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'sozai.csv' }).first()).toBeVisible()
  const readAs = page.getByRole('combobox', { name: '読み方' })
  await readAs.selectOption('table')
  await expect(readAs).toHaveValue('table', { timeout: 20_000 })

  // 時刻の順を選ぶと, 日時に見える列 (date) を時刻にする読み方を案内する
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  const split = page.getByRole('combobox', { name: '分割', exact: true })
  await split.selectOption('time')
  const hint = page.getByText(/「読み方」を「時系列 \(時刻: date\)」にすると使えます/)
  await expect(hint).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/日時の列が要ります/).first()).toBeVisible({ timeout: 20_000 })

  // 他の分割では出さない
  await split.selectOption('random')
  await expect(hint).toHaveCount(0)
})

test('記録した軌跡を登録し, 分布と行動の偏りと守りとエピソードを見て, 分析を書き出す', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'trajectories'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /guarded\.csv/ }).click()
  // 軌跡の表は普通の表としても読めるが, 軌跡の読み込みが先に出る
  await expect(page.getByLabel('読み込み', { exact: true })).toHaveValue('trajectory')
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'guarded.csv' })).toBeVisible()
  await expect(page.getByText(/^記録した軌跡 · /)).toBeVisible()

  // 概要: 数, 長さと報酬の和の分布, 終わり方, 説明
  await expect(page.getByRole('img', { name: 'エピソードの長さのヒストグラム' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('img', { name: '報酬の和のヒストグラム' })).toBeVisible()
  await expect(page.getByRole('img', { name: '終わり方ごとのエピソードの数' })).toBeVisible()
  await expect(page.getByText('守り付きの評価')).toBeVisible()
  // 表の分析の目的の列と前処理のタブは出さない
  await expect(page.getByLabel('目的の列')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '前処理と書き出し' })).toHaveCount(0)

  // 観測と行動: 守りで止めた行は行動の欠けに数え, Discrete の行動は値ごとの数を描く
  await page.getByRole('tab', { name: '観測と行動' }).click()
  const actions = page.getByRole('table', { name: '行動の要素ごとの統計' })
  await expect(
    actions
      .getByRole('row', { name: /action/ })
      .getByRole('cell')
      .nth(1),
  ).toHaveText('2')
  await expect(page.getByRole('img', { name: 'action の値ごとの数' })).toBeVisible()

  // 守り: 結果と理由ごとの数
  await page.getByRole('tab', { name: '守り' }).click()
  await expect(page.getByRole('img', { name: '守りの結果ごとの行の数' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '観測の要素 0 が範囲の外 (3)' })).toBeVisible()

  // エピソードごとの一覧
  await page.getByRole('tab', { name: /エピソード/ }).click()
  const episodes = page.getByRole('table', { name: /エピソードごと/ })
  await expect(episodes.getByRole('row')).toHaveCount(3)
  await expect(episodes.getByText('守りで止めた')).toHaveCount(2)

  // 分析を書き出すと, 要約の JSON を保存する
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '分析を書き出す' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('guarded.analysis.json')
  const saved = await download.path()
  const { readFile } = await import('node:fs/promises')
  const written = JSON.parse(await readFile(saved, 'utf-8')) as Record<string, unknown>
  expect(written.episodes).toBe(2)
  expect(written.ends).toMatchObject({ stop: 2 })
})

test('Box の行動の軌跡では要素ごとの統計を出し, 守りのタブを出さない', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'trajectories'))
  await page.getByRole('button', { name: '移動' }).click()
  // 説明の JSON を選んでも, その表を軌跡として読む
  await page.getByRole('button', { name: /box\.json/ }).click()
  await expect(page.getByLabel('読み込み', { exact: true })).toHaveValue('trajectory')
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'box.json' })).toBeVisible()
  await page.getByRole('tab', { name: '観測と行動' }).click()
  const actions = page.getByRole('table', { name: '行動の要素ごとの統計' })
  await expect(actions.getByRole('row', { name: /action_0/ })).toContainText('number')
  await expect(page.getByRole('img', { name: /の値ごとの数/ })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '守り' })).toHaveCount(0)
})

test('行動を選んだ確率のある軌跡で, 確率の列の欠けと範囲の外の数を見る', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page
    .getByLabel('ディレクトリのパス')
    .fill(path.resolve(import.meta.dirname, '.work', 'trajectories'))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /prob\.csv/ }).click()
  await expect(page.getByLabel('読み込み', { exact: true })).toHaveValue('trajectory')
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'prob.csv' })).toBeVisible()

  // 確率の列: 守りで止めた 2 行は欠け, 範囲の外は無い
  await page.getByRole('tab', { name: '観測と行動' }).click()
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '行動を選んだ確率', exact: true }) })
  await expect(card.getByText('欠け', { exact: true }).locator('..')).toContainText('2')
  await expect(card.getByText(/^範囲の外/).locator('..')).toContainText('0')
})

test('作るものが表の問題の設定から始め, 書き戻してプロジェクトへ書き出す', async ({ page }) => {
  // 置き換えの確かめは既定で受ける (やり直しで前の書き出しが残っていても進めるように)
  page.on('dialog', (dialog) => void dialog.accept())

  // 一覧から始めると, 目的の列の無いレシピで始まり, 始めたときの知らせが出る
  await page.goto('/')
  await page.getByRole('button', { name: '問題の設定から始める' }).click()
  const stored = page.getByRole('list', { name: '保存した問題の設定' })
  await stored.getByRole('button', { name: /合成の表のプロジェクト/ }).click()
  await page.getByRole('button', { name: 'この問題の設定から始める' }).click()
  await expect(page.getByRole('heading', { name: '合成の表のプロジェクト' })).toBeVisible()
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  const notes = page.getByRole('region', { name: '始めたときの知らせ' })
  await expect(notes.getByText(/drop_columns で落とし/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('問題の設定との食い違いはありません.')).toBeVisible()

  // 書き戻してから, 骨組みの読む場所 (outputs/dataset) へ書き出す
  await page.getByRole('button', { name: '問題の設定に書き戻す' }).click()
  await expect(page.getByText(/書き戻しました/)).toBeVisible()
  const button = page.getByRole('button', { name: 'プロジェクトへ書き出す' })
  await expect(page.getByText(/table_project\/outputs\/dataset$/)).toBeVisible()
  await button.click()
  await expect(page.getByText(/プロジェクトへ書き出しました/)).toBeVisible({ timeout: 20_000 })
})

test('並べるの問題の設定から始め, 反応の表の偏りを見てプロジェクトへ写す', async ({ page }) => {
  // 骨組みが入れたデータを写しているので, 置き換えの確かめを受ける
  page.on('dialog', (dialog) => void dialog.accept())

  // 一覧から始めると, レシピを持たない反応の表の分析の画面が開く
  await page.goto('/')
  await page.getByRole('button', { name: '問題の設定から始める' }).click()
  const stored = page.getByRole('list', { name: '保存した問題の設定' })
  await stored.getByRole('button', { name: /推薦のプロジェクト/ }).click()
  await page.getByRole('button', { name: 'この問題の設定から始める' }).click()
  await expect(page.getByRole('heading', { name: '推薦のプロジェクト' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '前処理と書き出し' })).toHaveCount(0)

  // 概要に除いた行の気付き, 読んだ列, 日時の時刻の範囲が出る
  await expect(page.getByText('利用者, 品物か時刻の欠けた 2 行を除きました')).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    page.getByText(/反応の強さ \(qty\) が 0 以下か数でない \d+ 行を除きました/),
  ).toBeVisible()
  const time = page.locator('section', { has: page.getByRole('heading', { name: '時刻の範囲' }) })
  await expect(time.getByText('日時')).toBeVisible()
  await expect(time.getByText(/^2025-01-01 \d\d:00:00$/)).toBeVisible()

  // 偏りに人気の偏りと多い品物が出る
  await page.getByRole('tab', { name: '偏り' }).click()
  const popular = page.getByRole('table', { name: '反応の多い品物' })
  await expect(popular.getByRole('row')).toHaveCount(11)
  await expect(
    page.getByRole('img', { name: '利用者ごとの反応の数の区切りごとの数' }),
  ).toBeVisible()

  // 骨組みの読む場所 (data/reactions.csv) へ, ファイル 1 つのまま写す
  await page.getByRole('tab', { name: '書き出し' }).click()
  await expect(page.getByText(/rank_project\/data\/reactions\.csv$/)).toBeVisible()
  await page.getByRole('button', { name: 'プロジェクトへ書き出す' }).click()
  await expect(page.getByRole('status')).toContainText('プロジェクトへ書き出しました', {
    timeout: 20_000,
  })
})

test('正解の無い表で群を作る列と群の数を選び, 群の要約を見て群分けの表を分析用に書き出す', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page.getByLabel('ディレクトリのパス').fill(path.dirname(TABLE))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /segments\.csv/ }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'segments.csv' })).toBeVisible()

  // 群分けのタブで, 初めは数と種類の列を選び, 会員の番号は外している
  await page.getByRole('tab', { name: '群分け' }).click({ timeout: 20_000 })
  const fields = page.getByRole('group', { name: '群を作る列' })
  await expect(fields.getByRole('checkbox', { name: /spend/ })).toBeChecked()
  await expect(fields.getByRole('checkbox', { name: /region/ })).toBeChecked()
  await expect(fields.getByRole('checkbox', { name: /member/ })).not.toBeChecked()
  await page.getByLabel('群の数').fill('3')
  await page.getByRole('button', { name: '群を作る' }).click()

  // 3 つの群が 40 行ずつで, 種を変えても同じ群になる
  const table = page.getByRole('table', { name: '群ごとの行の数, 割合, 安定性と列の特徴' })
  await expect(table.getByRole('row')).toHaveCount(5, { timeout: 20_000 })
  await expect(table.getByRole('row').last()).toContainText('全体')
  await expect(table.getByText('40', { exact: true })).toHaveCount(3)
  await expect(page.getByText('調整ランド指数 (安定性)').locator('..')).toContainText('1')

  // 会員の番号で行を見分けて書き出し, 一覧に群分けの表として並ぶ
  await page.getByLabel('行を見分ける列').selectOption('member')
  await page.getByLabel('データセットの名前').fill('segments_groups')
  await page.getByRole('button', { name: '群分けの表を分析用に書き出す' }).click()
  await expect(page.getByRole('status')).toContainText('書き出しました', { timeout: 20_000 })
  await page.getByRole('link', { name: 'データセット' }).click()
  const card = page.locator('section', { has: page.getByText('segments_groups', { exact: true }) })
  await expect(card.getByText('版 2 · 群分けの表')).toBeVisible()
  await expect(card.getByText('まとめる · 正解なし')).toBeVisible()
})

test('まとめるの問題の設定から始め, 答えの列で群を作ってプロジェクトへ写す', async ({ page }) => {
  // 骨組みが入れたデータを写しているので, 置き換えの確かめを受ける
  page.on('dialog', (dialog) => void dialog.accept())

  // 一覧から始めると, 群分けのタブが開き, 問題の設定の答えで欄を埋める
  await page.goto('/')
  await page.getByRole('button', { name: '問題の設定から始める' }).click()
  const stored = page.getByRole('list', { name: '保存した問題の設定' })
  await stored.getByRole('button', { name: /客の群のプロジェクト/ }).click()
  await page.getByRole('button', { name: 'この問題の設定から始める' }).click()
  await expect(page.getByRole('heading', { name: '客の群のプロジェクト' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '群分け' })).toHaveAttribute('aria-selected', 'true', {
    timeout: 20_000,
  })
  const fields = page.getByRole('group', { name: '群を作る列' })
  await expect(fields.getByRole('checkbox', { name: /spend/ })).toBeChecked()
  await expect(fields.getByRole('checkbox', { name: /visits/ })).toBeChecked()
  await expect(fields.getByRole('checkbox', { name: /region/ })).not.toBeChecked()
  await expect(page.getByLabel('群の数')).toHaveValue('3')

  // 安定性の数え方は答えの「標本を変えて作り直す」で, 骨組みと同じ数え方と添える
  await expect(page.getByText('標本を変えて作り直す')).toBeVisible()
  await expect(page.getByText(/ここの調整ランド指数も骨組みと同じく標本を変えて/)).toBeVisible()

  // 答えの列で群を作ると, 40 行ずつの 3 つの群になり, 行の 8 割を引き直して数える.
  // はっきりした群なので, 引き直しても同じ群になる
  await page.getByRole('button', { name: '群を作る' }).click()
  const table = page.getByRole('table', { name: '群ごとの行の数, 割合, 安定性と列の特徴' })
  await expect(table.getByText('40', { exact: true })).toHaveCount(3, { timeout: 20_000 })
  await expect(page.getByText(/全ての行から 80% の行を引き直し/)).toBeVisible()
  const ari = page.getByText('調整ランド指数 (安定性)').locator('..').locator('div').nth(1)
  await expect(ari).toHaveText('1')

  // 答えと違う列を選ぶと知らせ, 戻すと消える
  await fields.getByRole('checkbox', { name: /region/ }).check()
  await expect(page.getByText(/問題の設定の答えと違います/)).toBeVisible()
  await fields.getByRole('checkbox', { name: /region/ }).uncheck()
  await expect(page.getByText(/問題の設定の答えと違います/)).toHaveCount(0)

  // 骨組みの読む場所 (data/segments.csv) へ, ファイル 1 つのまま写す
  await expect(page.getByText(/group_project\/data\/segments\.csv$/)).toBeVisible()
  await page.getByRole('button', { name: 'プロジェクトへ書き出す' }).click()
  await expect(page.getByText(/プロジェクトへ書き出しました/)).toContainText(
    '120 行. 骨組みが群を作る列 spend, visits, 行を見分ける列 member',
    { timeout: 20_000 },
  )

  // 前処理のタブは, レシピの確かめの誤りでなく案内を出し, 群分けのタブへ導く
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await expect(page.getByText(/まとめる \(群分け\) の問題の設定から始めたデータは/)).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText(/レシピを持ちません \(表をファイル/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '問題の設定に書き戻す' })).toHaveCount(0)
  await page.getByRole('link', { name: '群分けのタブへ移る' }).click()
  await expect(page.getByRole('tab', { name: '群分け' })).toHaveAttribute('aria-selected', 'true')

  // 群の数を答えと違う値にすると, 変わる点を確かめてから問題の設定に書き戻せる.
  // 書き戻すと答えが欄と同じになり, 知らせが消える
  await page.getByLabel('群の数').fill('4')
  await expect(page.getByText(/問題の設定の答えと違います/)).toBeVisible()
  const changes = page.getByRole('region', { name: '書き戻すと変わる点' })
  await expect(changes).toContainText('群の数を 4 に書き戻した', { timeout: 20_000 })
  await expect(changes).toContainText('骨組みを書き出し直してください')
  await page.getByRole('button', { name: '問題の設定に書き戻す' }).click()
  await expect(page.getByText('問題の設定に書き戻しました.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/問題の設定の答えと違います/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '問題の設定に書き戻す' })).toHaveCount(0)
  await expect(page.getByLabel('群の数')).toHaveValue('4')
})

test('値段を変えた売れ行きの記録で値段と原価と商品を選び, 要約を見て値段を変える判断を書き出す', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'データを追加' }).first().click()
  await page.getByLabel('ディレクトリのパス').fill(path.dirname(TABLE))
  await page.getByRole('button', { name: '移動' }).click()
  await page.getByRole('button', { name: /sales\.csv/ }).click()
  await page.getByRole('button', { name: '追加', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'sales.csv' })).toBeVisible()
  await page.getByRole('combobox', { name: '目的の列' }).selectOption('units')

  // タスクを値段を変える判断にし, 値段, 原価, 商品の id, 行の id の列を選ぶ
  await page.getByRole('tab', { name: '前処理と書き出し' }).click()
  await page.getByLabel('タスク').selectOption('price', { timeout: 20_000 })
  await page.getByLabel('分割', { exact: true }).selectOption('stratified')
  await page.getByLabel('値段の列').selectOption('price')
  await page.getByLabel('原価の列').selectOption('unit_cost')
  await page.getByLabel('商品の id の列').selectOption('product_id')
  await page.getByLabel('行の id の列').selectOption('record_id')

  // 要約に弾力性の目安と, 試した値段が 1 つの商品が出る
  await expect(page.getByText(/弾力性の目安 -/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('試した値段が 1 つの商品 1')).toBeVisible()
  await expect(page.getByRole('table', { name: /商品ごとの試した値段/ })).toContainText('p9')

  // 種類の列を数にし, 値段の列も標準化する. 値段の列は他の手順の候補に出ない
  await page.getByLabel('足す手順').selectOption('one_hot')
  await page.getByRole('button', { name: '足す', exact: true }).click()
  await page.getByRole('checkbox', { name: 'auto (型から選ぶ)' }).uncheck()
  const candidates = page.locator('#step-0-columns option')
  await expect(candidates.filter({ hasText: /^category$/ })).toHaveCount(1)
  await expect(candidates.filter({ hasText: /^price$/ })).toHaveCount(0)
  await page.locator('#step-0-columns').selectOption('category')
  await page.getByLabel('足す手順').selectOption('standardize')
  await page.getByRole('button', { name: '足す', exact: true }).click()

  // 学習用のデータに分割ごとの値段の範囲が出て, 書き出すと一覧に並ぶ
  const splits = page.getByRole('table', {
    name: '分割ごとの行と商品の数, 元の値段の範囲と種類の数, 売れた数と原価の平均',
  })
  await expect(splits).toContainText('valid', { timeout: 20_000 })
  await page.getByLabel('データセットの名前').fill('sales_price')
  await page.getByRole('button', { name: '学習用に書き出す' }).click()
  await expect(page.getByText(/書き出しました/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/dataset\.price_inputs/)).toBeVisible()
  await page.getByRole('link', { name: 'データセット' }).click()
  const card = page.locator('section', { has: page.getByText('sales_price', { exact: true }) })
  await expect(card.getByText(/1 \(売れた数の予測/)).toBeVisible()
  await expect(card.getByText(/値段の列:/)).toContainText('standardize')
})
