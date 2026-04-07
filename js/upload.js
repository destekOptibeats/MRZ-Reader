// ═══════════════════════════════════════════════════════════════════════
// IMAGE UPLOAD PATH — Smart MRZ Detection Pipeline (OCR-free rotation)
// Phase 1: Rank rotations by pixel-based MRZ-likeness (no OCR)
// Phase 2: Locate MRZ region (projection + variance + gradient + width)
// Phase 3: Focused OCR on top candidates with conditional budget
// Fallback: band search if detection fails
// These functions must NOT be used by camera path.
// ═══════════════════════════════════════════════════════════════════════

// ── Externalized Thresholds ────────────────────────────────────────────
var UPLOAD_CFG = {
  // Phase 1: Rotation ranking
  ROTATION_KEEP_TOP:    2,
  ROTATION_THUMB_SIZE:  600,
  ROTATION_CROP_RATIO:  0.50,

  // Phase 2: Row scoring weights
  PROJ_W: 0.4,
  VAR_W:  0.3,
  GRAD_W: 0.3,

  // Phase 2: Region detection
  REGION_KEEP_TOP:       2,
  REGION_SMOOTH_KERNEL:  0.003,
  REGION_DARK_THRESHOLD: 140,
  PEAK_MIN_HEIGHT:       0.01,
  PEAK_MAX_HEIGHT:       0.08,
  PEAK_MAX_GAP:          0.04,
  BAND_HEIGHT_MIN:       0.04,
  BAND_HEIGHT_MAX:       0.25,
  WIDTH_SIM_MIN:         0.6,
  ALIGN_SCORE_MIN:       0.7,
  WIDTH_PENALTY:         0.5,

  // Phase 2: Region scoring weights
  RS_MEAN_ROW_W:    0.30,
  RS_BAND_FIT_W:    0.15,
  RS_LINE_COUNT_W:  0.10,
  RS_WIDTH_CONS_W:  0.25,
  RS_BOTTOM_BIAS_W: 0.20,

  // Phase 3: OCR budget
  REGION2_MIN_RATIO:    0.80,
  WIDER_CROP_MULT:      2.0,
  ROT_SCORE_W:          0.35,
  REG_SCORE_W:          0.65,
};

// ── Helpers (unchanged) ────────────────────────────────────────────────

// Resmi max genişliğe ölçekle + döndür (upload-only)
function uploadMakeCanvas(img, deg, maxW) {
  maxW = maxW || 1600;
  var imgW = img.naturalWidth || img.width;
  var imgH = img.naturalHeight || img.height;
  const swap = deg === 90 || deg === 270;
  const sw = swap ? imgH : imgW;
  const sh = swap ? imgW : imgH;
  const scale = sw > maxW ? maxW / sw : 1;
  const rw = Math.round(sw * scale), rh = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  const ctx = c.getContext('2d');
  ctx.save(); ctx.translate(rw/2, rh/2);
  ctx.rotate(deg * Math.PI / 180); ctx.scale(scale, scale);
  ctx.drawImage(img, -imgW/2, -imgH/2);
  ctx.restore(); return c;
}

// Upload-only: crop a vertical band by center position and height ratio
function uploadCropBand(srcCanvas, centerY, heightRatio) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  if (!sw || !sh) return srcCanvas;
  const cropH = Math.min(Math.round(sh * heightRatio), sh);
  let sy = Math.round(sh * centerY - cropH / 2);
  sy = Math.max(0, Math.min(sy, sh - cropH));
  const c = document.createElement('canvas');
  c.width = sw; c.height = cropH;
  c.getContext('2d').drawImage(srcCanvas, 0, sy, sw, cropH, 0, 0, sw, cropH);
  return c;
}

// Upload-only: crop by absolute pixel coordinates
function uploadCropRegion(srcCanvas, sy, cropH) {
  const sw = srcCanvas.width;
  const c = document.createElement('canvas');
  c.width = sw; c.height = cropH;
  c.getContext('2d').drawImage(srcCanvas, 0, sy, sw, cropH, 0, 0, sw, cropH);
  return c;
}

// Upload-only: grayscale + contrast + unsharp mask
// mode: undefined=normal, 'hi'=high contrast, 'bin'=adaptive binarization
function uploadPreprocess(srcCanvas, mode) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  // Legacy boolean support: true → 'hi'
  if (mode === true) mode = 'hi';

  // Adaptive binarization: local mean threshold → pure black/white
  if (mode === 'bin') {
    ctx.filter = 'grayscale(1)';
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.filter = 'none';
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    // Build grayscale array
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = d[i * 4];
    // Integral image for fast local mean
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = rowSum + integral[y * (w + 1) + (x + 1)];
      }
    }
    // Adaptive threshold with local window
    const radius = Math.max(8, Math.round(Math.min(w, h) * 0.02));
    const bias = -8; // slight bias toward keeping dark pixels (text)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
        const x1 = Math.min(w, x + radius + 1), y1 = Math.min(h, y + radius + 1);
        const area = (x1 - x0) * (y1 - y0);
        const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1]
                  - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        const mean = sum / area;
        const val = gray[y * w + x] < (mean + bias) ? 0 : 255;
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return c;
  }

  var contrastVal = mode === 'hi' ? 2.2 : 1.6;
  ctx.filter = 'grayscale(1) contrast(' + contrastVal + ')';
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.filter = 'none';

  // Unsharp mask (sharpen)
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const orig = new Uint8ClampedArray(d);
  const amount = 0.6, threshold = 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const blur = (
          orig[((y-1)*w+x-1)*4+ch] + orig[((y-1)*w+x)*4+ch]*2 + orig[((y-1)*w+x+1)*4+ch] +
          orig[(y*w+x-1)*4+ch]*2   + orig[i+ch]*4              + orig[(y*w+x+1)*4+ch]*2 +
          orig[((y+1)*w+x-1)*4+ch] + orig[((y+1)*w+x)*4+ch]*2 + orig[((y+1)*w+x+1)*4+ch]
        ) / 16;
        const diff = orig[i+ch] - blur;
        if (Math.abs(diff) > threshold) {
          d[i+ch] = Math.min(255, Math.max(0, orig[i+ch] + diff * amount));
        }
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

