import { useRef, useState } from 'react'
import {
  API_BASE,
  IMPORT_COLUMNS,
  IMPORT_TEMPLATE,
  REQUIRED_IMPORT_COLUMNS,
  RISK_META,
  SEVERITY_LABEL,
  downloadFile,
  parseCSV,
  projectSource,
  toCSV,
  toISODate,
} from './utils'

// ---------- Source badge ----------

export function ProjectSource({ project }) {
  if (!project) return null
  const src = projectSource(project)
  if (src.kind === 'link') {
    return (
      <a
        className="source-badge link"
        href={src.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Open the public filing"
      >
        📄 {src.label} ↗
      </a>
    )
  }
  const icon = { synthetic: '◌', upload: '⬆', hypothetical: '✎' }[src.kind]
  const title = {
    synthetic: 'Illustrative project, not from a public filing',
    upload: 'Imported from a CSV file',
    hypothetical: 'Added by hand as a what-if',
  }[src.kind]
  return (
    <span className={`source-badge ${src.kind}`} title={title}>
      {icon} {src.label}
    </span>
  )
}

// ---------- Coordination suggestions ----------

const NOTE_ICON = {
  share: '🤝',
  meet: '📅',
  reuse: '♻️',
  handoff: '🔁',
  outage: '⚡',
  road: '🚧',
  cross_state: '⇄',
}

export function Coordination({ notes }) {
  if (!notes?.length) return null
  return (
    <div className="coordination">
      <div className="coordination-title">How the utilities could coordinate</div>
      <ul>
        {notes.map((n, i) => (
          <li key={i}>
            <span className="coordination-icon" aria-hidden="true">
              {NOTE_ICON[n.kind] || '•'}
            </span>
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- Report export ----------

const REPORT_COLUMNS = [
  'record_type',
  'category',
  'cross_state',
  'project_a_id',
  'project_a_name',
  'project_a_utility',
  'project_a_state',
  'project_a_start',
  'project_a_end',
  'project_b_id',
  'project_b_name',
  'project_b_utility',
  'project_b_state',
  'project_b_start',
  'project_b_end',
  'distance_miles',
  'overlap_start',
  'overlap_end',
  'est_budget_overhead_avoided',
  'est_relocation_cost_avoided',
  'coordination',
]

function pairColumns(x) {
  const out = { cross_state: x.cross_state ? 'yes' : 'no', distance_miles: x.distance_miles }
  for (const [side, p] of [['a', x.project_a], ['b', x.project_b]]) {
    out[`project_${side}_id`] = p.id
    out[`project_${side}_name`] = p.name
    out[`project_${side}_utility`] = p.utility
    out[`project_${side}_state`] = p.state
    out[`project_${side}_start`] = p.start_date
    out[`project_${side}_end`] = p.end_date
  }
  return out
}

export function exportReport(overlaps, risks) {
  const rows = [
    ...overlaps.map((o) => {
      const start = o.project_a.start_date > o.project_b.start_date ? o.project_a.start_date : o.project_b.start_date
      const end = o.project_a.end_date < o.project_b.end_date ? o.project_a.end_date : o.project_b.end_date
      return {
        record_type: 'conflict',
        category: SEVERITY_LABEL[o.severity],
        ...pairColumns(o),
        overlap_start: start <= end ? start : '',
        overlap_end: start <= end ? end : '',
        est_budget_overhead_avoided: o.potential_savings ?? '',
        est_relocation_cost_avoided: o.relocation_savings ?? '',
        coordination: (o.coordination || []).map((n) => n.text).join(' | '),
      }
    }),
    ...risks.map((r) => ({
      record_type: 'dependency_risk',
      category: RISK_META[r.type].label + (r.road ? ` (${r.road})` : ''),
      ...pairColumns(r),
      overlap_start: r.start_date,
      overlap_end: r.end_date,
      coordination: RISK_META[r.type].explain,
    })),
  ]
  downloadFile(`grid-conflict-report-${toISODate(new Date())}.csv`, toCSV(REPORT_COLUMNS, rows))
}

// ---------- Plan import ----------

export function ImportPanel({ onImported }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null) // { name, headers, records }
  const [status, setStatus] = useState(null) // null | 'saving' | 'done' | 'error'
  const [message, setMessage] = useState('')
  const [rowErrors, setRowErrors] = useState([])
  const inputRef = useRef(null)

  const reset = () => {
    setFile(null)
    setStatus(null)
    setMessage('')
    setRowErrors([])
    if (inputRef.current) inputRef.current.value = ''
  }

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    setStatus(null)
    setMessage('')
    setRowErrors([])
    if (!f) return setFile(null)
    const { headers, records } = parseCSV(await f.text())
    setFile({ name: f.name, headers, records })
  }

  const missing = file ? REQUIRED_IMPORT_COLUMNS.filter((c) => !file.headers.includes(c)) : []
  const ignored = file ? file.headers.filter((h) => h && !IMPORT_COLUMNS.includes(h)) : []
  const utilities = file ? [...new Set(file.records.map((r) => r.utility).filter(Boolean))] : []
  const canImport = file && file.records.length > 0 && missing.length === 0 && status !== 'saving'

  const submit = async () => {
    setStatus('saving')
    setRowErrors([])
    try {
      const res = await fetch(`${API_BASE}/projects/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_label: `Uploaded: ${file.name}`, projects: file.records }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail = data.detail
        setRowErrors(Array.isArray(detail?.errors) ? detail.errors : [])
        throw new Error(detail?.message || (typeof detail === 'string' ? detail : 'Import failed'))
      }
      setStatus('done')
      setMessage(`${data.message} from ${file.name}. Conflicts recalculated.`)
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
      onImported()
    } catch (err) {
      setStatus('error')
      setMessage(err.message === 'Failed to fetch' ? 'Could not reach the API.' : err.message)
    }
  }

  if (!open) {
    return (
      <button className="new-project-toggle" onClick={() => setOpen(true)}>
        ⬆ Import a utility's plan (CSV)
      </button>
    )
  }

  return (
    <div className="import-panel">
      <div className="import-head">
        <h3>Import a utility's plan</h3>
        <button
          className="cancel-btn"
          onClick={() => {
            reset()
            setOpen(false)
          }}
        >
          Close
        </button>
      </div>
      <p className="import-help">
        Upload a CSV with one row per planned project. Required columns:{' '}
        <code>{REQUIRED_IMPORT_COLUMNS.join(', ')}</code>. Optional columns add the state, cost, outages, road closures and a
        source link.{' '}
        <button className="link-btn" onClick={() => downloadFile('grid-import-template.csv', IMPORT_TEMPLATE)}>
          Download template
        </button>
      </p>

      <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={onFile} className="file-input" />

      {file && (
        <div className="import-preview">
          <div>
            <strong>{file.name}</strong>: {file.records.length} project{file.records.length === 1 ? '' : 's'}
            {utilities.length > 0 && <> from {utilities.join(', ')}</>}
          </div>
          {missing.length > 0 && <div className="form-error">Missing required columns: {missing.join(', ')}</div>}
          {ignored.length > 0 && <div className="import-note">Ignoring unknown columns: {ignored.join(', ')}</div>}
          {file.records.length === 0 && <div className="form-error">No data rows found.</div>}
          <div className="form-row">
            <button className="primary-btn" disabled={!canImport} onClick={submit}>
              {status === 'saving' ? 'Importing…' : `Import ${file.records.length} project${file.records.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="form-error">
          {message}
          {rowErrors.length > 0 && (
            <ul className="row-errors">
              {rowErrors.map((e) => (
                <li key={`${e.row}-${e.error}`}>
                  Row {e.row}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status === 'done' && <div className="form-ok">{message}</div>}
    </div>
  )
}
