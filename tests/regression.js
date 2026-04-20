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

// ── VISUAL QUALITY RENDERER ───────────────────────────────────────────────────

// Compute vision regression metrics by comparing visionAnalyzeImage output to
// the visionExpected ground truth in the manifest case config.
// Returns null when vd or visionExpected is absent.
function computeVisionMetrics(vd, c) {
  const exp = c && c.visionExpected;
  if (!vd || !vd.meta || !exp) return null;
  const m = vd.meta;

  const isFullFrame   = exp.frameMode === 'full-frame';
  const isKnownBug    = !!exp.knownBug;
  const warpDetected  = m.finalDocumentSource === 'warp';
  const warpCorrect   = warpDetected === !!exp.warpExpected;
  const rotationCorrect = isFullFrame ? m.detectedRotation === exp.rotation : null;
  const uprightCorrect  = m.isVisuallyUpright === !!exp.isVisuallyUpright;
  // Post-warp normalization check: any non-zero warpNormDeg means the algorithm applied
  // an extra rotation to the warp canvas after perspective correction. This is only valid
  // when the warp genuinely comes out sideways (corner-ordering issue). The manifest
  // declares an expected warpNormDeg (defaults to 0). A mismatch means the algorithm
  // incorrectly flipped the warp, which is a false positive for isVisuallyUpright.
  const expectedWarpNormDeg = exp.warpNormDeg || 0;
  const warpNormCorrect = (m.warpNormDeg || 0) === expectedWarpNormDeg;
  // MRZ crop quality: if the extracted mrzCrop contains background texture instead of
  // real MRZ text (uniform low-density pattern), the vision result is unreliable.
  const mrzCropValid = m.mrzCropValid !== false; // true by default (non-warp / legacy)
  // DocType check: detected docType must match manifest's expected docType.
  // A mismatch means the quad aspect ratio was distorted by background inclusion,
  // causing the wrong strip size for mrzCrop extraction.
  const detectedDocType  = m.docType || null;
  const expectedDocType  = c.docType || null;
  const docTypeCorrect   = !warpDetected || !detectedDocType || !expectedDocType
                           || detectedDocType === expectedDocType;

  // Aspect deviation: only when warp produced a finalDocument canvas
  let aspectDeviation = null;
  if (warpDetected && vd.images && vd.images.finalDocument) {
    const fd  = vd.images.finalDocument;
    let asp   = fd.width / fd.height;
    if (asp < 1) asp = 1 / asp;   // normalize to landscape
    const expAspects = { TD1: 1.586, TD2: 1.421, TD3: 1.414 };
    const expAsp = expAspects[c.docType] || expAspects[m.docType] || 1.414;
    aspectDeviation = Math.round(Math.abs(asp - expAsp) / expAsp * 1000) / 10;
  }

  // Warp quality score: MRZ density in the warp canvas (from pipeline scoreMRZPresence × 1.2).
  // A low warpScore (<0.30) means the warp captured too much background relative to the MRZ zone.
  // This catches bad quads where the card is a small fraction of the warp canvas.
  const warpScore = (warpDetected && m.warpScore > 0) ? Math.round(m.warpScore * 1000) / 1000 : null;
  const warpScoreWeak = warpDetected && (warpScore === null || warpScore < 0.30);

  // Overall vision pass/fail
  // Scene: warp must be correct, document must be upright, aspect within 15%, AND warpScore ≥ 0.30
  // (warpScore < 0.30 means MRZ density in warp is too low — quad captured too much background)
  let visionPass;
  if (isKnownBug)        visionPass = null;
  else if (isFullFrame)  visionPass = rotationCorrect;
  else                   visionPass = warpCorrect && uprightCorrect && warpNormCorrect
                                   && mrzCropValid && docTypeCorrect
                                   && (aspectDeviation === null || aspectDeviation <= 15)
                                   && !warpScoreWeak;

  // Visual quality category
  let visualQuality;
  if (isKnownBug || visionPass === null) visualQuality = 'na';
  else if (!visionPass)                  visualQuality = 'bad';
  else if (warpDetected && aspectDeviation !== null && aspectDeviation > 20) visualQuality = 'weak';
  else if (warpDetected && aspectDeviation !== null && aspectDeviation <= 10) visualQuality = 'good';
  else                                   visualQuality = 'weak';

  return {
    rotationCorrect,
    warpDetected,
    warpCorrect,
    uprightCorrect,
    aspectDeviation,
    warpScore,
    warpScoreWeak,
    visualQuality,
    visionPass,
    isKnownBug,
    isFullFrame,
    detectedRotation:  m.detectedRotation,
    expectedRotation:  exp.rotation,
    isVisuallyUpright: m.isVisuallyUpright,
    detectedDocType,
    expectedDocType,
    docTypeCorrect,
  };
}

