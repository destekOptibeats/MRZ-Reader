// ═══════════════════════════════════════════════════════════════════════
// IMAGE UPLOAD PATH — Unguided Capture
// Phase 1: Detect document orientation (quick OCR at 4 rotations)
// Phase 2: Locate MRZ region (horizontal projection profile)
// Phase 3: Focused OCR on detected MRZ band
// Fallback: brute-force band search if detection fails
// These functions must NOT be used by camera path.
// ═══════════════════════════════════════════════════════════════════════

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

// Upload-only: Quick OCR — return raw text + MRZ score (no parse required)
async function uploadQuickOCR(canvas) {
  try {
    const { data: { text } } = await worker.recognize(canvas);
    return { text, score: scoreMRZText(text), longest: longestOCRLine(text) };
  } catch(e) { return { text: '', score: 0, longest: 0 }; }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: ORIENTATION DETECTION
// Quick low-res OCR at 4 rotations on bottom 50% → pick best MRZ score
// ═══════════════════════════════════════════════════════════════════════
async function detectOrientation(img, onProgress) {
  const rotations = [0, 90, 180, 270];
  let bestDeg = 0, bestScore = -1, bestLongest = 0;

  for (const deg of rotations) {
    if (processingCancelled) return { deg: 0, score: 0 };
    if (onProgress) onProgress(deg);

    // Small canvas for quick OCR (max 800px wide)
    const small = uploadMakeCanvas(img, deg, 800);
    // Crop bottom 50% — MRZ is typically at the bottom
    const cropped = uploadCropBand(small, 0.75, 0.50);
    const enhanced = uploadPreprocess(cropped);

    const r = await uploadQuickOCR(enhanced);
    console.log('[Orientation] ' + deg + '° → score:' + r.score + ' longest:' + r.longest);

    if (r.score > bestScore) {
      bestScore = r.score;
      bestDeg = deg;
      bestLongest = r.longest;
    }

    // Early exit: strong MRZ signal found
    if (r.longest >= 28 && r.score > 60) {
      console.log('[Orientation] early exit at ' + deg + '° (strong signal)');
      break;
    }
  }

  console.log('[Orientation] selected: ' + bestDeg + '° score:' + bestScore + ' longest:' + bestLongest);
  return { deg: bestDeg, score: bestScore, longest: bestLongest };
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2: MRZ REGION LOCALIZATION
// Horizontal projection profile — find dense text bands in bottom half
// MRZ lines: 2-3 consecutive rows of high dark-pixel density
// ═══════════════════════════════════════════════════════════════════════
function locateMRZRegion(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w < 100 || h < 100) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Step 1: Build horizontal projection (dark pixel ratio per row)
  // Only scan bottom 70% of image (MRZ won't be in top 30%)
  const startY = Math.round(h * 0.30);
  const projection = new Float32Array(h);
  for (let y = startY; y < h; y++) {
    let darkCount = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      if (gray < 140) darkCount++;
    }
    projection[y] = darkCount / w;
  }

  // Step 2: Smooth projection (reduce noise)
  const smoothed = new Float32Array(h);
  const kernel = Math.max(2, Math.round(h * 0.003));
  for (let y = startY + kernel; y < h - kernel; y++) {
    let sum = 0;
    for (let k = -kernel; k <= kernel; k++) sum += projection[y + k];
    smoothed[y] = sum / (2 * kernel + 1);
  }

  // Step 3: Find text line peaks (dark ratio above threshold)
  // Adaptive threshold: median + offset
  const vals = [];
  for (let y = startY; y < h; y++) {
    if (smoothed[y] > 0) vals.push(smoothed[y]);
  }
  vals.sort((a, b) => a - b);
  const median = vals.length > 0 ? vals[Math.floor(vals.length * 0.5)] : 0;
  const peakThreshold = Math.max(median * 2.0, 0.03);

  const peaks = []; // {start, end, center, width, density}
  let inPeak = false, peakStart = 0;
  for (let y = startY; y < h; y++) {
    if (smoothed[y] > peakThreshold && !inPeak) {
      inPeak = true; peakStart = y;
    } else if ((smoothed[y] <= peakThreshold || y === h - 1) && inPeak) {
      inPeak = false;
      const peakEnd = y;
      const pw = peakEnd - peakStart;
      // Filter: MRZ text lines are typically 10-60px tall (at 1600px wide image)
      const minLineH = Math.max(5, Math.round(h * 0.01));
      const maxLineH = Math.round(h * 0.08);
      if (pw >= minLineH && pw <= maxLineH) {
        let densitySum = 0;
        for (let py = peakStart; py < peakEnd; py++) densitySum += smoothed[py];
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

  console.log('[MRZLocate] peaks found: ' + peaks.length + ' (threshold: ' + peakThreshold.toFixed(3) + ')');
  if (peaks.length < 2) return null;

  // Step 4: Find best cluster of 2-3 consecutive peaks (MRZ = 2 or 3 lines)
  // MRZ lines have similar width and are closely spaced
  let bestCluster = null, bestClusterScore = -1;

  for (let i = 0; i < peaks.length; i++) {
    // Try 2-line cluster (TD3 passport)
    if (i + 1 < peaks.length) {
      const gap = peaks[i + 1].start - peaks[i].end;
      const maxGap = Math.round(h * 0.04); // max gap between MRZ lines
      const widthRatio = Math.min(peaks[i].width, peaks[i + 1].width) /
                         Math.max(peaks[i].width, peaks[i + 1].width);
      if (gap >= 0 && gap <= maxGap && widthRatio > 0.4) {
        const score = (peaks[i].density + peaks[i + 1].density) * widthRatio * 2;
        if (score > bestClusterScore) {
          bestClusterScore = score;
          bestCluster = { start: peaks[i].start, end: peaks[i + 1].end, lines: 2 };
        }
      }
    }
    // Try 3-line cluster (TD1 ID card)
    if (i + 2 < peaks.length) {
      const gap1 = peaks[i + 1].start - peaks[i].end;
      const gap2 = peaks[i + 2].start - peaks[i + 1].end;
      const maxGap = Math.round(h * 0.04);
      const wr1 = Math.min(peaks[i].width, peaks[i + 1].width) /
                   Math.max(peaks[i].width, peaks[i + 1].width);
      const wr2 = Math.min(peaks[i + 1].width, peaks[i + 2].width) /
                   Math.max(peaks[i + 1].width, peaks[i + 2].width);
      if (gap1 >= 0 && gap1 <= maxGap && gap2 >= 0 && gap2 <= maxGap && wr1 > 0.4 && wr2 > 0.4) {
        const score = (peaks[i].density + peaks[i + 1].density + peaks[i + 2].density) * wr1 * wr2 * 3;
        if (score > bestClusterScore) {
          bestClusterScore = score;
          bestCluster = { start: peaks[i].start, end: peaks[i + 2].end, lines: 3 };
        }
      }
    }
  }

  if (!bestCluster) {
    console.log('[MRZLocate] no valid cluster found');
    return null;
  }

  // Step 5: Add padding around the detected region
  const regionH = bestCluster.end - bestCluster.start;
  const padY = Math.round(regionH * 0.5);
  const cropStart = Math.max(0, bestCluster.start - padY);
  const cropEnd = Math.min(h, bestCluster.end + padY);

  console.log('[MRZLocate] detected ' + bestCluster.lines + '-line MRZ at y:' +
    bestCluster.start + '-' + bestCluster.end + ' (padded: ' + cropStart + '-' + cropEnd + ')');

  return { y: cropStart, h: cropEnd - cropStart, lines: bestCluster.lines };
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: FOCUSED OCR + FALLBACK
// ═══════════════════════════════════════════════════════════════════════

// Upload main: detect orientation → locate MRZ → focused OCR → fallback
async function processImage(img) {
  if (!workerReady) return;
  processingCancelled = false;
  goScreen('s-processing');
  document.getElementById('proc-cancel-btn').style.display = 'flex';
  const procProg = document.getElementById('proc-prog');
  const procMsg  = document.getElementById('proc-msg');

  procProg.style.width = '5%';
  if (metrics) { metrics.upload.attempts = 0; metrics.upload.successful = 0; }

  let uploadOcrCount = 0;

  // ── PHASE 1: Orientation Detection ──────────────────────────────────
  procMsg.textContent = 'Belge yönü tespit ediliyor…';
  const orientation = await detectOrientation(img, (deg) => {
    uploadOcrCount++;
    procMsg.textContent = deg + '° kontrol ediliyor…';
    procProg.style.width = (5 + (deg / 270) * 20) + '%';
  });
  if (processingCancelled) return;

  // Count orientation OCR attempts (max 4)
  uploadOcrCount = Math.min(uploadOcrCount, 4);
  console.log('[Upload] orientation: ' + orientation.deg + '° (score: ' + orientation.score + ')');

  // Build full-res rotated canvas
  const rotated = uploadMakeCanvas(img, orientation.deg);
  procProg.style.width = '30%';

  // ── PHASE 2: MRZ Region Localization ────────────────────────────────
  procMsg.textContent = 'MRZ alanı aranıyor…';
  const mrzRegion = locateMRZRegion(rotated);
  procProg.style.width = '35%';

  // ── PHASE 3A: Focused OCR on detected region ───────────────────────
  if (mrzRegion) {
    procMsg.textContent = 'MRZ alanı bulundu — okunuyor…';
    console.log('[Upload] MRZ region detected: y=' + mrzRegion.y + ' h=' + mrzRegion.h + ' lines=' + mrzRegion.lines);

    const cropped = uploadCropRegion(rotated, mrzRegion.y, mrzRegion.h);

    // Try enhanced
    const enhanced = uploadPreprocess(cropped);
    uploadOcrCount++;
    let result = await uploadTryRecognize(enhanced);
    if (result) {
      if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = orientation.deg; metrics.upload.successBandIndex = -1; }
      console.log('[Upload] SUCCESS via MRZ detection (enhanced) ocrAttempts=' + uploadOcrCount);
      procProg.style.width = '100%';
      document.getElementById('proc-cancel-btn').style.display = 'none';
      saveAndShow(result);
      return;
    }

    // Try raw
    if (processingCancelled) return;
    uploadOcrCount++;
    result = await uploadTryRecognize(cropped);
    if (result) {
      if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = orientation.deg; metrics.upload.successBandIndex = -1; }
      console.log('[Upload] SUCCESS via MRZ detection (raw) ocrAttempts=' + uploadOcrCount);
      procProg.style.width = '100%';
      document.getElementById('proc-cancel-btn').style.display = 'none';
      saveAndShow(result);
      return;
    }

    // Try wider region (double height)
    if (processingCancelled) return;
    procMsg.textContent = 'Geniş alan deneniyor…';
    const widerY = Math.max(0, mrzRegion.y - mrzRegion.h);
    const widerH = Math.min(mrzRegion.h * 3, rotated.height - widerY);
    const wider = uploadCropRegion(rotated, widerY, widerH);
    const widerEnhanced = uploadPreprocess(wider);
    uploadOcrCount++;
    result = await uploadTryRecognize(widerEnhanced);
    if (result) {
      if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = orientation.deg; metrics.upload.successBandIndex = -2; }
      console.log('[Upload] SUCCESS via wider MRZ region ocrAttempts=' + uploadOcrCount);
      procProg.style.width = '100%';
      document.getElementById('proc-cancel-btn').style.display = 'none';
      saveAndShow(result);
      return;
    }
  } else {
    console.log('[Upload] MRZ region NOT detected — falling back to band search');
  }

  procProg.style.width = '45%';

  // ── PHASE 3B: Fallback — band search on best rotation ──────────────
  procMsg.textContent = 'Band taraması yapılıyor…';
  const bandConfigs = [
    { cy: 0.80, hr: 0.40, label: 'alt %40' },
    { cy: 0.65, hr: 0.50, label: 'orta-alt %50' },
    { cy: 0.50, hr: 1.00, label: 'tam resim' },
  ];

  // First: try bands on the detected best rotation
  for (let bi = 0; bi < bandConfigs.length; bi++) {
    if (processingCancelled) return;
    const bc = bandConfigs[bi];
    procMsg.textContent = orientation.deg + '° ' + bc.label + ' taranıyor…';
    procProg.style.width = (45 + bi * 8) + '%';

    const cropped = bc.hr >= 1.0 ? rotated : uploadCropBand(rotated, bc.cy, bc.hr);

    const enhanced = uploadPreprocess(cropped);
    uploadOcrCount++;
    let result = await uploadTryRecognize(enhanced);
    if (result) {
      if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = orientation.deg; metrics.upload.successBandIndex = bi; }
      console.log('[Upload] SUCCESS (fallback band) rot=' + orientation.deg + '° band=' + bc.label + ' ocrAttempts=' + uploadOcrCount);
      procProg.style.width = '100%';
      document.getElementById('proc-cancel-btn').style.display = 'none';
      saveAndShow(result);
      return;
    }

    if (processingCancelled) return;
    uploadOcrCount++;
    result = await uploadTryRecognize(cropped);
    if (result) {
      if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = orientation.deg; metrics.upload.successBandIndex = bi; }
      console.log('[Upload] SUCCESS (fallback raw) rot=' + orientation.deg + '° band=' + bc.label + ' ocrAttempts=' + uploadOcrCount);
      procProg.style.width = '100%';
      document.getElementById('proc-cancel-btn').style.display = 'none';
      saveAndShow(result);
      return;
    }
  }

  // ── PHASE 3C: Last resort — try other rotations ────────────────────
  const otherRotations = [0, 90, 180, 270].filter(d => d !== orientation.deg);
  for (const deg of otherRotations) {
    if (processingCancelled) return;
    procMsg.textContent = deg + '° tam resim deneniyor…';
    procProg.style.width = (70 + otherRotations.indexOf(deg) * 10) + '%';

    const alt = uploadMakeCanvas(img, deg);
    const altBottom = uploadCropBand(alt, 0.75, 0.50);
    const altEnhanced = uploadPreprocess(altBottom);
    uploadOcrCount++;
    const result = await uploadTryRecognize(altEnhanced);
    if (result) {
      if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = -3; }
      console.log('[Upload] SUCCESS (alt rotation) rot=' + deg + '° ocrAttempts=' + uploadOcrCount);
      procProg.style.width = '100%';
      document.getElementById('proc-cancel-btn').style.display = 'none';
      saveAndShow(result);
      return;
    }
  }

  // ── FAIL ───────────────────────────────────────────────────────────
  if (metrics) metrics.upload.attempts = uploadOcrCount;
  console.log('[Upload] FAILED after ' + uploadOcrCount + ' OCR attempts');
  document.getElementById('proc-cancel-btn').style.display = 'none';
  showError('MRZ tespit edilemedi. Kimliğin arka yüzünü yükleyin.');
}
