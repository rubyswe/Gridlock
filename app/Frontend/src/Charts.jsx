import { useMemo, useState } from 'react'
import {
  CLEAR_COLOR,
  RISK_META,
  RISK_TYPES,
  SEVERITIES,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  UTILITY_COLOR,
  formatMoney,
  formatRange,
  riskKey,
  utilityColor,
} from './utils'

// ---------- Shared tooltip ----------

function useTooltip() {
  const [tip, setTip] = useState(null)
  const show = (e, content) => setTip({ x: e.clientX, y: e.clientY, content })
  const hide = () => setTip(null)
  const node = tip && (
    <div className="chart-tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
      {tip.content}
    </div>
  )
  return { show, hide, node }
}

function TipBody({ title, rows }) {
  return (
    <>
      <div className="tip-title">{title}</div>
      {rows.map(([label, value, color]) => (
        <div className="tip-row" key={label}>
          {color && <span className="dot" style={{ background: color }} />}
          <span className="tip-label">{label}</span>
          <span className="tip-value">{value}</span>
        </div>
      ))}
    </>
  )
}

function Legend({ items }) {
  return (
    <ul className="chart-legend">
      {items.map((it) => (
        <li key={it.label}>
          <span className="dot" style={{ background: it.color }} />
          <span>{it.label}</span>
          {it.value !== undefined && <span className="legend-value">{it.value}</span>}
        </li>
      ))}
    </ul>
  )
}

// ---------- Donut ----------

function arcPath(cx, cy, rOuter, rInner, a0, a1) {
  const pt = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)]
  const large = a1 - a0 > Math.PI ? 1 : 0
  const [x0, y0] = pt(rOuter, a0)
  const [x1, y1] = pt(rOuter, a1)
  const [x2, y2] = pt(rInner, a1)
  const [x3, y3] = pt(rInner, a0)
  return `M${x0},${y0} A${rOuter},${rOuter} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${rInner},${rInner} 0 ${large} 0 ${x3},${y3} Z`
}

function Donut({ title, subtitle, segments, centerValue, centerLabel, tooltip }) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const size = 180
  const c = size / 2
  let angle = 0

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      {subtitle && <p className="chart-sub">{subtitle}</p>}
      <div className="donut-wrap">
        <svg viewBox={`0 0 ${size} ${size}`} className="donut" role="img" aria-label={title}>
          {total === 0 && <circle cx={c} cy={c} r={70} fill="none" stroke="var(--border)" strokeWidth={24} />}
          {segments.map((s) => {
            if (s.value === 0) return null
            const a0 = angle
            const a1 = angle + (s.value / total) * Math.PI * 2
            angle = a1
            const pct = Math.round((s.value / total) * 100)
            const path =
              s.value === total ? (
                <circle cx={c} cy={c} r={70} fill="none" stroke={s.color} strokeWidth={24} />
              ) : (
                <path d={arcPath(c, c, 82, 58, a0, a1)} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
              )
            return (
              <g
                key={s.label}
                className="chart-mark"
                onMouseMove={(e) => tooltip.show(e, <TipBody title={s.label} rows={[['Count', `${s.value} (${pct}%)`, s.color]]} />)}
                onMouseLeave={tooltip.hide}
              >
                {path}
              </g>
            )
          })}
          <text x={c} y={c - 2} textAnchor="middle" className="donut-value">
            {centerValue}
          </text>
          <text x={c} y={c + 18} textAnchor="middle" className="donut-label">
            {centerLabel}
          </text>
        </svg>
        <Legend items={segments.map((s) => ({ label: s.label, color: s.color, value: s.value }))} />
      </div>
    </div>
  )
}

// ---------- Horizontal stacked bars (per utility) ----------

function UtilityBars({ rows, tooltip }) {
  const max = Math.max(1, ...rows.map((r) => r.conflicted + r.clear))
  return (
    <div className="chart-card">
      <h3>Projects by utility</h3>
      <p className="chart-sub">How much of each utility's portfolio is caught up in a conflict</p>
      <div className="hbars">
        {rows.map((r) => {
          const total = r.conflicted + r.clear
          const tip = (e) =>
            tooltip.show(
              e,
              <TipBody
                title={r.utility}
                rows={[
                  ['In conflict', r.conflicted, SEVERITY_COLOR.high],
                  ['No conflict', r.clear, CLEAR_COLOR],
                  ['Total budget', formatMoney(r.cost, true)],
                ]}
              />,
            )
          return (
            <div className="hbar-row" key={r.utility} onMouseMove={tip} onMouseLeave={tooltip.hide}>
              <div className="hbar-label">
                <span className="dot" style={{ background: utilityColor(r.utility) }} />
                {r.utility}
              </div>
              <div className="hbar-track">
                <div className="hbar-fill" style={{ width: `${(r.conflicted / max) * 100}%`, background: SEVERITY_COLOR.high }} />
                <div className="hbar-fill" style={{ width: `${(r.clear / max) * 100}%`, background: CLEAR_COLOR }} />
              </div>
              <div className="hbar-total">{total}</div>
            </div>
          )
        })}
      </div>
      <Legend
        items={[
          { label: 'In conflict', color: SEVERITY_COLOR.high },
          { label: 'No conflict', color: CLEAR_COLOR },
        ]}
      />
    </div>
  )
}

