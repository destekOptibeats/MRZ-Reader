// ═══════════════════════════════════════════════════════════════════════
// IMAGE UPLOAD PATH — Unguided Capture
// No screen geometry. Uses rotation + vertical band search.
// No assumption about document alignment.
// These functions must NOT be used by camera path.
// ═══════════════════════════════════════════════════════════════════════

// Resmi max genişliğe ölçekle + döndür (upload-only)
function uploadMakeCanvas(img, deg) {
  const swap = deg === 90 || deg === 270;
  const sw = swap ? img.naturalHeight : img.naturalWidth;
  const sh = swap ? img.naturalWidth  : img.naturalHeight;
  const MAX = 1600, scale = sw > MAX ? MAX / sw : 1;
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

// Upload main: rotation × vertical band search (unguided)
async function processImage(img) {
  if (!workerReady) return;
  processingCancelled = false;
  goScreen('s-processing');
  document.getElementById('proc-cancel-btn').style.display = 'flex';
  const procProg = document.getElementById('proc-prog');
  const procMsg  = document.getElementById('proc-msg');

  procProg.style.width = '10%';
  if (metrics) { metrics.upload.attempts = 0; metrics.upload.successful = 0; }

  // Vertical band search positions: center Y ratio, height ratio, label
  const bandConfigs = [
    { cy: 0.80, hr: 0.40, label: 'alt %40' },
    { cy: 0.65, hr: 0.50, label: 'orta-alt %50' },
    { cy: 0.50, hr: 1.00, label: 'tam resim' },
  ];

  let uploadOcrCount = 0;

  for (const deg of [0, 90, 270]) {
    if (processingCancelled) return;
    const pct = deg === 0 ? 15 : deg === 90 ? 40 : 65;
    procProg.style.width = pct + '%';

    const full = uploadMakeCanvas(img, deg);

    for (let bi = 0; bi < bandConfigs.length; bi++) {
      if (processingCancelled) return;
      const bc = bandConfigs[bi];
      procMsg.textContent = `${deg}° ${bc.label} taranıyor…`;

      const cropped = bc.hr >= 1.0 ? full : uploadCropBand(full, bc.cy, bc.hr);

      // Preprocessed attempt
      const enhanced = uploadPreprocess(cropped);
      uploadOcrCount++;
      let result = await uploadTryRecognize(enhanced);
      if (result) {
        if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = bi; }
        console.log('[Upload] SUCCESS rot=' + deg + '° band=' + bc.label + ' ocrAttempts=' + uploadOcrCount);
        procProg.style.width='100%'; document.getElementById('proc-cancel-btn').style.display='none'; saveAndShow(result); return;
      }

      // Raw attempt (no preprocessing)
      if (processingCancelled) return;
      uploadOcrCount++;
      result = await uploadTryRecognize(cropped);
      if (result) {
        if (metrics) { metrics.upload.attempts = uploadOcrCount; metrics.upload.successful++; metrics.upload.successRotation = deg; metrics.upload.successBandIndex = bi; }
        console.log('[Upload] SUCCESS (raw) rot=' + deg + '° band=' + bc.label + ' ocrAttempts=' + uploadOcrCount);
        procProg.style.width='100%'; document.getElementById('proc-cancel-btn').style.display='none'; saveAndShow(result); return;
      }
    }
  }

  if (metrics) metrics.upload.attempts = uploadOcrCount;
  console.log('[Upload] FAILED after ' + uploadOcrCount + ' OCR attempts');
  document.getElementById('proc-cancel-btn').style.display = 'none';
  showError('MRZ tespit edilemedi. Kimliğin arka yüzünü yükleyin.');
}
