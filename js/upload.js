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
  const swap = deg === 90 || deg === 270;
  const sw = swap ? img.naturalHeight : img.naturalWidth;
  const sh = swap ? img.naturalWidth  : img.naturalHeight;
  const scale = sw > maxW ? maxW / sw : 1;
  const rw = Math.round(sw * scale), rh = Math.round(sh * scale);
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  const ctx = c.getContext('2d');
  ctx.save(); ctx.translate(rw/2, rh/2);
  ctx.rotate(deg * Math.PI / 180); ctx.scale(scale, scale);
  ctx.drawImage(img, -img.naturalWidth/2, -img.naturalHeight/2);
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
function uploadPreprocess(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  ctx.filter = 'grayscale(1) contrast(1.6)';
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

// Upload-only: OCR → parse → checksum denemesi
async function uploadTryRecognize(canvas) {
  try {
    const { data: { text } } = await worker.recognize(canvas);
    const result = extractMRZ(clean(text));
    if (result && validateMRZ(result).valid) return result;
  } catch(e) { /* devam */ }
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
    console.log('[rankRotations] ' + deg + '° → score: ' + score.toFixed(4));
  }

  scored.sort(function(a, b) { return b.score - a.score; });
  var top = scored.slice(0, C.ROTATION_KEEP_TOP);
  console.log('[rankRotations] top ' + C.ROTATION_KEEP_TOP + ': ' +
    top.map(function(r) { return r.deg + '°(' + r.score.toFixed(3) + ')'; }).join(', '));
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
  var peakThreshold = Math.max(median * 2.0, 0.03);

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

  console.log('[MRZLocate] peaks: ' + peaks.length + ' threshold: ' + peakThreshold.toFixed(3) + ' darkThresh: ' + darkThresh);
  if (peaks.length < 2) return [];

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
    console.log('[MRZLocate] no valid clusters');
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
    console.log('[MRZLocate] region #' + (ci+1) + ': y=' + cropStart + '-' + cropEnd +
      ' lines=' + cl.lines + ' score=' + cl.score.toFixed(4));
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

async function processImage(img) {
  if (!workerReady) return;
  processingCancelled = false;
  goScreen('s-processing');
  document.getElementById('proc-cancel-btn').style.display = 'flex';
  var procProg = document.getElementById('proc-prog');
  var procMsg  = document.getElementById('proc-msg');

  procProg.style.width = '5%';
  if (metrics) { metrics.upload.attempts = 0; metrics.upload.successful = 0; }

  var C = UPLOAD_CFG;
  var uploadOcrCount = 0;

  // ── PHASE 1: OCR-free Rotation Ranking ──────────────────────────────
  procMsg.textContent = 'Belge yönü analiz ediliyor…';
  var rankedRotations = rankRotations(img);
  if (processingCancelled) return;
  procProg.style.width = '15%';

  // ── PHASE 2 + 3: For each top rotation, locate regions and OCR ──────
  for (var ri = 0; ri < rankedRotations.length; ri++) {
    if (processingCancelled) return;
    var rot = rankedRotations[ri];
    var deg = rot.deg;
    var rotScore = rot.score;

    procMsg.textContent = deg + '° MRZ alanı aranıyor…';
    var rotated = uploadMakeCanvas(img, deg);
    procProg.style.width = (15 + ri * 35) + '%';

    // Phase 2: Locate MRZ regions
    var regions = locateMRZRegions(rotated);

    if (regions.length > 0) {
      // Determine how many regions to try
      var tryCount = 1;
      if (regions.length >= 2) {
        var ratio = regions[1].score / regions[0].score;
        if (ratio >= C.REGION2_MIN_RATIO) tryCount = 2;
      }

      for (var rgi = 0; rgi < tryCount; rgi++) {
        if (processingCancelled) return;
        var region = regions[rgi];
        procMsg.textContent = deg + '° bölge #' + (rgi+1) + ' okunuyor…';

        // finalCandidateScore for logging
        var finalScore = C.ROT_SCORE_W * rotScore + C.REG_SCORE_W * region.score;
        console.log('[Upload] trying rot=' + deg + '° region#' + (rgi+1) +
          ' regScore=' + region.score.toFixed(3) + ' finalScore=' + finalScore.toFixed(3));

        // Try enhanced crop
        var cropped = uploadCropRegion(rotated, region.y, region.h);
        var enhanced = uploadPreprocess(cropped);
        uploadOcrCount++;
        var result = await uploadTryRecognize(enhanced);
        if (result) {
          if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = -1; }
          console.log('[Upload] SUCCESS rot=' + deg + '° region#' + (rgi+1) + ' (enhanced) ocrAttempts=' + uploadOcrCount);
          procProg.style.width = '100%';
          document.getElementById('proc-cancel-btn').style.display = 'none';
          saveAndShow(result);
          return;
        }

        // Try raw crop
        if (processingCancelled) return;
        uploadOcrCount++;
        result = await uploadTryRecognize(cropped);
        if (result) {
          if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = -1; }
          console.log('[Upload] SUCCESS rot=' + deg + '° region#' + (rgi+1) + ' (raw) ocrAttempts=' + uploadOcrCount);
          procProg.style.width = '100%';
          document.getElementById('proc-cancel-btn').style.display = 'none';
          saveAndShow(result);
          return;
        }

        // Try wider crop (WIDER_CROP_MULT × region height)
        if (processingCancelled) return;
        procMsg.textContent = deg + '° geniş alan deneniyor…';
        var rawH = region.rawEnd - region.rawStart;
        var widerPad = Math.round(rawH * (C.WIDER_CROP_MULT - 1) / 2);
        var widerY = Math.max(0, region.rawStart - widerPad);
        var widerEnd = Math.min(rotated.height, region.rawEnd + widerPad);
        var widerH = widerEnd - widerY;
        var wider = uploadCropRegion(rotated, widerY, widerH);
        var widerEnhanced = uploadPreprocess(wider);
        uploadOcrCount++;
        result = await uploadTryRecognize(widerEnhanced);
        if (result) {
          if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = -2; }
          console.log('[Upload] SUCCESS rot=' + deg + '° region#' + (rgi+1) + ' (wider) ocrAttempts=' + uploadOcrCount);
          procProg.style.width = '100%';
          document.getElementById('proc-cancel-btn').style.display = 'none';
          saveAndShow(result);
          return;
        }
      }
    } else {
      console.log('[Upload] no regions found at ' + deg + '°');
    }

    // Fallback: band search on this rotation
    if (processingCancelled) return;
    procMsg.textContent = deg + '° band taraması…';
    var bandConfigs = [
      { cy: 0.80, hr: 0.40, label: 'alt %40' },
      { cy: 0.65, hr: 0.50, label: 'orta-alt %50' },
      { cy: 0.50, hr: 1.00, label: 'tam resim' },
    ];

    for (var bi = 0; bi < bandConfigs.length; bi++) {
      if (processingCancelled) return;
      var bc = bandConfigs[bi];
      procMsg.textContent = deg + '° ' + bc.label + ' taranıyor…';
      procProg.style.width = (25 + ri * 35 + bi * 8) + '%';

      var bandCrop = bc.hr >= 1.0 ? rotated : uploadCropBand(rotated, bc.cy, bc.hr);
      var bandEnhanced = uploadPreprocess(bandCrop);
      uploadOcrCount++;
      var result = await uploadTryRecognize(bandEnhanced);
      if (result) {
        if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = bi; }
        console.log('[Upload] SUCCESS (fallback band) rot=' + deg + '° band=' + bc.label + ' ocrAttempts=' + uploadOcrCount);
        procProg.style.width = '100%';
        document.getElementById('proc-cancel-btn').style.display = 'none';
        saveAndShow(result);
        return;
      }

      if (processingCancelled) return;
      uploadOcrCount++;
      result = await uploadTryRecognize(bandCrop);
      if (result) {
        if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = bi; }
        console.log('[Upload] SUCCESS (fallback raw) rot=' + deg + '° band=' + bc.label + ' ocrAttempts=' + uploadOcrCount);
        procProg.style.width = '100%';
        document.getElementById('proc-cancel-btn').style.display = 'none';
        saveAndShow(result);
        return;
      }
    }
  }

  // ── FAIL ───────────────────────────────────────────────────────────
  if (metrics) metrics.upload.attempts = uploadOcrCount;
  console.log('[Upload] FAILED after ' + uploadOcrCount + ' OCR attempts');
  document.getElementById('proc-cancel-btn').style.display = 'none';
  showError('MRZ tespit edilemedi. Kimliğin arka yüzünü yükleyin.');
}
