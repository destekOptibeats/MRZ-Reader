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

  // Hi-contrast variant: contrast-stretch THEN Otsu (no 140 floor).
  // Used as a fallback preprocessing path for images where standard Otsu
  // binarization gives poor results (low-contrast MRZ zones, blurry text).
  function hiContrastPreprocess(srcCanvas) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    if (!sw || !sh) return srcCanvas;

    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, sw, sh, 0, 0, sw, sh);

    const imgData = ctx.getImageData(0, 0, sw, sh);
    const data = imgData.data;

    // 1. Grayscale + find actual pixel range for contrast stretch
    const gray = new Uint8Array(sw * sh);
    let minV = 255, maxV = 0;
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const g = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      gray[j] = g;
      if (g < minV) minV = g;
      if (g > maxV) maxV = g;
    }

    // 2. Contrast stretch: map [minV, maxV] → [0, 255] (uses full dynamic range)
    const range = maxV - minV || 1;
    for (let j = 0; j < gray.length; j++) {
      gray[j] = Math.round((gray[j] - minV) * 255 / range);
    }

    // 3. Otsu threshold on stretched image — NO 140 floor, computed freely
    const thresh = computeOtsuThreshold(gray);

    // 4. Inversion detection (same logic as batchPreprocessMRZ)
    let darkCount = 0;
    for (let j = 0; j < gray.length; j++) if (gray[j] < thresh) darkCount++;
    const inverted = (darkCount / gray.length) > 0.65;

    // 5. Binarize
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      const isDark = inverted ? (gray[j] >= thresh) : (gray[j] < thresh);
      const val = isDark ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = val;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
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

  // Rotate a canvas by an arbitrary angle (degrees) around its center.
  // Output canvas is sized to contain the full rotated image; background is white.
  // Used by Phase 2.9 micro-deskew search for small tilt correction (±12°).
  function arbitraryRotateCanvas(srcCanvas, angleDeg) {
    if (angleDeg === 0) return srcCanvas;
    const rad = angleDeg * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const w = srcCanvas.width, h = srcCanvas.height;
    const nw = Math.round(w * cos + h * sin);
    const nh = Math.round(w * sin + h * cos);
    const c = document.createElement('canvas');
    c.width = nw; c.height = nh;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, nw, nh);
    ctx.translate(nw / 2, nh / 2);
    ctx.rotate(rad);
    ctx.drawImage(srcCanvas, -w / 2, -h / 2);
    return c;
  }

  // Score a binarized (black-on-white) canvas for MRZ horizontal alignment
  // using row-density variance. Higher variance = text rows are sharply separated
  // from blank rows = better horizontal alignment. When MRZ is tilted, text smears
  // across rows → variance drops. Used by Phase 2.9 to rank deskew angle candidates.
  function scoreDeskewCandidate(binaryCanvas) {
    const ctx = binaryCanvas.getContext('2d');
    const { width: w, height: h } = binaryCanvas;
    const data = ctx.getImageData(0, 0, w, h).data;
    const densities = [];
    for (let y = 0; y < h; y++) {
      let dark = 0;
      for (let x = 0; x < w; x++) if (data[(y * w + x) * 4] === 0) dark++;
      densities.push(dark / w);
    }
    const mean = densities.reduce((a, b) => a + b, 0) / h;
    return densities.reduce((s, d) => s + (d - mean) ** 2, 0) / h;  // variance
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

  // ── Per-run instrumentation ───────────────────────────────────────────────
  // All instrumentation is gated behind window._mrzDebug.
  // _runDbg accumulates data for one fastBatchOCR call; reset by _finalizeRun.

  let _runDbg = null; // module-level; safe because fastBatchOCR is not re-entrant per worker

  function _pushAttempt(entry) {
    if (_runDbg) _runDbg.attempts.push(entry);
  }

  // Call at every return point in fastBatchOCR.
  // Computes the final debug summary, pushes to window._dbgData, resets _runDbg.
  // Returns result unchanged so callers can do: return _finalizeRun(result, phaseTag)
  function _finalizeRun(result, phaseTag) {
    if (!_runDbg) return result;
    const rd = _runDbg;
    _runDbg = null; // reset first — avoids double-push on unexpected re-entry
    if (!window._mrzDebug) return result;

    const totalMs   = Math.round(performance.now() - rd.startMs);
    const isPass    = !!(result && result.extracted);
    const corrected = result && (result.corrected || false);
    const corrCount = result && (result.correctionCount || 0);
    const selBand   = (result && result.selectedBand) || '—';

    // usedFallback: anything beyond Phase 1 mainline
    const usedFallback = phaseTag !== 'phase_1';
    const outcome      = isPass ? 'pass' : 'no_parse';

    // passClass priority: debt-pass > correction-pass > fallback-pass > primary-pass
    let passClass;
    if (!isPass) {
      passClass = 'no_parse';
    } else if (phaseTag === 'phase_1' && !corrected) {
      passClass = 'primary-pass';
    } else if (phaseTag === 'phase_1' && corrected) {
      passClass = 'correction-pass';
    } else if (phaseTag === 'phase_2') {
      passClass = 'correction-pass'; // Phase 2 is always correction-only
    } else {
      passClass = corrected ? 'correction-pass' : 'fallback-pass';
    }

    const summary = {
      fileName:        rd.fileName,
      attemptCount:    rd.attempts.length,
      ocrCalls:        rd.ocrCalls,
      finalOutcome:    outcome,
      finalPath:       selBand,
      finalPhase:      phaseTag,
      usedFallback,
      usedCorrection:  corrected,
      correctionCount: corrCount,
      usedRelaxation:  false, // reserved for future relaxation tracking
      passClass,
      attempts:        rd.attempts,
      timing:          { totalMs },
    };
    if (!window._dbgData) window._dbgData = [];
    window._dbgData.push(summary);
    if (window._mrzDebug) console.log('[MRZ-DBG]', rd.fileName, '→', outcome, phaseTag, selBand,
      'ocr:', rd.ocrCalls, 'ms:', totalMs, 'class:', passClass);
    return result;
  }

  // ── tryMRZ helper ─────────────────────────────────────────────────────────

  // Runs the full extract → correct → validate pipeline on raw OCR text.
  // Returns a complete pipeline result object (ready to return from fastBatchOCR)
  // or null. Fast-rejects weak OCR output before running extractMRZ.
  // Debug mode logs the null reason and input quality signals for tuning.
  // quiet=true suppresses _pushAttempt (used in Phase 2.95 reord loop to avoid 60+ entries)
  function tryMRZ(text, label, { diag, attempts, longestLine, chevronCount }, quiet = false) {
    const dbgEntry = { path: label, longestLine, chevronCount, extracted: false, validated: false, reason: '' };
    const dbg = (reason) => {
      dbgEntry.reason = reason;
      if (!quiet) _pushAttempt({ ...dbgEntry });
      if (window._mrzDebug) console.log('[tryMRZ]', label, reason,
        '| longest:', longestLine, 'chevrons:', chevronCount, 'attempt:', attempts);
    };
    // Fast reject: OCR output too weak to contain any MRZ line
    if (longestLine < 25) { dbg('fast_reject_length'); return null; }
    if (chevronCount < 3)  { dbg('fast_reject_chevrons'); return null; }
    const cleaned = clean(text);
    const raw = extractMRZ(cleaned);
    if (!raw) { dbg('no_extract'); return null; }
    const corrLines = correctCheckDigits(raw.type, raw.lines);
    const corrCount = countCheckDigitChanges(raw.type, raw.lines, corrLines);
    if (corrCount > MAX_CORRECTIONS) { dbg('too_many_corrections(' + corrCount + ')'); return null; }
    const corrResult = { type: raw.type, lines: corrLines };
    if (!validateMRZ(corrResult).valid) { dbg('validation_failed'); return null; }
    if (!quiet) _pushAttempt({ ...dbgEntry, extracted: true, validated: true, reason: 'accepted' });
    return {
      extracted: corrResult, diag, attempts, longestLine, chevronCount,
      rawOcrText: text, selectedBand: label,
      corrected: corrCount > 0, correctionCount: corrCount,
      recoveryMode: label,
    };
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

    // Initialize per-run debug accumulator
    if (window._mrzDebug) {
      _runDbg = { fileName: fileName || '', attempts: [], ocrCalls: 0, startMs: performance.now() };
    }

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

    // Collect one proj crop per rotation for Phase 2.95 safety net.
    // Done BEFORE sort so each rotation's proj candidate is captured regardless of ranking.
    const projByDeg = {};  // deg → { deg, rotated, y, h }
    for (const c of allCandidates) {
      if (c.label === 'proj' && !(c.deg in projByDeg))
        projByDeg[c.deg] = { deg: c.deg, rotated: c.rotated, y: c.y, h: c.h };
    }

    // Global sort + take top MAX_OCR
    allCandidates.sort((a, b) => b.globalScore - a.globalScore);
    const topCandidates = allCandidates.slice(0, MAX_OCR);

    if (window._mrzDebug) {
      console.log('[MRZ top-' + MAX_OCR + ']',
        topCandidates.map(c => 'rot' + c.deg + '/' + c.label + ' gs=' + c.globalScore.toFixed(3)).join(' | '));
    }

    let globalBestScore = -1, globalBestText = '', globalBestMRZ = null;
    let lastDiag = null, ocrAttempt = 0;
    const allFragmentLines = []; // Phase 2.5: accumulate candidate lines across OCR attempts
    let bestProjCropData = null;  // Phase 2.75: save best proj raw crop for hi-contrast fallback
    let hiContrastCanvas = null; // Phase 2.8:  reuse hi-contrast canvas across phases
    const triedProjDegs = new Set(); // Phase 2.95: track proj degs tried in Phase 1

    // ── Phase 1: OCR top candidates in rank order ─────────────────────────
    for (const { deg, rotated, y: cropY, h: cropH, label } of topCandidates) {
      const padW = Math.round(rotated.width * 0.03);
      const crop = document.createElement('canvas');
      crop.width  = Math.max(1, rotated.width - 2 * padW);
      crop.height = Math.max(1, cropH);
      crop.getContext('2d').drawImage(rotated, padW, cropY, crop.width, cropH, 0, 0, crop.width, cropH);

      // Save first proj crop (raw, before preprocessing) for Phase 2.75 hi-contrast fallback
      if (label === 'proj' && !bestProjCropData) bestProjCropData = { crop, deg };
      // Track which proj rotations are OCR'd in Phase 1 (for Phase 2.95 deduplication)
      if (label === 'proj') triedProjDegs.add(deg);

      const ocrIn = batchUpscaleIfNeeded(batchPreprocessMRZ(crop));
      if (ocrIn.width <= 100 || ocrIn.height <= 100) continue;

      ocrAttempt++;
      if (_runDbg) _runDbg.ocrCalls++;
      const key = 'ocr' + ocrAttempt;
      const t = performance.now();
      const p1path = 'rot' + deg + '/' + label;
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

        if (ocrScore > globalBestScore) { globalBestScore = ocrScore; globalBestText = text; }

        // Collect MRZ-candidate lines for Phase 2.5 fragment combine
        for (const rawLine of text.split('\n')) {
          const fline = rawLine.replace(/[^A-Z0-9<]/g, '');
          const fchevs = (fline.match(/</g) || []).length;
          if (fline.length >= 28 && fline.length <= 46 && fchevs >= 3) {
            allFragmentLines.push({ line: fline, rot: deg, label });
          }
        }

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
              _pushAttempt({ path: p1path, longestLine: longest, chevronCount: chevs,
                             extracted: true, validated: true,
                             reason: corrected ? 'accepted_corrected' : 'accepted' });
              return _finalizeRun({
                extracted: finalResult, diag: diagnoseMRZ(text), attempts: ocrAttempt,
                longestLine: longest, chevronCount: chevs, rawOcrText: text,
                selectedBand: p1path, corrected, correctionCount,
              }, 'phase_1');
            }
            // Phase 1 miss: valid parse but checksum failed
            _pushAttempt({ path: p1path, longestLine: longest, chevronCount: chevs,
                           extracted: true, validated: false, reason: 'validation_failed' });
            if (ocrScore >= globalBestScore) globalBestMRZ = result;
          } else {
            _pushAttempt({ path: p1path, longestLine: longest, chevronCount: chevs,
                           extracted: false, validated: false, reason: 'no_extract' });
          }
        } else {
          _pushAttempt({ path: p1path, longestLine: longest, chevronCount: chevs,
                         extracted: false, validated: false, reason: 'fast_reject_length' });
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
            const chevs2  = countChevrons(globalBestText || '');
            _pushAttempt({ path: 'checkdigit-corrected', longestLine: longest, chevronCount: chevs2,
                           extracted: true, validated: true, reason: 'accepted' });
            return _finalizeRun({
              extracted: corrResult, diag: lastDiag, attempts: ocrAttempt,
              longestLine: longest, chevronCount: chevs2,
              rawOcrText: globalBestText, selectedBand: 'checkdigit-corrected',
              corrected: true, correctionCount,
            }, 'phase_2');
          }
        }
      } catch (_) {}
    }

    // Shared stats for Phase 2.5 and Phase 3
    const failLongest  = globalBestText ? longestOCRLine(globalBestText) : 0;
    const failChevrons = globalBestText ? countChevrons(globalBestText)  : 0;

    // ── Phase 2.5: fragment combine (0 extra OCR calls) ──────────────────
    // Deduplicate candidate lines (max 10 unique), try all combinations (max 20)
    if (allFragmentLines.length >= 2) {
      try {
        const seen = new Set();
        const frags = [];
        for (const c of allFragmentLines) {
          if (!seen.has(c.line) && frags.length < 10) {
            seen.add(c.line);
            frags.push(c);
          }
        }

        let combinationCount = 0;

        const tryCombo = (combo) => {
          combinationCount++;
          const synText = combo.map(f => f.line).join('\n');
          const r = extractMRZ(synText);
          if (!r) return null;
          const corrLines  = correctCheckDigits(r.type, r.lines);
          const corrCount  = countCheckDigitChanges(r.type, r.lines, corrLines);
          if (corrCount > MAX_CORRECTIONS) return null;
          const corrResult = { type: r.type, lines: corrLines };
          if (!validateMRZ(corrResult).valid) return null;
          return { corrResult, corrCount };
        };

        const sources = (combo) =>
          combo.map(f => 'rot' + f.rot + '/' + f.label).join('+');

        outer25:
        for (let i = 0; i < frags.length; i++) {
          for (let j = 0; j < frags.length; j++) {
            if (i === j) continue;
            if (combinationCount >= 20) break outer25;

            // 2-line combo (TD3)
            const r2 = tryCombo([frags[i], frags[j]]);
            if (r2) {
              const fss2 = sources([frags[i], frags[j]]);
              _pushAttempt({ path: 'fragment-combined/' + fss2, longestLine: failLongest, chevronCount: failChevrons,
                             extracted: true, validated: true, reason: 'accepted' });
              return _finalizeRun({
                extracted: r2.corrResult, diag: lastDiag, attempts: ocrAttempt,
                longestLine: failLongest, chevronCount: failChevrons,
                rawOcrText: globalBestText,
                selectedBand: 'fragment-combined',
                corrected: r2.corrCount > 0, correctionCount: r2.corrCount,
                recoveryMode: 'fragment-combined',
                combinationCount,
                fragmentSources: fss2,
              }, 'phase_2.5');
            }

            // 3-line combos (TD1)
            for (let k = 0; k < frags.length; k++) {
              if (k === i || k === j) continue;
              if (combinationCount >= 20) break outer25;
              const r3 = tryCombo([frags[i], frags[j], frags[k]]);
              if (r3) {
                const fss3 = sources([frags[i], frags[j], frags[k]]);
                _pushAttempt({ path: 'fragment-combined/' + fss3, longestLine: failLongest, chevronCount: failChevrons,
                               extracted: true, validated: true, reason: 'accepted' });
                return _finalizeRun({
                  extracted: r3.corrResult, diag: lastDiag, attempts: ocrAttempt,
                  longestLine: failLongest, chevronCount: failChevrons,
                  rawOcrText: globalBestText,
                  selectedBand: 'fragment-combined',
                  corrected: r3.corrCount > 0, correctionCount: r3.corrCount,
                  recoveryMode: 'fragment-combined',
                  combinationCount,
                  fragmentSources: fss3,
                }, 'phase_2.5');
              }
            }
          }
        }
      } catch (_) {}
    }

    // ── Phase 2.75: proj-hicontrast (1 extra OCR call, only on full failure) ─
    // Applies contrast-stretch + free-Otsu binarization to the best proj crop.
    // Different from standard batchPreprocessMRZ (no 140 threshold floor) so it
    // can recover MRZ zones that the standard path over-thresholds or under-exposes.
    if (bestProjCropData) {
      try {
        hiContrastCanvas = hiContrastPreprocess(bestProjCropData.crop); // save for Phase 2.8
        const hiOcrIn = batchUpscaleIfNeeded(hiContrastCanvas);
        if (hiOcrIn.width > 100 && hiOcrIn.height > 100) {
          ocrAttempt++;
          if (_runDbg) _runDbg.ocrCalls++;
          const { data: { text: hiText } } = await wr.recognize(hiOcrIn);

          const hiLongest  = longestOCRLine(hiText);
          const hiChevrons = countChevrons(hiText);
          const hiHit = tryMRZ(hiText, 'proj-hicontrast', { diag: lastDiag, attempts: ocrAttempt,
                                                             longestLine: hiLongest, chevronCount: hiChevrons });
          if (hiHit) return _finalizeRun(hiHit, 'phase_2.75');
        }
      } catch (_) {}
    }

    // ── Phase 2.8: PSM 7 / PSM 8 targeted line fallback (≤2 extra OCR calls) ─
    // Feeds the hi-contrast crop to Tesseract with PSM 7 (single text line),
    // which can improve character recognition when block segmentation fails.
    // Falls back to PSM 8 (single word) if PSM 7 also fails to find MRZ.
    // Always restores PSM 6 (uniform block) before exiting.
    if (hiContrastCanvas) {
      const hiOcrIn28 = batchUpscaleIfNeeded(hiContrastCanvas);
      // tryPsm: refactored to use tryMRZ for consistent validation + instrumentation
      const tryPsm = async (psm) => {
        try {
          await wr.setParameters({ tessedit_pageseg_mode: psm });
          ocrAttempt++;
          if (_runDbg) _runDbg.ocrCalls++;
          const { data: { text: psmText } } = await wr.recognize(hiOcrIn28);
          await wr.setParameters({ tessedit_pageseg_mode: '6' }); // restore
          const psmLongest  = longestOCRLine(psmText);
          const psmChevrons = countChevrons(psmText);
          return tryMRZ(psmText, 'psm' + psm, { diag: lastDiag, attempts: ocrAttempt,
                                                 longestLine: psmLongest, chevronCount: psmChevrons });
        } catch (_) {
          try { await wr.setParameters({ tessedit_pageseg_mode: '6' }); } catch (_2) {}
          return null;
        }
      };

      if (hiOcrIn28.width > 100 && hiOcrIn28.height > 100) {
        const r7 = await tryPsm('7');
        if (r7) return _finalizeRun(r7, 'phase_2.8');
        const r8 = await tryPsm('8');
        if (r8) return _finalizeRun(r8, 'phase_2.8');
      }
    }

    // ── Phase 2.9: micro-deskew search (≤1 extra OCR call) ──────────────
    // Tries small rotation offsets [-12…+12]° on the raw proj crop.
    // Scores each via row-density variance (no OCR) — higher variance means
    // text rows are sharply separated from blank rows = better alignment.
    // Runs 1 OCR call only if a non-0° angle beats the 0° baseline by ≥3%.
    if (bestProjCropData) {
      try {
        const DESKEW_ANGLES = [0, -4, 4, -8, 8, -12, 12]; // small angles first
        let score0 = null, bestAngleScore = -1, bestRawCanvas = null, bestAngle = 0;
        const angleScores = {};

        for (const angle of DESKEW_ANGLES) {
          const rotated   = arbitraryRotateCanvas(bestProjCropData.crop, angle); // raw color
          const processed = hiContrastPreprocess(rotated);                       // binary — scoring only
          const score     = scoreDeskewCandidate(processed);
          angleScores[angle] = score;
          if (angle === 0) { score0 = score; continue; } // baseline, skip as candidate
          if (score > bestAngleScore) {
            bestAngleScore = score;
            bestRawCanvas  = rotated;   // store RAW canvas, not processed
            bestAngle      = angle;
          }
          // Early break: angle is clearly superior, no need to check wider ones
          if (score0 !== null && score > score0 * 1.10) break;
        }

        // Only proceed if a non-zero angle meaningfully outperforms 0° baseline (≥3%)
        // RAW canvas used for OCR → single preprocessing, no double-processing artifacts
        if (bestRawCanvas && score0 !== null && bestAngleScore > score0 * 1.03) {
          const deskewOcrIn = batchUpscaleIfNeeded(hiContrastPreprocess(bestRawCanvas));
          if (deskewOcrIn.width > 80 && deskewOcrIn.height > 40) {
            ocrAttempt++;
            if (_runDbg) _runDbg.ocrCalls++;
            const { data: { text: deskewText } } = await wr.recognize(deskewOcrIn);

            const deskewLongest  = longestOCRLine(deskewText);
            const deskewChevrons = countChevrons(deskewText);
            const deskewHit = tryMRZ(deskewText, 'micro-deskew', { diag: lastDiag, attempts: ocrAttempt,
                                                                    longestLine: deskewLongest, chevronCount: deskewChevrons });
            if (deskewHit) return _finalizeRun(deskewHit, 'phase_2.9');
          }
        }
      } catch (_) {}
    }

    // ── Phase 2.95: adaptive geometric bottom-crop safety net ────────────
    // All prior phases failed. The density scorer often produces full-image crops
    // when the MRZ zone has low density (OCR-B '<' fillers). This phase bypasses
    // the scorer entirely, cutting a geometric bottom band from the stored rotated
    // canvas for each rotation. Adaptive: starts from the density scorer's top pick
    // (bestDeg), then tries +90° and +180° offsets with progressively deeper bands.
    // Max 3 extra OCR calls; triedProjDegs is intentionally ignored here.
    {
      const bestDeg = topCandidates[0]?.deg ?? 0;   // density scorer's top pick
      const PHASE295_ATTEMPTS = [
        { deg: bestDeg,                frac: 0.16 },  // scorer's choice, narrow band
        { deg: (bestDeg + 90)  % 360,  frac: 0.22 },  // +90° alternative
        { deg: (bestDeg + 180) % 360,  frac: 0.40 },  // opposite rotation, deep band
      ];
      const MAX_P295_CALLS = 3;
      let p295count = 0;

      if (window._mrzDebug) console.log('[P295] start bestDeg=' + bestDeg + ' file=' + (fileName || '?'));

      for (const { deg: fallbackDeg, frac } of PHASE295_ATTEMPTS) {
        if (p295count >= MAX_P295_CALLS) break;
        const pcd = projByDeg[fallbackDeg];
        if (!pcd) { if (window._mrzDebug) console.log('[P295] skip deg=' + fallbackDeg + ' no projByDeg entry'); continue; }

        const rh     = pcd.rotated.height;
        const botH   = Math.round(rh * frac);
        const topPad = Math.round(rh * 0.02);
        const botY   = Math.max(0, rh - botH - topPad);
        const padW   = Math.min(20, Math.round(pcd.rotated.width * 0.03));

        const fbCrop = document.createElement('canvas');
        fbCrop.width  = Math.max(1, pcd.rotated.width - 2 * padW);
        fbCrop.height = Math.max(1, botH);
        fbCrop.getContext('2d').drawImage(
          pcd.rotated, padW, botY, fbCrop.width, botH, 0, 0, fbCrop.width, botH
        );

        const fbOcrIn = batchUpscaleIfNeeded(batchPreprocessMRZ(fbCrop));
        if (window._mrzDebug) console.log('[P295] attempt deg=' + fallbackDeg + ' frac=' + frac + ' cropH=' + botH + ' ocrH=' + fbOcrIn.height);
        if (fbOcrIn.height < 24) { if (window._mrzDebug) console.log('[P295] skip: height < 24'); continue; }

        ocrAttempt++;
        if (_runDbg) _runDbg.ocrCalls++;
        p295count++;
        const pct       = Math.round(frac * 100);
        const bandLabel = 'rot' + fallbackDeg + '/bot' + pct + '-fallback';

        try {
          const { data: { text: fbText } } = await wr.recognize(fbOcrIn);

          const fbLongest  = longestOCRLine(fbText);
          const fbChevrons = countChevrons(fbText);

          if (window._mrzDebug) {
            const fl = fbText.split('\n');
            const dbgEntry = {
              phase: '2.95', label: bandLabel, deg: fallbackDeg, frac, fileName,
              cropHeight: botH,
              allLengths: fl.map(l => l.length),
              longestLine: fbLongest,
              mrzCandidates: fl.filter(l => l.length >= 28),
              chevronCount: fbChevrons,
              mrzScore: scoreMRZText(fbText),
            };
            if (!window._dbgData) window._dbgData = [];
            window._dbgData.push(dbgEntry);
            console.log('[P295]', JSON.stringify(dbgEntry));
          }

          // Phase 2.95 line recombination: ALWAYS try filtered candidates FIRST
          // to prevent false positives from garbage lines in full OCR text.
          // Collect MRZ-like lines (≥28 chars, clean charset, MRZ pattern),
          // try all 3-line orderings via extractMRZ. Pure string ops, no OCR.
          // Max 5 candidates = 60 permutations. Falls back to full-text
          // extractMRZ only if no filtered candidates found or all fail.
          const fbCands = fbText.split('\n').filter(l => {
            const cl = l.trim().replace(/[^A-Z0-9<]/gi, '').toUpperCase();
            if (cl.length < 28) return false;
            if (!/^[A-Z0-9<]+$/.test(cl)) return false;
            return cl.includes('<') || /^I</.test(cl) || /^\d{6}/.test(cl) || cl.includes('<<');
          }).slice(0, 5);

          let p295permCount = 0;

          if (fbCands.length >= 2) {
            outer295:
            for (let ai = 0; ai < fbCands.length; ai++) {
              for (let bi = 0; bi < fbCands.length; bi++) {
                if (bi === ai) continue;
                for (let ci = 0; ci < fbCands.length; ci++) {
                  if (ci === ai || ci === bi) continue;
                  p295permCount++;
                  const reord = [fbCands[ai], fbCands[bi], fbCands[ci]].join('\n');
                  // quiet=true: suppress per-permutation entries (up to 60); push one summary on success
                  const reordHit = tryMRZ(reord, bandLabel, { diag: lastDiag, attempts: ocrAttempt,
                                                               longestLine: fbLongest, chevronCount: fbChevrons }, true);
                  if (reordHit) {
                    if (window._mrzDebug) console.log('[P295] recombination success at perm#' + p295permCount + ' order=[' + ai + ',' + bi + ',' + ci + ']');
                    _pushAttempt({ path: bandLabel + '/reord', longestLine: fbLongest, chevronCount: fbChevrons,
                                   extracted: true, validated: true, reason: 'reord_accepted_perm' + p295permCount });
                    return _finalizeRun(reordHit, 'phase_2.95');
                  }
                }
              }
            }
            if (window._mrzDebug) console.log('[P295] recombination done: no match after ' + p295permCount + ' permutations, candidates=' + fbCands.length);
          }

          // Fallback: full OCR text (only if recombination found nothing or too few candidates)
          const fbHit = tryMRZ(fbText, bandLabel, { diag: lastDiag, attempts: ocrAttempt,
                                                     longestLine: fbLongest, chevronCount: fbChevrons });
          if (fbHit) {
            if (window._mrzDebug) console.log('[P295] full-text extractMRZ found result');
            return _finalizeRun(fbHit, 'phase_2.95');
          }
          if (window._mrzDebug) console.log('[P295] attempt ' + bandLabel + ' no valid MRZ');
        } catch (e) { if (window._mrzDebug) console.log('[P295] OCR error:', e?.message); }
      }
      if (window._mrzDebug) console.log('[P295] all attempts exhausted, p295count=' + p295count);
    }

    // ── Phase 3: NO_PARSE ─────────────────────────────────────────────────
    return _finalizeRun({
      extracted: null, diag: lastDiag, attempts: ocrAttempt,
      longestLine: failLongest, chevronCount: failChevrons,
      rawOcrText: globalBestText, selectedBand: '—',
    }, 'phase_3');
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
                    corrected: ocr.corrected || false, correctionCount: ocr.correctionCount || 0,
                    recoveryMode: ocr.recoveryMode || null,
                    combinationCount: ocr.combinationCount || 0,
                    fragmentSources: ocr.fragmentSources || null },
    };
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────

  window.MRZPipeline = {
    resizeForOCR,
    batchPreprocessMRZ,
    batchUpscaleIfNeeded,
    rotateCanvas,
    scoreMRZPresence,
    longestOCRLine,
    countChevrons,
    scoreMRZText,
    fastBatchOCR,
    createBatchWorker,
    processImage,
  };

})();