// Render the 📐 Görsel cell. When ground truth is available (visionExpected),
// shows VISION PASS/FAIL badge with Yön (orientation) and Kırp (crop) sub-checks.
// Falls back to informational emoji when no ground truth.
function renderVisualQuality(vd, c) {
  if (!vd || !vd.meta) return '<span style="color:var(--muted)">—</span>';
  const m  = vd.meta;
  const vm = computeVisionMetrics(vd, c);

  // Dimension string from actual finalDocument canvas
  let dimStr = null;
  if (vd.images && vd.images.finalDocument) {
    const fd = vd.images.finalDocument;
    dimStr = fd.width + '×' + fd.height;
  }

  // aspBonus of the winning rotation (for informational fallback)
  let aspBonus = null;
  if (m.rotationScores && m.rotationScores.length) {
    const winner = m.rotationScores.reduce((a, b) =>
      b.effectiveScore > a.effectiveScore ? b : a);
    if (winner.aspBonus !== undefined) aspBonus = winner.aspBonus;
  }

  // ── No ground truth: informational display ──────────────────────────────────
  if (!vm) {
    if (m.finalDocumentSource === 'rotated') {
      return '<span style="color:var(--muted);font-size:.72rem">⬜ orig' +
             (dimStr ? '<br>' + escapeHtml(dimStr) : '') + '</span>';
    }
    let icon, color;
    if (!m.isVisuallyUpright)                   { icon = '🔴'; color = 'var(--red)'; }
    else if (aspBonus !== null && aspBonus >= 8) { icon = '🟢'; color = 'var(--green)'; }
    else                                         { icon = '🟡'; color = 'var(--yellow)'; }
    const parts = [];
    if (dimStr)            parts.push(escapeHtml(dimStr));
    if (aspBonus !== null) parts.push('asp +' + aspBonus.toFixed(1));
    return '<span style="color:' + color + ';font-size:.8rem">' + icon + '</span>' +
      (parts.length ? '<br><span style="color:var(--muted);font-size:.66rem">' +
        parts.join(' | ') + '</span>' : '');
  }

  // ── With ground truth: VISION PASS / FAIL badge + sub-checks ────────────────
  let badge, badgeColor;
  if (vm.isKnownBug)      { badge = '🐛 BUG';    badgeColor = 'var(--yellow)'; }
  else if (vm.visionPass) { badge = '✅ V-PASS'; badgeColor = 'var(--green)'; }
  else                    { badge = '❌ V-FAIL'; badgeColor = 'var(--red)'; }

  // ── Yön (Orientation) sub-check ──────────────────────────────────────────────
  let yonHtml;
  if (vm.isKnownBug) {
    yonHtml = '<span style="color:var(--yellow)">🔄 —</span>';
  } else if (vm.isFullFrame) {
    // Full-frame: check detected rotation vs expected
    const ok = vm.rotationCorrect;
    const rotLabel = vm.detectedRotation + '°' + (ok ? '' : '≠' + vm.expectedRotation + '°');
    yonHtml = '<span style="color:' + (ok ? 'var(--green)' : 'var(--red)') + '">' +
              '🔄 ' + rotLabel + (ok ? ' ✅' : ' ❌') + '</span>';
  } else {
    // Scene: check isVisuallyUpright
    const ok = vm.uprightCorrect && vm.warpCorrect;
    yonHtml = '<span style="color:' + (ok ? 'var(--green)' : 'var(--red)') + '">' +
              '🔄 ' + (ok ? 'upright ✅' : 'wrong ❌') + '</span>';
  }

  // ── Kırp (Crop) sub-check ────────────────────────────────────────────────────
  let kirpHtml;
  if (!vm.warpDetected) {
    // Full-frame: no crop expected
    kirpHtml = '<span style="color:var(--muted)">✂️ N/A</span>';
  } else if (vm.aspectDeviation === null) {
    kirpHtml = '<span style="color:var(--muted)">✂️ —</span>';
  } else {
    // Scene with warp: aspect deviation + warpScore quality
    const dev = vm.aspectDeviation;
    let kirpColor, kirpIcon;
    if (vm.warpScoreWeak)   { kirpColor = 'var(--red)';    kirpIcon = '❌'; }
    else if (dev <= 10)     { kirpColor = 'var(--green)';  kirpIcon = '✅'; }
    else if (dev <= 25)     { kirpColor = 'var(--yellow)'; kirpIcon = '🟡'; }
    else                    { kirpColor = 'var(--red)';    kirpIcon = '❌'; }
    const scoreStr = vm.warpScore !== null ? ' s=' + vm.warpScore.toFixed(2) : '';
    kirpHtml = '<span style="color:' + kirpColor + '">✂️ Δ' + dev + '%' + scoreStr + ' ' + kirpIcon + '</span>';
  }

  // ── DocType sub-check ────────────────────────────────────────────────────────
  let docTypeHtml = '';
  if (vm.warpDetected && vm.detectedDocType) {
    const dtOk = vm.docTypeCorrect;
    const dtLabel = vm.detectedDocType + (dtOk ? '' : '≠' + vm.expectedDocType);
    docTypeHtml = ' &nbsp; <span style="color:' + (dtOk ? 'var(--muted)' : 'var(--red)') + ';font-size:.64rem">'
                + '🪪 ' + dtLabel + (dtOk ? '' : ' ❌') + '</span>';
  }

  const dimLine = dimStr
    ? '<br><span style="color:var(--muted);font-size:.6rem">' + escapeHtml(dimStr) + '</span>'
    : '';
  const checksLine = '<br><span style="font-size:.64rem">' + yonHtml + ' &nbsp; ' + kirpHtml + docTypeHtml + '</span>';

  return '<span style="color:' + badgeColor + ';font-size:.75rem;font-weight:700">' + badge + '</span>' +
    dimLine + checksLine;
}

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

  // 📐 Görsel quality cell (index 5)
  const vd = (typeof batchVisionCache !== 'undefined' && batchVisionCache.has(caseId))
    ? batchVisionCache.get(caseId).vd : null;
  const caseConf = manifest.cases.find(mc => mc.id === caseId) || null;
  if (tr.cells[5]) tr.cells[5].innerHTML = renderVisualQuality(vd, caseConf);

  // Vision debug button (index 6)
  const visionBtn = (typeof batchVisionCache !== 'undefined' && batchVisionCache.has(caseId))
    ? '<button class="btn-vision" onclick="toggleVisionPanel(\'' + caseId + '\',this)">🔍 Vision</button>'
    : '—';
  if (tr.cells[6]) tr.cells[6].innerHTML = visionBtn;
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
    let dbgPathClass = null, dbgP295 = null;

    if (!file) {
      outcome = 'SKIPPED';
    } else {
      const timings = {};
      const t0 = performance.now();

      // Snapshot _dbgData length before this run so we can find the new entry afterward
      if (window._mrzDebug) window._dbgData = window._dbgData || [];
      const dbgIdxBefore = window._mrzDebug ? window._dbgData.length : -1;

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

      // Pull pathClass / p295 from the _dbgData entry written by _finalizeRun
      if (window._mrzDebug && dbgIdxBefore >= 0 &&
          window._dbgData && window._dbgData.length > dbgIdxBefore) {
        const dbgEntry = window._dbgData[window._dbgData.length - 1];
        dbgPathClass = dbgEntry.pathClass || null;
        dbgP295      = dbgEntry.p295      || null;
      }

      const cmp = compareCase(pipelineResult, c);
      outcome = cmp.outcome;
      subtype = cmp.subtype;
      diffs   = cmp.diffs;
    }

    const resultEntry = { id: c.id, outcome, subtype, diffs, timingMs, timings: timingsDetail, meta };
    if (window._mrzDebug && dbgPathClass !== null) {
      resultEntry.pathClass = dbgPathClass;
      resultEntry.p295      = dbgP295;
    }
    results.push(resultEntry);

    // Capture canvas + run vision analysis for Visual Quality column
    if (file && outcome !== 'SKIPPED' && typeof batchVisionCache !== 'undefined') {
      try {
        const bmp = await createImageBitmap(file);
        const vW = Math.min(800, bmp.width);
        const vH = Math.round(bmp.height * vW / bmp.width);
        const vCanvas = document.createElement('canvas');
        vCanvas.width = vW; vCanvas.height = vH;
        vCanvas.getContext('2d').drawImage(bmp, 0, 0, vW, vH);
        if (bmp.close) bmp.close();

        // Run visionAnalyzeImage immediately so 📐 Görsel column is populated
        let vd = null;
        if (typeof visionAnalyzeImage === 'function') {
          try { vd = visionAnalyzeImage(vCanvas); } catch (_) {}
        }
        batchVisionCache.set(c.id, { imgCanvas: vCanvas, vd: vd });

        // Compute vision regression metrics against ground truth
        const visionMetrics = computeVisionMetrics(vd, c);
        resultEntry.vision = visionMetrics;
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
                        debt_fallback: 0, no_parse: 0 };
    let p295Reached = 0, p295Won = 0;
    for (const r of results) {
      if (r.pathClass) pathClass[r.pathClass] = (pathClass[r.pathClass] || 0) + 1;
      if (r.p295) { if (r.p295.reached) p295Reached++; if (r.p295.won) p295Won++; }
    }
    aggregate = { pathClass, p295Reached, p295Won };
  }

  // Vision regression summary
  const vCounts = { PASS: 0, FAIL: 0, BUG: 0, NA: 0 };
  for (const r of results) {
    if (!r.vision || r.vision.visionPass === undefined) vCounts.NA++;
    else if (r.vision.isKnownBug)           vCounts.BUG++;
    else if (r.vision.visionPass === true)  vCounts.PASS++;
    else                                    vCounts.FAIL++;
  }

  const summary = { ...counts, total: results.length, vision: vCounts };
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
