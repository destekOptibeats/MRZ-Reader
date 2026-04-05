const {
  chk, clean, cleanLine, fixLine, applyDigitFixes,
  isL1_TD1, isL2_TD1, isL3_TD1, isL1_TD3, isL2_TD3,
  extractMRZ, getChecksums_TD3, parseResult,
  validateMRZ, diagnoseMRZ, validateNationalId
} = window.MRZCore;

let worker       = null;
let workerReady  = false;
let stream       = null;
let scanning     = false;
let loopId       = null;
let currentIdx   = -1;
let loadedImg    = null;
let processingCancelled = false;

let lastFrameHash = 0;
let lastL2        = null;
let l2Count       = 0;
let checksumPassed = false;

const video    = document.getElementById('video');
const mainC    = document.getElementById('main-canvas');
const mainCtx  = mainC.getContext('2d', {willReadFrequently: true});
const camOvl   = document.getElementById('cam-overlay');
const camCtx   = camOvl.getContext('2d');

// ── SCREEN NAV ──────────────────────────────────────────────────────────
function goScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
  if (id === 's-scan') setTimeout(() => startCamera(), 100);
  else stopCamera();
}
function goHome() {
  stopScan();
  renderList();
  goScreen('s-home');
}

// ── STORAGE ─────────────────────────────────────────────────────────────
const DEMO = [{
  id:'demo_mia',
  line1:'P<ESPGUCEL<MAZLIYAH<<MIA<<<<<<<<<<<<<<<<<<',
  line2:'XDE4677822ESP1507218F2801223<<<<<<<<<<<<<<6',
  name:'Gucel Mazliyah, Mia', nation:'ESP'
}];
function loadPassports() {
  try { return JSON.parse(localStorage.getItem('mrz_pp') || '[]'); } catch { return []; }
}
function savePassports(list) { localStorage.setItem('mrz_pp', JSON.stringify(list)); }
function getAllPassports() {
  const saved = loadPassports();
  const ids   = saved.map(p => p.id);
  return [...DEMO.filter(d => !ids.includes(d.id)), ...saved];
}

// ── PASSPORT LIST ───────────────────────────────────────────────────────
const FLAGS = {ESP:'🇪🇸',TUR:'🇹🇷',USA:'🇺🇸',GBR:'🇬🇧',DEU:'🇩🇪',FRA:'🇫🇷',ITA:'🇮🇹',NLD:'🇳🇱',RUS:'🇷🇺',CHN:'🇨🇳',JPN:'🇯🇵',IND:'🇮🇳',BRA:'🇧🇷',CAN:'🇨🇦',AUS:'🇦🇺',SAU:'🇸🇦',ARE:'🇦🇪'};
function flag(c) { return FLAGS[c] || '🌍'; }

function toggleList() {
  const wrap = document.getElementById('pp-list-wrap');
  const icon = document.getElementById('list-toggle-icon');
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  icon.textContent = open ? '▲' : '▼';
}

let serialMode = false;
let serialCount = 0;
let serialScannedIds = [];
let toastTimer = null;
let serialTotalShots = 0;
let serialStartTime = 0;
let serialTimerInterval = null;
let serialEntries = [];       // {docId, name, type, readCount, firstReadTime}
let serialCooldown = false;
let serialCooldownTimer = null;

