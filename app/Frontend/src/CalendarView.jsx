import { useMemo, useState } from 'react'
import { ProjectSource } from './Tools'
import {
  CLEAR_COLOR,
  RISK_META,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  formatDate,
  formatRange,
  isActiveOn,
  riskKey,
  toISODate,
  utilityColor,
  utilityLabel,
} from './utils'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Everything the calendar needs to know about one day:
 *  - active: projects under construction that day
 *  - concurrent: flagged conflict pairs where BOTH projects are active that day
 *  - risks: dependency risks (stacked outages, shared road closures) whose
 *           overlap window includes that day
 *  - starts / ends: projects that begin or finish that day
 *  - status: 'conflict' | 'watch' | 'clear' | 'idle'
 *      conflict = two conflicting projects are working at the same time, or
 *                 a dependency risk is active
 *      watch    = a project that's part of some conflict is active, but its
 *                 conflicting partner isn't active that day
 *      clear    = only conflict-free projects are active
 */
function describeDay(iso, projects, overlaps, risks, conflictIndex) {
  const active = projects.filter((p) => isActiveOn(p, iso))
  const concurrent = overlaps.filter((o) => isActiveOn(o.project_a, iso) && isActiveOn(o.project_b, iso))
  const activeRisks = risks.filter((r) => isActiveOn(r, iso))
  const starts = projects.filter((p) => p.start_date === iso)
  const ends = projects.filter((p) => p.end_date === iso)

  let status = 'idle'
  if (concurrent.length || activeRisks.length) status = 'conflict'
  else if (active.some((p) => conflictIndex.has(p.project_id))) status = 'watch'
  else if (active.length) status = 'clear'

  return { iso, active, concurrent, risks: activeRisks, starts, ends, status }
}

function monthGrid(year, month) {
  const first = new Date(year, month, 1)
  const cells = []
  // Leading days from the previous month so the grid starts on Sunday
  for (let i = first.getDay(); i > 0; i--) cells.push(new Date(year, month, 1 - i))
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1]
    cells.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1))
  }
  return cells
}

const STATUS_META = {
  conflict: { label: 'Conflicting work happening at the same time', short: 'Conflict', color: SEVERITY_COLOR.high },
  watch: { label: 'Conflict-flagged project active (partner not active)', short: 'Watch', color: SEVERITY_COLOR['medium-temporal'] },
  clear: { label: 'Only conflict-free projects active', short: 'Clear', color: CLEAR_COLOR },
  idle: { label: 'No construction', short: 'Idle', color: 'transparent' },
}

