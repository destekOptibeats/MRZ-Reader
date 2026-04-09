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
      data[i + 3] = 255;

      if (val !== 0) nonZero++;
    }

    ctx.putImageData(imgData, 0, 0);

    if (window._mrzDebug) {
      const pct = ((nonZero / (sw * sh)) * 100).toFixed(1);
      console.log('[MRZ] preprocess', sw + 'x' + sh, 'non-zero:', pct + '%');
    }

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

  async function fastBatchOCR(resized, timings, ocrWorker, fileName, fileIndex) {
    const wr = ocrWorker || worker;
    const isFirstFile = (fileIndex === 0);
    const rotations = [0, 90, 180, 270];

    timings.resizedSize = resized.width + 'x' + resized.height;
    if (window._mrzDebug) console.log('[MRZ] batch', fileName || '', resized.width + 'x' + resized.height);

    const isLandscape = resized.width > resized.height;
    const crops = [
      isLandscape ? 0.50 : 0.45,
      isLandscape ? 0.65 : 0.60,
      1.0,
    ];

    let lastDiag = null;
    let t;

    for (let i = 0; i < crops.length; i++) {
      const ratio = crops[i];
      const attemptKey = 'ocr' + (i + 1);

      t = performance.now();
      const cropped = ratio >= 1.0 ? resized : cropBottom(resized, ratio);
      if (i === 0) timings.crop = Math.round(performance.now() - t);

      if (cropped.width <= 100 || cropped.height <= 100) continue;

      // Try all rotations, collect scores
      let bestScore = -1, bestText = '', bestDeg = 0;

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

          if (window._mrzDebug && isFirstFile) {
            console.log('[MRZ] batch crop' + (i+1), deg + '°', 'longest:', longest, 'score:', score);
          }

          // Immediate success: try parse+checksum on promising results
          if (longest >= 28) {
            const result = extractMRZ(clean(text));
            if (result && validateMRZ(result).valid) {
              timings[attemptKey] = Math.round(performance.now() - t);
              timings['sz' + (i+1)] = ocrInput.width + 'x' + ocrInput.height;
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
          if (window._mrzDebug) console.warn('[MRZ] batch rot', deg + '° error:', e.message);
        }
      }
      timings[attemptKey] = Math.round(performance.now() - t);

      // Try parse on best rotation result
      if (bestText && longestOCRLine(bestText) >= 28) {
        const result = extractMRZ(clean(bestText));
        if (result && validateMRZ(result).valid) {
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
      rawOcrText: bestText || '', selectedBand: bestBandIdx >= 0 ? 'crop' + (bestBandIdx+1) : '—' };
  }

  // ── WORKER FACTORY ────────────────────────────────────────────────────────

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
