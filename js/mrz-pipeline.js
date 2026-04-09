// js/mrz-pipeline.js
// Image processing pipeline — shared between main app and regression test harness.
// Must be loaded AFTER mrz-core.js and BEFORE the main inline <script>.

(function () {
  'use strict';

  // mrz-core.js must be loaded first — destructure needed functions
  const { extractMRZ, clean, validateMRZ, diagnoseMRZ, parseResult } = window.MRZCore;

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
    // Otsu improves binarization when it produces a HIGHER threshold (brighter paper),
    // but going below 140 drops ink pixels and reduces OCR accuracy on colored cards.
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
  // Returns { score, cropY, cropH } — score > 0.1 means promising MRZ location.
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
    const smooth = density.slice();
    for (let y = 2; y < h - 2; y++) {
      smooth[y] = (density[y - 2] + density[y - 1] + density[y] + density[y + 1] + density[y + 2]) / 5;
    }

    // Search bottom 60% of image (MRZ is always near the bottom of a document)
    const searchStart = Math.floor(h * 0.40);
    const TEXT_THRESH = 0.08;

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
    if (bands.length === 0) return { score: 0, cropY: defaultY, cropH: defaultH };

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

    return { score: bestScore, cropY: bestY, cropH: bestH };
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

  // ── BATCH OCR LOOP ────────────────────────────────────────────────────────

  // Pipeline:
  //  Phase 0: score all 4 rotations via density projection (no OCR)
  //  Phase 1: projection-detected crop on all 4 rotations (best-first) — early exit on success
  //  Phase 2: bottom-75% fallback on all 4 rotations (best-first)    — early exit on success
  //  Max OCR calls: 8 (vs. 12 before). Speed: ~8-20s vs ~36s.
  async function fastBatchOCR(resized, timings, ocrWorker, fileName, fileIndex) {
    const wr = ocrWorker || worker;
    const isFirstFile = (fileIndex === 0);

    timings.resizedSize = resized.width + 'x' + resized.height;
    if (window._mrzDebug) console.log('[MRZ] batch', fileName || '', resized.width + 'x' + resized.height);

    // ── Phase 0: Rotation pre-selection (density projection, no OCR) ─────────
    const t0 = performance.now();
    const rotCandidates = [0, 90, 180, 270].map(deg => {
      const rotated = rotateCanvas(resized, deg);
      const binary  = batchPreprocessMRZ(rotated);
      const { score, cropY, cropH } = scoreMRZPresence(binary);
      return { deg, rotated, score, cropY, cropH };
    });
    timings.crop = Math.round(performance.now() - t0);

    // Sort: highest density score first (but try ALL 4 rotations in both phases)
    rotCandidates.sort((a, b) => b.score - a.score);

    if (window._mrzDebug && isFirstFile) {
      rotCandidates.forEach(r =>
        console.log('[MRZ] rot', r.deg + '°', 'density:', r.score.toFixed(3),
          'cropY:', r.cropY, 'cropH:', r.cropH));
    }

    let lastDiag  = null;
    let globalBestScore = -1, globalBestText = '', globalBestBand = -1;
    let ocrAttempt = 0;
    let t;

    // Helper: run one OCR attempt on a canvas, update globals, return result or null
    async function tryOCR(canvas, label) {
      const ocrIn = batchUpscaleIfNeeded(batchPreprocessMRZ(canvas));
      if (ocrIn.width <= 100 || ocrIn.height <= 100) return null;
      ocrAttempt++;
      const key = 'ocr' + ocrAttempt;
      t = performance.now();
      try {
        const { data: { text } } = await wr.recognize(ocrIn);
        const score   = scoreMRZText(text);
        const longest = longestOCRLine(text);
        const chevs   = countChevrons(text);
        timings[key] = Math.round(performance.now() - t);
        timings['sz' + ocrAttempt] = ocrIn.width + 'x' + ocrIn.height;
        if (window._mrzDebug && isFirstFile)
          console.log('[MRZ]', label, 'longest:', longest, 'score:', score);
        if (text) lastDiag = diagnoseMRZ(text);
        if (longest >= 28) {
          const result = extractMRZ(clean(text));
          if (result && validateMRZ(result).valid)
            return { extracted: result, diag: diagnoseMRZ(text), attempts: ocrAttempt,
              longestLine: longest, chevronCount: chevs, rawOcrText: text, selectedBand: label };
        }
        if (score > globalBestScore) {
          globalBestScore = score; globalBestText = text; globalBestBand = ocrAttempt - 1;
        }
      } catch(e) {
        timings[key] = Math.round(performance.now() - t);
        if (window._mrzDebug) console.warn('[MRZ]', label, 'error:', e.message);
      }
      return null;
    }

    // ── Phase 1: projection-detected crop + 3% horizontal padding ────────────
    for (const { deg, rotated, cropY, cropH } of rotCandidates) {
      const padW  = Math.round(rotated.width * 0.03);
      const canvA = document.createElement('canvas');
      canvA.width  = rotated.width - 2 * padW;
      canvA.height = cropH;
      canvA.getContext('2d').drawImage(rotated, padW, cropY, canvA.width, cropH, 0, 0, canvA.width, cropH);
      const hit = await tryOCR(canvA, 'rot' + deg + '/proj');
      if (hit) return hit;
    }

    // ── Phase 2: bottom-75% fallback on all 4 rotations ─────────────────────
    for (const { deg, rotated } of rotCandidates) {
      const croppedB = cropBottom(rotated, 0.75);
      const hit = await tryOCR(croppedB, 'rot' + deg + '/fallback75');
      if (hit) return hit;
    }

    const failLongest  = globalBestText ? longestOCRLine(globalBestText) : 0;
    const failChevrons = globalBestText ? countChevrons(globalBestText)  : 0;
    return { extracted: null, diag: lastDiag, attempts: ocrAttempt,
      longestLine: failLongest, chevronCount: failChevrons,
      rawOcrText: globalBestText,
      selectedBand: globalBestBand >= 0 ? 'attempt' + (globalBestBand + 1) : '—' };
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
      bitmap = await createImageBitmap(file);
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
      meta:       { selectedBand: ocr.selectedBand, attempts: ocr.attempts },
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