// ---------- Vertical stacked columns (projects active per year) ----------

function YearColumns({ years, tooltip }) {
  const max = Math.max(1, ...years.map((y) => y.conflicted + y.clear))
  const W = 520
  const H = 200
  const pad = { top: 12, right: 8, bottom: 24, left: 28 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const step = plotW / Math.max(1, years.length)
  const barW = Math.min(34, step * 0.6)
  const y = (v) => pad.top + plotH - (v / max) * plotH
  const ticks = [0, Math.ceil(max / 2), max]

  return (
    <div className="chart-card wide">
      <h3>Active projects per year</h3>
      <p className="chart-sub">Projects under construction at any point in each year</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="columns" role="img" aria-label="Active projects per year">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className="grid-line" />
            <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" className="axis-text">
              {t}
            </text>
          </g>
        ))}
        {years.map((yr, i) => {
          const x = pad.left + i * step + (step - barW) / 2
          const hConf = (yr.conflicted / max) * plotH
          const hClear = (yr.clear / max) * plotH
          const base = pad.top + plotH
          return (
            <g
              key={yr.year}
              className="chart-mark"
              onMouseMove={(e) =>
                tooltip.show(
                  e,
                  <TipBody
                    title={String(yr.year)}
                    rows={[
                      ['In conflict', yr.conflicted, SEVERITY_COLOR.high],
                      ['No conflict', yr.clear, CLEAR_COLOR],
                    ]}
                  />,
                )
              }
              onMouseLeave={tooltip.hide}
            >
              {/* invisible hit target bigger than the bars */}
              <rect x={pad.left + i * step} y={pad.top} width={step} height={plotH} fill="transparent" />
              {hConf > 0 && <rect x={x} y={base - hConf} width={barW} height={hConf} fill={SEVERITY_COLOR.high} />}
              {hClear > 0 && (
                <rect
                  x={x}
                  y={base - hConf - hClear}
                  width={barW}
                  height={Math.max(0, hClear - (hConf > 0 ? 2 : 0))}
                  fill={CLEAR_COLOR}
                  rx={hClear > 4 ? 3 : 0}
                />
              )}
              <text x={x + barW / 2} y={H - 6} textAnchor="middle" className="axis-text">
                {yr.year}
              </text>
            </g>
          )
        })}
      </svg>
      <Legend
        items={[
          { label: 'In conflict', color: SEVERITY_COLOR.high },
          { label: 'No conflict', color: CLEAR_COLOR },
        ]}
      />
    </div>
  )
}

// ---------- Dependency risks (summary + table) ----------

