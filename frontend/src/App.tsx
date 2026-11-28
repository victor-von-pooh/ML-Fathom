import clsx from 'clsx'
import { Database, FolderInput, Moon, SearchX, Sun, Telescope } from 'lucide-react'
import { Link, NavLink, Route, Routes } from 'react-router'

import { EmptyState, PageHeader } from './components/common'

import { DatasetsPage } from './features/datasets/DatasetsPage'
import { PairExportPage } from './features/datasets/PairExportPage'
import { SourcePage } from './features/source/SourcePage'
import { SourcesPage } from './features/sources/SourcesPage'
import { useStage } from './lib/stage'
import { useTheme } from './lib/themeContext'

/** 左の欄の移動先 */
function NavItem({ to, icon: Icon, label }: { to: string; icon: typeof Database; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
          isActive
            ? 'bg-accent-soft font-medium text-accent-text'
            : 'text-ink-2 hover:bg-surface-2',
        )
      }
    >
      <Icon size={16} aria-hidden />
      {label}
    </NavLink>
  )
}

/** 段階の中の知らない経路 (段階の頭の画面へのリンクを出す) */
function NotFound() {
  return (
    <>
      <PageHeader title="データの分析" />
      <EmptyState icon={SearchX} title="ページが見つかりません">
        <Link to="/" className="text-accent-text hover:underline">
          データの一覧へ戻る
        </Link>
      </EmptyState>
    </>
  )
}

export function App() {
  const { theme, toggle } = useTheme()
  const { embedded } = useStage()
  return (
    // キーの操作と portal の出し先を, この範囲の中に限る (殻の R9)
    <div data-stage-root className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        本文へ移る
      </a>
      <nav
        aria-label="移動"
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-line bg-surface p-3"
      >
        {/* 殻の下では名前と明暗の切り替えを殻の上の帯が持つ */}
        {!embedded && (
          <div className="mb-3 flex items-center justify-between px-2">
            <span className="flex items-center gap-2 text-base font-semibold">
              <Telescope size={20} className="text-accent" aria-hidden />
              ML-Fathom
            </span>
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === 'dark' ? '明るい表示にする' : '暗い表示にする'}
              className="rounded p-1 text-ink-3 hover:bg-surface-2"
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        )}
        <NavItem to="/" icon={FolderInput} label="データ" />
        <NavItem to="/datasets" icon={Database} label="データセット" />
      </nav>
      <main id="main" className="min-w-0 flex-1 overflow-auto px-8 py-6">
        <Routes>
          <Route path="/" element={<SourcesPage />} />
          <Route path="/sources/:id" element={<SourcePage />} />
          <Route path="/datasets" element={<DatasetsPage />} />
          <Route path="/datasets/export" element={<PairExportPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  )
}
