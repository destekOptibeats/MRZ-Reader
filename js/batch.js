// ═══════════════════════════════════════════════════════════════════════
// BATCH PATH — Unguided Capture (file-based)
// No screen geometry. Uses dynamic crop ratios + all rotations.
// Includes bulk serial scan, HEIC helpers, image loaders.
// These functions must NOT be used by camera path.
// ═══════════════════════════════════════════════════════════════════════

async function startBulkSerialFromPhotos(files) {
  if (!files || !files.length || !workerReady) return;
  if (!serialMode) startSerialScan();
  await new Promise(r => setTimeout(r, 200));
  stopCamera();

  const prog = document.getElementById('bulk-prog');
  const status = document.getElementById('bulk-status');
  document.getElementById('bulk-progress').style.display = 'block';

  for (let i = 0; i < files.length; i++) {
    prog.style.width = ((i / files.length) * 100) + '%';
    status.textContent = (i+1) + '/' + files.length + ': ' + files[i].name;

    let imgData = null;
    try { imgData = await loadImageFast(files[i]); }
    catch(e) { continue; }

    // Upload pipeline ile işle (aynı karar ağacı)
    const ocrResult = await batchProcessImage(imgData.img, null);
    imgData.cleanup();

    if (ocrResult.result) {
      addSerialResult(ocrResult.result);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  prog.style.width = '100%';
  status.textContent = '✅ ' + files.length + ' fotoğraf işlendi';
  document.getElementById('file-in').value = '';
  document.getElementById('bulk-progress').style.display = 'none';
}

// ── BATCH HELPERS ──────────────────────────────────────────────────────

// HEIC detection
function isHEIC(file) {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif') || type.includes('heic') || type.includes('heif');
}

// Lazy-load heic2any — returns promise, caches result
let _heic2anyPromise = null;
function ensureHeic2any() {
  if (window.heic2any) return Promise.resolve(true);
  if (_heic2anyPromise) return _heic2anyPromise;
  _heic2anyPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
    s.onload = () => resolve(!!window.heic2any);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return _heic2anyPromise;
}

// Convert HEIC file to JPEG blob
async function convertHEIC(file) {
  const loaded = await ensureHeic2any();
  if (!loaded) throw new Error('heic2any yüklenemedi');
  const blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.8 });
  return Array.isArray(blob) ? blob[0] : blob;
}

// Load image via HTMLImageElement + objectURL (reliable, works everywhere)
function loadImageElement(blob) {
  const objectURL = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      if (im.naturalWidth > 50 && im.naturalHeight > 50) {
        resolve({ img: im, cleanup: () => URL.revokeObjectURL(objectURL) });
      } else {
        URL.revokeObjectURL(objectURL);
        reject(new Error('Image too small: ' + im.naturalWidth + 'x' + im.naturalHeight));
      }
    };
    im.onerror = () => { URL.revokeObjectURL(objectURL); reject(new Error('Image decode failed')); };
    im.src = objectURL;
  });
}

// Fast image loading: createImageBitmap (validated) > HTMLImageElement fallback
async function loadImageFast(file) {
  let blob = file;

  // HEIC conversion
  if (isHEIC(file)) {
    try {
      blob = await convertHEIC(file);
      // Validate converted blob
      if (!blob || blob.size < 100) throw new Error('Converted blob too small');
    } catch(e) { throw new Error('HEIC dönüştürülemedi: ' + e.message); }
  }

  // Try createImageBitmap first — validate dimensions before accepting
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      if (bmp.width > 50 && bmp.height > 50) {
        return { img: bmp, cleanup: () => {} };
      }
      // Dimensions invalid, close bitmap and fall through
      bmp.close();
    } catch(e) { /* fallback to HTMLImageElement */ }
  }

  // Fallback: HTMLImageElement + objectURL
  return loadImageElement(blob);
}

// ═══════════════════════════════════════════════════════════════════════
// BATCH PATH — Unguided Capture (file-based)
// No screen geometry. Uses dynamic crop ratios + all rotations.
// These functions must NOT be used by camera path.
// ═══════════════════════════════════════════════════════════════════════