// Parçalı MRZ satırlarını OCR çıktısından toplayan fonksiyon
// Her OCR denemesinden sonra potansiyel satırları biriktirir
function collectMRZLines(text, acc) {
  if (!text) return;
  var cleaned = clean(text);
  var lines = cleaned.split(/\n+/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 15; });

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // TD1 satırları (30 karakter)
    var l1 = fixLine(line, {targetLen: 30, kind: 'TD1_L1'});
    if (l1 && isL1_TD1(l1) && acc.td1_l1.indexOf(l1) === -1) acc.td1_l1.push(l1);

    var l2 = fixLine(line, {targetLen: 30, kind: 'TD1_L2'});
    if (l2 && isL2_TD1(l2) && acc.td1_l2.indexOf(l2) === -1) acc.td1_l2.push(l2);

    var l3 = fixLine(line, {targetLen: 30, kind: 'TD1_L3'});
    if (l3 && isL3_TD1(l3) && acc.td1_l3.indexOf(l3) === -1) acc.td1_l3.push(l3);

    // TD3 satırları (44 karakter)
    var t1 = fixLine(line, {targetLen: 44, kind: 'TD3_L1'});
    if (t1 && isL1_TD3(t1) && acc.td3_l1.indexOf(t1) === -1) acc.td3_l1.push(t1);

    var t2 = fixLine(line, {targetLen: 44, kind: 'TD3_L2'});
    if (t2 && isL2_TD3(t2) && acc.td3_l2.indexOf(t2) === -1) acc.td3_l2.push(t2);
  }
}

// Biriktirilen satırlardan geçerli MRZ oluşturmayı dener
function tryAssemblyFromAcc(acc) {
  // TD1: L1 + L2 + L3 gerekli
  for (var a = 0; a < acc.td1_l1.length; a++) {
    for (var b = 0; b < acc.td1_l2.length; b++) {
      for (var c = 0; c < acc.td1_l3.length; c++) {
        var result = { type: 'TD1', lines: [acc.td1_l1[a], acc.td1_l2[b], acc.td1_l3[c]] };
        var v = validateMRZ(result);
        if (v.valid) return result;
      }
    }
  }

  // TD3: L1 + L2 gerekli
  for (var a = 0; a < acc.td3_l1.length; a++) {
    for (var b = 0; b < acc.td3_l2.length; b++) {
      var result = { type: 'TD3', lines: [acc.td3_l1[a], acc.td3_l2[b]] };
      var v = validateMRZ(result);
      if (v.valid) return result;
    }
  }

  return null;
}

// Upload-only: OCR → parse → checksum denemesi
// acc: opsiyonel satır biriktirici — başarısız olsa bile parçalı satırları toplar
// meta: { rotation, method, region, preprocess } — debug export için
async function uploadTryRecognize(canvas, acc, ocrWorker, meta) {
  var attempt = {
    rotation: meta ? meta.rotation : null,
    method: meta ? meta.method : '',
    region: meta ? meta.region : '',
    preprocess: meta ? meta.preprocess : '',
    ocrText: '',
    ocrLen: 0,
    mrzFound: false,
    checksumOk: false,
    success: false,
    confidence: null
  };
  try {
    const wr = ocrWorker || worker;
    const { data: { text, confidence } } = await wr.recognize(canvas);
    attempt.confidence = typeof confidence === 'number' ? Math.round(confidence) : null;
    // Diagnostic: log what Tesseract actually reads
    var ocrLines = text.split('\n').filter(function(l) { return l.trim().length > 5; });
    var longest = ocrLines.reduce(function(a, b) { return a.length > b.length ? a : b; }, '');
    attempt.ocrText = text.replace(/\n+/g, ' ').substring(0, 300);
    attempt.ocrLen = longest.length;
    logStep('[OCR_TEXT] text="' + longest.substring(0, 40) + '" len=' + longest.length);
    // OCR quality heuristic
    var qualityLabel = attempt.confidence !== null && attempt.confidence < 40 ? 'low' :
                       attempt.confidence !== null && attempt.confidence < 65 ? 'medium' : 'ok';
    if (longest.length < 20) qualityLabel = 'low';
    if (qualityLabel !== 'ok') logStep('[OCR_QUALITY] level=' + qualityLabel + ' conf=' + attempt.confidence + ' len=' + longest.length);

    // Parçalı satırları biriktir (her zaman, başarılı/başarısız fark etmez)
    if (acc) collectMRZLines(text, acc);

    const result = extractMRZ(clean(text));
    if (result) {
      attempt.mrzFound = true;
      var v = validateMRZ(result);
      if (v.valid) {
        attempt.checksumOk = true;
        attempt.success = true;
        if (window._debugAttempts) window._debugAttempts.push(attempt);
        return result;
      }
      logStep('[OCR] status=checksum_fail checksums=' + JSON.stringify(v.checksums));
    }
  } catch(e) { /* devam */ }
  if (window._debugAttempts) window._debugAttempts.push(attempt);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: OCR-FREE ROTATION RANKING
// Pixel analysis at 4 rotations — rank by MRZ-likeness score
// Signals: horizontal projection density, row variance, gradient strength
// ═══════════════════════════════════════════════════════════════════════

// Compute per-row scores: projection + variance + horizontal gradient
function computeRowScores(canvas) {
  var C = UPLOAD_CFG;
  var w = canvas.width, h = canvas.height;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var imgData = ctx.getImageData(0, 0, w, h);
  var data = imgData.data;

  // Adaptive dark threshold: sample center region for Otsu-like split
  var darkThresh = C.REGION_DARK_THRESHOLD;
  var sampleW = Math.round(w * 0.4);
  var sampleX = Math.round(w * 0.3);
  var sampleH = Math.round(h * 0.3);
  var sampleY = Math.round(h * 0.6);
  var histogram = new Uint32Array(256);
  for (var sy = sampleY; sy < sampleY + sampleH && sy < h; sy++) {
    for (var sx = sampleX; sx < sampleX + sampleW && sx < w; sx++) {
      var si = (sy * w + sx) * 4;
      var sg = Math.round(0.299 * data[si] + 0.587 * data[si+1] + 0.114 * data[si+2]);
      histogram[sg]++;
    }
  }
  // Simple Otsu threshold
  var total = sampleW * sampleH;
  var sumAll = 0;
  for (var t = 0; t < 256; t++) sumAll += t * histogram[t];
  var sumB = 0, wB = 0, maxBetween = 0, bestT = darkThresh;
  for (var t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    var wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    var mB = sumB / wB;
    var mF = (sumAll - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxBetween) { maxBetween = between; bestT = t; }
  }
  darkThresh = Math.min(180, Math.max(80, bestT));

  // Per-row: projection (dark ratio), variance, horizontal gradient
  var projections = new Float32Array(h);
  var variances = new Float32Array(h);
  var gradients = new Float32Array(h);

  for (var y = 0; y < h; y++) {
    var darkCount = 0;
    var graySum = 0, graySumSq = 0;
    var gradSum = 0;
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      if (gray < darkThresh) darkCount++;
      graySum += gray;
      graySumSq += gray * gray;
      if (x > 0) {
        var prevI = (y * w + x - 1) * 4;
        var prevGray = 0.299 * data[prevI] + 0.587 * data[prevI+1] + 0.114 * data[prevI+2];
        gradSum += Math.abs(gray - prevGray);
      }
    }
    projections[y] = darkCount / w;
    var mean = graySum / w;
    variances[y] = (graySumSq / w) - (mean * mean);
    gradients[y] = gradSum / (w - 1);
  }

  // Normalize each signal to [0,1]
  var maxProj = 0, maxVar = 0, maxGrad = 0;
  for (var y = 0; y < h; y++) {
    if (projections[y] > maxProj) maxProj = projections[y];
    if (variances[y] > maxVar) maxVar = variances[y];
    if (gradients[y] > maxGrad) maxGrad = gradients[y];
  }

  var rowScores = new Float32Array(h);
  for (var y = 0; y < h; y++) {
    var pNorm = maxProj > 0 ? projections[y] / maxProj : 0;
    var vNorm = maxVar > 0 ? variances[y] / maxVar : 0;
    var gNorm = maxGrad > 0 ? gradients[y] / maxGrad : 0;
    rowScores[y] = C.PROJ_W * pNorm + C.VAR_W * vNorm + C.GRAD_W * gNorm;
  }

  return { rowScores: rowScores, projections: projections, darkThresh: darkThresh };
}

