import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Card } from './ui'

test('見出しを持つ欄は見出しを名前にした区域になる', () => {
  render(
    <>
      <Card title="選んだ問題の設定">中身</Card>
      <Card title="プロジェクトへ書き出す">別の中身</Card>
    </>,
  )
  expect(screen.getByRole('region', { name: '選んだ問題の設定' })).toHaveTextContent('中身')
  expect(screen.getByRole('region', { name: 'プロジェクトへ書き出す' })).toHaveTextContent(
    '別の中身',
  )
})

test('見出しの無い欄は名前を持たず, 区域にならない', () => {
  render(<Card>中身だけ</Card>)
  expect(screen.queryByRole('region')).toBeNull()
  expect(screen.getByText('中身だけ').closest('section')).not.toHaveAttribute('aria-labelledby')
})

test('name を渡した欄は, 見出しの中のボタンを含めずにその名前の区域になる', () => {
  render(
    <Card
      name="メモ"
      title={
        <span>
          <button type="button">星を付ける</button>
          メモ
        </span>
      }
    >
      中身
    </Card>,
  )
  expect(screen.getByRole('region', { name: 'メモ' })).toHaveTextContent('中身')
  expect(screen.queryByRole('region', { name: /星を付ける/ })).toBeNull()
})

test('landmark={false} の欄は区域にならず, 見出しは h2 のまま', () => {
  render(
    <Card title="people.csv" landmark={false}>
      一覧の中身
    </Card>,
  )
  expect(screen.queryByRole('region')).toBeNull()
  expect(screen.getByRole('heading', { level: 2, name: 'people.csv' })).toBeInTheDocument()
  const section = screen.getByText('一覧の中身').closest('section')
  expect(section).not.toHaveAttribute('aria-labelledby')
  expect(section).not.toHaveAttribute('aria-label')
})