export default function CalendarView({ projects, overlaps, risks, conflictIndex, onShowConflict, onShowRisk }) {
  const today = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() })
  const [selectedIso, setSelectedIso] = useState(toISODate(today))

  const cells = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor])

  const days = useMemo(() => {
    const map = new Map()
    for (const d of cells) {
      const iso = toISODate(d)
      map.set(iso, describeDay(iso, projects, overlaps, risks, conflictIndex))
    }
    return map
  }, [cells, projects, overlaps, risks, conflictIndex])

  const monthSummary = useMemo(() => {
    const counts = { conflict: 0, watch: 0, clear: 0, idle: 0, risk: 0 }
    for (const d of cells) {
      if (d.getMonth() !== cursor.month) continue
      const info = days.get(toISODate(d))
      counts[info.status] += 1
      if (info.risks.length) counts.risk += 1
    }
    return counts
  }, [cells, days, cursor.month])

  const years = useMemo(() => {
    if (!projects.length) return [today.getFullYear()]
    const lo = Math.min(today.getFullYear(), ...projects.map((p) => +p.start_date.slice(0, 4)))
    const hi = Math.max(today.getFullYear(), ...projects.map((p) => +p.end_date.slice(0, 4)))
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  }, [projects, today])

  const shift = (delta) => {
    const d = new Date(cursor.year, cursor.month + delta, 1)
    setCursor({ year: d.getFullYear(), month: d.getMonth() })
  }

  const goToday = () => {
    setCursor({ year: today.getFullYear(), month: today.getMonth() })
    setSelectedIso(toISODate(today))
  }

  // Jump to the next month (after the current view) that has an active conflict
  const nextConflict = () => {
    for (let i = 1; i <= 12 * 15; i++) {
      const d = new Date(cursor.year, cursor.month + i, 1)
      const monthStart = toISODate(d)
      const monthEnd = toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0))
      const hit = overlaps.some((o) => {
        const s = o.project_a.start_date > o.project_b.start_date ? o.project_a.start_date : o.project_b.start_date
        const e = o.project_a.end_date < o.project_b.end_date ? o.project_a.end_date : o.project_b.end_date
        return s <= e && s <= monthEnd && e >= monthStart
      })
      if (hit) {
        setCursor({ year: d.getFullYear(), month: d.getMonth() })
        return
      }
    }
  }

  const selected = selectedIso && (days.get(selectedIso) || describeDay(selectedIso, projects, overlaps, risks, conflictIndex))
  const todayIso = toISODate(today)

  return (
    <div className="calendar-layout">
      <div className="calendar-card">
        <div className="cal-toolbar">
          <div className="cal-nav">
            <button onClick={() => shift(-1)} aria-label="Previous month">‹</button>
            <button onClick={() => shift(1)} aria-label="Next month">›</button>
            <h2>
              {MONTHS[cursor.month]} {cursor.year}
            </h2>
          </div>
          <div className="cal-nav">
            <select
              value={cursor.month}
              onChange={(e) => setCursor({ ...cursor, month: +e.target.value })}
              aria-label="Month"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={cursor.year}
              onChange={(e) => setCursor({ ...cursor, year: +e.target.value })}
              aria-label="Year"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button onClick={goToday}>Today</button>
            <button onClick={nextConflict}>Next conflict →</button>
          </div>
        </div>

        <div className="cal-summary">
          {['conflict', 'watch', 'clear'].map((s) => (
            <span key={s} className="cal-summary-item">
              <span className="dot" style={{ background: STATUS_META[s].color }} />
              {STATUS_META[s].short}: <strong>{monthSummary[s]}</strong> day{monthSummary[s] === 1 ? '' : 's'}
            </span>
          ))}
          <span className="cal-summary-item">
            ⚡🚧 Dependency risk: <strong>{monthSummary.risk}</strong> day{monthSummary.risk === 1 ? '' : 's'}
          </span>
        </div>

        <div className="cal-grid">
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-weekday">
              {w}
            </div>
          ))}
          {cells.map((d) => {
            const iso = toISODate(d)
            const info = days.get(iso)
            const outside = d.getMonth() !== cursor.month
            const conflictedActive = info.active.filter((p) => conflictIndex.has(p.project_id)).length
            const clearActive = info.active.length - conflictedActive
            return (
              <button
                key={iso}
                className={`cal-day status-${info.status}${outside ? ' outside' : ''}${iso === selectedIso ? ' selected' : ''}${iso === todayIso ? ' today' : ''}`}
                onClick={() => setSelectedIso(iso)}
                title={`${formatDate(iso)} — ${STATUS_META[info.status].label}`}
              >
                <span className="cal-date">{d.getDate()}</span>
                {info.status !== 'idle' && (
                  <span className="cal-chips">
                    {info.concurrent.length > 0 && (
                      <span className="chip chip-conflict">
                        ⚠ {info.concurrent.length}
                        <span className="chip-word"> conflict{info.concurrent.length === 1 ? '' : 's'}</span>
                      </span>
                    )}
                    {info.risks.map((r) => (
                      <span key={riskKey(r)} className="chip chip-risk" title={RISK_META[r.type].label}>
                        {RISK_META[r.type].icon}
                        <span className="chip-word"> {r.type === 'road' ? r.road : 'outages'}</span>
                      </span>
                    ))}
                    {conflictedActive > 0 && info.concurrent.length === 0 && (
                      <span className="chip chip-watch">
                        ● {conflictedActive}
                        <span className="chip-word"> flagged</span>
                      </span>
                    )}
                    {clearActive > 0 && (
                      <span className="chip chip-clear">
                        ✓ {clearActive}
                        <span className="chip-word"> clear</span>
                      </span>
                    )}
                  </span>
                )}
                {(info.starts.length > 0 || info.ends.length > 0) && (
                  <span className="cal-events">
                    {info.starts.length > 0 && <span title="Project starts">▶{info.starts.length}</span>}
                    {info.ends.length > 0 && <span title="Project ends">■{info.ends.length}</span>}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="legend">
          {['conflict', 'watch', 'clear'].map((s) => (
            <span key={s}>
              <span className="dot" style={{ background: STATUS_META[s].color }} /> {STATUS_META[s].label}
            </span>
          ))}
          <span>⚡ stacked outage · 🚧 shared road closure</span>
          <span>▶ project starts · ■ project ends</span>
        </div>
      </div>

      <aside className="panel day-panel">
        {selected ? (
          <>
            <h2>{formatDate(selected.iso)}</h2>
            <div className="day-status" style={{ '--status': STATUS_META[selected.status].color }}>
              {STATUS_META[selected.status].label}
            </div>

            {selected.risks.length > 0 && (
              <section>
                <h4>Dependency risks this day ({selected.risks.length})</h4>
                {selected.risks.map((r) => (
                  <button
                    key={riskKey(r)}
                    className="day-conflict day-risk"
                    onClick={() => onShowRisk(r)}
                    title="Show on map"
                  >
                    <span className="badges">
                      <span className="badge risk">
                        {RISK_META[r.type].icon} {RISK_META[r.type].label}
                        {r.type === 'road' ? ` · ${r.road}` : ''}
                      </span>
                      {r.cross_state && <span className="badge cross-state">⇄ Cross-state</span>}
                    </span>
                    <span className="day-conflict-names">
                      {r.project_a.name} <em>and</em> {r.project_b.name}
                    </span>
                    <span className="distance">
                      Overlap {formatRange(r.start_date, r.end_date)} · view on map →
                    </span>
                  </button>
                ))}
              </section>
            )}

            {selected.concurrent.length > 0 && (
              <section>
                <h4>⚠ Conflicts active this day ({selected.concurrent.length})</h4>
                {selected.concurrent.map((o) => (
                  <button
                    key={`${o.project_a.id}|${o.project_b.id}`}
                    className="day-conflict"
                    onClick={() => onShowConflict(o)}
                    title="Show on map"
                  >
                    <span className="badges">
                      <span className={`badge ${o.severity}`}>{SEVERITY_LABEL[o.severity]}</span>
                      {o.cross_state && <span className="badge cross-state">⇄ Cross-state</span>}
                    </span>
                    <span className="day-conflict-names">
                      {o.project_a.name} <em>vs</em> {o.project_b.name}
                    </span>
                    <span className="distance">{o.distance_miles} mi apart · view on map →</span>
                  </button>
                ))}
              </section>
            )}

            <section>
              <h4>Active projects ({selected.active.length})</h4>
              {selected.active.length === 0 ? (
                <div className="empty small">No construction scheduled.</div>
              ) : (
                <ul className="day-projects">
                  {selected.active.map((p) => {
                    const entry = conflictIndex.get(p.project_id)
                    return (
                      <li key={p.project_id}>
                        <span className="dot" style={{ background: utilityColor(p.utility) }} />
                        <div>
                          <div className="proj-name">{p.name}</div>
                          <div className="proj-util">
                            {utilityLabel(p)} · {formatDate(p.start_date)} → {formatDate(p.end_date)}
                          </div>
                          <ProjectSource project={p} />
                        </div>
                        {entry ? (
                          <span className={`badge ${entry.worst}`}>
                            {entry.overlaps.length} conflict{entry.overlaps.length === 1 ? '' : 's'}
                          </span>
                        ) : (
                          <span className="badge clear">✓ Clear</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {(selected.starts.length > 0 || selected.ends.length > 0) && (
              <section>
                <h4>Milestones</h4>
                <ul className="day-milestones">
                  {selected.starts.map((p) => (
                    <li key={`s-${p.project_id}`}>▶ {p.name} starts</li>
                  ))}
                  {selected.ends.map((p) => (
                    <li key={`e-${p.project_id}`}>■ {p.name} ends</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <div className="empty">Pick a day to see what's happening.</div>
        )}
      </aside>
    </div>
  )
}