// Compute rotation MRZ-likeness score (no OCR)
function scoreRotation(canvas) {
  var C = UPLOAD_CFG;
  var h = canvas.height;
  var result = computeRowScores(canvas);
  var rowScores = result.rowScores;

  // Focus on bottom ROTATION_CROP_RATIO of image
  var startY = Math.round(h * (1 - C.ROTATION_CROP_RATIO));
  var sumScore = 0;

  // Find top N rows by score in the bottom region
  var bottomScores = [];
  for (var y = startY; y < h; y++) {
    bottomScores.push(rowScores[y]);
  }
  bottomScores.sort(function(a, b) { return b - a; });

  // MRZ typically occupies ~5-15% of image height — take top such rows
  var topN = Math.max(10, Math.round(h * 0.10));
  topN = Math.min(topN, bottomScores.length);
  for (var i = 0; i < topN; i++) {
    sumScore += bottomScores[i];
  }

  return topN > 0 ? sumScore / topN : 0;
}

// Rank all 4 rotations, return top ROTATION_KEEP_TOP
function rankRotations(img) {
  var C = UPLOAD_CFG;
  var rotations = [0, 180, 90, 270]; // prioritize 0° and 180°
  var scored = [];

  for (var ri = 0; ri < rotations.length; ri++) {
    var deg = rotations[ri];
    var thumb = uploadMakeCanvas(img, deg, C.ROTATION_THUMB_SIZE);
    var score = scoreRotation(thumb);
    scored.push({ deg: deg, score: score });
    logStep('[ROT] deg=' + deg + ' score=' + score.toFixed(4));
  }

  scored.sort(function(a, b) { return b.score - a.score; });
  var top = scored.slice(0, C.ROTATION_KEEP_TOP);

  // Portrait guard: only for portrait photos (height > width).
  // Landscape photos may have the card sideways, so 90°/270° can be valid.
  var imgW = img.naturalWidth || img.width;
  var imgH = img.naturalHeight || img.height;
  var isPortrait = imgH > imgW;

  if (!isPortrait) {
    logStep('[ROT] status=landscape_skip reason=portrait_guard');
  }

  var primaryInTop = 0;
  for (var ti = 0; ti < top.length; ti++) {
    if (top[ti].deg === 0 || top[ti].deg === 180) primaryInTop++;
  }
  if (isPortrait && primaryInTop === 0) {
    // Both slots are 90°/270° — replace both with 0° and 180°
    var s0 = null, s180 = null;
    for (var si = 0; si < scored.length; si++) {
      if (scored[si].deg === 0) s0 = scored[si];
      if (scored[si].deg === 180) s180 = scored[si];
    }
    if (s0 && s180) {
      top = s0.score >= s180.score ? [s0, s180] : [s180, s0];
    } else {
      top = [s0 || s180];
    }
    logStep('[ROT] status=portrait_guard forced=[0,180]');
  }

  logStep('[ROT] selected=[' + top.map(function(r) { return r.deg; }).join(',') + '] scores=[' + top.map(function(r) { return r.score.toFixed(3); }).join(',') + ']');
  return top;
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2: MRZ REGION LOCALIZATION (Enhanced 5-signal scoring)
// Signals: projection density, row variance, horizontal gradient,
//          width consistency, bottom-bias gradient
// ═══════════════════════════════════════════════════════════════════════

// Measure line widths for width consistency scoring
function measureLineWidths(canvas, peakStart, peakEnd, darkThresh) {
  var w = canvas.width;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var data = ctx.getImageData(0, peakStart, w, peakEnd - peakStart).data;
  var lineH = peakEnd - peakStart;

  // Find leftmost and rightmost dark pixels (averaged across rows)
  var leftSum = 0, rightSum = 0, rowCount = 0;
  for (var y = 0; y < lineH; y++) {
    var leftMost = -1, rightMost = -1;
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      if (gray < darkThresh) {
        if (leftMost < 0) leftMost = x;
        rightMost = x;
      }
    }
    if (leftMost >= 0 && rightMost > leftMost) {
      leftSum += leftMost;
      rightSum += rightMost;
      rowCount++;
    }
  }

  if (rowCount === 0) return { xStart: 0, xEnd: w, width: w };
  return {
    xStart: leftSum / rowCount,
    xEnd: rightSum / rowCount,
    width: (rightSum - leftSum) / rowCount
  };
}

