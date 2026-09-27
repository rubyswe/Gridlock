import { useRef, useState } from 'react'
import {
  API_BASE,
  IMPORT_COLUMNS,
  IMPORT_TEMPLATE,
  REQUIRED_IMPORT_COLUMNS,
  RISK_META,
  SEVERITY_LABEL,
  THREAD_STATUS,
  THREAD_STATUSES,
  downloadFile,
  formatTimestamp,
  parseCSV,
  projectSource,
  threadFor,
  toCSV,
  toISODate,
  utilityColor,
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
  'coordination_status',
  'agreed_plan',
  'notes',
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

export function exportReport(overlaps, risks, threads = {}) {
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
        ...threadColumns(threadFor(threads, o)),
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

function threadColumns(t) {
  return {
    coordination_status: THREAD_STATUS[t.status]?.label || t.status,
    agreed_plan: t.plan || '',
    notes: t.notes.map((n) => `${n.utility}: ${n.body}`).join(' | '),
  }
}

// ---------- Coordination thread (status + notes between the two utilities) ----------

export function ThreadStatusBadge({ status }) {
  if (!status || status === 'open') return null
  const meta = THREAD_STATUS[status]
  return (
    <span className={`badge thread-${status}`}>
      {meta.icon} {meta.label}
    </span>
  )
}

export function CoordinationThread({ overlap, thread, onChanged }) {
  const utilities = [...new Set([overlap.project_a.utility, overlap.project_b.utility])]
  const [open, setOpen] = useState(false)
  const [utility, setUtility] = useState(utilities[0])
  const [body, setBody] = useState('')
  const [plan, setPlan] = useState(thread.plan || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const base = `${API_BASE}/coordination/${encodeURIComponent(overlap.project_a.id)}/${encodeURIComponent(overlap.project_b.id)}`

  // Always a PUT (status) or POST (note) with a JSON body
  const send = async (url, method, payload) => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(url, {
        method: method === 'PUT' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save')
      }
      await onChanged()
      return true
    } catch (err) {
      setError(err.message === 'Failed to fetch' ? 'Could not reach the API.' : err.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const setStatus = (status) =>
    send(base, 'PUT', { status, plan: status === 'agreed' || status === 'resolved' ? plan || thread.plan : null })
  const savePlan = () => send(base, 'PUT', { status: thread.status, plan })
  const post = async (e) => {
    e.preventDefault()
    if (!body.trim()) return
    if (await send(`${base}/notes`, 'POST', { utility, body })) setBody('')
  }

  const showsPlan = thread.status === 'agreed' || thread.status === 'resolved'

  return (
    // Clicks inside the thread shouldn't re-select the conflict on the map
    <div className="thread" onClick={(e) => e.stopPropagation()}>
      <button className="thread-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>💬 Coordinate with the other utility</span>
        <span className="thread-meta">
          {thread.notes.length} note{thread.notes.length === 1 ? '' : 's'} · {THREAD_STATUS[thread.status].label}
        </span>
        <span className="settings-caret">{open ? '▴' : '▾'}</span>
      </button>

      {!open && showsPlan && thread.plan && <div className="thread-plan-summary">🤝 {thread.plan}</div>}

      {open && (
        <div className="thread-body">
          <div className="thread-status" role="group" aria-label="Coordination status">
            {THREAD_STATUSES.map((s) => (
              <button
                key={s}
                className={`chip-btn${thread.status === s ? ' active' : ''}`}
                aria-pressed={thread.status === s}
                disabled={busy}
                onClick={() => setStatus(s)}
              >
                {THREAD_STATUS[s].icon} {THREAD_STATUS[s].label}
              </button>
            ))}
          </div>

          {showsPlan && (
            <div className="thread-plan">
              <input
                placeholder="What did the utilities agree to? (e.g. shared staging yard, APC outage moved to March)"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              />
              <button className="chip-btn" disabled={busy || plan === (thread.plan || '')} onClick={savePlan}>
                Save plan
              </button>
            </div>
          )}

          {thread.notes.length === 0 ? (
            <div className="thread-empty">No notes yet. Start the conversation below.</div>
          ) : (
            <ul className="thread-notes">
              {thread.notes.map((n) => (
                <li key={n.id}>
                  <div className="thread-note-head">
                    <span className="dot" style={{ background: utilityColor(n.utility) }} />
                    <strong>{n.utility}</strong>
                    <span className="thread-time">{formatTimestamp(n.created_at)}</span>
                  </div>
                  <div className="thread-note-body">{n.body}</div>
                </li>
              ))}
            </ul>
          )}

          <form className="thread-compose" onSubmit={post}>
            <select value={utility} onChange={(e) => setUtility(e.target.value)} aria-label="Post as">
              {utilities.map((u) => (
                <option key={u} value={u}>
                  Post as {u}
                </option>
              ))}
            </select>
            <textarea
              rows={2}
              placeholder="e.g. We can move our February outage to March."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(e)
              }}
            />
            <button className="primary-btn" type="submit" disabled={busy || !body.trim()}>
              {busy ? 'Saving…' : 'Post note'}
            </button>
          </form>
          {error && <div className="form-error">{error}</div>}
        </div>
      )}
    </div>
  )
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
