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

        // TEMP DEBUG — img_1914/1780 root cause investigation
        if (['1914','1780'].some(id => (fileName||'').includes(id))) {
          const lines = text.split('\n');
          const mrzLines = lines.filter(l => l.length >= 28);
          const entry = { rot: deg, label, fileName,
            allLengths: lines.map(l => l.length),
            mrzCandidates: mrzLines };
          if (!window._dbgData) window._dbgData = [];
          window._dbgData.push(entry);
        }

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
              return {
                extracted: r2.corrResult, diag: lastDiag, attempts: ocrAttempt,
                longestLine: failLongest, chevronCount: failChevrons,
                rawOcrText: globalBestText,
                selectedBand: 'fragment-combined',
                corrected: r2.corrCount > 0, correctionCount: r2.corrCount,
                recoveryMode: 'fragment-combined',
                combinationCount,
                fragmentSources: sources([frags[i], frags[j]]),
              };
            }

            // 3-line combos (TD1)
            for (let k = 0; k < frags.length; k++) {
              if (k === i || k === j) continue;
              if (combinationCount >= 20) break outer25;
              const r3 = tryCombo([frags[i], frags[j], frags[k]]);
              if (r3) {
                return {
                  extracted: r3.corrResult, diag: lastDiag, attempts: ocrAttempt,
                  longestLine: failLongest, chevronCount: failChevrons,
                  rawOcrText: globalBestText,
                  selectedBand: 'fragment-combined',
                  corrected: r3.corrCount > 0, correctionCount: r3.corrCount,
                  recoveryMode: 'fragment-combined',
                  combinationCount,
                  fragmentSources: sources([frags[i], frags[j], frags[k]]),
                };
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
          const { data: { text: hiText } } = await wr.recognize(hiOcrIn);

          // Debug log — same images as Phase 1 debug
          if (['1914','1780'].some(id => (fileName||'').includes(id))) {
            const hiLines = hiText.split('\n');
            const entry = { rot: bestProjCropData.deg, label: 'proj-hicontrast', fileName,
              allLengths: hiLines.map(l => l.length),
              mrzCandidates: hiLines.filter(l => l.length >= 28) };
            if (!window._dbgData) window._dbgData = [];
            window._dbgData.push(entry);
          }

          const hiResult = extractMRZ(clean(hiText));
          if (hiResult) {
            const corrLines = correctCheckDigits(hiResult.type, hiResult.lines);
            const corrCount = countCheckDigitChanges(hiResult.type, hiResult.lines, corrLines);
            if (corrCount <= MAX_CORRECTIONS) {
              const corrResult = { type: hiResult.type, lines: corrLines };
              if (validateMRZ(corrResult).valid) {
                return {
                  extracted: corrResult, diag: lastDiag, attempts: ocrAttempt,
                  longestLine: failLongest, chevronCount: failChevrons,
                  rawOcrText: hiText, selectedBand: 'proj-hicontrast',
                  corrected: corrCount > 0, correctionCount: corrCount,
                  recoveryMode: 'proj-hicontrast',
                };
              }
            }
          }
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
      const tryPsm = async (psm) => {
        try {
          await wr.setParameters({ tessedit_pageseg_mode: psm });
          ocrAttempt++;
          const { data: { text: psmText } } = await wr.recognize(hiOcrIn28);
          await wr.setParameters({ tessedit_pageseg_mode: '6' }); // restore

          // Debug log for targeted images
          if (['1914','1780'].some(id => (fileName||'').includes(id))) {
            const psmLines = psmText.split('\n');
            const entry = { rot: bestProjCropData?.deg, label: 'psm' + psm, fileName,
              allLengths: psmLines.map(l => l.length),
              mrzCandidates: psmLines.filter(l => l.length >= 28) };
            if (!window._dbgData) window._dbgData = [];
            window._dbgData.push(entry);
          }

          const psmResult = extractMRZ(clean(psmText));
          if (psmResult) {
            const corrLines = correctCheckDigits(psmResult.type, psmResult.lines);
            const corrCount = countCheckDigitChanges(psmResult.type, psmResult.lines, corrLines);
            if (corrCount <= MAX_CORRECTIONS) {
              const corrResult = { type: psmResult.type, lines: corrLines };
              if (validateMRZ(corrResult).valid) {
                return {
                  extracted: corrResult, diag: lastDiag, attempts: ocrAttempt,
                  longestLine: failLongest, chevronCount: failChevrons,
                  rawOcrText: psmText, selectedBand: 'psm' + psm,
                  corrected: corrCount > 0, correctionCount: corrCount,
                  recoveryMode: 'psm' + psm,
                };
              }
            }
          }
          return null;
        } catch (_) {
          try { await wr.setParameters({ tessedit_pageseg_mode: '6' }); } catch (_2) {}
          return null;
        }
      };

      if (hiOcrIn28.width > 100 && hiOcrIn28.height > 100) {
        const r7 = await tryPsm('7');
        if (r7) return r7;
        const r8 = await tryPsm('8');
        if (r8) return r8;
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
            const { data: { text: deskewText } } = await wr.recognize(deskewOcrIn);

            // Debug log for problem images
            if (['1914', '1780'].some(id => (fileName || '').includes(id))) {
              const dl = deskewText.split('\n');
              const entry = {
                rot: bestProjCropData.deg, label: 'micro-deskew', fileName,
                allLengths: dl.map(l => l.length),
                mrzCandidates: dl.filter(l => l.length >= 28),
                bestAngle, score0, bestAngleScore, angleScores,
              };
              if (!window._dbgData) window._dbgData = [];
              window._dbgData.push(entry);
            }

            const deskewResult = extractMRZ(clean(deskewText));
            if (deskewResult) {
              const corrLines = correctCheckDigits(deskewResult.type, deskewResult.lines);
              const corrCount = countCheckDigitChanges(deskewResult.type, deskewResult.lines, corrLines);
              if (corrCount <= MAX_CORRECTIONS) {
                const corrResult = { type: deskewResult.type, lines: corrLines };
                if (validateMRZ(corrResult).valid) {
                  return {
                    extracted: corrResult, diag: lastDiag, attempts: ocrAttempt,
                    longestLine: failLongest, chevronCount: failChevrons,
                    rawOcrText: deskewText, selectedBand: 'micro-deskew',
                    corrected: corrCount > 0, correctionCount: corrCount,
                    recoveryMode: 'micro-deskew',
                  };
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    // ── Phase 2.95: proj-crop safety net (untried rotations) ─────────────
    // All prior phases failed. Try proj crops from rotations not yet OCR'd in Phase 1.
    // This guarantees deg=0/proj is attempted even if density scoring ranked it below top-8.
    // Priority order: [0, 90, 270, 180] — 0° first (most likely correct orientation).
    // Max 3 extra OCR calls; only untried proj degs; no duplicate OCR.
    {
      const PROJ_FALLBACK_ORDER = [0, 90, 270, 180];
      const MAX_PROJ_FALLBACK   = 3;
      let projFallbackCount = 0;

      for (const fallbackDeg of PROJ_FALLBACK_ORDER) {
        if (projFallbackCount >= MAX_PROJ_FALLBACK) break;
        if (triedProjDegs.has(fallbackDeg)) continue;   // already tried in Phase 1 — skip
        const pcd = projByDeg[fallbackDeg];
        if (!pcd) continue;

        // Recreate crop canvas the same way Phase 1 does
        const padW = Math.round(pcd.rotated.width * 0.03);
        const fbCrop = document.createElement('canvas');
        fbCrop.width  = Math.max(1, pcd.rotated.width - 2 * padW);
        fbCrop.height = Math.max(1, pcd.h);
        fbCrop.getContext('2d').drawImage(
          pcd.rotated, padW, pcd.y, fbCrop.width, pcd.h, 0, 0, fbCrop.width, pcd.h
        );

        const fbOcrIn = batchUpscaleIfNeeded(batchPreprocessMRZ(fbCrop));
        if (fbOcrIn.width <= 80 || fbOcrIn.height <= 40) continue;

        ocrAttempt++;
        projFallbackCount++;
        const bandLabel = 'rot' + fallbackDeg + '/proj-fallback';

        try {
          const { data: { text: fbText } } = await wr.recognize(fbOcrIn);

          // Debug log for problem images
          if (['1914', '1780'].some(id => (fileName || '').includes(id))) {
            const fl = fbText.split('\n');
            const entry = {
              label: 'proj-fallback', deg: fallbackDeg, fileName,
              allLengths: fl.map(l => l.length),
              mrzCandidates: fl.filter(l => l.length >= 28),
            };
            if (!window._dbgData) window._dbgData = [];
            window._dbgData.push(entry);
          }

          const fbResult = extractMRZ(clean(fbText));
          if (fbResult) {
            const corrLines = correctCheckDigits(fbResult.type, fbResult.lines);
            const corrCount = countCheckDigitChanges(fbResult.type, fbResult.lines, corrLines);
            if (corrCount <= MAX_CORRECTIONS) {
              const corrResult = { type: fbResult.type, lines: corrLines };
              if (validateMRZ(corrResult).valid) {
                return {
                  extracted: corrResult, diag: lastDiag, attempts: ocrAttempt,
                  longestLine: failLongest, chevronCount: failChevrons,
                  rawOcrText: fbText, selectedBand: bandLabel,
                  corrected: corrCount > 0, correctionCount: corrCount,
                  recoveryMode: 'proj-fallback',
                };
              }
            }
          }
        } catch (_) {}
      }
    }

    // ── Phase 3: NO_PARSE ─────────────────────────────────────────────────
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
                    corrected: ocr.corrected || false, correctionCount: ocr.correctionCount || 0,
                    recoveryMode: ocr.recoveryMode || null,
                    combinationCount: ocr.combinationCount || 0,
                    fragmentSources: ocr.fragmentSources || null },
    };
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────

  window.MRZPipeline = {
    cropBottom,
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