// Enhanced MRZ region localization with 5-signal scoring
function locateMRZRegions(canvas) {
  var C = UPLOAD_CFG;
  var w = canvas.width, h = canvas.height;
  if (w < 100 || h < 100) return [];

  var rowResult = computeRowScores(canvas);
  var rowScores = rowResult.rowScores;
  var projections = rowResult.projections;
  var darkThresh = rowResult.darkThresh;

  // Smooth row scores
  var smoothed = new Float32Array(h);
  var kernel = Math.max(2, Math.round(h * C.REGION_SMOOTH_KERNEL));
  for (var y = kernel; y < h - kernel; y++) {
    var sum = 0;
    for (var k = -kernel; k <= kernel; k++) sum += rowScores[y + k];
    smoothed[y] = sum / (2 * kernel + 1);
  }

  // Find adaptive peak threshold
  var vals = [];
  for (var y = 0; y < h; y++) {
    if (smoothed[y] > 0) vals.push(smoothed[y]);
  }
  vals.sort(function(a, b) { return a - b; });
  var median = vals.length > 0 ? vals[Math.floor(vals.length * 0.5)] : 0;
  var peakThreshold = Math.max(median * 1.5, 0.03);

  // Find peaks (dense text rows)
  var peaks = [];
  var inPeak = false, peakStart = 0;
  var minLineH = Math.max(5, Math.round(h * C.PEAK_MIN_HEIGHT));
  var maxLineH = Math.round(h * C.PEAK_MAX_HEIGHT);

  for (var y = 0; y < h; y++) {
    if (smoothed[y] > peakThreshold && !inPeak) {
      inPeak = true; peakStart = y;
    } else if ((smoothed[y] <= peakThreshold || y === h - 1) && inPeak) {
      inPeak = false;
      var peakEnd = y;
      var pw = peakEnd - peakStart;
      if (pw >= minLineH && pw <= maxLineH) {
        var densitySum = 0;
        for (var py = peakStart; py < peakEnd; py++) densitySum += smoothed[py];
        peaks.push({
          start: peakStart,
          end: peakEnd,
          center: (peakStart + peakEnd) / 2,
          width: pw,
          density: densitySum / pw
        });
      }
    }
  }

  if (peaks.length < 1) {
    logStep('[REGION] peaks=0 thresh=' + peakThreshold.toFixed(3) + ' median=' + median.toFixed(3) + ' status=none reason=no_peaks');
    return [];
  }
  logStep('[REGION] peaks=' + peaks.length + ' thresh=' + peakThreshold.toFixed(3) + ' median=' + median.toFixed(3));

  // Single peak: create expanded region around it (MRZ lines likely nearby but below threshold)
  if (peaks.length === 1) {
    var sp = peaks[0];
    // Estimate MRZ height: ~3× single peak height (TD1 has 3 lines)
    var estMrzH = sp.width * 3;
    var spStart = Math.max(0, sp.start - estMrzH);
    var spEnd = Math.min(h, sp.end + estMrzH);
    var spPad = Math.round((spEnd - spStart) * 0.3);
    var spCropStart = Math.max(0, spStart - spPad);
    var spCropEnd = Math.min(h, spEnd + spPad);
    var spPosRatio = sp.center / h;
    logStep('[REGION] status=single_peak_fallback y=' + spCropStart + '-' + spCropEnd + ' pos=' + (spPosRatio * 100).toFixed(0) + '%' + (spPosRatio < 0.5 ? ' warning=upper_half_peak' : ''));
    return [{
      y: spCropStart,
      h: spCropEnd - spCropStart,
      lines: 1,
      score: sp.density * 0.5,
      rawStart: spStart,
      rawEnd: spEnd
    }];
  }

  // Measure line widths for each peak
  for (var pi = 0; pi < peaks.length; pi++) {
    peaks[pi].lineWidth = measureLineWidths(canvas, peaks[pi].start, peaks[pi].end, darkThresh);
  }

  // Score clusters of 2-3 consecutive peaks
  var clusters = [];
  var maxGap = Math.round(h * C.PEAK_MAX_GAP);

  for (var i = 0; i < peaks.length; i++) {
    // Try 2-line cluster (TD3 passport)
    if (i + 1 < peaks.length) {
      var gap = peaks[i + 1].start - peaks[i].end;
      if (gap >= 0 && gap <= maxGap) {
        clusters.push(scoreCluster([peaks[i], peaks[i + 1]], h, C));
      }
    }
    // Try 3-line cluster (TD1 ID card)
    if (i + 2 < peaks.length) {
      var gap1 = peaks[i + 1].start - peaks[i].end;
      var gap2 = peaks[i + 2].start - peaks[i + 1].end;
      if (gap1 >= 0 && gap1 <= maxGap && gap2 >= 0 && gap2 <= maxGap) {
        clusters.push(scoreCluster([peaks[i], peaks[i + 1], peaks[i + 2]], h, C));
      }
    }
  }

  if (clusters.length === 0) {
    logStep('[REGION] status=no_valid_clusters');
    return [];
  }

  // Sort by score descending, return top N
  clusters.sort(function(a, b) { return b.score - a.score; });
  var topN = Math.min(C.REGION_KEEP_TOP, clusters.length);
  var results = [];
  for (var ci = 0; ci < topN; ci++) {
    var cl = clusters[ci];
    var regionH = cl.end - cl.start;
    var padY = Math.round(regionH * 0.5);
    var cropStart = Math.max(0, cl.start - padY);
    var cropEnd = Math.min(h, cl.end + padY);
    results.push({
      y: cropStart,
      h: cropEnd - cropStart,
      lines: cl.lines,
      score: cl.score,
      rawStart: cl.start,
      rawEnd: cl.end
    });
    logStep('[REGION] candidate=' + (ci+1) + ' y=' + cropStart + '-' + cropEnd + ' lines=' + cl.lines + ' score=' + cl.score.toFixed(4));
  }
  return results;
}