function resizeForOCR(img, maxSide) {
  maxSide = maxSide || 1400;
  // ImageBitmap has .width/.height; HTMLImageElement has .naturalWidth/.naturalHeight
  const w = img.width || img.naturalWidth || 0;
  const h = img.height || img.naturalHeight || 0;
  if (w <= 50 || h <= 50) return null;
  const longSide = Math.max(w, h);
  const scale = longSide > maxSide ? maxSide / longSide : 1;
  const rw = Math.round(w * scale), rh = Math.round(h * scale);
  if (rw <= 50 || rh <= 50) return null;
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  // Explicit 9-param drawImage: source full rect → dest full rect
  c.getContext('2d').drawImage(img, 0, 0, w, h, 0, 0, rw, rh);
  return c;
}

// Simple stable MRZ preprocessing: grayscale + fixed threshold + alpha=255
function batchPreprocessMRZ(srcCanvas) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  if (!sw || !sh) return srcCanvas;

  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0, sw, sh, 0, 0, sw, sh);

  const imgData = ctx.getImageData(0, 0, sw, sh);
  const data = imgData.data;

  // Simple grayscale + fixed threshold
  let nonZero = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const val = gray > 140 ? 255 : 0;

    data[i]     = val;
    data[i + 1] = val;
    data[i + 2] = val;
    data[i + 3] = 255; // always opaque

    if (val !== 0) nonZero++;
  }

  ctx.putImageData(imgData, 0, 0);

  // Validation: log pixel health
  const totalPixels = sw * sh;
  const pct = ((nonZero / totalPixels) * 100).toFixed(1);
  console.log('[Preprocess]', sw + 'x' + sh, 'non-zero:', nonZero + '/' + totalPixels, '(' + pct + '%)');
  if (nonZero < totalPixels * 0.01) {
    console.warn('[Preprocess] WARNING: almost all pixels are black — image may be too dark');
  }
  if (nonZero > totalPixels * 0.99) {
    console.warn('[Preprocess] WARNING: almost all pixels are white — image may be too bright');
  }

  return c;
}

// Batch-only: crop bottom N% of image (no screen geometry)
function batchCropBottom(srcCanvas, ratio) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  if (!sw || !sh) return srcCanvas;
  const cropH = Math.min(Math.round(sh * ratio), sh);
  const sy = Math.max(sh - cropH, 0);
  const c = document.createElement('canvas');
  c.width = sw; c.height = cropH;
  c.getContext('2d').drawImage(srcCanvas, 0, sy, sw, cropH, 0, 0, sw, cropH);
  return c;
}

// Simple upscale for small crop canvases
function batchUpscaleIfNeeded(canvas) {
  if (canvas.height >= 400) return canvas;
  const factor = 2;
  const c = document.createElement('canvas');
  c.width = canvas.width * factor;
  c.height = canvas.height * factor;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, c.width, c.height);
  return c;
}

// ── SHARED SCORING HELPERS (used by camera + batch) ─────────────────────
function longestOCRLine(text) {
  if (!text) return 0;
  return text.split('\n').reduce((max, l) => Math.max(max, l.replace(/[^A-Z0-9<]/gi, '').length), 0);
}

function countChevrons(text) {
  return (text.match(/</g) || []).length;
}

// Rotate a canvas by degrees (0, 90, 180, 270). For 90/270, width/height swap.
function rotateCanvas(srcCanvas, deg) {
  if (deg === 0) return srcCanvas;
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const swap = (deg === 90 || deg === 270);
  const dw = swap ? sh : sw;
  const dh = swap ? sw : sh;
  const c = document.createElement('canvas');
  c.width = dw; c.height = dh;
  const ctx = c.getContext('2d');
  ctx.translate(dw / 2, dh / 2);
  ctx.rotate(deg * Math.PI / 180);
  ctx.drawImage(srcCanvas, -sw / 2, -sh / 2, sw, sh);
  return c;
}

// Score OCR text for MRZ likelihood (higher = better)
function scoreMRZText(text) {
  const longest = longestOCRLine(text);
  const chevrons = countChevrons(text);
  // Bonus for MRZ-length lines (30 for TD1, 44 for TD3)
  let lineBonus = 0;
  const lines = text.split('\n').map(l => l.replace(/[^A-Z0-9<]/gi, ''));
  for (const l of lines) {
    if (l.length >= 42 && l.length <= 46) lineBonus += 20;
    else if (l.length >= 28 && l.length <= 32) lineBonus += 15;
  }
  return longest * 2 + chevrons + lineBonus;
}

