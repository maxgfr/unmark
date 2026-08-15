import { useEffect, useState } from 'react'
import { VERSION } from '../core/index.ts'
import { TextTab } from './TextTab.tsx'
import { FilesTab } from './FilesTab.tsx'
import { ImageTab } from './ImageTab.tsx'
import { IconFile, IconImage, IconText } from './icons.tsx'
import { applyUpdate, onServiceWorker, type ServiceWorkerState } from './serviceWorker.ts'

const TABS = [
  { id: 'text', label: 'Text', Icon: IconText },
  { id: 'files', label: 'Files', Icon: IconFile },
  { id: 'image', label: 'Image', Icon: IconImage },
] as const

type TabId = (typeof TABS)[number]['id']

const isTabId = (value: string): value is TabId => TABS.some((tab) => tab.id === value)

/** The hash is the whole router: deep links work with no server rewrite. */
function useHashTab(): [TabId, (next: TabId) => void] {
  const [tab, setTab] = useState<TabId>(() => {
    const fromHash = globalThis.location?.hash.slice(1) ?? ''
    return isTabId(fromHash) ? fromHash : 'text'
  })

  useEffect(() => {
    const sync = () => {
      const fromHash = globalThis.location.hash.slice(1)
      if (isTabId(fromHash)) setTab(fromHash)
    }
    globalThis.addEventListener('hashchange', sync)
    return () => globalThis.removeEventListener('hashchange', sync)
  }, [])

  return [
    tab,
    (next: TabId) => {
      globalThis.location.hash = next
      setTab(next)
    },
  ]
}

export function App() {
  const [tab, setTab] = useHashTab()
  const [worker, setWorker] = useState<ServiceWorkerState>({
    needsRefresh: false,
    offlineReady: false,
  })
  useEffect(() => onServiceWorker(setWorker), [])

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-5 sm:px-8">
      {/* A waiting build never takes over on its own. Reloading under someone
          who has a 28 MB model in memory and a mask half drawn is the one thing
          this app must not decide for itself. */}
      {worker.needsRefresh ? (
        <output className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-[var(--color-rule)] px-4 py-2.5 text-xs">
          <span className="text-[var(--color-muted)]">
            A newer build is downloaded and waiting. Nothing reloads until you say so.
          </span>
          <button
            type="button"
            onClick={applyUpdate}
            className="rounded-md border border-[var(--color-signal)] px-2.5 py-1 text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)]"
          >
            Reload now
          </button>
        </output>
      ) : undefined}

      <header className="grid gap-8 pt-12 pb-8 sm:pt-16 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <h1 className="text-4xl font-bold tracking-[-0.03em] sm:text-5xl">unmark</h1>
          <p className="mt-3 max-w-[62ch] text-[var(--color-muted)]">
            Find, decode and remove watermarks and provenance marks — invisible characters in text,
            metadata in files, watermarks drawn into images. Every mark is named and graded before
            anything is stripped.
          </p>
          <p className="mt-3 max-w-[62ch] text-sm text-[var(--color-muted)]">
            Everything runs in this tab.{' '}
            <span className="text-[var(--color-bone)]">Nothing you give it is uploaded</span> —
            there is no server to upload it to.
          </p>
        </div>

        {/* A report states its own parameters. This is the masthead spec block,
            not a stat row: three facts about the build, set as a definition list. */}
        <dl className="hidden border-l border-[var(--color-rule)] pl-6 font-mono text-xs lg:block">
          {[
            ['build', VERSION],
            ['formats', '17'],
            ['uploads', 'none'],
          ].map(([term, value]) => (
            <div key={term} className="flex gap-6 py-0.5">
              <dt className="w-16 text-[var(--color-muted)]">{term}</dt>
              <dd className="tnum text-[var(--color-bone)]">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <nav className="flex gap-1 border-b border-[var(--color-rule)]" aria-label="Sections">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors duration-150 ${
              tab === id
                ? 'border-[var(--color-signal)] text-[var(--color-bone)]'
                : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-bone)]'
            }`}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>

      <main className="flex-1 py-10">
        {tab === 'text' ? <TextTab /> : undefined}
        {tab === 'files' ? <FilesTab /> : undefined}
        {tab === 'image' ? <ImageTab /> : undefined}
      </main>

      <footer className="border-t border-[var(--color-rule)] py-6 text-xs text-[var(--color-muted)]">
        <p>
          Provenance and metadata hygiene on your own files, and inspecting what is hidden in
          something you were sent. Not certified to defeat any vendor&rsquo;s detector, and not a
          tool for removing authorship marks from work that is not yours.
        </p>
        <p className="mt-2">
          MIT ·{' '}
          <a
            href="https://github.com/maxgfr/unmark"
            className="underline decoration-[var(--color-rule-bright)] underline-offset-4 transition-colors duration-150 hover:text-[var(--color-bone)] hover:decoration-[var(--color-muted)]"
          >
            source
          </a>{' '}
          · run it from a terminal with{' '}
          <code className="font-mono">npx skills add maxgfr/unmark</code>
        </p>
      </footer>
    </div>
  )
}