// Score a cluster of peaks using 5 signals
function scoreCluster(peakGroup, imgH, C) {
  var lines = peakGroup.length;
  var start = peakGroup[0].start;
  var end = peakGroup[lines - 1].end;
  var bandH = (end - start) / imgH;

  // Signal 1: Mean row density
  var meanDensity = 0;
  for (var i = 0; i < lines; i++) meanDensity += peakGroup[i].density;
  meanDensity /= lines;

  // Signal 2: Band height fitness [BAND_HEIGHT_MIN, BAND_HEIGHT_MAX]
  var bandFit = 0;
  if (bandH >= C.BAND_HEIGHT_MIN && bandH <= C.BAND_HEIGHT_MAX) {
    var ideal = (C.BAND_HEIGHT_MIN + C.BAND_HEIGHT_MAX) / 2;
    bandFit = 1 - Math.abs(bandH - ideal) / (C.BAND_HEIGHT_MAX - C.BAND_HEIGHT_MIN);
  }

  // Signal 3: Line count estimate (2=1.0, 3=1.05)
  var lineCountScore = lines === 3 ? 1.05 : 1.0;

  // Signal 4: Width consistency
  var widths = [];
  var xStarts = [];
  for (var i = 0; i < lines; i++) {
    widths.push(peakGroup[i].lineWidth.width);
    xStarts.push(peakGroup[i].lineWidth.xStart);
  }
  var minW = Math.min.apply(null, widths);
  var maxW = Math.max.apply(null, widths);
  var widthSim = maxW > 0 ? minW / maxW : 0;

  // Alignment: how close are xStart values
  var xMin = Math.min.apply(null, xStarts);
  var xMax = Math.max.apply(null, xStarts);
  var xRange = maxW > 0 ? (xMax - xMin) / maxW : 1;
  var alignScore = Math.max(0, 1 - xRange * 2);

  var widthConsistency = 1.0;
  if (widthSim < C.WIDTH_SIM_MIN || alignScore < C.ALIGN_SCORE_MIN) {
    widthConsistency = C.WIDTH_PENALTY;
  } else {
    widthConsistency = (widthSim + alignScore) / 2;
  }

  // Signal 5: Bottom bias (soft gradient — scan entire image, weight lower regions)
  var centerY = (start + end) / 2 / imgH;
  var bottomBias = centerY; // linear gradient: 0 at top, 1 at bottom

  // Composite score
  var score = C.RS_MEAN_ROW_W * meanDensity +
              C.RS_BAND_FIT_W * bandFit +
              C.RS_LINE_COUNT_W * lineCountScore +
              C.RS_WIDTH_CONS_W * widthConsistency +
              C.RS_BOTTOM_BIAS_W * bottomBias;

  return { start: start, end: end, lines: lines, score: score };
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: FOCUSED OCR WITH CONDITIONAL BUDGET
// ═══════════════════════════════════════════════════════════════════════

// Try all OCR methods for a single rotation. Returns result or null.
async function tryRotation(rotated, deg, ctx, ocrWorker) {
  var C = UPLOAD_CFG;

  // Satır biriktirici — aynı rotasyondaki OCR denemelerinden parçalı satırları toplar
  var acc = { td1_l1: [], td1_l2: [], td1_l3: [], td3_l1: [], td3_l2: [] };

  // ── Region detection + OCR ──
  var regions = locateMRZRegions(rotated);
  ctx.summary.regionsFound = Math.max(ctx.summary.regionsFound, regions.length);

  if (regions.length > 0) {
    var tryCount = 1;
    if (regions.length >= 2) {
      var ratio = regions[1].score / regions[0].score;
      if (ratio >= C.REGION2_MIN_RATIO) {
        tryCount = 2;
        logStep('[REGION] status=score_close trying=2 ratio=' + ratio.toFixed(3));
      }
    }

    // EXPERIMENT: Region budget limiter — peaks<2 → only 1 enhanced attempt per region
    var regionBudgetLimited = (regions.length < 2);
    if (regionBudgetLimited) {
      logStep('[EXP] name=RegionBudget action=limit_to_1 reason=peaks_lt_2');
    }

    for (var rgi = 0; rgi < tryCount; rgi++) {
      if (processingCancelled) return null;
      var region = regions[rgi];
      ctx.summary.regionsTried++;
      var regLabel = 'region-' + (rgi+1);
      logStep('[OCR] rot=' + deg + ' region=' + regLabel + ' score=' + region.score.toFixed(3));

      var cropped = uploadCropRegion(rotated, region.y, region.h);

      // Enhanced
      var enhanced = uploadPreprocess(cropped);
      ctx.ocrCount++; ctx.summary.totalOCR++;
      var result = await uploadTryRecognize(enhanced, acc, ocrWorker, { rotation: deg, method: regLabel + ' enhanced', region: regLabel, preprocess: 'enhanced' });
      logStep('[OCR] rot=' + deg + ' region=' + regLabel + ' method=enhanced result=' + (result ? 'SUCCESS' : 'FAIL'));
      if (result) return { result: result, method: 'enhanced', region: rgi + 1, bandIdx: -1 };

      // Budget limited: skip remaining region attempts, go to band fallback
      if (regionBudgetLimited) {
        logStep('[EXP] name=RegionBudget action=skip region=' + regLabel);
        continue;
      }

      // Raw
      if (processingCancelled) return null;
      ctx.ocrCount++; ctx.summary.totalOCR++;
      result = await uploadTryRecognize(cropped, acc, ocrWorker, { rotation: deg, method: regLabel + ' raw', region: regLabel, preprocess: 'raw' });
      logStep('[OCR] rot=' + deg + ' region=' + regLabel + ' method=raw result=' + (result ? 'SUCCESS' : 'FAIL'));
      if (result) return { result: result, method: 'raw', region: rgi + 1, bandIdx: -1 };

      // Wider
      if (processingCancelled) return null;
      var rawH = region.rawEnd - region.rawStart;
      var widerPad = Math.round(rawH * (C.WIDER_CROP_MULT - 1) / 2);
      var widerY = Math.max(0, region.rawStart - widerPad);
      var widerEnd = Math.min(rotated.height, region.rawEnd + widerPad);
      var wider = uploadCropRegion(rotated, widerY, widerEnd - widerY);
      var widerEnh = uploadPreprocess(wider);
      ctx.ocrCount++; ctx.summary.totalOCR++;
      result = await uploadTryRecognize(widerEnh, acc, ocrWorker, { rotation: deg, method: regLabel + ' wider', region: regLabel, preprocess: 'enhanced' });
      logStep('[OCR] rot=' + deg + ' region=' + regLabel + ' method=wider result=' + (result ? 'SUCCESS' : 'FAIL'));
      if (result) return { result: result, method: 'wider', region: rgi + 1, bandIdx: -2 };

      // Hi-contrast
      if (processingCancelled) return null;
      var hiCon = uploadPreprocess(cropped, 'hi');
      ctx.ocrCount++; ctx.summary.totalOCR++;
      result = await uploadTryRecognize(hiCon, acc, ocrWorker, { rotation: deg, method: regLabel + ' hi-contrast', region: regLabel, preprocess: 'hi' });
      logStep('[OCR] rot=' + deg + ' region=' + regLabel + ' method=hi-contrast result=' + (result ? 'SUCCESS' : 'FAIL'));
      if (result) return { result: result, method: 'hi-contrast', region: rgi + 1, bandIdx: -1 };
    }
  } else {
    logStep('[REGION] deg=' + deg + ' regions=0 status=none');
  }

  // ── Band fallback ──
  ctx.summary.fallbackUsed = true;
  if (regions.length > 0) logStep('[REGION] deg=' + deg + ' status=fallback reason=region_ocr_failed');
  // Band sırası: alt %50 öne alındı — çoğu fotoğrafta MRZ buraya düşer
  var bands = [
    { cy: 0.85, hr: 0.25, label: 'alt-25', tryBin: true },
    { cy: 0.75, hr: 0.50, label: 'alt-50', tryBin: true },
    { cy: 0.80, hr: 0.35, label: 'alt-35', tryBin: false },
    { cy: 0.65, hr: 0.35, label: 'midlow-35', tryBin: false },
    { cy: 0.15, hr: 0.25, label: 'top-25', tryBin: false },
    { cy: 0.50, hr: 1.00, label: 'full', tryBin: false },
  ];

  for (var bi = 0; bi < bands.length; bi++) {
    if (processingCancelled) return null;
    var bc = bands[bi];
    var bandCrop = bc.hr >= 1.0 ? rotated : uploadCropBand(rotated, bc.cy, bc.hr);

    var bandEnh = uploadPreprocess(bandCrop);
    ctx.ocrCount++; ctx.summary.totalOCR++;
    var result = await uploadTryRecognize(bandEnh, acc, ocrWorker, { rotation: deg, method: 'band ' + bc.label + ' enhanced', region: 'band-' + bc.label, preprocess: 'enhanced' });
    logStep('[OCR] rot=' + deg + ' band=' + bc.label + ' method=enhanced result=' + (result ? 'SUCCESS' : 'FAIL'));
    if (result) return { result: result, method: 'band-' + bc.label, region: null, bandIdx: bi };

    // Adaptive binarization dene (işaretli bandlar için)
    if (bc.tryBin) {
      if (processingCancelled) return null;
      var bandBin = uploadPreprocess(bandCrop, 'bin');
      ctx.ocrCount++; ctx.summary.totalOCR++;
      result = await uploadTryRecognize(bandBin, acc, ocrWorker, { rotation: deg, method: 'band ' + bc.label + ' bin', region: 'band-' + bc.label, preprocess: 'bin' });
      logStep('[OCR] rot=' + deg + ' band=' + bc.label + ' method=bin result=' + (result ? 'SUCCESS' : 'FAIL'));
      if (result) return { result: result, method: 'band-' + bc.label + '-bin', region: null, bandIdx: bi };
    }
  }

  // ── Parçalı satır birleştirme denemesi ──
  var accTotal = acc.td1_l1.length + acc.td1_l2.length + acc.td1_l3.length + acc.td3_l1.length + acc.td3_l2.length;
  // Assembly bilgisini her zaman kaydet (summary'ye eklenecek)
  var assemblyInfo = {
    l1: acc.td1_l1.length, l2: acc.td1_l2.length, l3: acc.td1_l3.length,
    td3_l1: acc.td3_l1.length, td3_l2: acc.td3_l2.length
  };
  ctx._lastAssembly = assemblyInfo;

  var asmStatus = 'ok';
  if (acc.td1_l2.length === 0 && acc.td1_l1.length > 0) asmStatus = 'l2_missing';
  else if (acc.td1_l1.length === 0 && acc.td1_l3.length > 0) asmStatus = 'l1_missing';
  else if (accTotal === 0) asmStatus = 'no_candidates';

  logStep('[ASSEMBLY] l1=' + assemblyInfo.l1 + ' l2=' + assemblyInfo.l2 + ' l3=' + assemblyInfo.l3 +
    (assemblyInfo.td3_l1 || assemblyInfo.td3_l2 ? ' td3_l1=' + assemblyInfo.td3_l1 + ' td3_l2=' + assemblyInfo.td3_l2 : '') +
    ' status=' + asmStatus);

  if (asmStatus !== 'ok' && asmStatus !== 'no_candidates') {
    logStep('[DIAGNOSE] type=' + asmStatus);
    if (asmStatus === 'l2_missing') logStep('[DIAGNOSE] l1_samples="' + acc.td1_l1.slice(0,2).join(' | ').substring(0, 80) + '"');
  }

  if (accTotal >= 2) {
    var assembled = tryAssemblyFromAcc(acc);
    if (assembled) {
      logStep('[ASSEMBLY] rot=' + deg + ' status=success');
      return { result: assembled, method: 'assembly', region: 0, bandIdx: -1 };
    }
  } else if (accTotal === 0) {
    logStep('[DIAGNOSE] type=no_candidates');
  }

  // ── EXPERIMENT: L2 Recovery ──
  // When L1>0 && L3>0 && L2==0 → try targeted L2 recovery
  // Does NOT affect main pipeline result — only logs and adds to debug export
  if (acc.td1_l1.length > 0 && acc.td1_l3.length > 0 && acc.td1_l2.length === 0) {
    ctx.summary.l2RecoveryAttempted = true;
    ctx.summary.l2RecoverySuccess = false;
    logStep('[EXP] name=L2Recovery status=triggered l1=' + acc.td1_l1.length + ' l2=0 l3=' + acc.td1_l3.length);

    var l2RecoveryResults = [];
    var wr = ocrWorker || worker;

    // Strategy: try band crops focused on MRZ middle area with different preprocessing and PSM
    var l2Bands = [
      { cy: 0.87, hr: 0.15, label: 'narrow-alt-15' },
      { cy: 0.82, hr: 0.20, label: 'narrow-alt-20' },
      { cy: 0.78, hr: 0.15, label: 'narrow-midlow-15' },
    ];
    var l2Preprocesses = ['enhanced', 'bin', 'hi'];
    var l2PSMs = ['6', '7'];

    for (var li = 0; li < l2Bands.length && !processingCancelled; li++) {
      var lb = l2Bands[li];
      var l2Crop = uploadCropBand(rotated, lb.cy, lb.hr);

      for (var pi = 0; pi < l2Preprocesses.length && !processingCancelled; pi++) {
        var ppType = l2Preprocesses[pi];
        var ppCanvas;
        if (ppType === 'bin') ppCanvas = uploadPreprocess(l2Crop, 'bin');
        else if (ppType === 'hi') ppCanvas = uploadPreprocess(l2Crop, 'hi');
        else ppCanvas = uploadPreprocess(l2Crop);

        for (var si = 0; si < l2PSMs.length && !processingCancelled; si++) {
          var psm = l2PSMs[si];
          try {
            // Temporarily change PSM
            await wr.setParameters({ tessedit_pageseg_mode: psm });
            var ocrResult = await wr.recognize(ppCanvas);
            // Restore PSM 6
            await wr.setParameters({ tessedit_pageseg_mode: '6' });

            var rawText = ocrResult.data.text;
            var conf = typeof ocrResult.data.confidence === 'number' ? Math.round(ocrResult.data.confidence) : null;
            var cleanedText = clean(rawText);
            var foundL2 = false;

            // Check if any line matches L2 pattern
            var l2lines = cleanedText.split(/\n+/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 15; });
            for (var lx = 0; lx < l2lines.length; lx++) {
              var candidateL2 = fixLine(l2lines[lx], {targetLen: 30, kind: 'TD1_L2'});
              if (candidateL2 && isL2_TD1(candidateL2)) {
                foundL2 = true;
                // Try assembly with recovered L2
                var recoveryAcc = {
                  td1_l1: acc.td1_l1.slice(), td1_l2: [candidateL2], td1_l3: acc.td1_l3.slice(),
                  td3_l1: [], td3_l2: []
                };
                var recoveryResult = tryAssemblyFromAcc(recoveryAcc);
                var entry = {
                  band: lb.label, preprocess: ppType, psm: psm,
                  ocrText: rawText.replace(/\n+/g, ' ').substring(0, 200),
                  confidence: conf, l2Found: true, l2Candidate: candidateL2,
                  assemblySuccess: !!recoveryResult
                };
                l2RecoveryResults.push(entry);
                logStep('[EXP] name=L2Recovery band=' + lb.label + ' preprocess=' + ppType + ' psm=' + psm + ' l2_found=true candidate="' + candidateL2 + '" assembly=' + (recoveryResult ? 'ok' : 'fail'));
                if (recoveryResult) {
                  ctx.summary.l2RecoverySuccess = true;
                  logStep('[EXP] name=L2Recovery status=assembly_success');
                }
                break;
              }
            }

            if (!foundL2) {
              var bestLine = l2lines.reduce(function(a, b) { return a.length > b.length ? a : b; }, '');
              l2RecoveryResults.push({
                band: lb.label, preprocess: ppType, psm: psm,
                ocrText: bestLine.substring(0, 100),
                confidence: conf, l2Found: false, l2Candidate: null,
                assemblySuccess: false
              });
              logStep('[EXP] name=L2Recovery band=' + lb.label + ' preprocess=' + ppType + ' psm=' + psm + ' l2_found=false len=' + bestLine.length);
            }
          } catch(e) {
            // Restore PSM 6 on error
            try { await wr.setParameters({ tessedit_pageseg_mode: '6' }); } catch(e2) {}
            l2RecoveryResults.push({
              band: lb.label, preprocess: ppType, psm: psm,
              ocrText: '', confidence: null, l2Found: false,
              l2Candidate: null, assemblySuccess: false, error: e.message
            });
          }
        }
      }
    }

    // Store in debug export
    if (window._debugAttempts) {
      window._debugAttempts.push({
        rotation: deg, method: 'L2-recovery-experiment', region: 'experiment',
        preprocess: 'mixed', ocrText: '', ocrLen: 0, mrzFound: false,
        checksumOk: false, success: false, confidence: null,
        l2Recovery: l2RecoveryResults
      });
    }

    var l2FoundCount = l2RecoveryResults.filter(function(r) { return r.l2Found; }).length;
    logStep('[EXP] name=L2Recovery status=completed attempts=' + l2RecoveryResults.length + ' l2_found=' + l2FoundCount + ' assembly_success=' + ctx.summary.l2RecoverySuccess);
  }

  return null;
}

