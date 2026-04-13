// regression.js — MRZ Regression Test Runner Logic
// Requires (loaded via HTML): mrz-core.js, js/mrz-pipeline.js, Tesseract.js

'use strict';

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const SCALAR_FIELDS   = ['docType', 'passNo', 'nation', 'issuer', 'dob', 'sex', 'expiry', 'surname', 'given'];
const NAME_FIELDS     = ['surname', 'given'];
const CRITICAL_FIELDS = ['passNo', 'dob', 'expiry'];

// ── STRING NORMALIZATION ──────────────────────────────────────────────────────

// Normalize a field value before comparison.
// Strips diacritics, Turkish characters, whitespace, and MRZ filler '<' characters.
function normalize(s, isName) {
  let r = (s ?? '').toString().toUpperCase()
    // Turkish characters not covered by NFD
    .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
    // Strip all other diacritics via Unicode decomposition
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (isName) {
    r = r.replace(/<+$/, '').replace(/<+/g, ' ');  // trailing fillers removed, internal → space
  } else {
    r = r.replace(/<+$/, '');                        // trailing fillers only
  }
  return r.trim();
}

// Levenshtein edit distance
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j - 1], row[j]);
      prev = tmp;
    }
  }
  return row[n];
}

// ── COMPARISON ENGINE ─────────────────────────────────────────────────────────

// Compare a pipeline result against a test case's expected values.
// Returns: { outcome, subtype, diffs }
//   outcome: 'PASS' | 'FAIL' | 'NO_PARSE' | 'DECODE_FAIL'
//   subtype: null | 'wrong_fields' | 'weak_validation' | 'partial_parse'
//   diffs:   Array<{ field, expected, actual }>
function compareCase(pipelineResult, caseConfig) {
  const expected  = caseConfig.expected || null;   // may be absent in mrz_expected-only cases
  const matchMode = caseConfig.match || 'exact';

  // Pipeline-level failures — not a field comparison
  if (!pipelineResult || pipelineResult.error) {
    const outcome = pipelineResult && pipelineResult.error === 'decode_failed'
      ? 'DECODE_FAIL' : 'NO_PARSE';
    return { outcome, subtype: null, diffs: [] };
  }

  const diffs = [];

  // ── MRZ line comparison (mrz_expected) ──────────────────────────────────────
  if (Array.isArray(caseConfig.mrz_expected) && caseConfig.mrz_expected.length > 0) {
    const actualLines = (pipelineResult.extracted && pipelineResult.extracted.lines) || [];
    for (let i = 0; i < caseConfig.mrz_expected.length; i++) {
      const exp = (caseConfig.mrz_expected[i] || '').trim();
      const act = (actualLines[i]             || '').trim();
      if (matchMode === 'fuzzy') {
        // Allow up to 5% of line length or 2 chars, whichever is larger
        const tol = Math.max(2, Math.round(exp.length * 0.05));
        if (editDistance(exp, act) > tol)
          diffs.push({ field: 'mrz_line' + (i + 1), expected: exp, actual: act });
      } else {
        if (exp !== act)
          diffs.push({ field: 'mrz_line' + (i + 1), expected: exp, actual: act });
      }
    }
  }

  // ── Scalar field comparison (expected object) ────────────────────────────────
  if (expected) {
    // Count missing critical fields (for partial_parse detection)
    const missingCritical = CRITICAL_FIELDS.filter(f => {
      const v = pipelineResult.parsed && pipelineResult.parsed[f];
      return !v || v.trim().length === 0;
    });

    for (const field of SCALAR_FIELDS) {
      if (expected[field] === null || expected[field] === undefined) continue;
      const isName = NAME_FIELDS.includes(field);
      const a = normalize(pipelineResult.parsed && pipelineResult.parsed[field], isName);
      const e = normalize(expected[field], isName);
      if (a === e) continue;
      if (matchMode === 'fuzzy' && isName && editDistance(a, e) <= 2) continue;
      diffs.push({ field, expected: e, actual: a });
    }

    for (const [k, v] of Object.entries(expected.validation || {})) {
      const actualV = pipelineResult.validation && pipelineResult.validation[k];
      if (actualV !== v) diffs.push({ field: 'validation.' + k, expected: v, actual: actualV });
    }

    for (const [k, v] of Object.entries(expected.checksums || {})) {
      const cs      = pipelineResult.validation && pipelineResult.validation.checksums;
      const actualV = cs && cs[k];
      if (actualV !== v) diffs.push({ field: 'checksums.' + k, expected: v, actual: actualV });
    }

    if (diffs.length === 0) return { outcome: 'PASS', subtype: null, diffs: [] };

    let subtype = 'wrong_fields';
    if (missingCritical.length >= 2) {
      subtype = 'partial_parse';
    } else if (diffs.every(d => d.field.startsWith('validation.') || d.field.startsWith('checksums.'))) {
      subtype = 'weak_validation';
    }
    return { outcome: 'FAIL', subtype, diffs };
  }

  if (diffs.length === 0) return { outcome: 'PASS', subtype: null, diffs: [] };
  return { outcome: 'FAIL', subtype: 'wrong_fields', diffs };
}

