import { useState } from 'react'
import { useSession } from './lib/useSession'
import Cleanup from './screens/Cleanup'
import Explore from './screens/Explore'
import History from './screens/History'
import Overview from './screens/Overview'
import Settings from './screens/Settings'

const TABS = ['Overview', 'Explore', 'Cleanup', 'History', 'Settings'] as const
type Tab = (typeof TABS)[number]

function App(): React.JSX.Element {
  const session = useSession()
  const [tab, setTab] = useState<Tab>('Overview')

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Modules">
        <div className="brand">Stash</div>
        <button className="module" aria-current="page">
          Space
        </button>
      </nav>
      <main className="content">
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
        {tab === 'Cleanup' && <Cleanup key={session.summary?.scanId ?? 'none'} session={session} />}
        {tab === 'History' && <History />}
        {tab === 'Settings' && <Settings />}
      </main>
    </div>
  )
}

export default App