// Compute failureReason from context
function computeFailureReason(ctx) {
  var a = ctx._lastAssembly;
  if (!a) return 'ocr_empty';
  if (a.l1 === 0 && a.l3 === 0 && a.td3_l1 === 0) return 'no_mrz_pattern';
  if (a.l2 === 0 && a.td3_l2 === 0) return 'l2_missing';
  if (a.l1 === 0 && a.td3_l1 === 0) return 'l1_missing';
  return 'checksum_fail';
}

// Enrich summary with assembly, experiment, failureReason + RunSummary fields
function enrichSummary(ctx, isSuccess, result) {
  if (ctx._lastAssembly) {
    ctx.summary.assembly = ctx._lastAssembly;
  }
  ctx.summary.experiment = { psm: 6, lang: 'mrz', preprocessWinner: isSuccess && ctx.summary.winner ? ctx.summary.winner.method : null };
  ctx.summary.attemptCount = ctx.summary.totalOCR;
  if (!isSuccess) {
    ctx.summary.failureReason = computeFailureReason(ctx);
    logStep('[DIAGNOSE] failureReason=' + ctx.summary.failureReason);
  } else {
    ctx.summary.failureReason = null;
  }
  // Unified RunSummary enrichment
  if (typeof setDocType === 'function') setDocType(ctx.summary, result || null);
  if (typeof enrichRunSummary === 'function') enrichRunSummary(ctx.summary);
}