// ── STATE ─────────────────────────────────────────────────────────────────────

let regressionWorker = null;
let manifest = { version: 1, cases: [] };
let fileMap  = {};   // basename → File (from <input type="file">)
let results  = [];   // per-case result objects accumulated during a run
let running  = false;

// ── WORKER ────────────────────────────────────────────────────────────────────

async function initWorker() {
  setPill('init', '⏳ Worker başlatılıyor...');
  try {
    // Pass '../' so traineddata resolves to project root, not /tests/
    regressionWorker = await window.MRZPipeline.createBatchWorker('../');
    setPill('ready', '✅ Hazır');
    document.getElementById('run-btn').disabled = false;
  } catch (e) {
    setPill('error', '❌ Worker hatası: ' + e.message);
    console.error('[Regression] Worker init failed:', e);
  }
}

// ── MANIFEST ──────────────────────────────────────────────────────────────────

async function loadManifest() {
  try {
    const r = await fetch('manifest.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    manifest = await r.json();
  } catch (e) {
    console.warn('[Regression] manifest.json yüklenemedi:', e.message);
    manifest = { version: 1, cases: [] };
  }
  renderPendingRows();
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────

function setPill(state, text) {
  const p = document.getElementById('worker-pill');
  p.textContent = text;
  p.className = 'pill ' + state;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPendingRows() {
  const tbody = document.getElementById('results-body');
  tbody.innerHTML = '';
  for (const c of manifest.cases) {
    const tr = document.createElement('tr');
    tr.id = 'row-' + c.id;
    tr.className = 'pending';
    tr.innerHTML =
      '<td>' + escapeHtml(c.id) + '</td>' +
      '<td>' + escapeHtml(c.description || '') + '</td>' +
      '<td><span class="badge skip">⏭ Bekliyor</span></td>' +
      '<td>—</td>' +
      '<td>—</td>' +
      '<td>—</td>';
    tbody.appendChild(tr);
  }
  document.getElementById('case-count').textContent =
    manifest.cases.length + ' test vakası yüklendi';
}

const BADGE = {
  PASS:        ['pass',        '✅ PASS'],
  FAIL:        ['fail',        '❌ FAIL'],
  NO_PARSE:    ['no-parse',    '⚠ NO_PARSE'],
  DECODE_FAIL: ['decode-fail', '🚫 DECODE_FAIL'],
  SKIPPED:     ['skip',        '⏭ ATLA'],
  RUNNING:     ['running',     '⏳ Çalışıyor'],
};

function updateRow(caseId, outcome, subtype, diffs, timingMs) {
  const tr = document.getElementById('row-' + caseId);
  if (!tr) return;
  tr.className = '';

  const [cls, label] = BADGE[outcome] || ['skip', outcome];
  const subtypeHtml  = subtype ? ' <small class="subtype">' + subtype + '</small>' : '';
  const timeHtml     = timingMs !== undefined ? '<span class="time">' + timingMs + 'ms</span>' : '—';

  let issueHtml = '—';
  if (diffs && diffs.length > 0) {
    issueHtml = '<table class="diff-table">' +
      diffs.map(d =>
        '<tr>' +
        '<td class="diff-field">' + escapeHtml(String(d.field)) + '</td>' +
        '<td class="diff-exp">→ ' + escapeHtml(String(d.expected)) + '</td>' +
        '<td class="diff-act">✗ ' + escapeHtml(String(d.actual)) + '</td>' +
        '</tr>'
      ).join('') +
      '</table>';
  }

  tr.cells[2].innerHTML = '<span class="badge ' + cls + '">' + label + '</span>' + subtypeHtml;
  tr.cells[3].innerHTML = timeHtml;
  tr.cells[4].innerHTML = issueHtml;

  const visionBtn = (typeof batchVisionCache !== 'undefined' && batchVisionCache.has(caseId))
    ? '<button class="btn-vision" onclick="toggleVisionPanel(\'' + caseId + '\',this)">🔍 Vision</button>'
    : '—';
  if (tr.cells[5]) tr.cells[5].innerHTML = visionBtn;
}

function updateSummary() {
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0, NO_PARSE: 0, DECODE_FAIL: 0 };
  for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;

  const sum = document.getElementById('summary');
  sum.style.display = 'flex';
  sum.innerHTML =
    '<span class="summary-pill pass">✅ ' + counts.PASS + ' geçti</span>' +
    '<span class="summary-pill fail">❌ ' + counts.FAIL + ' başarısız</span>' +
    '<span class="summary-pill skip">⏭ ' + counts.SKIPPED + ' atlandı</span>' +
    (counts.NO_PARSE    ? '<span class="summary-pill warn">⚠ '  + counts.NO_PARSE    + ' bulunamadı</span>' : '') +
    (counts.DECODE_FAIL ? '<span class="summary-pill warn">🚫 ' + counts.DECODE_FAIL + ' decode hatası</span>' : '');
}

// ── IMAGE LOADER ──────────────────────────────────────────────────────────────

// Fetch an image from a server URL and wrap it as a File object.
// `url` is relative to the page location (e.g. 'images/IMG_1775.jpg').
async function fetchImageAsFile(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  const blob     = await r.blob();
  const filename = url.split('/').pop();
  return new File([blob], filename, { type: blob.type || 'image/jpeg' });
}

// ── RUNNER ────────────────────────────────────────────────────────────────────

async function runAllTests() {
  if (running || !regressionWorker) return;
  running = true;
  results = [];
  if (typeof batchVisionCache !== 'undefined') batchVisionCache.clear();

  const runBtn    = document.getElementById('run-btn');
  const exportBtn = document.getElementById('export-btn');
  const progWrap  = document.getElementById('progress-wrap');
  const progBar   = document.getElementById('progress-bar');

  runBtn.disabled = true;
  exportBtn.style.display = 'none';
  document.getElementById('summary').style.display = 'none';
  progWrap.style.display = 'block';
  progBar.style.width = '0%';

  renderPendingRows();   // reset all rows to "waiting"

  const cases = manifest.cases;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    updateRow(c.id, 'RUNNING', null, [], undefined);
    progBar.style.width = Math.round((i / cases.length) * 100) + '%';

    // Resolve file: fileMap (manual picker) first, then auto-fetch from tests/images/
    const baseName = c.file.replace(/^.*\//, '');
    let file = fileMap[baseName] || fileMap[c.file];

    if (!file) {
      try {
        file = await fetchImageAsFile('images/' + baseName);
      } catch (e) {
        console.warn('[Regression] Auto-fetch failed for', baseName, '—', e.message);
        // file stays null → SKIPPED below
      }
    }

    let outcome, subtype = null, diffs = [], timingMs, timingsDetail = null, meta = null;
    let dbgPathClass = null, dbgP275 = null, dbgP295 = null;

    if (!file) {
      outcome = 'SKIPPED';
    } else {
      const timings = {};
      const t0 = performance.now();

      // Snapshot _dbgData length before this run so we can find the new entry afterward
      const dbgIdxBefore = (window._dbgData && window._mrzDebug) ? window._dbgData.length : -1;

      let pipelineResult;
      try {
        pipelineResult = await window.MRZPipeline.processImage(file, regressionWorker, timings);
      } catch (e) {
        pipelineResult = { error: 'decode_failed' };
      }
      timingMs = Math.round(performance.now() - t0);

      const ocrTime           = (timings.ocr1 || 0) + (timings.ocr2 || 0) + (timings.ocr3 || 0);
      const preprocessingTime = timings.crop || 0;
      timingsDetail = { totalTime: timingMs, ocrTime, preprocessingTime, raw: timings };
      meta = pipelineResult && pipelineResult.meta ? pipelineResult.meta : null;

      // Pull pathClass / p275 / p295 from the _dbgData entry written by _finalizeRun
      if (window._mrzDebug && dbgIdxBefore >= 0 &&
          window._dbgData && window._dbgData.length > dbgIdxBefore) {
        const dbgEntry = window._dbgData[window._dbgData.length - 1];
        dbgPathClass = dbgEntry.pathClass  || null;
        dbgP275      = dbgEntry.p275       || null;
        dbgP295      = dbgEntry.p295       || null;
      }

      const cmp = compareCase(pipelineResult, c);
      outcome = cmp.outcome;
      subtype = cmp.subtype;
      diffs   = cmp.diffs;
    }

    const resultEntry = { id: c.id, outcome, subtype, diffs, timingMs, timings: timingsDetail, meta };
    if (window._mrzDebug && dbgPathClass !== null) {
      resultEntry.pathClass = dbgPathClass;
      resultEntry.p275      = dbgP275;
      resultEntry.p295      = dbgP295;
    }
    results.push(resultEntry);

    // Capture canvas for Vision debug panel (all non-SKIPPED rows)
    if (file && outcome !== 'SKIPPED' && typeof batchVisionCache !== 'undefined') {
      try {
        const bmp = await createImageBitmap(file);
        const vW = Math.min(800, bmp.width);
        const vH = Math.round(bmp.height * vW / bmp.width);
        const vCanvas = document.createElement('canvas');
        vCanvas.width = vW; vCanvas.height = vH;
        vCanvas.getContext('2d').drawImage(bmp, 0, 0, vW, vH);
        if (bmp.close) bmp.close();
        batchVisionCache.set(c.id, { imgCanvas: vCanvas, vd: null });
      } catch (_) {}
    }

    updateRow(c.id, outcome, subtype, diffs, timingMs);
  }

  progBar.style.width = '100%';
  setTimeout(() => { progWrap.style.display = 'none'; }, 500);

  updateSummary();
  runBtn.disabled = false;
  exportBtn.style.display = 'inline-block';
  running = false;
}

// ── EXPORT ────────────────────────────────────────────────────────────────────

function exportJSON() {
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0, NO_PARSE: 0, DECODE_FAIL: 0 };
  for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;

  // Build aggregate block if any result carries debug instrumentation
  let aggregate = null;
  if (results.some(r => r.pathClass !== undefined)) {
    const pathClass = { primary: 0, early_correction: 0, cheap_fallback: 0,
                        late_fallback: 0, debt_fallback: 0, no_parse: 0 };
    let p275Reached = 0, p275Won = 0, p295Reached = 0, p295Won = 0;
    for (const r of results) {
      if (r.pathClass) pathClass[r.pathClass] = (pathClass[r.pathClass] || 0) + 1;
      if (r.p275) { if (r.p275.reached) p275Reached++; if (r.p275.won) p275Won++; }
      if (r.p295) { if (r.p295.reached) p295Reached++; if (r.p295.won) p295Won++; }
    }
    aggregate = { pathClass, p275Reached, p275Won, p295Reached, p295Won };
  }

  const summary = { ...counts, total: results.length };
  if (aggregate) summary.aggregate = aggregate;

  const report = {
    timestamp:       new Date().toISOString(),
    manifestVersion: manifest.version,
    summary,
    results,
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'regression-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── INIT ──────────────────────────────────────────────────────────────────────

document.getElementById('file-input').addEventListener('change', function () {
  fileMap = {};
  for (const f of this.files) fileMap[f.name] = f;
  const n = this.files.length;
  document.getElementById('file-status').textContent =
    n > 0 ? n + ' dosya seçildi' : '';
});

document.getElementById('run-btn').addEventListener('click', runAllTests);
document.getElementById('export-btn').addEventListener('click', exportJSON);

window.addEventListener('beforeunload', function () {
  if (regressionWorker) {
    try { regressionWorker.terminate(); } catch (_) {}
  }
});

// Boot
loadManifest().then(initWorker);