async function fastBatchOCR(resized, timings, ocrWorker, fileName, fileIndex) {
  const wr = ocrWorker || worker;
  const isFirstFile = (fileIndex === 0);
  const rotations = [0, 90, 180, 270];

  timings.resizedSize = resized.width + 'x' + resized.height;
  console.log('[BatchOCR]', fileName || '', 'resized:', resized.width, 'x', resized.height);

  const isLandscape = resized.width > resized.height;
  const crops = [
    isLandscape ? 0.50 : 0.45,
    isLandscape ? 0.65 : 0.60,
    1.0,
  ];

  let lastDiag = null;
  let t;
  let bestScore = -1, bestText = '', bestDeg = 0;

  for (let i = 0; i < crops.length; i++) {
    const ratio = crops[i];
    const attemptKey = 'ocr' + (i + 1);

    t = performance.now();
    const cropped = ratio >= 1.0 ? resized : batchCropBottom(resized, ratio);
    if (i === 0) timings.crop = Math.round(performance.now() - t);

    console.log('[BatchOCR] crop attempt', i+1, 'size:', cropped.width + 'x' + cropped.height);

    if (cropped.width <= 100 || cropped.height <= 100) {
      console.warn('[BatchOCR] crop attempt', i+1, 'SKIPPED: too small');
      continue;
    }

    // Try all rotations, collect scores
    bestScore = -1; bestText = ''; bestDeg = 0;

    t = performance.now();
    for (const deg of rotations) {
      const rotated = rotateCanvas(cropped, deg);
      const preprocessed = batchPreprocessMRZ(rotated);
      const ocrInput = batchUpscaleIfNeeded(preprocessed);

      if (ocrInput.width <= 100 || ocrInput.height <= 100) continue;

      try {
        const { data: { text } } = await wr.recognize(ocrInput);
        const score = scoreMRZText(text);
        const longest = longestOCRLine(text);
        const chevrons = countChevrons(text);

        if (isFirstFile) {
          console.log('[BatchOCR] crop', i+1, 'rot', deg + '°',
            '→ longest:', longest, '<count:', chevrons, 'score:', score);
        }

        // Immediate success: try parse+checksum on promising results
        if (longest >= 28) {
          const result = extractMRZ(clean(text));
          if (result && validateMRZ(result).valid) {
            timings[attemptKey] = Math.round(performance.now() - t);
            timings['sz' + (i+1)] = ocrInput.width + 'x' + ocrInput.height;
            console.log('[BatchOCR] SUCCESS at crop', i+1, 'rot', deg + '°');
            return { extracted: result, diag: diagnoseMRZ(text), attempts: i + 1,
              longestLine: longest, chevronCount: chevrons, rawOcrText: text,
              selectedBand: 'crop' + (i+1) + '/rot' + deg };
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestText = text;
          bestDeg = deg;
        }
      } catch(e) {
        if (isFirstFile) console.error('[BatchOCR] rot', deg + '° error:', e.message);
      }
    }
    timings[attemptKey] = Math.round(performance.now() - t);

    if (isFirstFile) {
      console.log('[BatchOCR] crop', i+1, 'best rotation:', bestDeg + '°', 'score:', bestScore);
    }

    // Try parse on best rotation result
    if (bestText && longestOCRLine(bestText) >= 28) {
      const result = extractMRZ(clean(bestText));
      if (result && validateMRZ(result).valid) {
        console.log('[BatchOCR] SUCCESS (best rot) at crop', i+1, 'rot', bestDeg + '°');
        return { extracted: result, diag: diagnoseMRZ(bestText), attempts: i + 1,
          longestLine: longestOCRLine(bestText), chevronCount: countChevrons(bestText),
          rawOcrText: bestText, selectedBand: 'crop' + (i+1) + '/rot' + bestDeg };
      }
    }

    if (bestText) lastDiag = diagnoseMRZ(bestText);

    // If best longest line < 30 and not full image, try wider crop
    if (longestOCRLine(bestText) < 30 && ratio < 1.0) continue;
  }

  // Include best OCR metadata even on failure
  const failLongest = bestText ? longestOCRLine(bestText) : 0;
  const failChevrons = bestText ? countChevrons(bestText) : 0;
  return { extracted: null, diag: lastDiag, attempts: crops.length,
    longestLine: failLongest, chevronCount: failChevrons,
    rawOcrText: bestText || '', selectedBand: '—' };
}

// Create a dedicated batch Tesseract worker (isolated from global worker)
async function createBatchWorker() {
  const localBase = window.location.origin + window.location.pathname.replace(/[^/]+$/, '');
  let bw = null;
  let mrzLoaded = false;

  for (const fname of ['mrz.traineddata', 'mrz.traineddata.gz']) {
    try {
      const r = await fetch(localBase + fname);
      if (!r.ok) continue;
      bw = await Tesseract.createWorker('mrz', 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
        corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js',
        langPath:   localBase,
      });
      mrzLoaded = true;
      break;
    } catch(e) {
      if (bw) { try { await bw.terminate(); } catch(_){} bw = null; }
    }
  }

  if (!mrzLoaded) {
    bw = await Tesseract.createWorker('eng', 1, {});
  }

  await bw.setParameters({
    tessedit_char_whitelist:   'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
    tessedit_pageseg_mode:     '6',
    preserve_interword_spaces: '0',
    tessedit_do_invert:        '0',
    textord_min_linesize:      '2.5',
  });

  return bw;
}

