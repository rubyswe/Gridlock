import { useState } from 'react'
import { utilityColor } from './utils'

export const EMPTY_FILTERS = { utilities: [], from: '', to: '' }

export function hasActiveFilters(f) {
  return f.utilities.length > 0 || Boolean(f.from) || Boolean(f.to)
}

export function FilterBar({ utilities, filters, onChange, shownCount, totalCount }) {
  const toggleUtility = (u) => {
    const on = filters.utilities.includes(u)
    onChange({ ...filters, utilities: on ? filters.utilities.filter((x) => x !== u) : [...filters.utilities, u] })
  }
  const rangeInvalid = filters.from && filters.to && filters.to < filters.from

  return (
    <div className="filter-bar">
      <div className="filter-group" role="group" aria-label="Utility">
        <span className="filter-label">Utility</span>
        <button
          className={`chip-btn${filters.utilities.length === 0 ? ' active' : ''}`}
          aria-pressed={filters.utilities.length === 0}
          onClick={() => onChange({ ...filters, utilities: [] })}
        >
          All
        </button>
        {utilities.map((u) => (
          <button
            key={u}
            className={`chip-btn${filters.utilities.includes(u) ? ' active' : ''}`}
            aria-pressed={filters.utilities.includes(u)}
            onClick={() => toggleUtility(u)}
          >
            <span className="dot" style={{ background: utilityColor(u) }} />
            {u}
          </button>
        ))}
      </div>

      <div className="filter-group">
        <span className="filter-label">Active between</span>
        <input
          type="date"
          aria-label="From date"
          value={filters.from}
          onChange={(e) => onChange({ ...filters, from: e.target.value })}
        />
        <span className="filter-sep">–</span>
        <input
          type="date"
          aria-label="To date"
          value={filters.to}
          onChange={(e) => onChange({ ...filters, to: e.target.value })}
        />
        {rangeInvalid && <span className="filter-warn">End is before start</span>}
      </div>

      <div className="filter-group filter-end">
        <span className="filter-count">
          Showing {shownCount} of {totalCount} projects
        </span>
        {hasActiveFilters(filters) && (
          <button className="link-btn" onClick={() => onChange(EMPTY_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  )
}

const THRESHOLD_FIELDS = [
  {
    key: 'distance_miles',
    label: 'Same-area distance',
    unit: 'mi',
    min: 1,
    max: 50,
    step: 1,
    help: 'Projects closer than this are flagged as being in the same area.',
  },
  {
    key: 'date_buffer_days',
    label: 'Timing buffer',
    unit: 'days',
    min: 0,
    max: 365,
    step: 5,
    help: 'Projects whose schedules overlap, or come within this many days of each other, are flagged as same-timeframe.',
  },
  {
    key: 'max_regional_miles',
    label: 'Regional radius',
    unit: 'mi',
    min: 10,
    max: 300,
    step: 5,
    help: 'A same-timeframe conflict or shared road closure only counts if the projects are within this distance of each other.',
  },
  {
    key: 'outage_radius_miles',
    label: 'Outage radius',
    unit: 'mi',
    min: 1,
    max: 100,
    step: 1,
    help: 'Overlapping equipment outages closer than this are flagged as a stacked-outage risk.',
  },
]

export function DetectionSettings({ thresholds, defaults, onChange, loading }) {
  const [open, setOpen] = useState(false)
  const custom = defaults && THRESHOLD_FIELDS.some((f) => thresholds[f.key] !== defaults[f.key])

  return (
    <div className={`settings${open ? ' open' : ''}`}>
      <button className="settings-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>⚙ Detection settings</span>
        <span className="settings-summary">
          {thresholds.distance_miles} mi · {thresholds.date_buffer_days} days · {thresholds.max_regional_miles} mi region
          · {thresholds.outage_radius_miles} mi outage
        </span>
        {custom && <span className="badge custom">Custom</span>}
        {loading && <span className="settings-loading">Recalculating…</span>}
        <span className="settings-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="settings-body">
          {THRESHOLD_FIELDS.map((f) => (
            <label key={f.key} className="slider-field">
              <div className="slider-head">
                <span>{f.label}</span>
                <span className="slider-value">
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={thresholds[f.key]}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (e.target.value !== '' && v >= 0) onChange({ ...thresholds, [f.key]: v })
                    }}
                  />
                  {f.unit}
                </span>
              </div>
              <input
                type="range"
                min={f.min}
                max={f.max}
                step={f.step}
                value={Math.min(f.max, Math.max(f.min, thresholds[f.key]))}
                onChange={(e) => onChange({ ...thresholds, [f.key]: Number(e.target.value) })}
              />
              <span className="slider-help">
                {f.help}
                {defaults && ` Default: ${defaults[f.key]} ${f.unit}.`}
              </span>
            </label>
          ))}
          <div className="settings-actions">
            <button className="link-btn" disabled={!custom} onClick={() => defaults && onChange(defaults)}>
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
