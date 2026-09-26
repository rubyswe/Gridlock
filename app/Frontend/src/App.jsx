import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup, useMap } from 'react-leaflet'
import Insights from './Charts'
import CalendarView from './CalendarView'
import { DetectionSettings, EMPTY_FILTERS, FilterBar } from './Controls'
import {
  API_BASE,
  CLEAR_COLOR,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  buildConflictIndex,
  formatDate,
  formatMoney,
  loadPref,
  overlapKey,
  projectInScope,
  savePref,
  severityColor,
  utilityColor,
} from './utils'
import './App.css'

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Small helper component so we can move the map imperatively whenever the
// selected conflict or project changes.
function FlyTo({ conflict, project }) {
  const map = useMap()
  useEffect(() => {
    if (conflict) {
      map.fitBounds(
        [
          [conflict.project_a.lat, conflict.project_a.lon],
          [conflict.project_b.lat, conflict.project_b.lon],
        ],
        { padding: [60, 60], maxZoom: 11 },
      )
    } else if (project) {
      map.flyTo([project.lat, project.lon], 10, { duration: 0.8 })
    }
  }, [conflict, project, map])
  return null
}

function ExplainButton({ overlap }) {
  const [explanation, setExplanation] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const fetchExplanation = async (e) => {
    e.stopPropagation() // don't trigger the row's onClick (map highlight)
    setLoading(true)
    setError(false)
    try {
      const res = await fetch(`${API_BASE}/overlaps/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overlap),
      })
      const data = await res.json()
      setError(Boolean(data.error))
      setExplanation(data.explanation)
    } catch {
      setError(true)
      setExplanation('Could not reach the AI explain endpoint.')
    } finally {
      setLoading(false)
    }
  }

  if (explanation) {
    return <div className={`explanation${error ? ' error' : ''}`}>{explanation}</div>
  }

  return (
    <button className="explain-btn" onClick={fetchExplanation} disabled={loading}>
      {loading ? 'Thinking…' : 'Explain with AI'}
    </button>
  )
}

function DeleteButton({ project, onDelete, label = 'Delete' }) {
  if (!project || project.is_seed !== false) return null
  return (
    <button
      className="delete-btn"
      title={`Delete ${project.name}`}
      onClick={(e) => {
        e.stopPropagation()
        onDelete(project)
      }}
    >
      {label}
    </button>
  )
}

function ConflictRow({ overlap, isSelected, onSelect, projectsById, onDelete }) {
  const savings = formatMoney(overlap.potential_savings)
  const relocation = formatMoney(overlap.relocation_savings)

  return (
    <li className={`list-row${isSelected ? ' selected' : ''}`} onClick={() => onSelect(overlap)}>
      <div className="row-top">
        <span className={`badge ${overlap.severity}`}>{SEVERITY_LABEL[overlap.severity]}</span>
        <span className="distance">{overlap.distance_miles} mi apart</span>
      </div>

      {[overlap.project_a, overlap.project_b].map((p) => (
        <div className="pair-proj" key={p.id}>
          <span className="dot" style={{ background: utilityColor(p.utility) }} />
          <div>
            <div className="proj-name">{p.name}</div>
            <div className="proj-util">
              {p.utility} · {formatDate(p.start_date)} → {formatDate(p.end_date)}
            </div>
          </div>
          <DeleteButton project={projectsById.get(p.id)} onDelete={onDelete} label="×" />
        </div>
      ))}

      {(savings || relocation) && (
        <div className="savings">
          {savings && (
            <div>
              <span className="savings-label">Est. budget overhead avoided:</span> {savings}
            </div>
          )}
          {relocation && (
            <div>
              <span className="savings-label">Est. relocation cost avoided:</span> {relocation}
            </div>
          )}
        </div>
      )}

      <ExplainButton overlap={overlap} />
    </li>
  )
}

function ClearRow({ project, nearest, isSelected, onSelect, onDelete }) {
  return (
    <li className={`list-row${isSelected ? ' selected' : ''}`} onClick={() => onSelect(project)}>
      <div className="row-top">
        <span className="badge clear">✓ No conflict</span>
        {project.estimated_cost != null && <span className="distance">{formatMoney(project.estimated_cost)}</span>}
      </div>
      <div className="pair-proj">
        <span className="dot" style={{ background: utilityColor(project.utility) }} />
        <div>
          <div className="proj-name">{project.name}</div>
          <div className="proj-util">
            {project.utility} · {formatDate(project.start_date)} → {formatDate(project.end_date)}
          </div>
        </div>
        <DeleteButton project={project} onDelete={onDelete} label="×" />
      </div>
      {nearest && (
        <div className="clear-reason">
          Nearest other-utility project: <strong>{nearest.name}</strong>, {Math.round(nearest.distance)} mi away
        </div>
      )}
    </li>
  )
}

const EMPTY_FORM = {
  project_id: '',
  utility: 'FPL',
  name: '',
  lat: '',
  lon: '',
  start_date: '',
  end_date: '',
  estimated_cost: '',
}

function NewProjectForm({ onCreated }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [status, setStatus] = useState(null)
  const [errorText, setErrorText] = useState('')

  const update = (field) => (e) => setForm({ ...form, [field]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    if (form.end_date < form.start_date) {
      setStatus('error')
      setErrorText('End date must be on or after the start date.')
      return
    }
    setStatus('saving')
    try {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          lat: parseFloat(form.lat),
          lon: parseFloat(form.lon),
          estimated_cost: form.estimated_cost ? parseFloat(form.estimated_cost) : null,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const detail = typeof data.detail === 'string' ? data.detail : data.detail?.[0]?.msg
        throw new Error(detail || 'Check the fields and try again.')
      }
      setStatus('done')
      setForm(EMPTY_FORM)
      onCreated()
    } catch (err) {
      setStatus('error')
      setErrorText(err.message === 'Failed to fetch' ? 'Could not reach the API.' : err.message)
    }
  }

  if (!open) {
    return (
      <button className="new-project-toggle" onClick={() => setOpen(true)}>
        + Add hypothetical project
      </button>
    )
  }

  return (
    <form className="new-project-form" onSubmit={submit}>
      <div className="form-row">
        <input placeholder="Project ID (e.g. TEST-001)" value={form.project_id} onChange={update('project_id')} required />
        <select value={form.utility} onChange={update('utility')}>
          <option value="FPL">FPL</option>
          <option value="Duke Energy Florida">Duke Energy Florida</option>
        </select>
      </div>
      <input placeholder="Project name" value={form.name} onChange={update('name')} required />
      <div className="form-row">
        <input type="number" step="any" min="-90" max="90" placeholder="Latitude" value={form.lat} onChange={update('lat')} required />
        <input type="number" step="any" min="-180" max="180" placeholder="Longitude" value={form.lon} onChange={update('lon')} required />
      </div>
      <div className="form-row">
        <label className="date-field">
          Start
          <input type="date" value={form.start_date} onChange={update('start_date')} required />
        </label>
        <label className="date-field">
          End
          <input type="date" value={form.end_date} onChange={update('end_date')} required />
        </label>
      </div>
      <input type="number" min="0" placeholder="Estimated cost (optional)" value={form.estimated_cost} onChange={update('estimated_cost')} />
      <div className="form-row">
        <button type="submit" disabled={status === 'saving'}>
          {status === 'saving' ? 'Adding…' : 'Add project'}
        </button>
        <button type="button" className="cancel-btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {status === 'error' && <div className="form-error">{errorText}</div>}
      {status === 'done' && <div className="form-ok">Project added — conflicts recalculated.</div>}
    </form>
  )
}

function HypotheticalList({ projects, conflictIndex, onDelete, onSelect }) {
  if (projects.length === 0) return null
  return (
    <div className="hypo-list">
      <h3>Your hypothetical projects ({projects.length})</h3>
      <ul>
        {projects.map((p) => {
          const entry = conflictIndex.get(p.project_id)
          return (
            <li key={p.project_id} onClick={() => onSelect(p)}>
              <span className="dot" style={{ background: utilityColor(p.utility) }} />
              <div className="hypo-main">
                <div className="proj-name">{p.name}</div>
                <div className="proj-util">
                  {p.project_id} · {formatDate(p.start_date)} → {formatDate(p.end_date)}
                </div>
              </div>
              {entry ? (
                <span className={`badge ${entry.worst}`}>
                  {entry.overlaps.length} conflict{entry.overlaps.length === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="badge clear">✓ Clear</span>
              )}
              <DeleteButton project={p} onDelete={onDelete} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'insights', label: 'Insights' },
  { id: 'calendar', label: 'Calendar' },
]

export default function App() {
  const [projects, setProjects] = useState([])
  const [overlaps, setOverlaps] = useState([])
  const [tab, setTab] = useState('map')
  const [view, setView] = useState('conflicts') // 'conflicts' | 'clear'
  const [selectedKey, setSelectedKey] = useState(null)
  const [focusId, setFocusId] = useState(null)
  const [status, setStatus] = useState({ text: 'Connecting to API…', error: false })
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState(() => loadPref('filters', EMPTY_FILTERS))
  const [defaults, setDefaults] = useState(null)
  const [thresholds, setThresholds] = useState(() => loadPref('thresholds', null))
  const requestId = useRef(0)

  useEffect(() => savePref('filters', filters), [filters])
  useEffect(() => {
    if (thresholds) savePref('thresholds', thresholds)
  }, [thresholds])

  // Default thresholds come from the backend so there's one source of truth.
  useEffect(() => {
    fetch(`${API_BASE}/settings/defaults`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setDefaults(d)
        setThresholds((t) => t || d)
      })
      .catch(() => setStatus({ text: `Could not reach API at ${API_BASE} — is the backend running?`, error: true }))
  }, [])

  const loadData = useCallback(async () => {
    if (!thresholds) return
    // Ignore responses that arrive after a newer request was sent (e.g. while
    // dragging a threshold slider).
    const id = ++requestId.current
    setLoading(true)
    try {
      const params = new URLSearchParams(Object.entries(thresholds).map(([k, v]) => [k, String(v)]))
      const [projectsRes, overlapsRes] = await Promise.all([
        fetch(`${API_BASE}/projects`),
        fetch(`${API_BASE}/overlaps?${params}`),
      ])
      if (!projectsRes.ok || !overlapsRes.ok) throw new Error('API returned an error')

      const projectsData = await projectsRes.json()
      const overlapsData = await overlapsRes.json()
      if (id !== requestId.current) return

      setProjects(projectsData)
      setOverlaps(overlapsData.overlaps)
      setStatus({
        text: `Loaded ${projectsData.length} projects, ${overlapsData.count} conflicts`,
        error: false,
      })
    } catch {
      if (id !== requestId.current) return
      setStatus({
        text: `Could not reach API at ${API_BASE} — is the backend running?`,
        error: true,
      })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [thresholds])

  // Debounced so dragging a slider doesn't fire a request per pixel.
  useEffect(() => {
    const t = setTimeout(loadData, 250)
    return () => clearTimeout(t)
  }, [loadData])

  const deleteProject = async (p) => {
    if (!window.confirm(`Delete "${p.name}" (${p.project_id})? This can't be undone.`)) return
    try {
      const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(p.project_id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || 'Delete failed')
      }
      if (focusId === p.project_id) setFocusId(null)
      setSelectedKey((k) => (k && k.split('|').includes(p.project_id) ? null : k))
      loadData()
    } catch (err) {
      window.alert(err.message === 'Failed to fetch' ? 'Could not reach the API.' : err.message)
    }
  }

  // Conflict status is always computed from ALL overlaps, so filtering the
  // view never turns a conflicted project into a "clear" one.
  const conflictIndex = useMemo(() => buildConflictIndex(overlaps), [overlaps])
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.project_id, p])), [projects])
  const utilities = useMemo(() => [...new Set(projects.map((p) => p.utility))].sort(), [projects])

  const scopedProjects = useMemo(() => projects.filter((p) => projectInScope(p, filters)), [projects, filters])
  const scopedOverlaps = useMemo(() => {
    const ids = new Set(scopedProjects.map((p) => p.project_id))
    return overlaps.filter((o) => ids.has(o.project_a.id) || ids.has(o.project_b.id))
  }, [overlaps, scopedProjects])
  const scopedConflictCount = useMemo(
    () => scopedProjects.filter((p) => conflictIndex.has(p.project_id)).length,
    [scopedProjects, conflictIndex],
  )
  const hypotheticals = useMemo(() => projects.filter((p) => p.is_seed === false), [projects])

  // Conflict-free projects, each with the nearest project from another
  // utility so the user can see *why* it's clear.
  const clearProjects = useMemo(
    () =>
      scopedProjects
        .filter((p) => !conflictIndex.has(p.project_id))
        .map((p) => {
          let nearest = null
          for (const q of projects) {
            if (q.utility === p.utility) continue
            const distance = haversineMiles(p.lat, p.lon, q.lat, q.lon)
            if (!nearest || distance < nearest.distance) nearest = { name: q.name, distance }
          }
          return { project: p, nearest }
        })
        .sort((a, b) => a.project.start_date.localeCompare(b.project.start_date)),
    [projects, scopedProjects, conflictIndex],
  )

  const selected = overlaps.find((o) => overlapKey(o) === selectedKey) || null
  const focusProject = projects.find((p) => p.project_id === focusId) || null

  const selectConflict = (o) => {
    setSelectedKey(overlapKey(o))
    setFocusId(null)
  }
  const selectProject = (p) => {
    setFocusId(p.project_id)
    setSelectedKey(null)
  }
  const switchView = (v) => {
    setView(v)
    setSelectedKey(null)
    setFocusId(null)
  }
  const showConflictOnMap = (o) => {
    setTab('map')
    setView('conflicts')
    selectConflict(o)
  }

  return (
    <div className="app">
      <header>
        <h1>GridLock</h1>
        <span className="subtitle">Cross-utility construction conflict detector</span>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className={`status${status.error ? ' error' : ''}`}>{status.text}</span>
      </header>

      <div className="ferc-banner">
        Utilities have historically planned construction in isolation, leading to waste
        and delays. FERC Order 1920 (2024) now requires regional transmission planners to
        coordinate — GridLock is a visibility layer for exactly that.
      </div>

      <div className="controls">
        <FilterBar
          utilities={utilities}
          filters={filters}
          onChange={setFilters}
          shownCount={scopedProjects.length}
          totalCount={projects.length}
        />
        {thresholds && (
          <DetectionSettings thresholds={thresholds} defaults={defaults} onChange={setThresholds} loading={loading} />
        )}
      </div>

      {status.error && (
        <div className="api-error">
          Start the FastAPI backend from the <code>app</code> folder (<code>uvicorn main:app --reload</code>) then refresh this page.
        </div>
      )}

      {tab === 'map' && (
        <div className="layout">
          <div>
            <MapContainer center={[27.8, -81.0]} zoom={6.4} style={{ height: 520 }} className="map">
              <TileLayer
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
                maxZoom={19}
              />

              {scopedProjects.map((p) => {
                const entry = conflictIndex.get(p.project_id)
                const inView = view === 'conflicts' ? Boolean(entry) : !entry
                const ring = entry ? severityColor(entry.worst) : CLEAR_COLOR
                return (
                  <CircleMarker
                    key={p.project_id}
                    center={[p.lat, p.lon]}
                    radius={p.project_id === focusId ? 11 : 8}
                    eventHandlers={{ click: () => selectProject(p) }}
                    pathOptions={{
                      color: ring,
                      fillColor: utilityColor(p.utility),
                      fillOpacity: inView ? 0.9 : 0.2,
                      opacity: inView ? 1 : 0.25,
                      weight: 3,
                    }}
                  >
                    <Popup>
                      <strong>{p.name}</strong>
                      <br />
                      {p.utility}
                      <br />
                      {formatDate(p.start_date)} → {formatDate(p.end_date)}
                      {p.estimated_cost != null && (
                        <>
                          <br />
                          {formatMoney(p.estimated_cost)}
                        </>
                      )}
                      <br />
                      {entry ? (
                        <span style={{ color: severityColor(entry.worst) }}>
                          ⚠ In {entry.overlaps.length} conflict{entry.overlaps.length === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span style={{ color: CLEAR_COLOR }}>✓ No conflicts</span>
                      )}
                      {p.is_seed === false && (
                        <div className="popup-actions">
                          <DeleteButton project={p} onDelete={deleteProject} label="Delete project" />
                        </div>
                      )}
                    </Popup>
                  </CircleMarker>
                )
              })}

              {selected && (
                <Polyline
                  positions={[
                    [selected.project_a.lat, selected.project_a.lon],
                    [selected.project_b.lat, selected.project_b.lon],
                  ]}
                  pathOptions={{
                    color: severityColor(selected.severity),
                    weight: 3,
                    dashArray: selected.severity === 'high' ? null : '6 6',
                  }}
                />
              )}

              <FlyTo conflict={selected} project={focusProject} />
            </MapContainer>

            <div className="legend">
              <span>
                <span className="dot" style={{ background: 'var(--fpl-color)' }} /> FPL
              </span>
              <span>
                <span className="dot" style={{ background: 'var(--def-color)' }} /> Duke Energy Florida
              </span>
              <span>Ring color:</span>
              <span>
                <span className="ring" style={{ borderColor: SEVERITY_COLOR.high }} /> High
              </span>
              <span>
                <span className="ring" style={{ borderColor: SEVERITY_COLOR['medium-spatial'] }} /> Same area
              </span>
              <span>
                <span className="ring" style={{ borderColor: SEVERITY_COLOR['medium-temporal'] }} /> Same timeframe
              </span>
              <span>
                <span className="ring" style={{ borderColor: CLEAR_COLOR }} /> No conflict
              </span>
            </div>

            <NewProjectForm onCreated={loadData} />
            <HypotheticalList
              projects={hypotheticals}
              conflictIndex={conflictIndex}
              onDelete={deleteProject}
              onSelect={selectProject}
            />
          </div>

          <div className="panel">
            <div className="segmented" role="tablist">
              <button
                role="tab"
                aria-selected={view === 'conflicts'}
                className={`seg conflicts${view === 'conflicts' ? ' active' : ''}`}
                onClick={() => switchView('conflicts')}
              >
                ⚠ Conflicts <span className="seg-count">{scopedOverlaps.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={view === 'clear'}
                className={`seg clear${view === 'clear' ? ' active' : ''}`}
                onClick={() => switchView('clear')}
              >
                ✓ No conflicts <span className="seg-count">{clearProjects.length}</span>
              </button>
            </div>

            {view === 'conflicts' ? (
              <>
                <div className="count">
                  {scopedOverlaps.length === 0
                    ? status.error
                      ? ''
                      : 'No conflicts found'
                    : `${scopedOverlaps.length} flagged pair${scopedOverlaps.length === 1 ? '' : 's'} involving ${scopedConflictCount} shown project${scopedConflictCount === 1 ? '' : 's'}`}
                </div>
                {scopedOverlaps.length === 0 ? (
                  <div className="empty">
                    {status.error
                      ? 'Waiting for the API…'
                      : 'No overlapping projects detected with the current filters and thresholds.'}
                  </div>
                ) : (
                  <ul className="list">
                    {scopedOverlaps.map((o) => (
                      <ConflictRow
                        key={overlapKey(o)}
                        overlap={o}
                        isSelected={selectedKey === overlapKey(o)}
                        onSelect={selectConflict}
                        projectsById={projectsById}
                        onDelete={deleteProject}
                      />
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <>
                <div className="count">
                  {clearProjects.length} project{clearProjects.length === 1 ? '' : 's'} with no scheduling or location
                  conflicts
                </div>
                {clearProjects.length === 0 ? (
                  <div className="empty">{status.error ? 'Waiting for the API…' : 'No conflict-free projects match the current filters.'}</div>
                ) : (
                  <ul className="list">
                    {clearProjects.map(({ project, nearest }) => (
                      <ClearRow
                        key={project.project_id}
                        project={project}
                        nearest={nearest}
                        isSelected={focusId === project.project_id}
                        onSelect={selectProject}
                        onDelete={deleteProject}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'insights' && (
        <div className="page">
          <Insights projects={scopedProjects} overlaps={scopedOverlaps} conflictIndex={conflictIndex} />
        </div>
      )}

      {tab === 'calendar' && (
        <div className="page">
          <CalendarView
            projects={scopedProjects}
            overlaps={scopedOverlaps}
            conflictIndex={conflictIndex}
            onShowConflict={showConflictOnMap}
          />
        </div>
      )}
    </div>
  )
}
