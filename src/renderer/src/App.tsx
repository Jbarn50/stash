import { useState } from 'react'
import mark from './assets/stash-mark.png'
import UndoBar from './components/UndoBar'
import { useSession } from './lib/useSession'
import Cleanup from './screens/Cleanup'
import Explore from './screens/Explore'
import History from './screens/History'
import Overview from './screens/Overview'
import Projects from './screens/Projects'
import Settings from './screens/Settings'

const TABS = ['Overview', 'Explore', 'Cleanup', 'History', 'Settings'] as const
type Tab = (typeof TABS)[number]

function App(): React.JSX.Element {
  const session = useSession()
  const [module, setModule] = useState<'space' | 'projects'>('space')
  const [tab, setTab] = useState<Tab>('Overview')
  const [undoTick, setUndoTick] = useState(0)
  const bumpUndo = (): void => setUndoTick((n) => n + 1)

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Modules">
        <div className="brand">
          <img className="brand-mark" src={mark} alt="" />
          Stash
        </div>
        <button
          className="module"
          aria-current={module === 'space' ? 'page' : undefined}
          onClick={() => setModule('space')}
        >
          Space
        </button>
        <button
          className="module"
          aria-current={module === 'projects' ? 'page' : undefined}
          onClick={() => setModule('projects')}
        >
          Projects
        </button>
      </nav>
      <main className="content">
        <UndoBar refreshKey={undoTick} onDone={bumpUndo} />
        {module === 'space' && (
          <>
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            {tab === 'Overview' && <Overview session={session} />}
            {tab === 'Explore' && (
              <Explore key={session.summary?.scanId ?? 'none'} summary={session.summary} />
            )}
            {tab === 'Cleanup' && (
              <Cleanup
                key={session.summary?.scanId ?? 'none'}
                session={session}
                onCleaned={bumpUndo}
              />
            )}
            {tab === 'History' && <History onRestored={bumpUndo} />}
            {tab === 'Settings' && <Settings />}
          </>
        )}
        {module === 'projects' && <Projects />}
      </main>
    </div>
  )
}

export default App