// Handle successful OCR result
function handleOCRSuccess(hit, deg, ctx) {
  if (metrics) {
    metrics.upload.attempts = ctx.ocrCount;
    metrics.upload.successful++;
    metrics.upload.successRotation = deg;
    metrics.upload.successBandIndex = hit.bandIdx;
  }
  ctx.summary.success = true;
  ctx.summary.winner = { rotation: deg, region: hit.region, method: hit.method };
  ctx.summary.durationMs = Date.now() - ctx.startTime;
  enrichSummary(ctx, true, hit.result);
  window._lastSummary = ctx.summary;
  window._lastDebugExport = { summary: ctx.summary, attempts: (window._debugAttempts || []).slice() };
  logStep('[SUCCESS] attempts=' + ctx.summary.totalOCR + ' duration=' + ctx.summary.durationMs + 'ms');
  logStep('[SUMMARY] runId=' + ctx.summary.runId + ' success=true mode=' + ctx.summary.mode);
  console.log('[MRZ_SUMMARY]', JSON.stringify(ctx.summary));
  document.getElementById('proc-prog').style.width = '100%';
  document.getElementById('proc-cancel-btn').style.display = 'none';
  saveAndShow(hit.result);
}

async function processImage(img) {
  if (!workerReady) return;
  processingCancelled = false;
  goScreen('s-processing');
  document.getElementById('proc-cancel-btn').style.display = 'flex';
  var procProg = document.getElementById('proc-prog');
  var procMsg  = document.getElementById('proc-msg');

  procProg.style.width = '5%';
  if (metrics) { metrics.upload.attempts = 0; metrics.upload.successful = 0; }

  var ctx = {
    ocrCount: 0,
    startTime: Date.now(),
    summary: {
      mode: 'single-upload', success: false, totalOCR: 0, selectedRotations: [],
      regionsFound: 0, regionsTried: 0, fallbackUsed: false, winner: null, durationMs: 0,
      failureReason: null, assembly: null, experiment: null, attemptCount: 0,
      l2RecoveryAttempted: false, l2RecoverySuccess: false
    }
  };

  window._debugAttempts = [];
  clearLiveLog();
  logStep('[START] mode=single-upload size=' + img.naturalWidth + 'x' + img.naturalHeight);

  // ── 1. Try 0° first (most photos are upright) ──────────────────────
  procMsg.textContent = '0° deneniyor…';
  var rotated0 = uploadMakeCanvas(img, 0);
  procProg.style.width = '10%';

  var hit = await tryRotation(rotated0, 0, ctx);
  if (hit) {
    ctx.summary.selectedRotations = [0];
    handleOCRSuccess(hit, 0, ctx);
    return;
  }
  if (processingCancelled) return;

  // ── 2. Rank remaining rotations, skip 0° ───────────────────────────
  procMsg.textContent = 'Diğer yönler analiz ediliyor…';
  var rankedRotations = rankRotations(img);
  // Filter out 0° (already fully tried)
  rankedRotations = rankedRotations.filter(function(r) { return r.deg !== 0; });
  ctx.summary.selectedRotations = [0].concat(rankedRotations.map(function(r) { return r.deg; }));
  procProg.style.width = '40%';

  // ── 3. Try each remaining rotation ─────────────────────────────────
  for (var ri = 0; ri < rankedRotations.length; ri++) {
    if (processingCancelled) return;
    var deg = rankedRotations[ri].deg;
    procMsg.textContent = deg + '° deneniyor…';
    procProg.style.width = (40 + ri * 25) + '%';

    var rotated = uploadMakeCanvas(img, deg);
    hit = await tryRotation(rotated, deg, ctx);
    if (hit) {
      handleOCRSuccess(hit, deg, ctx);
      return;
    }
  }

  // ── FAIL ───────────────────────────────────────────────────────────
  if (metrics) metrics.upload.attempts = ctx.ocrCount;
  ctx.summary.durationMs = Date.now() - ctx.startTime;
  enrichSummary(ctx, false, null);
  logStep('[FAIL] attempts=' + ctx.summary.totalOCR + ' duration=' + ctx.summary.durationMs + 'ms reason=' + (ctx.summary.failureReason || 'unknown'));
  logStep('[SUMMARY] runId=' + ctx.summary.runId + ' success=false mode=' + ctx.summary.mode);
  window._lastSummary = ctx.summary;
  window._lastDebugExport = { summary: ctx.summary, attempts: (window._debugAttempts || []).slice() };
  console.log('[MRZ_SUMMARY]', JSON.stringify(ctx.summary));
  document.getElementById('proc-cancel-btn').style.display = 'none';
  showError('MRZ tespit edilemedi. Kimliğin arka yüzünü yükleyin.');
}