function showCamToast(msg, duration) {
  duration = duration || 2500;
  const el = document.getElementById('cam-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function flashScan(type) {
  const el = document.getElementById('scan-flash');
  if (!el) return;
  el.className = '';
  void el.offsetWidth; // reflow
  el.classList.add(type === 'dup' ? 'flash-orange' : 'flash-green');
  setTimeout(() => el.className = '', 300);
}

function bounceStat(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('stat-bounce');
  void el.offsetWidth;
  el.classList.add('stat-bounce');
}

function updateSerialStats() {
  const elapsed = Math.floor((Date.now() - serialStartTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  document.getElementById('serial-timer').textContent = mm + ':' + ss;
  if (serialTotalShots > 0) {
    document.getElementById('serial-avg').textContent = (elapsed / serialTotalShots).toFixed(1) + 's';
  }
}

function startSerialScan() {
  serialMode = true;
  serialCount = 0;
  serialScannedIds = [];
  serialEntries = [];
  serialTotalShots = 0;
  serialStartTime = Date.now();
  serialCooldown = false;
  if (serialCooldownTimer) { clearTimeout(serialCooldownTimer); serialCooldownTimer = null; }
  document.getElementById('serial-panel').style.display = 'flex';
  document.getElementById('serial-finish-btn').style.display = 'flex';
  document.getElementById('serial-counter').textContent = '0';
  document.getElementById('serial-total-shots').textContent = '0';
  document.getElementById('serial-timer').textContent = '00:00';
  document.getElementById('serial-avg').textContent = '0.0s';
  document.getElementById('serial-list').innerHTML = '';
  document.getElementById('cam-cancel-btn').style.display = 'none';
  document.getElementById('tab-bulk').style.display = '';
  if (serialTimerInterval) clearInterval(serialTimerInterval);
  serialTimerInterval = setInterval(updateSerialStats, 1000);
  goScreen('s-scan');
  setTimeout(() => startCamera(), 100);
}

function makeSerialKey(parsed) {
  return [
    (parsed.passNo || '').replace(/</g,'').trim(),
    (parsed.surname || '').trim(),
    (parsed.given || '').trim(),
    (parsed.dob || '').trim()
  ].join('|');
}

// ocrMeta: { ocrText, bandIdx, ocrAttempts } — optional, for analysis
function addSerialResult(mrzResult, ocrMeta) {
  ocrMeta = ocrMeta || {};
  // Debug: log video-wrap size before UI updates (first 5 scans)
  const _wrap = document.getElementById('video-wrap');
  if (serialCount < 5) console.log('[SizeDebug] BEFORE addSerialResult #' + (serialCount+1), _wrap.offsetWidth + 'x' + _wrap.offsetHeight);

  const parsed = parseResult(mrzResult);
  const mrzName = MRZCore.parseMRZName(mrzResult);
  parsed.surname = mrzName.surname;
  parsed.given   = mrzName.given;
  const docId = (parsed.passNo || '').replace(/</g,'').trim();
  const compositeKey = makeSerialKey(parsed);
  const readTime = Date.now();

  // OCR analysis fields — captured at accept time
  const ocrText = ocrMeta.ocrText || '';
  const longest = longestOCRLine(ocrText);
  const chevrons = countChevrons(ocrText);
  const bandLabel = ocrMeta.bandIdx != null ? 'band' + (ocrMeta.bandIdx + 1) : '—';
  const attempts = ocrMeta.ocrAttempts || 1;

  // Her okumada toplam çekim artır
  serialTotalShots++;
  document.getElementById('serial-total-shots').textContent = serialTotalShots;
  bounceStat('serial-total-shots');

  // Duplicate: still show toast + flash, but also add as analysis entry
  const isDuplicate = serialScannedIds.includes(docId);
  if (isDuplicate) {
    const dupName = (parsed.surname || '') + (parsed.given ? ' ' + parsed.given : '');
    showCamToast('⚠️ Tekrar okundu: ' + dupName, 2000);
    flashScan('dup');
    const countEl = document.getElementById('sr-count-' + docId);
    if (countEl) {
      let c = parseInt(countEl.textContent) || 1;
      countEl.textContent = (c + 1) + 'x';
    }
  } else {
    flashScan('new');
    // Save to localStorage only for first occurrence
    const photo = captureDocPhoto();
    const entry = {
      id: 'pp_' + Date.now(),
      line1: mrzResult.lines[0],
      line2: mrzResult.lines[1],
      line3: mrzResult.lines[2] || '',
      type:  mrzResult.type,
      name:  parsed.surname + (parsed.given ? ', ' + parsed.given : ''),
      nation: parsed.nation,
      photo: photo || '',
      addedAt: readTime
    };
    const saved = loadPassports();
    saved.push(entry);
    savePassports(saved);
    serialScannedIds.push(docId);
  }

  // Always add analysis entry (every scan = separate row in report)
  serialCount++;
  serialEntries.push({
    docId,
    compositeKey,
    name: parsed.surname + (parsed.given ? ' ' + parsed.given : ''),
    type: mrzResult.type === 'TD1' ? 'TC Kimlik' : 'Pasaport',
    readCount: 1,
    firstReadTime: readTime,
    isDuplicate,
    // OCR analysis fields
    selectedBand: bandLabel,
    longestLine: longest,
    chevronCount: chevrons,
    ocrAttempts: attempts,
    rawOcrText: ocrText,
    // Parsed fields for consistency comparison
    parsedFields: {
      documentNumber: docId || null,
      birthDate: parsed.dob || null,
      surname: parsed.surname || null,
      givenNames: parsed.given || null,
      nationalId: parsed.nationalId || null,
      nationalIdValid: parsed.nationalIdValid || false,
    }
  });

  // UI güncelle
  document.getElementById('serial-counter').textContent = serialCount;
  bounceStat('serial-counter');

  const displayName = (parsed.surname || '') + (parsed.given ? ' ' + parsed.given : '');
  const row = document.createElement('div');
  row.className = 'serial-row';
  row.innerHTML = '<span class="sr-flag">' + flag(parsed.nation) + '</span>' +
    '<span class="sr-name">' + displayName + '</span>' +
    '<span class="sr-docno">' + docId + '</span>' +
    '<span class="sr-count" id="sr-count-' + docId + '">1x</span>';
  const listEl = document.getElementById('serial-list');
  listEl.insertBefore(row, listEl.firstChild);
  document.getElementById('serial-panel').scrollTop = 0;

  // Scan state sıfırla
  lastFrameHash = 0;
  lastL2 = null;
  l2Count = 0;
  checksumPassed = false;

  // Kısa görsel geri bildirim
  setHint('✓ ' + displayName + ' okundu', 'ok');
  drawOverlayState('accepted');
  setTimeout(() => { if (scanning) drawOverlayState('searching'); }, 800);

  // Debug: log video-wrap size after UI updates
  if (serialCount <= 5) console.log('[SizeDebug] AFTER addSerialResult #' + serialCount, _wrap.offsetWidth + 'x' + _wrap.offsetHeight);

  // Cooldown başlat
  startSerialCooldown();
}

function startSerialCooldown() {
  if (!serialMode) return;
  serialCooldown = true;
  if (serialCooldownTimer) clearTimeout(serialCooldownTimer);
  setHint('Sonraki belge için hazır...', 'warn');
  serialCooldownTimer = setTimeout(() => {
    serialCooldown = false;
    serialCooldownTimer = null;
    if (scanning) {
      setHint('📏 MRZ satırlarını çerçeveye hizalayın', '');
      drawOverlayState('searching');
    }
  }, 1000);
}

function finishSerialScan() {
  serialMode = false;
  stopCamera();
  serialCooldown = false;
  if (serialCooldownTimer) { clearTimeout(serialCooldownTimer); serialCooldownTimer = null; }
  if (serialTimerInterval) { clearInterval(serialTimerInterval); serialTimerInterval = null; }
  document.getElementById('serial-panel').style.display = 'none';
  document.getElementById('serial-finish-btn').style.display = 'none';
  document.getElementById('cam-cancel-btn').style.display = '';
  document.getElementById('tab-bulk').style.display = 'none';

  // Show report (don't go home yet — session data preserved)
  showSerialReport();
}

// ── REPORT HELPERS ─────────────────────────────────────────────────────
function classifyFailure(opts) {
  // opts: { parseOk, checksumOk, longestLine, isBlurry, chevrons }
  if (opts.isBlurry) return 'BLURRY_FRAME';
  if (!opts.longestLine || opts.longestLine < 10) return 'MRZ_NOT_FOUND';
  if (opts.longestLine < 28) return 'LINES_TOO_SHORT';
  if ((!opts.chevrons || opts.chevrons < 3) && opts.longestLine < 35) return 'LOW_CHEVRON_COUNT';
  if (!opts.parseOk) return 'PARSE_FAILED';
  if (!opts.checksumOk) return 'CHECKSUM_FAILED';
  return 'UNKNOWN_ERROR';
}

const RESULT_COMMENTS = {
  BLURRY_FRAME: 'Görüntü bulanık',
  MRZ_NOT_FOUND: 'MRZ bulunamadı',
  LINES_TOO_SHORT: 'Satırlar çok kısa',
  LOW_CHEVRON_COUNT: 'MRZ deseni yetersiz',
  PARSE_FAILED: 'MRZ bulundu ama parse edilemedi',
  CHECKSUM_FAILED: 'Checksum geçmedi',
  NO_STABLE_FRAME: 'Kararlı kare yakalanamadı',
  DOCUMENT_TOO_FAR: 'Belge çok uzak',
  UNKNOWN_ERROR: 'Bilinmeyen hata',
  SUCCESS: 'Okuma başarılı',
};

function getResultComment(reason) {
  return RESULT_COMMENTS[reason] || RESULT_COMMENTS.UNKNOWN_ERROR;
}

function formatResultForCopy(r) {
  const lines = [
    'Belge: ' + (r.name || '—'),
    'Tip: ' + (r.docType || '—'),
    'Sonuç: ' + (r.finalResult || '—'),
    'Süre: ' + (r.durationMs != null ? r.durationMs + 'ms' : (r.durationSec != null ? r.durationSec + 's' : '—')),
    'Band: ' + (r.selectedBand || '—'),
    'OCR Deneme: ' + (r.ocrAttempts || '—'),
    'En Uzun Satır: ' + (r.longestLine || '—'),
    'Chevron (<): ' + (r.chevronCount != null ? r.chevronCount : '—'),
    'Parse: ' + (r.parseOk ? 'OK' : 'FAIL'),
    'Checksum: ' + (r.checksumOk ? 'OK' : 'FAIL'),
    'Sebep: ' + (r.failReason || '—'),
    'Yorum: ' + (r.comment || '—'),
  ];
  if (r.parsedFields) {
    const pf = r.parsedFields;
    lines.push('--- Parsed Fields ---');
    lines.push('Belge No: ' + (pf.documentNumber || '—'));
    lines.push('Doğum Tarihi: ' + (pf.birthDate || '—'));
    lines.push('Soyad: ' + (pf.surname || '—'));
    lines.push('Ad: ' + (pf.givenNames || '—'));
    if (pf.nationalId) lines.push('TC Kimlik No: ' + pf.nationalId + (pf.nationalIdValid ? ' ✓' : ' ⚠ Geçersiz'));
  }
  if (r.rawOcrText) {
    lines.push('--- Raw OCR ---');
    lines.push(r.rawOcrText.substring(0, 300));
  }
  return lines.join('\n');
}

function formatAllResultsForCopy(results, summary) {
  let md = '| # | Belge | Tip | Sonuç | Süre | Band | Deneme | Uzun Satır | <Count | DocNo | TC Kimlik No | DOB | Soyad | Ad | Yorum |\n';
  md += '|---|-------|-----|-------|------|------|--------|------------|--------|-------|--------------|-----|-------|----|---------|\n';
  results.forEach((r, i) => {
    const pf = r.parsedFields || {};
    const nid = pf.nationalId ? (pf.nationalId + (pf.nationalIdValid ? ' ✓' : ' ⚠')) : '—';
    md += '| ' + (i+1) + ' | ' + (r.name||'—') + ' | ' + (r.docType||'—') + ' | ' + (r.finalResult||'—') +
      ' | ' + (r.durationMs != null ? r.durationMs+'ms' : (r.durationSec != null ? r.durationSec+'s' : '—')) +
      ' | ' + (r.selectedBand||'—') + ' | ' + (r.ocrAttempts||'—') +
      ' | ' + (r.longestLine||'—') + ' | ' + (r.chevronCount != null ? r.chevronCount : '—') +
      ' | ' + (pf.documentNumber||'—') + ' | ' + nid +
      ' | ' + (pf.birthDate||'—') + ' | ' + (pf.surname||'—') + ' | ' + (pf.givenNames||'—') +
      ' | ' + (r.comment||'—') + ' |\n';
  });
  if (summary) md += '\n' + summary;
  return md;
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(
    () => showCamToast ? showCamToast('📋 Kopyalandı', 1500) : null,
    () => {}
  );
}

function showSerialReport() {
  const totalSec = Math.round((Date.now() - serialStartTime) / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const uniqueDocs = new Set(serialEntries.map(e => e.docId)).size;
  const avgSec = serialEntries.length > 0 ? (totalSec / serialEntries.length).toFixed(1) : '0.0';
  const summaryText = '📷 ' + serialEntries.length + ' tarama · 📄 ' + uniqueDocs + ' benzersiz belge · ⏱ ' + mm + ':' + ss + ' · Ort: ' + avgSec + 's/tarama';

  // Build structured results — every scan is a separate row
  const structuredResults = serialEntries.map((e) => ({
    name: e.name,
    docType: e.type,
    finalResult: 'SUCCESS',
    durationSec: Math.round((e.firstReadTime - serialStartTime) / 1000),
    selectedBand: e.selectedBand || '—',
    ocrAttempts: e.ocrAttempts || 1,
    longestLine: e.longestLine || 0,
    chevronCount: e.chevronCount != null ? e.chevronCount : 0,
    parseOk: true,
    checksumOk: true,
    failReason: null,
    comment: e.isDuplicate ? 'Tekrar okuma' : getResultComment('SUCCESS'),
    docId: e.docId,
    isDuplicate: e.isDuplicate || false,
    parsedFields: e.parsedFields || null,
    rawOcrText: e.rawOcrText || '',
  }));

  let html = '<table class="batch-table"><thead><tr>' +
    '<th>#</th><th>Ad Soyad</th><th>Belge No</th><th>TC Kimlik No</th><th>Band</th><th>Uzun</th><th>&lt;</th><th>DOB</th><th>Süre</th><th>Yorum</th><th></th>' +
    '</tr></thead><tbody>';

  structuredResults.forEach((r, i) => {
    const pf = r.parsedFields || {};
    const dupStyle = r.isDuplicate ? 'opacity:.6;' : '';
    const nid = pf.nationalId ? (pf.nationalId + (pf.nationalIdValid ? ' ✓' : ' ⚠')) : '';
    html += '<tr style="' + dupStyle + '">' +
      '<td>' + (i+1) + '</td>' +
      '<td>' + r.name + '</td>' +
      '<td style="font-family:monospace;font-size:.75rem">' + r.docId + '</td>' +
      '<td style="font-family:monospace;font-size:.72rem">' + nid + '</td>' +
      '<td>' + r.selectedBand + '</td>' +
      '<td>' + r.longestLine + '</td>' +
      '<td>' + r.chevronCount + '</td>' +
      '<td style="font-size:.75rem">' + (pf.birthDate || '—') + '</td>' +
      '<td>' + r.durationSec + 's</td>' +
      '<td style="font-size:.72rem;color:var(--muted)">' + r.comment + '</td>' +
      '<td><button onclick="copyToClipboard(formatResultForCopy(serialReportData[' + i + ']))" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--muted);cursor:pointer;font-size:.7rem">📋</button></td>' +
      '</tr>';
  });

  html += '</tbody></table>';
  html += '<div class="batch-summary">' + summaryText + '</div>';
  html += '<div style="text-align:center;margin-top:10px"><button class="btn ghost btn-sm" onclick="copyToClipboard(formatAllResultsForCopy(serialReportData,\'' + summaryText.replace(/'/g,'') + '\'))">📋 Tüm Sonuçları Kopyala</button></div>';

  window.serialReportData = structuredResults;
  document.getElementById('serial-report-body').innerHTML = html;
  goScreen('s-serial-report');
}

function leaveSerialReport() {
  // Reset session data only when leaving report
  serialEntries = [];
  serialScannedIds = [];
  serialCount = 0;
  serialTotalShots = 0;
  renderList();
  goScreen('s-home');
}

function nextScan() {
  goScreen('s-scan');
  setTimeout(() => startCamera(), 100);
}

function renderList() {
  const list = getAllPassports();
  const el   = document.getElementById('pp-list');
  const hasSaved = loadPassports().length > 0;
  const sb = document.getElementById('serial-btn');
  if (sb) sb.style.display = 'flex';
  const delBtn = document.getElementById('delete-all-btn');
  if (delBtn) delBtn.style.display = hasSaved ? 'flex' : 'none';
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">Henüz kayıtlı pasaport yok.</div>`;
    return;
  }
  el.innerHTML = list.map((p, i) => `
    <div class="pp-card" onclick="viewPassport(${i})">
      <span style="font-size:1.6rem;flex-shrink:0">${flag(p.nation)}</span>
      <div style="flex:1">
        <div class="pp-name">${p.name}</div>
        <div class="pp-meta">${p.nation} · ${p.line2.substring(0,9).replace(/</g,'')}</div>
      </div>
      <span style="color:var(--muted);font-size:1.1rem">›</span>
    </div>`).join('');
}

function deleteAllPassports() {
  const saved = loadPassports();
  if (!saved.length) return;
  if (!confirm(saved.length + ' kayıtlı belge silinecek. Emin misiniz?')) return;
  savePassports([]);
  renderList();
}

function viewPassport(idx) {
  currentIdx = idx;
  const p = getAllPassports()[idx];
  if (!p) return;
  const type = p.type || 'TD3';
  const lines = type === 'TD1'
    ? [p.line1, p.line2, p.line3 || '']
    : [p.line1, p.line2];
  showParsed(parseResult({type, lines}), {...p, type, lines}, false);
}

function deleteCurrent() {
  const p = getAllPassports()[currentIdx];
  if (!p || p.id.startsWith('demo_')) { alert('Demo kayıtlar silinemez.'); return; }
  if (!confirm(`"${p.name}" silinsin mi?`)) return;
  savePassports(loadPassports().filter(x => x.id !== p.id));
  goHome();
}

// ── TABS ────────────────────────────────────────────────────────────────
function setTab(t) {
  ['cam','img','bulk'].forEach(x => {
    const tab = document.getElementById('tab-'+x);
    const content = document.getElementById('tab-'+x+'-content');
    if (tab) tab.classList.toggle('active', x===t);
    if (content) content.style.display = x===t ? 'flex' : 'none';
  });
  if (t === 'cam') startCamera();
  else stopCamera();
}

// ── INIT / WORKER ───────────────────────────────────────────────────────
async function init() {
  updatePill('loading');
  document.getElementById('load-prog').style.width = '10%';
  document.getElementById('load-msg').textContent  = 'OCR motoru yükleniyor…';

  try {
    const origWarn = console.warn;
    console.warn = (...args) => {
      const msg = args[0]?.toString() || '';
      if (msg.includes('Image too small') || msg.includes('Line cannot be recognized')) return;
      origWarn.apply(console, args);
    };

    const logger = m => {
      if (m.status === 'loading tesseract core')       setLoadProg(20, 'Tesseract yükleniyor…');
      if (m.status === 'initializing tesseract')       setLoadProg(40, 'Motor başlatılıyor…');
      if (m.status === 'loading language traineddata') {
        const p = Math.round((m.progress||0)*100);
        setLoadProg(50 + Math.round((m.progress||0)*40), `Dil modeli indiriliyor %${p}…`);
      }
      if (m.status === 'initializing api')             setLoadProg(92, 'Hazırlanıyor…');
    };

    setLoadProg(40, 'OCR motoru başlatılıyor…');
    const localBase = window.location.origin + window.location.pathname.replace(/[^/]+$/, '');
    let mrzLoaded = false;

    for (const fname of ['mrz.traineddata', 'mrz.traineddata.gz']) {
      try {
        setLoadProg(43, `MRZ modeli kontrol: ${fname}…`);
        const r = await fetch(localBase + fname);
        if (!r.ok) continue;
        setLoadProg(55, 'MRZ modeli yükleniyor…');
        worker = await Tesseract.createWorker('mrz', 1, {
          workerPath:  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
          corePath:    'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js',
          langPath:    localBase,
          logger,
        });
        mrzLoaded = true;
        setLoadProg(85, 'MRZ modeli hazır ✓');
        break;
      } catch(e) {
        if (worker) { try { await worker.terminate(); } catch(_){} worker = null; }
      }
    }

    if (!mrzLoaded) {
      setLoadProg(48, 'Standart model yükleniyor (eng)…');
      worker = await Tesseract.createWorker('eng', 1, { logger });
    }

    await worker.setParameters({
      tessedit_char_whitelist:    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
      tessedit_pageseg_mode:      '6',
      preserve_interword_spaces:  '0',
      tessedit_do_invert:         '0',
      textord_min_linesize:       '2.5',
    });
    workerReady = true;
    const modelName = mrzLoaded ? 'mrz.traineddata ✓' : 'eng (düşük doğruluk)';
    setLoadProg(100, `Hazır! — ${modelName}`);
    updatePill('ready');
    addLog('skip', '🚀 Sistem hazır', [
      `OCR Modeli: ${modelName}`,
      mrzLoaded ? 'MRZ modeli yüklendi' : '⚠ mrz.traineddata bulunamadı',
    ]);
    await new Promise(r => setTimeout(r, 400));
    renderList();
    goScreen('s-home');
  } catch(e) {
    setLoadProg(100, '');
    document.getElementById('load-msg').textContent = 'Hata: ' + e.message;
  }
}

function setLoadProg(p, msg) {
  document.getElementById('load-prog').style.width = p + '%';
  if (msg) document.getElementById('load-msg').textContent = msg;
}

function updatePill(state) {
  const pill = document.getElementById('cache-pill');
  const txt  = document.getElementById('pill-txt');
  if (state === 'loading') { pill.className = 'id'; txt.textContent = 'Yükleniyor'; }
  if (state === 'ready')   { pill.className = 'ready'; txt.textContent = 'Hazır ✓'; }
  if (state === 'offline') { pill.className = 'offline'; txt.textContent = 'Çevrimdışı'; }
}

// ── STOP SCAN ──────────────────────────────────────────────────────────
function stopScan() {
  serialMode = false;
  stopCamera();
  serialCooldown = false;
  if (serialCooldownTimer) { clearTimeout(serialCooldownTimer); serialCooldownTimer = null; }
  if (serialTimerInterval) { clearInterval(serialTimerInterval); serialTimerInterval = null; }
  document.getElementById('serial-panel').style.display = 'none';
  document.getElementById('serial-finish-btn').style.display = 'none';
  document.getElementById('cam-cancel-btn').style.display = '';
  document.getElementById('tab-bulk').style.display = 'none';
  renderList();
  goScreen('s-home');
}

// ── FILE UPLOAD ─────────────────────────────────────────────────────────
function cancelProcessing() {
  processingCancelled = true;
  goHome();
}

function resetImageUpload() {
  document.getElementById('img-preview-wrap').style.display = 'none';
  document.getElementById('upload-zone-wrap').style.display = 'block';
  document.getElementById('file-in').value = '';
  loadedImg = null;
}

function onFile(e) {
  const file = e.target.files[0]; if (!file) return;
  stopCamera();
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      loadedImg = img;
      const preview = document.getElementById('img-preview');
      const info    = document.getElementById('img-preview-info');
      const wrap    = document.getElementById('img-preview-wrap');
      const zone    = document.getElementById('upload-zone-wrap');
      preview.src   = ev.target.result;
      info.textContent = `${img.naturalWidth}×${img.naturalHeight}px · ${(file.size/1024).toFixed(0)} KB`;
      zone.style.display  = 'none';
      wrap.style.display  = 'flex';
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

async function startImageScan() {
  if (!loadedImg) return;
  if (!workerReady) {
    goScreen('s-processing');
    while (!workerReady) await new Promise(r => setTimeout(r, 200));
  }
  processImage(loadedImg);
}

const dz = document.getElementById('drop-zone');
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop',      e => {
  e.preventDefault(); dz.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) onFile({ target: { files: [f] } });
});

// ── SAVE & SHOW ─────────────────────────────────────────────────────────
function captureDocPhoto() {
  try {
    if (!video || !video.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = Math.min(video.videoWidth, 800);
    c.height = Math.round(c.width * video.videoHeight / video.videoWidth);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  } catch(e) { return null; }
}

function saveAndShow(mrzResult) {
  const parsed = parseResult(mrzResult);
  const mrzName = MRZCore.parseMRZName(mrzResult);
  parsed.surname = mrzName.surname;
  parsed.given   = mrzName.given;
  const photo = captureDocPhoto();
  const entry = {
    id: 'pp_' + Date.now(),
    line1: mrzResult.lines[0],
    line2: mrzResult.lines[1],
    line3: mrzResult.lines[2] || '',
    type:  mrzResult.type,
    name:  parsed.surname + (parsed.given ? ', ' + parsed.given : ''),
    nation: parsed.nation,
    photo: photo || '',
    addedAt: Date.now()
  };
  const saved = loadPassports();
  saved.push(entry);
  savePassports(saved);
  const all = getAllPassports();
  currentIdx = all.findIndex(p => p.id === entry.id);
  showParsed(parsed, entry, true);
}

function toggleFullPhoto() {
  const fs = document.getElementById('photo-fullscreen');
  fs.style.display = fs.style.display === 'flex' ? 'none' : 'flex';
}

function showParsed(p, entry, isNew) {
  const cs = p.cs || {};
  function ck(v) {
    if (v===null||v===undefined) return '';
    return `<span class="${v?'ok':'fail'}">${v?'✓':'✗'}</span>`;
  }

  // Belge fotoğrafı göster
  const photoWrap = document.getElementById('doc-photo-wrap');
  const photoEl = document.getElementById('doc-photo');
  const photoFull = document.getElementById('doc-photo-full');
  if (entry.photo) {
    photoEl.src = entry.photo;
    photoFull.src = entry.photo;
    photoWrap.style.display = 'block';
  } else {
    photoWrap.style.display = 'none';
  }
  document.getElementById('photo-fullscreen').style.display = 'none';

  document.getElementById('edit-surname').value = p.surname || '';
  document.getElementById('edit-given').value   = p.given   || '';

  const rows = [
    ['Belge Tipi',     p.docType  || '—', ''],
    ['Pasaport/Doc No',p.passNo   || '—', ck(cs.passOk)],
    ['Uyruk',          p.nation   || '—', ''],
    ['Doğum Tarihi',   fmtDate(p.dob),    ck(cs.dobOk)],
    ['Cinsiyet',       p.sex==='M'?'Erkek':p.sex==='F'?'Kadın':(p.sex||'—'), ''],
    ['Son Geçerlilik', fmtDate(p.expiry), ck(cs.expOk)],
  ];
  // TC Kimlik No — only for TD1
  if (p.nationalId) {
    const nidValid = p.nationalIdValid;
    const nidBadge = nidValid
      ? '<span class="ok">✓</span>'
      : '<span class="fail">⚠ Geçersiz</span>';
    rows.push(['TC Kimlik No', p.nationalId, nidBadge]);
  }
  document.getElementById('res-fields').innerHTML = rows.map(([l,v,b]) => `
    <div class="row">
      <div class="rl">${l}</div>
      <div class="rv">${v}${b}</div>
    </div>`).join('');

  const allOk = cs.passOk && cs.dobOk && cs.expOk;
  const banner = document.getElementById('res-banner');
  banner.className = 'banner ' + (allOk ? 'b-ok' : 'b-warn');
  document.getElementById('res-icon').textContent = allOk ? '✅' : '⚠️';
  document.getElementById('res-txt').textContent  = allOk
    ? `${p.docType} — Tüm checksum'lar geçerli ✓`
    : `${p.docType} — MRZ okundu`;

  const rawLines = [entry.line1, entry.line2, entry.line3].filter(Boolean).join('\n');
  document.getElementById('mrz-raw').textContent = rawLines;
  document.getElementById('del-btn').style.display = 'flex';

  if (serialMode) {
    serialCount++;
    document.getElementById('next-scan-btn').style.display = 'flex';
    document.getElementById('next-scan-btn').textContent =
      `📷 Sonraki Pasaport → (${serialCount} tarandı)`;
  } else {
    document.getElementById('next-scan-btn').style.display = 'none';
  }

  goScreen('s-result');
}

function updateSavedName() {
  const surname = document.getElementById('edit-surname').value.trim();
  const given   = document.getElementById('edit-given').value.trim();
  const name    = surname + (given ? ', ' + given : '');
  const all = getAllPassports();
  const p   = all[currentIdx];
  if (!p || p.id.startsWith('demo_')) return;
  const saved = loadPassports();
  const idx   = saved.findIndex(x => x.id === p.id);
  if (idx >= 0) { saved[idx].name = name; savePassports(saved); }
}

function fmtDate(d) {
  if (!d || d.length < 6) return d || '—';
  const yy=+d.substring(0,2), mm=d.substring(2,4), dd=d.substring(4,6);
  const currentYY = new Date().getFullYear() % 100;
  const year = yy <= (currentYY + 10) ? 2000+yy : 1900+yy;
  return `${dd}/${mm}/${year}`;
}


function showError(msg) {
  document.getElementById('err-msg').textContent = msg;
  goScreen('s-error');
}

window.addEventListener('offline', () => updatePill('offline'));
window.addEventListener('online',  () => workerReady && updatePill('ready'));

// Ekran döndürme ve resize'da overlay'i yeniden çiz (debounced)
let _resizeTimer = null;
function onVideoResize() {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (scanning) { resizeOverlay(); drawOverlayState('searching'); }
  }, 100);
}
window.addEventListener('resize', onVideoResize);
window.addEventListener('orientationchange', () => setTimeout(onVideoResize, 200));
