// js/mrz-pipeline.js
// Image processing pipeline — shared between main app and regression test harness.
// Must be loaded AFTER mrz-core.js and BEFORE the main inline <script>.

(function () {
  'use strict';

  // mrz-core.js must be loaded first — destructure needed functions
  const { extractMRZ, clean, validateMRZ, diagnoseMRZ, parseResult, correctCheckDigits } = window.MRZCore;

  // Maximum Tesseract calls per image — hard cap
  const MAX_OCR = 8;
  // Maximum check-digit positions allowed to be corrected in a single result
  const MAX_CORRECTIONS = 3;

  // ── CANVAS UTILITIES ──────────────────────────────────────────────────────

  // Alt bölgeyi crop et — explicit dimensions, clamped to source bounds
  function cropBottom(srcCanvas, ratio) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    if (!sw || !sh) return srcCanvas; // safety
    const cropH = Math.min(Math.round(sh * ratio), sh);
    const sy = Math.max(sh - cropH, 0);
    const cropW = sw;
    const c = document.createElement('canvas');
    c.width = cropW;
    c.height = cropH;
    c.getContext('2d').drawImage(srcCanvas,
      0, sy, cropW, cropH,
      0, 0, cropW, cropH);
    return c;
  }

  // Resize so long side = maxSide, preserve aspect ratio
  function resizeForOCR(img, maxSide) {
    maxSide = maxSide || 1400;
    const w = img.width || img.naturalWidth || 0;
    const h = img.height || img.naturalHeight || 0;
    if (w <= 50 || h <= 50) return null;
    const longSide = Math.max(w, h);
    const scale = longSide > maxSide ? maxSide / longSide : 1;
    const rw = Math.round(w * scale), rh = Math.round(h * scale);
    if (rw <= 50 || rh <= 50) return null;
    const c = document.createElement('canvas');
    c.width = rw; c.height = rh;
    c.getContext('2d').drawImage(img, 0, 0, w, h, 0, 0, rw, rh);
    return c;
  }

  // ── BINARIZATION ─────────────────────────────────────────────────────────

  // Otsu's method: find threshold that maximises between-class variance
  function computeOtsuThreshold(gray) {
    const hist = new Int32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, maxVar = 0, thresh = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const v = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
      if (v > maxVar) { maxVar = v; thresh = t; }
    }
    return thresh;
  }

  // Binarize: grayscale → Otsu threshold → black text / white background.
  // Handles inverted images (dark background) automatically.
  function batchPreprocessMRZ(srcCanvas) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    if (!sw || !sh) return srcCanvas;

    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, sw, sh, 0, 0, sw, sh);

    const imgData = ctx.getImageData(0, 0, sw, sh);
    const data = imgData.data;

    // Build grayscale array for Otsu
    const gray = new Uint8Array(sw * sh);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    // Otsu threshold, but never below 140 (the proven minimum for document text).
    const thresh = Math.max(140, computeOtsuThreshold(gray));

    // Detect inverted image: if >65% of pixels are darker than threshold → flip
    let darkCount = 0;
    for (let j = 0; j < gray.length; j++) if (gray[j] < thresh) darkCount++;
    const inverted = (darkCount / gray.length) > 0.65;

    let nonZero = 0;
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const isDark = inverted ? (gray[j] >= thresh) : (gray[j] < thresh);
      const val = isDark ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = val;
      data[i + 3] = 255;
      if (val !== 0) nonZero++;
    }

    ctx.putImageData(imgData, 0, 0);

    if (window._mrzDebug) {
      const pct = ((nonZero / (sw * sh)) * 100).toFixed(1);
      console.log('[MRZ] preprocess thresh:', thresh, (inverted ? 'inv' : ''), sw + 'x' + sh, 'non-zero:', pct + '%');
    }

    return c;
  }

  // ── HORIZONTAL DENSITY PROJECTION ────────────────────────────────────────

  // Analyse a binarised canvas: find dense text bands near the bottom.
  // Returns { score, cropY, cropH, smooth } — score > 0.1 means promising MRZ location.
  function scoreMRZPresence(binaryCanvas) {
    const ctx = binaryCanvas.getContext('2d');
    const w = binaryCanvas.width, h = binaryCanvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;

    // Per-row density: fraction of dark (text) pixels
    const density = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let dark = 0;
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4] === 0) dark++;
      }
      density[y] = dark / w;
    }

    // 5-row box-filter smooth
    const smooth = new Float32Array(h);
    for (let y = 0; y < h; y++) smooth[y] = density[y];
    for (let y = 2; y < h - 2; y++) {
      smooth[y] = (density[y - 2] + density[y - 1] + density[y] + density[y + 1] + density[y + 2]) / 5;
    }

    // Search bottom 65% of image — avoids false bands in upper area
    const searchStart = Math.floor(h * 0.35);
    const TEXT_THRESH = 0.07;  // 0.07 is robust against noise while catching sparse MRZ text

    // Find contiguous dark-pixel bands
    const bands = [];
    let inBand = false, bs = 0, bSum = 0;
    for (let y = searchStart; y < h; y++) {
      const d = smooth[y];
      if (!inBand && d > TEXT_THRESH) {
        inBand = true; bs = y; bSum = d;
      } else if (inBand) {
        if (d > TEXT_THRESH) { bSum += d; }
        else {
          const bh = y - bs;
          if (bh >= 3) bands.push({ y: bs, h: bh, avg: bSum / bh });
          inBand = false;
        }
      }
    }
    if (inBand && h - bs >= 3) bands.push({ y: bs, h: h - bs, avg: bSum / (h - bs) });

    const defaultY = Math.floor(h * 0.45);
    const defaultH = h - defaultY;
    if (bands.length === 0) return { score: 0, cropY: defaultY, cropH: defaultH, smooth };

    // Score pairs/triples (consistent band heights = MRZ characteristic)
    let bestScore = 0, bestY = defaultY, bestH = defaultH;

    for (let i = 0; i < bands.length; i++) {
      const b1 = bands[i];

      // Single band — weak evidence, use as fallback
      if (b1.avg > bestScore * 2) {
        const padH1 = Math.round(b1.h * 0.5);
        bestScore = b1.avg * 0.5;
        bestY = Math.max(0, b1.y - padH1);
        bestH = Math.min(h - bestY, b1.h + 2 * padH1);
      }

      if (i + 1 >= bands.length) continue;
      const b2 = bands[i + 1];

      // Pair (TD3 / 2-line MRZ)
      const c2  = Math.min(b1.h, b2.h) / Math.max(b1.h, b2.h);
      const s2  = (b1.avg + b2.avg) / 2 * (1 + c2);
      if (s2 > bestScore) {
        bestScore = s2;
        const pad2 = Math.round(Math.max(b1.h, b2.h) * 0.4);
        bestY = Math.max(0, b1.y - pad2);
        bestH = Math.min(h - bestY, b2.y + b2.h - bestY + pad2);
      }

      if (i + 2 >= bands.length) continue;
      const b3 = bands[i + 2];

      // Triple (TD1 / 3-line MRZ) — 1.3× bonus
      const c3  = Math.min(b1.h, b2.h, b3.h) / Math.max(b1.h, b2.h, b3.h);
      const s3  = (b1.avg + b2.avg + b3.avg) / 3 * (1 + c3) * 1.3;
      if (s3 > bestScore) {
        bestScore = s3;
        const pad3 = Math.round(Math.max(b1.h, b2.h, b3.h) * 0.4);
        bestY = Math.max(0, b1.y - pad3);
        bestH = Math.min(h - bestY, b3.y + b3.h - bestY + pad3);
      }
    }

    return { score: bestScore, cropY: bestY, cropH: bestH, smooth };
  }

  // ── REGION DENSITY SCORING ────────────────────────────────────────────────

  // Score a sub-range of the already-computed smooth density array.
  // O(N), zero pixel reads. Same band pair/triple logic as scoreMRZPresence.
  function scoreRegionDensity(smooth, startY, endY) {
    const THRESH = 0.07;
    const bands = [];
    let inBand = false, bs = 0, bSum = 0;
    for (let y = startY; y < endY; y++) {
      const d = smooth[y];
      if (!inBand && d > THRESH) { inBand = true; bs = y; bSum = d; }
      else if (inBand) {
        if (d > THRESH) bSum += d;
        else {
          if (y - bs >= 3) bands.push({ y: bs, h: y - bs, avg: bSum / (y - bs) });
          inBand = false;
        }
      }
    }
    if (inBand && endY - bs >= 3) bands.push({ y: bs, h: endY - bs, avg: bSum / (endY - bs) });

    let best = 0;
    for (let i = 0; i < bands.length; i++) {
      best = Math.max(best, bands[i].avg * 0.5);
      if (i + 1 < bands.length) {
        const c2 = Math.min(bands[i].h, bands[i + 1].h) / Math.max(bands[i].h, bands[i + 1].h);
        best = Math.max(best, (bands[i].avg + bands[i + 1].avg) / 2 * (1 + c2));
      }
      if (i + 2 < bands.length) {
        const c3 = Math.min(bands[i].h, bands[i + 1].h, bands[i + 2].h) /
                   Math.max(bands[i].h, bands[i + 1].h, bands[i + 2].h);
        best = Math.max(best, (bands[i].avg + bands[i + 1].avg + bands[i + 2].avg) / 3 * (1 + c3) * 1.3);
      }
    }
    return best;
  }

  // ── CROP CANDIDATE GENERATION ─────────────────────────────────────────────

  // Generate diverse crop candidates for a single rotation using the smooth density array.
  // Returns sorted array of { y, h, score, label }. No canvas creation, no OCR.
  function generateCropCandidates(imgH, smooth, projCropY, projCropH) {
    const raw = [];

    // 1. Density-projected crop (pre-vetted by band detection) — 2× score bonus
    raw.push({
      y: projCropY, h: projCropH, label: 'proj',
      score: scoreRegionDensity(smooth, projCropY, projCropY + projCropH) * 2,
    });

    // 2. Sliding bottom windows — scored independently
    for (const pct of [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.65]) {
      const ch = Math.round(imgH * pct);
      const cy = imgH - ch;
      raw.push({
        y: cy, h: ch, label: 'bot' + Math.round(pct * 100),
        score: scoreRegionDensity(smooth, cy, imgH),
      });
    }

    // 3. Full image (last resort)
    raw.push({ y: 0, h: imgH, label: 'full', score: 0 });

    // Sort descending, dedup within same rotation (overlap > 90% → keep higher-scored)
    raw.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of raw) {
      const dominated = kept.some(k => {
        const inter = Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y);
        return inter > 0 && inter / Math.min(c.h, k.h) > 0.90;
      });
      if (!dominated) kept.push(c);
    }
    return kept;
  }

  // Upscale small crop canvases for reliable Tesseract recognition.
  // Very small crops (<150px) get a higher target to preserve detail in distance shots.
  function batchUpscaleIfNeeded(canvas) {
    const targetH = canvas.height < 150 ? 1200 : 900;
    if (canvas.height >= targetH) return canvas;
    const factor = Math.max(2, Math.ceil(targetH / canvas.height));
    const c = document.createElement('canvas');
    c.width = canvas.width * factor;
    c.height = canvas.height * factor;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, c.width, c.height);
    return c;
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

  // ── OCR SCORING HELPERS ───────────────────────────────────────────────────

  function longestOCRLine(text) {
    if (!text) return 0;
    return text.split('\n').reduce((max, l) => Math.max(max, l.replace(/[^A-Z0-9<]/gi, '').length), 0);
  }

  function countChevrons(text) {
    return (text.match(/</g) || []).length;
  }

  // Score OCR text for MRZ likelihood (higher = better)
  function scoreMRZText(text) {
    const longest = longestOCRLine(text);
    const chevrons = countChevrons(text);
    let lineBonus = 0;
    const lines = text.split('\n').map(l => l.replace(/[^A-Z0-9<]/gi, ''));
    for (const l of lines) {
      if (l.length >= 42 && l.length <= 46) lineBonus += 20;
      else if (l.length >= 28 && l.length <= 32) lineBonus += 15;
    }
    return longest * 2 + chevrons + lineBonus;
  }

  // ── CHECK-DIGIT CORRECTION HELPERS ───────────────────────────────────────

  // Count changes ONLY at check-digit positions (not data fields).
  // TD3  L2 check positions: 9, 19, 27, 42, 43
  // TD1  L1 check positions: 14, 29
  // TD1  L2 check positions: 6, 14, 29
  function countCheckDigitChanges(type, origLines, corrLines) {
    let count = 0;
    if (type === 'TD3') {
      const o = origLines[1] || '', c = corrLines[1] || '';
      for (const p of [9, 19, 27, 42, 43]) if (o[p] !== c[p]) count++;
    } else if (type === 'TD1') {
      const o1 = origLines[0] || '', c1 = corrLines[0] || '';
      const o2 = origLines[1] || '', c2 = corrLines[1] || '';
      for (const p of [14, 29])   if (o1[p] !== c1[p]) count++;
      for (const p of [6, 14, 29]) if (o2[p] !== c2[p]) count++;
    }
    return count;
  }

  // ── BATCH OCR LOOP ────────────────────────────────────────────────────────

  // Multi-crop → global scoring → top-MAX_OCR OCR pipeline.
  //
  // Phase 0: Generate crop candidates across 4 rotations using density scoring (no OCR).
  //          40 raw candidates → deduped → globally ranked → top MAX_OCR selected.
  // Phase 1: OCR each top candidate in rank order — early exit on valid MRZ.
  //          Track best parseable MRZ as rescue candidate even when checksum fails.
  // Phase 2: Check digit rescue — recompute expected check digits from field data.
  //          Returns corrected: true when this path fires.
  // Phase 3: NO_PARSE return with best-effort metadata.
  async function fastBatchOCR(resized, timings, ocrWorker, fileName, fileIndex) {
    const wr = ocrWorker || worker;
    timings.resizedSize = resized.width + 'x' + resized.height;

    if (window._mrzDebug) console.log('[MRZ] batch', fileName || '', resized.width + 'x' + resized.height);

    // ── Phase 0: generate all crop candidates across 4 rotations (no OCR) ──
    const t0 = performance.now();
    const allCandidates = [];

    for (const deg of [0, 90, 180, 270]) {
      const rotated = rotateCanvas(resized, deg);
      const binary  = batchPreprocessMRZ(rotated);
      const { score: rotScore, cropY, cropH, smooth } = scoreMRZPresence(binary);

      const crops = generateCropCandidates(rotated.height, smooth, cropY, cropH);
      for (const c of crops) {
        allCandidates.push({ deg, rotated, ...c, globalScore: c.score * (1 + rotScore * 0.2) });
        if (window._mrzDebug) {
          console.log('[MRZ candidates] rot=' + deg, 'y=' + c.y, 'h=' + c.h,
            'score=' + c.score.toFixed(3), 'globalScore=' + (c.score * (1 + rotScore * 0.2)).toFixed(3),
            'label=' + c.label);
        }
      }
      if (window._mrzDebug) {
        console.log('[MRZ] rot', deg + '°', 'rotScore:', rotScore.toFixed(3),
          crops.length, 'candidates, top:', crops[0]?.label, crops[0]?.score.toFixed(3));
      }
    }
    timings.crop = Math.round(performance.now() - t0);

    // Global sort + take top MAX_OCR
    allCandidates.sort((a, b) => b.globalScore - a.globalScore);
    const topCandidates = allCandidates.slice(0, MAX_OCR);

    if (window._mrzDebug) {
      console.log('[MRZ top-' + MAX_OCR + ']',
        topCandidates.map(c => 'rot' + c.deg + '/' + c.label + ' gs=' + c.globalScore.toFixed(3)).join(' | '));
    }

    let globalBestScore = -1, globalBestText = '', globalBestMRZ = null;
    let lastDiag = null, ocrAttempt = 0;

    // ── Phase 1: OCR top candidates in rank order ─────────────────────────
    for (const { deg, rotated, y: cropY, h: cropH, label } of topCandidates) {
      const padW = Math.round(rotated.width * 0.03);
      const crop = document.createElement('canvas');
      crop.width  = Math.max(1, rotated.width - 2 * padW);
      crop.height = Math.max(1, cropH);
      crop.getContext('2d').drawImage(rotated, padW, cropY, crop.width, cropH, 0, 0, crop.width, cropH);

      const ocrIn = batchUpscaleIfNeeded(batchPreprocessMRZ(crop));
      if (ocrIn.width <= 100 || ocrIn.height <= 100) continue;

      ocrAttempt++;
      const key = 'ocr' + ocrAttempt;
      const t = performance.now();
      try {
        const { data: { text } } = await wr.recognize(ocrIn);
        timings[key] = Math.round(performance.now() - t);
        timings['sz' + ocrAttempt] = ocrIn.width + 'x' + ocrIn.height;

        const ocrScore = scoreMRZText(text);
        const longest  = longestOCRLine(text);
        const chevs    = countChevrons(text);
        if (text) lastDiag = diagnoseMRZ(text);
        if (window._mrzDebug) console.log('[MRZ] rot' + deg + '/' + label,
          'longest:', longest, 'ocrScore:', ocrScore);

        // TEMP DEBUG — img_1914/1924/1925 L2 root cause investigation
        if (['1914','1924','1925'].some(id => (fileName||'').includes(id))) {
          const lines = text.split('\n');
          const mrzLines = lines.filter(l => l.length >= 28);
          const entry = { rot: deg, label, fileName,
            allLengths: lines.map(l => l.length),
            mrzCandidates: mrzLines };
          if (!window._dbgData) window._dbgData = [];
          window._dbgData.push(entry);
        }

        if (ocrScore > globalBestScore) { globalBestScore = ocrScore; globalBestText = text; }

        if (longest >= 28) {
          const result = extractMRZ(clean(text));
          if (result) {
            // First parseable result → candidate for rescue
            if (!globalBestMRZ) globalBestMRZ = result;
            if (validateMRZ(result).valid) {
              // Normalize check-digit positions (fixes e.g. 'C' at composite check)
              const corrLines = correctCheckDigits(result.type, result.lines);
              const correctionCount = countCheckDigitChanges(result.type, result.lines, corrLines);
              const corrected = correctionCount > 0 && correctionCount <= MAX_CORRECTIONS;
              const finalResult = corrected ? { type: result.type, lines: corrLines } : result;
              return {
                extracted: finalResult, diag: diagnoseMRZ(text), attempts: ocrAttempt,
                longestLine: longest, chevronCount: chevs, rawOcrText: text,
                selectedBand: 'rot' + deg + '/' + label,
                corrected, correctionCount,
              };
            }
            // Better-scoring parse: update rescue candidate
            if (ocrScore >= globalBestScore) globalBestMRZ = result;
          }
        }
      } catch (e) {
        timings[key] = Math.round(performance.now() - t);
        if (window._mrzDebug) console.warn('[MRZ] rot' + deg + '/' + label, 'error:', e.message);
      }
    }

    // ── Phase 2: check digit rescue (0 OCR calls) ─────────────────────────
    if (globalBestMRZ) {
      try {
        const corrLines      = correctCheckDigits(globalBestMRZ.type, globalBestMRZ.lines);
        const correctionCount = countCheckDigitChanges(globalBestMRZ.type, globalBestMRZ.lines, corrLines);
        if (correctionCount > 0 && correctionCount <= MAX_CORRECTIONS) {
          const corrResult = { type: globalBestMRZ.type, lines: corrLines };
          if (validateMRZ(corrResult).valid) {
            const longest = globalBestText ? longestOCRLine(globalBestText) : 0;
            return {
              extracted: corrResult, diag: lastDiag, attempts: ocrAttempt,
              longestLine: longest, chevronCount: countChevrons(globalBestText || ''),
              rawOcrText: globalBestText, selectedBand: 'checkdigit-corrected',
              corrected: true, correctionCount,
            };
          }
        }
      } catch (_) {}
    }

    // ── Phase 3: NO_PARSE ─────────────────────────────────────────────────
    const failLongest  = globalBestText ? longestOCRLine(globalBestText) : 0;
    const failChevrons = globalBestText ? countChevrons(globalBestText)  : 0;
    return {
      extracted: null, diag: lastDiag, attempts: ocrAttempt,
      longestLine: failLongest, chevronCount: failChevrons,
      rawOcrText: globalBestText, selectedBand: '—',
    };
  }

  // ── WORKER FACTORY ────────────────────────────────────────────────────────

  // Create a dedicated batch Tesseract worker (isolated from global worker)
  async function createBatchWorker(langPathOverride) {
    const localBase = langPathOverride
      ? new URL(langPathOverride, window.location.href).href.replace(/\/?$/, '/')
      : window.location.origin + window.location.pathname.replace(/[^/]+$/, '');
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

  // ── HIGH-LEVEL ENTRY POINT ────────────────────────────────────────────────

  // processImage — used by regression runner to run the full pipeline on a File.
  // timings: object passed by reference, filled with perf data by fastBatchOCR.
  // Returns one of:
  //   { error: 'decode_failed' }                      image could not be decoded
  //   { error: 'no_parse', meta: {attempts, longestLine} }  MRZ not found
  //   { extracted, parsed, validation, meta }          success
  async function processImage(file, worker, timings) {
    timings = timings || {};
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      return { error: 'decode_failed' };
    }
    const resized = resizeForOCR(bitmap, 1400);
    if (bitmap.close) bitmap.close();
    if (!resized) return { error: 'decode_failed' };

    const ocr = await fastBatchOCR(resized, timings, worker, file.name, 0);
    if (!ocr.extracted) {
      return { error: 'no_parse', meta: { attempts: ocr.attempts, longestLine: ocr.longestLine } };
    }

    return {
      extracted:  ocr.extracted,
      parsed:     parseResult(ocr.extracted),
      validation: validateMRZ(ocr.extracted),
      meta:       { selectedBand: ocr.selectedBand, attempts: ocr.attempts,
                    corrected: ocr.corrected || false, correctionCount: ocr.correctionCount || 0 },
    };
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────

  window.MRZPipeline = {
    cropBottom,
    resizeForOCR,
    batchPreprocessMRZ,
    batchUpscaleIfNeeded,
    rotateCanvas,
    longestOCRLine,
    countChevrons,
    scoreMRZText,
    fastBatchOCR,
    createBatchWorker,
    processImage,
  };

})();
