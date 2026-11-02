import { useEffect, useState } from 'react'
import { api, errorText, maybeApi } from '../lib/api'
import { fromForm, toForm, type SettingsForm } from '../lib/settingsForm'

type ListKey = 'exclusions' | 'personalFolders' | 'scanTargets'
type NumberKey = 'trackFileMinMB' | 'staleMinMB' | 'staleAgeMonths' | 'tempMinAgeHours' | 'idleDays'

const LISTS: { key: ListKey; label: string; help: string }[] = [
  { key: 'scanTargets', label: 'Scan targets', help: 'Drives or folders Stash scans.' },
  {
    key: 'exclusions',
    label: 'Exclusions',
    help: 'Stash never suggests cleaning anything inside these.'
  },
  {
    key: 'personalFolders',
    label: 'Personal folders',
    help: 'Extra folders to check for duplicates and stale files.'
  }
]

const NUMBERS: { key: NumberKey; label: string; unit: string; step: string }[] = [
  { key: 'trackFileMinMB', label: 'List files from', unit: 'MB', step: 'any' },
  { key: 'staleMinMB', label: 'Stale files from', unit: 'MB', step: 'any' },
  { key: 'staleAgeMonths', label: 'Stale after', unit: 'months', step: '1' },
  { key: 'tempMinAgeHours', label: 'Temp files older than', unit: 'hours', step: '1' },
  { key: 'idleDays', label: 'Projects idle for', unit: 'days', step: '1' }
]

export default function Settings(): React.JSX.Element {
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const stash = maybeApi()
    if (!stash) return
    let alive = true
    stash
      .getSettings()
      .then((s) => alive && setForm(toForm(s)))
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [])

  if (!form) {
    return (
      <div className="screen">
        <h1>Settings</h1>
        {error && <div className="error">{error}</div>}
      </div>
    )
  }

  const edit = (next: SettingsForm): void => {
    setForm(next)
    setSaved(false)
  }

  const addFolder = (key: ListKey): void => {
    api()
      .pickFolder()
      .then((path) => {
        if (path && !form[key].some((p) => p.toLowerCase() === path.toLowerCase()))
          edit({ ...form, [key]: [...form[key], path] })
      })
      .catch((e) => setError(errorText(e)))
  }

  const save = (): void => {
    setError(null)
    api()
      .saveSettings(fromForm(form))
      .then((s) => {
        setForm(toForm(s))
        setSaved(true)
      })
      .catch((e) => setError(errorText(e)))
  }

  return (
    <div className="screen">
      <h1>Settings</h1>
      {LISTS.map(({ key, label, help }) => (
        <section className="card" key={key} aria-label={label}>
          <h2>{label}</h2>
          <p className="muted">{help}</p>
          <ul className="editable-list">
            {form[key].map((path) => (
              <li key={path}>
                <span>{path}</span>
                <button
                  aria-label={`Remove ${path}`}
                  onClick={() => edit({ ...form, [key]: form[key].filter((p) => p !== path) })}
                >
                  Remove
                </button>
              </li>
            ))}
            {form[key].length === 0 && <li className="muted">None</li>}
          </ul>
          <button onClick={() => addFolder(key)}>Add folder</button>
        </section>
      ))}

      <section className="card" aria-label="Thresholds">
        <h2>Thresholds</h2>
        {NUMBERS.map(({ key, label, unit, step }) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              type="number"
              min="0"
              step={step}
              value={Number.isNaN(form[key]) ? '' : form[key]}
              onChange={(e) => edit({ ...form, [key]: e.target.valueAsNumber })}
            />
            <span className="muted">{unit}</span>
          </label>
        ))}
      </section>

      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="primary" onClick={save}>
          Save
        </button>
        {saved && <span className="muted">Saved.</span>}
      </div>
    </div>
  )
}