function RiskPanel({ risks, onShowRisk }) {
  const byType = RISK_TYPES.map((t) => {
    const items = risks.filter((r) => r.type === t)
    return { type: t, count: items.length, days: items.reduce((s, r) => s + r.days, 0) }
  })
  const maxDays = Math.max(1, ...byType.map((t) => t.days))

  return (
    <div className="chart-card full">
      <h3>Dependency risks</h3>
      <p className="chart-sub">
        Where one utility's work affects the other's systems. Bars show total days of overlap.
      </p>
      <div className="risk-summary">
        {byType.map((t) => (
          <div className="risk-summary-row" key={t.type}>
            <div className="risk-summary-label">
              <span className="risk-icon">{RISK_META[t.type].icon}</span>
              <div>
                <div className="proj-name">{RISK_META[t.type].label}</div>
                <div className="proj-util">{RISK_META[t.type].explain}</div>
              </div>
            </div>
            <div className="hbar-track">
              {t.days > 0 && <div className="hbar-fill risk-fill" style={{ width: `${(t.days / maxDays) * 100}%` }} />}
            </div>
            <div className="risk-summary-nums">
              <strong>{t.count}</strong> pair{t.count === 1 ? '' : 's'} · <strong>{t.days}</strong> days
            </div>
          </div>
        ))}
      </div>

      {risks.length === 0 ? (
        <div className="empty small">No dependency risks with the current filters and thresholds.</div>
      ) : (
        <div className="table-wrap">
          <table className="risk-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Projects</th>
                <th>Overlap window</th>
                <th className="num">Days</th>
                <th className="num">Distance</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r) => (
                <tr key={riskKey(r)} onClick={() => onShowRisk(r)} title="Show on map">
                  <td>
                    {RISK_META[r.type].icon} {r.type === 'road' ? r.road : 'Outage'}
                  </td>
                  <td>
                    <div>{r.project_a.name}</div>
                    <div>{r.project_b.name}</div>
                  </td>
                  <td>{formatRange(r.start_date, r.end_date)}</td>
                  <td className="num">{r.days}</td>
                  <td className="num">{r.distance_miles} mi</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------- Dashboard ----------

export default function Insights({ projects, overlaps, risks, conflictIndex, onShowRisk }) {
  const tooltip = useTooltip()

  const stats = useMemo(() => {
    const conflicted = projects.filter((p) => conflictIndex.has(p.project_id))
    const clear = projects.filter((p) => !conflictIndex.has(p.project_id))

    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]))
    let savings = 0
    for (const o of overlaps) {
      bySeverity[o.severity] += 1
      savings += (o.potential_savings || 0) + (o.relocation_savings || 0)
    }

    const utilities = [...new Set([...Object.keys(UTILITY_COLOR), ...projects.map((p) => p.utility)])]
    const utilityRows = utilities
      .map((u) => {
        const ps = projects.filter((p) => p.utility === u)
        return {
          utility: u,
          conflicted: ps.filter((p) => conflictIndex.has(p.project_id)).length,
          clear: ps.filter((p) => !conflictIndex.has(p.project_id)).length,
          cost: ps.reduce((s, p) => s + (p.estimated_cost || 0), 0),
        }
      })
      .filter((r) => r.conflicted + r.clear > 0)

    const years = []
    if (projects.length) {
      const minY = Math.min(...projects.map((p) => +p.start_date.slice(0, 4)))
      const maxY = Math.max(...projects.map((p) => +p.end_date.slice(0, 4)))
      for (let yr = minY; yr <= maxY; yr++) {
        const active = projects.filter((p) => +p.start_date.slice(0, 4) <= yr && yr <= +p.end_date.slice(0, 4))
        years.push({
          year: yr,
          conflicted: active.filter((p) => conflictIndex.has(p.project_id)).length,
          clear: active.filter((p) => !conflictIndex.has(p.project_id)).length,
        })
      }
    }

    return { conflicted, clear, bySeverity, savings, utilityRows, years }
  }, [projects, overlaps, conflictIndex])

  return (
    <div className="insights">
      <div className="stat-row">
        <div className="stat">
          <div className="stat-value">{projects.length}</div>
          <div className="stat-label">Total projects</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.conflicted.length}</div>
          <div className="stat-label">
            <span className="dot" style={{ background: SEVERITY_COLOR.high }} /> In conflict
          </div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats.clear.length}</div>
          <div className="stat-label">
            <span className="dot" style={{ background: CLEAR_COLOR }} /> No conflict
          </div>
        </div>
        <div className="stat">
          <div className="stat-value">{overlaps.length}</div>
          <div className="stat-label">Flagged pairs</div>
        </div>
        <div className="stat">
          <div className="stat-value">{overlaps.filter((o) => o.cross_state).length}</div>
          <div className="stat-label">⇄ Cross-state pairs</div>
        </div>
        <div className="stat">
          <div className="stat-value">{risks.length}</div>
          <div className="stat-label">⚡🚧 Dependency risks</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatMoney(stats.savings, true) || '$0'}</div>
          <div className="stat-label">Est. savings if coordinated</div>
        </div>
      </div>

      <div className="chart-grid">
        <Donut
          title="Conflict vs. no conflict"
          subtitle="Share of all projects"
          centerValue={projects.length ? `${Math.round((stats.conflicted.length / projects.length) * 100)}%` : '—'}
          centerLabel="in conflict"
          tooltip={tooltip}
          segments={[
            { label: 'In conflict', value: stats.conflicted.length, color: SEVERITY_COLOR.high },
            { label: 'No conflict', value: stats.clear.length, color: CLEAR_COLOR },
          ]}
        />
        <Donut
          title="Conflicts by severity"
          subtitle="Flagged project pairs"
          centerValue={overlaps.length}
          centerLabel="pairs"
          tooltip={tooltip}
          segments={SEVERITIES.map((s) => ({
            label: SEVERITY_LABEL[s],
            value: stats.bySeverity[s],
            color: SEVERITY_COLOR[s],
          }))}
        />
        <UtilityBars rows={stats.utilityRows} tooltip={tooltip} />
        <YearColumns years={stats.years} tooltip={tooltip} />
        <RiskPanel risks={risks} onShowRisk={onShowRisk} />
      </div>
      {tooltip.node}
    </div>
  )
}
