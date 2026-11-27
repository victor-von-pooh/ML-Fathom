import { act, cleanup, render, screen } from '@testing-library/react'
import type { EChartsOption } from 'echarts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Chart } from './chart'
import { cssVar } from './chartTheme'
import { ThemeProvider } from './theme'
import { useTheme } from './themeContext'

/** 描いた設定 (setOption に渡した値) */
const drawn: EChartsOption[] = []

vi.mock('echarts', () => ({
  init: () => ({
    setOption: (option: EChartsOption) => drawn.push(option),
    resize: () => undefined,
    dispose: () => undefined,
    on: () => undefined,
    off: () => undefined,
  }),
}))

/** 明るい表示と暗い表示の --series-2 */
const LIGHT = '#111111'
const DARK = '#eeeeee'

/** 最後に描いた系列の 1 本目の色 */
function lastColor(): unknown {
  const series = drawn.at(-1)?.series as { itemStyle?: { color?: unknown } }[] | undefined
  return series?.[0]?.itemStyle?.color
}

/** 色を CSS の変数から読む棒のグラフと, 明暗の切り替え */
function Sample() {
  const { toggle } = useTheme()
  return (
    <>
      <button type="button" onClick={toggle}>
        切り替え
      </button>
      <Chart
        label="例"
        option={() => ({
          series: [{ type: 'bar', data: [1], itemStyle: { color: cssVar('--series-2') } }],
        })}
      />
    </>
  )
}

beforeEach(() => {
  drawn.length = 0
  document.documentElement.classList.remove('dark')
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  // jsdom は CSS の変数を数えないので, html のクラスで値を返す
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) =>
          name === '--series-2'
            ? document.documentElement.classList.contains('dark')
              ? DARK
              : LIGHT
            : '',
      }) as CSSStyleDeclaration,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('dark')
})

describe('Chart の明暗の切り替え', () => {
  it('単独で切り替えた後は新しい色で描き直す', () => {
    render(
      <ThemeProvider>
        <Sample />
      </ThemeProvider>,
    )
    expect(lastColor()).toBe(LIGHT)
    act(() => screen.getByRole('button', { name: '切り替え' }).click())
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(lastColor()).toBe(DARK)
    act(() => screen.getByRole('button', { name: '切り替え' }).click())
    expect(lastColor()).toBe(LIGHT)
  })

  it('殻の下で殻が html のクラスを替えた後は新しい色で描き直す', async () => {
    render(
      <ThemeProvider readOnly>
        <Sample />
      </ThemeProvider>,
    )
    expect(lastColor()).toBe(LIGHT)
    await act(async () => {
      document.documentElement.classList.add('dark')
      // MutationObserver の知らせを待つ
      await Promise.resolve()
    })
    expect(lastColor()).toBe(DARK)
  })
})
