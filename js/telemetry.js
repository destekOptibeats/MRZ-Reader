// ── SESSION METRICS (telemetry only — does not affect decisions) ────────
let metrics = null;
const BAND_NAMES = ['main', 'upper', 'lower'];

function resetMetrics() {
  metrics = {
    sessionStartTs: Date.now(),
    firstLockMs: null,
    successfulScans: 0,
    attemptedOCR: 0,
    blurSkips: 0,
    motionSkips: 0,
    rejectedOCR: 0,
    acceptedOCR: 0,
    bandHits: { main: 0, upper: 0, lower: 0 },
    bestScoreUpdates: 0,
    lastAcceptScore: null,
    upload: { attempts: 0, successful: 0, successRotation: null, successBandIndex: null }
  };
}

function getSessionMetricsSummary() {
  if (!metrics) return 'No active session';
  const now = Date.now();
  const elapsed = ((now - metrics.sessionStartTs) / 1000).toFixed(1);
  const avgMs = metrics.successfulScans > 0
    ? Math.round((metrics.firstLockMs || 0) / metrics.successfulScans)
    : null;
  return {
    elapsed: elapsed + 's',
    firstLockMs: metrics.firstLockMs,
    successfulScans: metrics.successfulScans,
    attemptedOCR: metrics.attemptedOCR,
    acceptedOCR: metrics.acceptedOCR,
    rejectedOCR: metrics.rejectedOCR,
    blurSkips: metrics.blurSkips,
    motionSkips: metrics.motionSkips,
    bandHits: { ...metrics.bandHits },
    bestScoreUpdates: metrics.bestScoreUpdates,
    lastAcceptScore: metrics.lastAcceptScore,
    upload: { ...metrics.upload },
    avgScanMs: avgMs
  };
}
window.getMetrics = getSessionMetricsSummary;

// ── LOG SİSTEMİ ────────────────────────────────────────────────────────
const MAX_LOGS = 20;
let logEntries  = [];
let scanCounter = 0;
let logOpen     = false;

function toggleLog() {
  logOpen = !logOpen;
  document.getElementById('log-panel').classList.toggle('open', logOpen);
}

function toggleFullscreen() {
  const panel = document.getElementById('log-panel');
  const btn   = document.getElementById('fs-btn');
  const isFull = panel.classList.toggle('fullscreen');
  btn.textContent = isFull ? '⊡' : '⛶';
}

function clearLog() { logEntries = []; scanCounter = 0; renderLog(); }

function addLog(type, main, details = [], mrz = null, cs = null, diag = null) {
  scanCounter++;
  const time = new Date().toTimeString().slice(0,8);
  logEntries.unshift({ type, time, scan: scanCounter, main, details, cs, diag });
  if (logEntries.length > MAX_LOGS) logEntries.pop();
  renderLog();
}

function renderLog() {
  const el    = document.getElementById('log-entries');
  const badge = document.getElementById('log-badge');
  if (!el) return;
  badge.textContent = logEntries.length;

  const icons = {ok:'✅', warn:'⚡', err:'❌', skip:'⏭'};
  const clr   = {ok:'log-ok', warn:'log-warn', err:'log-err', skip:'log-skip'};

  el.innerHTML = logEntries.map((e, idx) => {
    const cc = clr[e.type] || 'log-skip';
    const csBadges = e.cs ? `<div class="log-cs">
      ${['passOk','dobOk','expOk'].map(k => {
        const lbl = {passOk:'Pass',dobOk:'DOB',expOk:'EXP'}[k];
        const exp = e.cs[k.replace('Ok','Expected')];
        const fnd = e.cs[k.replace('Ok','Found')];
        const detail = (exp !== undefined && fnd !== undefined) ? ` (${exp}/${fnd})` : '';
        return `<span class="cs-badge ${e.cs[k]?'cs-ok-badge':'cs-fail-badge'}">${lbl}${e.cs[k]?'✓':'✗'}${detail}</span>`;
      }).join('')}</div>` : '';
    const details = e.details.map(d =>
      `<div class="log-detail">${d.replace(/</g,'&lt;')}</div>`).join('');
    // Diagnosis details
    let diagHtml = '';
    if (e.diag) {
      const d = e.diag;
      const parts = [];
      if (d.rawText) parts.push('<div class="log-detail" style="color:var(--muted)">RAW: ' + d.rawText.substring(0,120).replace(/</g,'&lt;').replace(/\n/g,' ↵ ') + '</div>');
      if (d.extracted) parts.push('<div class="log-detail">Lines: ' + d.extracted.lines.map(l => l.replace(/</g,'&lt;')).join(' | ') + '</div>');
      if (d.parseResult) {
        const pr = d.parseResult;
        parts.push('<div class="log-detail" style="color:var(--green)">→ ' + (pr.surname||'') + ' ' + (pr.given||'') + ' | ' + (pr.passNo||'') + ' | ' + (pr.nation||'') + '</div>');
      }
      if (d.failureReasons && d.failureReasons.length) {
        parts.push('<div class="log-detail" style="color:var(--red)">⚠ ' + d.failureReasons.join('; ') + '</div>');
      }
      diagHtml = parts.join('');
    }
    return `<div class="log-row" onclick="copyEntry(${idx})">
      <div class="log-col-time">${e.time}</div>
      <div class="log-col-icon">${icons[e.type]||'•'}</div>
      <div class="log-col-body">
        <div class="log-main ${cc}">[#${e.scan}] ${e.main}</div>
        ${details}${csBadges}${diagHtml}
      </div>
    </div>`;
  }).join('');
}

function copyEntry(idx) {
  const e = logEntries[idx]; if (!e) return;
  const text = [`[${e.time}] [#${e.scan}] ${e.main}`, ...e.details].join('\n');
  navigator.clipboard?.writeText(text);
}

function copyLog() {
  const text = logEntries.map(e =>
    [`[${e.time}] [#${e.scan}] ${e.main}`, ...e.details].join('\n')
  ).join('\n─────\n');
  navigator.clipboard?.writeText(text);
}

function exportLog() {
  const data = JSON.stringify(logEntries, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], {type:'application/json'}));
  a.download = `mrz-log-${new Date().toISOString().slice(0,16).replace(/[T:]/g,'-')}.json`;
  a.click();
}
