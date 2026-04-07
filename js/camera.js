// ═══════════════════════════════════════════════════════════════════════
// CAMERA PATH — Guided Capture
// Crop geometry derives from screen-based getMRZBand / getMRZBandCandidates.
// User aligns document to on-screen frame.
// These functions must NOT be used by image upload or batch paths.
// ═══════════════════════════════════════════════════════════════════════

let scanDebugCount = 0;
let blurSkipCount = 0;
let lastBlurLogTime = 0;

async function startCamera() {
  if (stream) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: {ideal:'environment'},
        width:  {min:320, ideal:1280},
        height: {min:240, ideal:720}
      }
    });
    video.srcObject = stream;
    await new Promise(r => video.onloadedmetadata = r);
    video.play();

    // Robust readiness: wait for readyState >= 3 + valid dimensions
    await new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        if (video.readyState >= 3 && video.videoWidth > 0 && video.videoHeight > 0) {
          resolve();
        } else if (attempts > 30) {
          // Fallback after 3s: accept readyState >= 2
          if (video.readyState >= 2 && video.videoWidth > 0) resolve();
          else resolve(); // give up waiting, let scanLoop handle it
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
    await new Promise(r => setTimeout(r, 200));

    console.log('[Camera] ready — videoWidth:', video.videoWidth, 'videoHeight:', video.videoHeight,
      'readyState:', video.readyState);

    // Safe delayed overlay sizing after layout settles
    requestAnimationFrame(() => resizeOverlay());

    scanning = true;
    scanDebugCount = 0;
    blurSkipCount = 0;
    lastBlurLogTime = 0;
    lastFrameHash = 0;
    lastL2 = null;
    l2Count = 0;
    checksumPassed = false;
    resetMetrics();
    setHint('MRZ satırlarını kutuya hizalayın');
    drawOverlayState('searching');
    loopId = setTimeout(() => scanLoop(), 800);
  } catch(e) {
    showError('Kamera hatası: ' + e.message);
  }
}

function stopCamera() {
  scanning = false;
  if (loopId) { clearTimeout(loopId); loopId = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

function getMRZBand(vw, vh) {
  const isLandscape = vw > vh;
  const isMobile = window.innerWidth <= 768;

  let w, h, x, y;
  if (isMobile && !isLandscape) {
    // Mobil dikey (portrait) — MRZ target zone, lower area
    w = Math.round(vw * 0.92);
    h = Math.round(vh * 0.20);
    y = Math.round(vh * 0.70);
  } else if (isMobile && isLandscape) {
    // Mobil yatay (landscape)
    w = Math.round(vw * 0.90);
    h = Math.round(vh * 0.35);
    y = Math.round(vh * 0.60);
  } else {
    // Desktop
    w = Math.round(vw * 0.85);
    h = Math.round(vh * 0.25);
    y = Math.round(vh * 0.72);
  }

  x = Math.round((vw - w) / 2);

  // Bounds safety
  if (y + h > vh - 8) y = vh - h - 8;
  if (x < 0) x = 0;
  if (x + w > vw) w = vw - x;

  return { x, y, w, h };
}

// 3 candidate bands — primary band = getMRZBand, then shifted up/down
function getMRZBandCandidates(vw, vh) {
  const primary = getMRZBand(vw, vh);
  const shift = Math.round(primary.h * 0.6);
  const offsets = [0, -shift, shift]; // center, upper, lower
  return offsets.map(dy => {
    let y = primary.y + dy;
    if (y < 0) y = 0;
    if (y + primary.h > vh - 8) y = vh - primary.h - 8;
    return { x: primary.x, y, w: primary.w, h: primary.h };
  });
}

// Motion detection zone — MRZ band çevresi + padding
function getScanZone(vw, vh) {
  const band = getMRZBand(vw, vh);
  const padX = Math.round(band.w * 0.05);
  const padY = Math.round(band.h * 0.4);
  let x = Math.max(band.x - padX, 0);
  let y = Math.max(band.y - padY, 0);
  let w = Math.min(band.w + padX * 2, vw - x);
  let h = Math.min(band.h + padY * 2, vh - y);
  return { x, y, w, h };
}

// ── SCAN HELPERS ────────────────────────────────────────────────────────
function getFrameHash(z) {
  const sw = 48, sh = 24;
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(video, z.x, z.y, z.w, z.h, 0, 0, sw, sh);
  const data = tctx.getImageData(0, 0, sw, sh).data;
  let hash = 0;
  for (let i = 0; i < data.length; i += 16)
    hash = ((hash << 5) - hash + data[i]) | 0;
  return hash;
}

function isSharpEnough(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const img  = ctx.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * img[i*4] + 0.587 * img[i*4+1] + 0.114 * img[i*4+2];
  }
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i   = y * width + x;
      const lap = gray[i - width] + gray[i - 1] - 4 * gray[i] + gray[i + 1] + gray[i + width];
      sum += lap; sumSq += lap * lap; count++;
    }
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return variance > 200;
}