// ── BATCH TEST ─────────────────────────────────────────────────────────
async function startBatchTest(files) {
  if (!files || !files.length) return;
  if (!workerReady) {
    alert('OCR motoru henüz hazır değil, lütfen bekleyin.');
    return;
  }
  goScreen('s-batch');
  const prog = document.getElementById('batch-prog');
  const status = document.getElementById('batch-status');
  const results = document.getElementById('batch-results');
  document.getElementById('batch-progress').style.display = 'block';
  results.innerHTML = '';

  // Create dedicated batch worker (isolated from global worker)
  let batchWorker = null;
  const batchT0 = performance.now();
  let workerInitTime = 0;

  try {
    status.textContent = 'Batch OCR worker başlatılıyor…';
    const wiT = performance.now();
    batchWorker = await createBatchWorker();
    workerInitTime = Math.round(performance.now() - wiT);
  } catch(e) {
    results.innerHTML = '<div class="batch-reason">Batch worker oluşturulamadı: ' + e.message + '</div>';
    document.getElementById('batch-file-in').value = '';
    return;
  }

  const rows = [];
  let successCount = 0;
  let totalTime = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      prog.style.width = ((i / files.length) * 100) + '%';
      status.textContent = (i+1) + '/' + files.length + ' işleniyor: ' + file.name;

      const timings = { decode: 0, resize: 0, crop: 0, ocr1: 0, ocr2: 0, total: 0 };
      const t0 = performance.now();

      // Fast image loading
      let imgData = null;
      let t = performance.now();
      try {
        imgData = await loadImageFast(file);
        timings.decode = Math.round(performance.now() - t);
      } catch(e) {
        rows.push({ name: file.name, ok: false, type: '—', cs: '—', time: 0, timing: '', reason: (isHEIC(file) ? 'HEIC: ' : '') + e.message });
        continue;
      }

      // Cleanup objectURL after creating HTMLImageElement for batchProcessImage
      // batchProcessImage needs an img element (uses .naturalWidth/.naturalHeight)
      const batchImg = imgData.img;

      // Use shared pipeline (same as upload)
      const ocrResult = await batchProcessImage(batchImg, batchWorker);
      imgData.cleanup();

      timings.total = Math.round(performance.now() - t0);
      totalTime += timings.total;
      const sm = ocrResult.summary;
      const timingStr = 'OCR:' + sm.totalOCR + ' rot:' + (sm.selectedRotations||[]).join(',') + ' T:' + timings.total + 'ms';

      if (ocrResult.result) {
        successCount++;
        const v = validateMRZ(ocrResult.result);
        const parsed = parseResult(ocrResult.result);
        const batchMrzName = MRZCore.parseMRZName(ocrResult.result);
        parsed.surname = batchMrzName.surname;
        parsed.given   = batchMrzName.given;
        const csStr = ['Pass','DOB','EXP'].map((k, idx) => {
          const key = ['passOk','dobOk','expOk'][idx];
          return k + (v.checksums[key] ? '✓' : '✗');
        }).join(' ');
        const winner = sm.winner || {};
        const row = {
          name: file.name, ok: true, docType: ocrResult.result.type, cs: csStr,
          finalResult: 'SUCCESS', durationMs: timings.total, timing: timingStr,
          selectedBand: winner.method || '—', ocrAttempts: sm.totalOCR,
          longestLine: 0, chevronCount: 0,
          parseOk: true, checksumOk: true,
          failReason: null, comment: getResultComment('SUCCESS'), reason: '',
          rawOcrText: '', batchLog: ocrResult.log,
          parsedFields: {
            documentNumber: (parsed.passNo || '').replace(/</g,'') || null,
            birthDate: parsed.dob || null,
            surname: parsed.surname || null,
            givenNames: parsed.given || null,
            nationalId: parsed.nationalId || null,
            nationalIdValid: parsed.nationalIdValid || false,
          }
        };
        rows.push(row);
      } else {
        const row = {
          name: file.name, ok: false, docType: '—', cs: '—',
          finalResult: 'FAIL', durationMs: timings.total, timing: timingStr,
          selectedBand: '—', ocrAttempts: sm.totalOCR,
          longestLine: 0, chevronCount: 0,
          parseOk: false, checksumOk: false,
          failReason: 'NO_MRZ', comment: 'Tüm yöntemler başarısız', reason: 'Tüm yöntemler başarısız',
          rawOcrText: '', batchLog: ocrResult.log,
          parsedFields: null
        };
        rows.push(row);
      }
    }
  } finally {
    // Always terminate and clear the dedicated batch worker
    if (batchWorker) {
      try { await batchWorker.terminate(); } catch(_) {}
      batchWorker = null;
    }
  }

  const batchTotal = Math.round(performance.now() - batchT0);
  prog.style.width = '100%';
  status.textContent = 'Tamamlandı';
  const avg = files.length > 0 ? Math.round(totalTime / files.length) : 0;

  // Store for copy access
  window.batchReportData = rows;
  const batchSummaryText = successCount + '/' + files.length + ' başarılı, ort ' + avg + 'ms/dosya · Worker init: ' + workerInitTime + 'ms · Toplam: ' + batchTotal + 'ms';

  results.innerHTML = '<table class="batch-table"><thead><tr>' +
    '<th>Dosya</th><th>Sonuç</th><th>Tip</th><th>CS</th><th>Yöntem</th><th>OCR</th><th>DocNo</th><th>TC Kimlik No</th><th>DOB</th><th>Soyad</th><th>Ad</th><th>Süre</th><th></th>' +
    '</tr></thead><tbody>' +
    rows.map((r, idx) => {
      const pf = r.parsedFields || {};
      const nid = pf.nationalId ? (pf.nationalId + (pf.nationalIdValid ? ' ✓' : ' ⚠')) : '';
      const logBtn = r.batchLog && r.batchLog.length ? '<button onclick="copyToClipboard(batchReportData[' + idx + '].batchLog.join(\'\\n\'))" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--muted);cursor:pointer;font-size:.7rem" title="Log kopyala">📋</button>' : '';
      return '<tr>' +
      '<td>' + r.name + '</td>' +
      '<td class="' + (r.ok ? 'bt-ok' : 'bt-fail') + '">' + (r.ok ? '✅' : '❌') + '</td>' +
      '<td>' + (r.docType || '—') + '</td>' +
      '<td style="font-size:.7rem">' + (r.cs || '—') + '</td>' +
      '<td style="font-size:.7rem">' + (r.selectedBand || '—') + '</td>' +
      '<td>' + (r.ocrAttempts || 0) + '</td>' +
      '<td style="font-family:monospace;font-size:.72rem">' + (pf.documentNumber || '—') + '</td>' +
      '<td style="font-family:monospace;font-size:.72rem">' + nid + '</td>' +
      '<td style="font-size:.72rem">' + (pf.birthDate || '—') + '</td>' +
      '<td style="font-size:.72rem">' + (pf.surname || '—') + '</td>' +
      '<td style="font-size:.72rem">' + (pf.givenNames || '—') + '</td>' +
      '<td>' + (r.durationMs || 0) + 'ms</td>' +
      '<td>' + logBtn + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table>' +
    '<div class="batch-summary">' + batchSummaryText + '</div>' +
    '<div style="text-align:center;margin-top:10px">' +
    '<button class="btn ghost btn-sm" onclick="copyToClipboard(formatAllResultsForCopy(batchReportData,\'' + batchSummaryText.replace(/'/g,'') + '\'))">📋 Tüm Sonuçları Kopyala</button> ' +
    '<button class="btn ghost btn-sm" onclick="copyAllBatchLogs()">📋 Tüm Logları Kopyala</button>' +
    '</div>';

  document.getElementById('batch-file-in').value = '';
}

function copyAllBatchLogs() {
  if (!window.batchReportData) return;
  var text = window.batchReportData.map(function(r, i) {
    var header = '=== ' + (i+1) + '. ' + r.name + ' (' + (r.ok ? 'SUCCESS' : 'FAIL') + ') ===';
    var log = (r.batchLog || []).join('\n');
    return header + '\n' + log;
  }).join('\n\n');
  copyToClipboard(text);
}
