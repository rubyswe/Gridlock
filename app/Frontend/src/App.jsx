import { useEffect, useState, useCallback } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup, useMap } from 'react-leaflet'
import './App.css'

const API_BASE = 'http://127.0.0.1:8000'

const UTILITY_COLOR = { FPL: '#0057b8', 'Duke Energy Florida': '#e8702a' }
const SEVERITY_COLOR = {
  high: '#d1233d',
  'medium-spatial': '#e8702a',
  'medium-temporal': '#c99a06',
}

function utilityColor(utility) {
  return UTILITY_COLOR[utility] || '#8a93a8'
}

function severityColor(sev) {
  return SEVERITY_COLOR[sev] || '#8a93a8'
}

// Small helper component so we can call map.fitBounds() imperatively
// whenever the selected conflict changes.
function FlyToConflict({ conflict }) {
  const map = useMap()
  useEffect(() => {
    if (!conflict) return
    const bounds = [
      [conflict.project_a.lat, conflict.project_a.lon],
      [conflict.project_b.lat, conflict.project_b.lon],
    ]
    map.fitBounds(bounds, { padding: [60, 60] })
  }, [conflict, map])
  return null
}

function ConflictRow({ overlap, isSelected, onSelect }) {
  return (
    <tr
      className={`conflict-row${isSelected ? ' selected' : ''}`}
      onClick={() => onSelect(overlap)}
    >
      <td>
        <span className={`badge ${overlap.severity}`}>
          {overlap.severity.replace('-', ' ')}
        </span>
      </td>
      <td>
        <div className="proj-name">{overlap.project_a.name}</div>
        <div className="proj-util">{overlap.project_a.utility}</div>
        <div className="proj-name" style={{ marginTop: 6 }}>
          {overlap.project_b.name}
        </div>
        <div className="proj-util">{overlap.project_b.utility}</div>
      </td>
      <td>{overlap.distance_miles} mi</td>
    </tr>
  )
}

export default function App() {
  const [projects, setProjects] = useState([])
  const [overlaps, setOverlaps] = useState([])
  const [selected, setSelected] = useState(null)
  const [status, setStatus] = useState({ text: 'Connecting to API…', error: false })

  const loadData = useCallback(async () => {
    try {
      const [projectsRes, overlapsRes] = await Promise.all([
        fetch(`${API_BASE}/projects`),
        fetch(`${API_BASE}/overlaps`),
      ])
      if (!projectsRes.ok || !overlapsRes.ok) throw new Error('API returned an error')

      const projectsData = await projectsRes.json()
      const overlapsData = await overlapsRes.json()

      setProjects(projectsData)
      setOverlaps(overlapsData.overlaps)
      setStatus({
        text: `Loaded ${projectsData.length} projects, ${overlapsData.count} conflicts`,
        error: false,
      })
    } catch (err) {
      setStatus({
        text: `Could not reach API at ${API_BASE} — is the backend running?`,
        error: true,
      })
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  return (
    <div className="app">
      <header>
        <h1>GridLock</h1>
        <span className="subtitle">Cross-utility construction conflict detector</span>
        <span className={`status${status.error ? ' error' : ''}`}>{status.text}</span>
      </header>

      <div className="layout">
        <div>
          <MapContainer
            center={[27.8, -81.0]}
            zoom={6.4}
            style={{ height: 480 }}
            className="map"
          >
            <TileLayer
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="&copy; OpenStreetMap contributors"
              maxZoom={19}
            />

            {projects.map((p) => (
              <CircleMarker
                key={p.project_id}
                center={[p.lat, p.lon]}
                radius={7}
                pathOptions={{
                  color: utilityColor(p.utility),
                  fillColor: utilityColor(p.utility),
                  fillOpacity: 0.85,
                  weight: 2,
                }}
              >
                <Popup>
                  <strong>{p.name}</strong>
                  <br />
                  {p.utility}
                  <br />
                  {p.start_date} → {p.end_date}
                </Popup>
              </CircleMarker>
            ))}

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

            <FlyToConflict conflict={selected} />
          </MapContainer>

          <div className="legend">
            <span>
              <span className="dot" style={{ background: 'var(--fpl-color)' }} /> FPL
            </span>
            <span>
              <span className="dot" style={{ background: 'var(--def-color)' }} /> Duke
              Energy Florida
            </span>
            <span>
              <span className="dot" style={{ background: 'var(--high)' }} /> High-priority
              conflict line
            </span>
          </div>
        </div>

        <div className="panel">
          <h2>Flagged Conflicts</h2>
          <div className="count">
            {overlaps.length === 0
              ? status.error
                ? ''
                : 'No conflicts found'
              : `${overlaps.length} flagged pair${overlaps.length === 1 ? '' : 's'}`}
          </div>

          {overlaps.length === 0 ? (
            <div className="empty">
              {status.error
                ? 'Start the FastAPI backend (uvicorn app.main:app --reload) then refresh this page.'
                : 'No overlapping projects detected with current thresholds.'}
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Projects</th>
                  <th>Distance</th>
                </tr>
              </thead>
              <tbody>
                {overlaps.map((o) => (
                  <ConflictRow
                    key={`${o.project_a.id}-${o.project_b.id}`}
                    overlap={o}
                    isSelected={selected === o}
                    onSelect={setSelected}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