function upscaleCanvas(srcCanvas, factor) {
  const out = document.createElement('canvas');
  out.width  = srcCanvas.width  * factor;
  out.height = srcCanvas.height * factor;
  const ctx  = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(srcCanvas, 0, 0, out.width, out.height);
  return out;
}

// ── SHADOW DETECTION ────────────────────────────────────────────────────
function measureBrightness(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  const count = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
  }
  return count > 0 ? sum / count : 128;
}

function shadowPreprocess(canvas) {
  const w = canvas.width, h = canvas.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, w, h, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Grayscale + find min/max
  const gray = new Uint8Array(w * h);
  let min = 255, max = 0;
  for (let i = 0; i < w * h; i++) {
    const g = Math.round(0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]);
    gray[i] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  // Histogram stretch (brightness normalize) + contrast boost
  const range = max - min;
  const stretch = range > 20;
  for (let i = 0; i < w * h; i++) {
    let v = gray[i];
    if (stretch) v = Math.round(((v - min) / range) * 255);
    // Light threshold: push toward black/white
    v = v > 140 ? Math.min(255, v + 40) : Math.max(0, v - 40);
    d[i*4] = d[i*4+1] = d[i*4+2] = v;
    d[i*4+3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

let _lastShadowHintTime = 0;

// ── SCAN LOOP ───────────────────────────────────────────────────────────
const SCAN_INTERVAL = 250;

async function scanLoop() {
  if (!scanning || !workerReady) return;
  // Serial cooldown — skip OCR but keep camera running
  if (serialCooldown) { setTimeout(scanLoop, 300); return; }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) {
    setHint('Kamera hazırlanıyor...', 'warn');
    setTimeout(scanLoop, 500); return;
  }

  // Frame hash uses wider zone for motion detection
  const z = getScanZone(vw, vh);
  const hash = getFrameHash(z);
  if (Math.abs(hash - lastFrameHash) < 5000 && !checksumPassed) {
    if (metrics) metrics.motionSkips++;
    setTimeout(scanLoop, SCAN_INTERVAL); return;
  }
  lastFrameHash = hash;

  // Adaptive multi-band: try 3 vertical positions, stop early on strong result
  const candidates = getMRZBandCandidates(vw, vh);
  const isDebug = scanDebugCount < 3;
  if (isDebug) scanDebugCount++;

  let bestText = '', bestResult = null, bestScore = -1, bestBandIdx = -1;

  for (let bi = 0; bi < candidates.length; bi++) {
    const band = candidates[bi];

    // Scale OCR input
    let ocrW = band.w, ocrH = band.h;
    if (ocrW < 600) { ocrW *= 2; ocrH *= 2; }
    if (ocrW > 1200) { const ds = 1200 / ocrW; ocrH = Math.round(ocrH * ds); ocrW = 1200; }

    mainC.width = ocrW;
    mainC.height = ocrH;
    mainCtx.filter = 'grayscale(1) contrast(1.4)';
    mainCtx.drawImage(video, band.x, band.y, band.w, band.h, 0, 0, ocrW, ocrH);
    mainCtx.filter = 'none';

    // Sharpness check on first band only
    if (bi === 0 && !isSharpEnough(mainC)) {
      blurSkipCount++;
      if (metrics) metrics.blurSkips++;
      const now = Date.now();
      if (now - lastBlurLogTime > 3000) {
        console.log('[Blur] son 3s: ' + blurSkipCount + ' frame atlandı (toplam: ' + (metrics ? metrics.blurSkips : '?') + ')');
        lastBlurLogTime = now;
        blurSkipCount = 0;
      }
      drawOverlayState('blurry');
      setTimeout(scanLoop, SCAN_INTERVAL); return;
    }

    let text;
    try { text = (await worker.recognize(mainC)).data.text; if (metrics) metrics.attemptedOCR++; }
    catch(e) { continue; }

    const longest = longestOCRLine(text);
    const score = scoreMRZText(text);

    if (isDebug) {
      console.log('[ScanDebug] frame', scanDebugCount,
        'band' + (bi+1), '{y:' + band.y + ' h:' + band.h + '}',
        'longest:', longest, 'score:', score);
    }

    // Priority 1: parse + checksum success → immediate accept
    const result = extractMRZ(clean(text));
    if (result) {
      const validation = validateMRZ(result);
      if (validation.valid) {
        if (isDebug) console.log('[ScanDebug] frame', scanDebugCount, 'selected: band' + (bi+1), '(parse+checksum success)');

        checksumPassed = true;
        const l2 = result.lines[1];
        if (l2 === lastL2) l2Count++; else { lastL2 = l2; l2Count = 1; }

        if (l2Count >= 2) {
          drawOverlayState('accepted');
          if (metrics) {
            metrics.acceptedOCR++;
            metrics.successfulScans++;
            metrics.lastAcceptScore = score;
            if (!metrics.firstLockMs) metrics.firstLockMs = Date.now() - metrics.sessionStartTs;
            const bname = BAND_NAMES[bi] || 'band' + bi;
            metrics.bandHits[bname] = (metrics.bandHits[bname] || 0) + 1;
          }
          const diag = diagnoseMRZ(text);
          addLog('ok', `${result.type} → KABUL`, [
            `L2: ${l2}`,
            `band: ${BAND_NAMES[bi] || bi} | score: ${score} | l2Count: ${l2Count}`,
            `OCR: ${metrics ? metrics.attemptedOCR : '?'} | blur: ${metrics ? metrics.blurSkips : '?'} | motion: ${metrics ? metrics.motionSkips : '?'}`,
            metrics && metrics.firstLockMs ? `firstLock: ${metrics.firstLockMs}ms` : ''
          ].filter(Boolean), null, validation.checksums, diag);
          var camSummary = {
            mode: 'single-camera', success: true,
            totalOCR: metrics ? metrics.attemptedOCR : 0,
            selectedRotations: [], regionsFound: 0, regionsTried: 0,
            fallbackUsed: false,
            winner: { rotation: 0, region: 0, method: 'camera-band-' + (BAND_NAMES[bi] || bi) },
            durationMs: metrics && metrics.firstLockMs ? metrics.firstLockMs : 0,
            failureReason: null, assembly: null, experiment: { psm: 6, lang: 'mrz', preprocessWinner: 'camera' },
            l2RecoveryAttempted: false, l2RecoverySuccess: false
          };
          if (typeof setDocType === 'function') setDocType(camSummary, result);
          if (typeof enrichRunSummary === 'function') enrichRunSummary(camSummary);
          window._lastSummary = camSummary;
          if (serialMode) { addSerialResult(result, { ocrText: text, bandIdx: bi, ocrAttempts: bi + 1 }); setTimeout(scanLoop, 500); return; }
          setTimeout(() => { stopCamera(); saveAndShow(result); }, 250);
          return;
        }

        drawOverlayState('confirming');
        setTimeout(scanLoop, SCAN_INTERVAL);
        return;
      }
    }

    // Track best
    if (score > bestScore) { bestScore = score; bestText = text; bestResult = result; bestBandIdx = bi; if (metrics) metrics.bestScoreUpdates++; }

    // Early exit: longest > 35 → no need to try more bands
    if (longest > 35) {
      if (isDebug) console.log('[ScanDebug] frame', scanDebugCount, 'early exit at band' + (bi+1), '(longest > 35)');
      break;
    }
  }

  if (isDebug) {
    console.log('[ScanDebug] frame', scanDebugCount,
      'selected: band' + (bestBandIdx+1), 'score:', bestScore,
      'longest:', longestOCRLine(bestText));
  }

  // Shadow fallback: if no strong result AND MRZ area is dark, retry with shadow preprocess
  const bestLongest = longestOCRLine(bestText);
  const noStrongResult = !bestResult || !validateMRZ(bestResult).valid;
  if (noStrongResult && bestLongest < 28 && bestBandIdx >= 0) {
    const brightness = measureBrightness(mainC);
    if (isDebug) console.log('[ScanDebug] brightness:', Math.round(brightness), 'shadow fallback:', brightness < 80);

    if (brightness < 80) {
      // Show shadow hint (throttled: max once per 3s)
      const now = Date.now();
      if (now - _lastShadowHintTime > 3000) {
        _lastShadowHintTime = now;
        setHint('Gölgeyi azaltın — belgeyi ışığa çevirin', 'warn');
      }

      // Retry OCR on best band with shadow preprocessing
      const band = candidates[bestBandIdx];
      let ocrW = band.w, ocrH = band.h;
      if (ocrW < 600) { ocrW *= 2; ocrH *= 2; }
      if (ocrW > 1200) { const ds = 1200 / ocrW; ocrH = Math.round(ocrH * ds); ocrW = 1200; }

      mainC.width = ocrW;
      mainC.height = ocrH;
      mainCtx.drawImage(video, band.x, band.y, band.w, band.h, 0, 0, ocrW, ocrH);
      const shadowCanvas = shadowPreprocess(mainC);

      try {
        const { data: { text: shadowText } } = await worker.recognize(shadowCanvas);
        if (metrics) metrics.attemptedOCR++;
        const shadowLongest = longestOCRLine(shadowText);
        const shadowScore = scoreMRZText(shadowText);
        if (isDebug) console.log('[ScanDebug] shadow fallback: longest:', shadowLongest, 'score:', shadowScore);

        // Use shadow result if better
        if (shadowScore > bestScore) {
          const shadowResult = extractMRZ(clean(shadowText));
          if (shadowResult) {
            const sv = validateMRZ(shadowResult);
            if (sv.valid) {
              // Shadow result is valid — accept it
              checksumPassed = true;
              const l2 = shadowResult.lines[1];
              if (l2 === lastL2) l2Count++; else { lastL2 = l2; l2Count = 1; }
              if (l2Count >= 2) {
                drawOverlayState('accepted');
                if (metrics) {
                  metrics.acceptedOCR++;
                  metrics.successfulScans++;
                  metrics.lastAcceptScore = shadowScore;
                  if (!metrics.firstLockMs) metrics.firstLockMs = Date.now() - metrics.sessionStartTs;
                  const bname = BAND_NAMES[bestBandIdx] || 'band' + bestBandIdx;
                  metrics.bandHits[bname] = (metrics.bandHits[bname] || 0) + 1;
                }
                const diag = diagnoseMRZ(shadowText);
                addLog('ok', `${shadowResult.type} → KABUL (shadow)`, [
                  `L2: ${l2}`,
                  `band: ${BAND_NAMES[bestBandIdx] || bestBandIdx} | score: ${shadowScore} | l2Count: ${l2Count}`,
                  `OCR: ${metrics ? metrics.attemptedOCR : '?'} | blur: ${metrics ? metrics.blurSkips : '?'} | motion: ${metrics ? metrics.motionSkips : '?'}`,
                  metrics && metrics.firstLockMs ? `firstLock: ${metrics.firstLockMs}ms` : ''
                ].filter(Boolean), null, sv.checksums, diag);
                window._lastSummary = {
                  mode: 'single-camera', success: true,
                  totalOCR: metrics ? metrics.attemptedOCR : 0,
                  selectedRotations: [], regionsFound: 0, regionsTried: 0,
                  fallbackUsed: false,
                  winner: { rotation: 0, region: 0, method: 'camera-shadow-' + (BAND_NAMES[bestBandIdx] || bestBandIdx) },
                  durationMs: metrics && metrics.firstLockMs ? metrics.firstLockMs : 0
                };
                if (serialMode) { addSerialResult(shadowResult, { ocrText: shadowText, bandIdx: bestBandIdx, ocrAttempts: candidates.length + 1 }); setTimeout(scanLoop, 500); return; }
                setTimeout(() => { stopCamera(); saveAndShow(shadowResult); }, 250);
                return;
              }
              drawOverlayState('confirming');
              setTimeout(scanLoop, SCAN_INTERVAL);
              return;
            }
            bestResult = shadowResult;
            bestText = shadowText;
            bestScore = shadowScore;
          }
        }
      } catch(e) { /* shadow OCR failed, continue with best */ }
    }
  }

  // Process best result (no checksum pass — rejected)
  if (metrics) metrics.rejectedOCR++;
  if (bestResult) {
    const l2 = bestResult.lines[1];
    if (l2 === lastL2) l2Count++; else { lastL2 = l2; l2Count = 1; }
    drawOverlayState('found');
  } else {
    drawOverlayState('searching');
  }

  setTimeout(scanLoop, SCAN_INTERVAL);
}

// ── HINT ────────────────────────────────────────────────────────────────
function setHint(msg, type='') {
  const el = document.getElementById('cam-hint');
  if (!el) return;
  el.textContent = msg;
  el.className = 'cam-hint' + (type ? ' hint-' + type : '');
}