// ═══════════════════════════════════════════════════════════════════════
// BATCH PROCESS — Aynı karar ağacı, UI olmadan, batch worker ile
// Returns { result, summary, log } or { result: null, summary, log }
// ═══════════════════════════════════════════════════════════════════════
async function batchProcessImage(img, ocrWorker) {
  var ctx = {
    ocrCount: 0,
    startTime: Date.now(),
    summary: {
      mode: 'batch', success: false, totalOCR: 0, selectedRotations: [],
      regionsFound: 0, regionsTried: 0, fallbackUsed: false, winner: null, durationMs: 0,
      failureReason: null, assembly: null, experiment: null, attemptCount: 0,
      l2RecoveryAttempted: false, l2RecoverySuccess: false
    }
  };

  window._debugAttempts = [];
  var batchLog = [];
  var origLogStep = window._batchLogFn;
  // Batch sırasında logStep çıktısını yakala
  window._batchLogFn = function(msg) { batchLog.push(msg); };

  try {
    logStep('[START] mode=batch size=' + (img.naturalWidth || img.width) + 'x' + (img.naturalHeight || img.height));

    // 1. Try 0° first
    var rotated0 = uploadMakeCanvas(img, 0);
    var hit = await tryRotation(rotated0, 0, ctx, ocrWorker);
    if (hit) {
      ctx.summary.selectedRotations = [0];
      ctx.summary.success = true;
      ctx.summary.winner = { rotation: 0, region: hit.region, method: hit.method };
      ctx.summary.durationMs = Date.now() - ctx.startTime;
      enrichSummary(ctx, true, hit.result);
      window._lastSummary = ctx.summary;
      window._lastDebugExport = { summary: ctx.summary, attempts: (window._debugAttempts || []).slice() };
      logStep('[SUCCESS] attempts=' + ctx.summary.totalOCR + ' duration=' + ctx.summary.durationMs + 'ms');
      return { result: hit.result, method: hit.method, summary: ctx.summary, log: batchLog };
    }

    // 2. Rank remaining rotations, skip 0°
    var rankedRotations = rankRotations(img);
    rankedRotations = rankedRotations.filter(function(r) { return r.deg !== 0; });
    ctx.summary.selectedRotations = [0].concat(rankedRotations.map(function(r) { return r.deg; }));

    // 3. Try each remaining rotation
    for (var ri = 0; ri < rankedRotations.length; ri++) {
      var deg = rankedRotations[ri].deg;
      var rotated = uploadMakeCanvas(img, deg);
      hit = await tryRotation(rotated, deg, ctx, ocrWorker);
      if (hit) {
        ctx.summary.success = true;
        ctx.summary.winner = { rotation: deg, region: hit.region, method: hit.method };
        ctx.summary.durationMs = Date.now() - ctx.startTime;
        enrichSummary(ctx, true, hit.result);
        window._lastSummary = ctx.summary;
        window._lastDebugExport = { summary: ctx.summary, attempts: (window._debugAttempts || []).slice() };
        logStep('[SUCCESS] attempts=' + ctx.summary.totalOCR + ' duration=' + ctx.summary.durationMs + 'ms');
        return { result: hit.result, method: hit.method, summary: ctx.summary, log: batchLog };
      }
    }

    // FAIL
    ctx.summary.durationMs = Date.now() - ctx.startTime;
    enrichSummary(ctx, false, null);
    window._lastSummary = ctx.summary;
    window._lastDebugExport = { summary: ctx.summary, attempts: (window._debugAttempts || []).slice() };
    logStep('[FAIL] attempts=' + ctx.summary.totalOCR + ' duration=' + ctx.summary.durationMs + 'ms reason=' + (ctx.summary.failureReason || 'unknown'));
    return { result: null, method: null, summary: ctx.summary, log: batchLog };

  } finally {
    window._batchLogFn = origLogStep;
  }
}
