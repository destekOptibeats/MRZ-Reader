// ═══════════════════════════════════════════════════════════════════════
// VISION DEBUG — Batch/Regression test yardımcı görsel analiz modülü
// Sadece FAIL / NO_PARSE satırlarında aktif olur.
// OCR çağrısı yapmaz. LocalStorage kullanmaz. Mevcut pipeline'a dokunmaz.
// ═══════════════════════════════════════════════════════════════════════

// In-memory cache: rowIdx → { imgCanvas: HTMLCanvasElement, vd: null | VisionResult }
var batchVisionCache = new Map();

// ── HELPERS ──────────────────────────────────────────────────────────────

function visionClassifyDocType(corners) {
  var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
  var w = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
  var h = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
  var aspect = w / Math.max(h, 1);
  if (aspect > 1.50) return 'TD1';
  if (aspect > 1.38) return 'TD3';
  return 'TD2';
}

// ── DOCUMENT QUAD DETECTION (Sobel edge, self-contained) ─────────────────

function visionDetectDocumentQuad(canvas) {
  var w = canvas.width, h = canvas.height;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var d = ctx.getImageData(0, 0, w, h).data;

  var gray = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) {
    gray[i] = Math.round(0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]);
  }
  var edge = new Uint8Array(w * h);
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      var gx = -gray[(y-1)*w+(x-1)] + gray[(y-1)*w+(x+1)]
               - 2*gray[y*w+(x-1)]  + 2*gray[y*w+(x+1)]
               - gray[(y+1)*w+(x-1)] + gray[(y+1)*w+(x+1)];
      var gy = -gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)]
               + gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)];
      edge[y*w+x] = Math.min(255, Math.sqrt(gx*gx + gy*gy)) > 30 ? 255 : 0;
    }
  }

  var minX = w, minY = h, maxX = 0, maxY = 0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (edge[y*w+x]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }

  var quadW = maxX - minX, quadH = maxY - minY;
  if (quadW < w * 0.30 || quadH < h * 0.30) return null;
  var aspect = quadW / Math.max(quadH, 1);
  if (aspect < 1.1 || aspect > 2.5) return null;

  var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  var tl = { x: maxX, y: maxY }, tr = { x: minX, y: maxY };
  var bl = { x: maxX, y: minY }, br = { x: minX, y: minY };

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (!edge[y*w+x]) continue;
      if (x <= cx && y <= cy) {
        if (x + y < tl.x + tl.y) { tl.x = x; tl.y = y; }
      } else if (x > cx && y <= cy) {
        if (-x + y < -tr.x + tr.y) { tr.x = x; tr.y = y; }
      } else if (x <= cx && y > cy) {
        if (x - y < bl.x - bl.y) { bl.x = x; bl.y = y; }
      } else {
        if (-x - y < -br.x - br.y) { br.x = x; br.y = y; }
      }
    }
  }
  return { corners: [tl, tr, br, bl] };
}

// ── PERSPECTIVE WARP (homography + bilinear, self-contained) ─────────────

function visionComputeHomography(src, dst) {
  var A = [], b = [];
  for (var i = 0; i < 4; i++) {
    var sx = src[i].x, sy = src[i].y, dx = dst[i].x, dy = dst[i].y;
    A.push([sx, sy, 1, 0, 0, 0, -dx*sx, -dx*sy]);
    A.push([0, 0, 0, sx, sy, 1, -dy*sx, -dy*sy]);
    b.push(dx); b.push(dy);
  }
  var n = 8;
  for (var col = 0; col < n; col++) {
    var pivotRow = col, pivotVal = Math.abs(A[col][col]);
    for (var row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > pivotVal) { pivotVal = Math.abs(A[row][col]); pivotRow = row; }
    }
    var tmp = A[col]; A[col] = A[pivotRow]; A[pivotRow] = tmp;
    var tmpb = b[col]; b[col] = b[pivotRow]; b[pivotRow] = tmpb;
    for (var row = col + 1; row < n; row++) {
      var factor = A[row][col] / A[col][col];
      for (var c = col; c < n; c++) A[row][c] -= factor * A[col][c];
      b[row] -= factor * b[col];
    }
  }
  var hv = new Array(n);
  for (var i = n - 1; i >= 0; i--) {
    hv[i] = b[i];
    for (var j = i + 1; j < n; j++) hv[i] -= A[i][j] * hv[j];
    hv[i] /= A[i][i];
  }
  return [hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1];
}

function visionWarpMRZStrip(srcCanvas, corners, docType) {
  var stripRatio = docType === 'TD1' ? 0.36 : 0.28;
  var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
  var docW = Math.round((Math.hypot(tr.x-tl.x, tr.y-tl.y) + Math.hypot(br.x-bl.x, br.y-bl.y)) / 2);
  var docH = Math.round((Math.hypot(bl.x-tl.x, bl.y-tl.y) + Math.hypot(br.x-tr.x, br.y-tr.y)) / 2);
  var stripH = Math.round(docH * stripRatio);
  var outW = Math.max(docW, 200), outH = Math.max(stripH, 40);

  var out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  var outCtx = out.getContext('2d');

  var t = 1 - stripRatio;
  var srcStrip = [
    { x: tl.x + (bl.x - tl.x) * t, y: tl.y + (bl.y - tl.y) * t },
    { x: tr.x + (br.x - tr.x) * t, y: tr.y + (br.y - tr.y) * t },
    { x: br.x, y: br.y },
    { x: bl.x, y: bl.y },
  ];
  var dstStrip = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  var H = visionComputeHomography(dstStrip, srcStrip);

  var srcImgData = srcCanvas.getContext('2d', { willReadFrequently: true })
                             .getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  var sd = srcImgData.data, sw = srcCanvas.width, sh = srcCanvas.height;
  var outImgData = outCtx.createImageData(outW, outH);
  var od = outImgData.data;

  for (var dy = 0; dy < outH; dy++) {
    for (var dx = 0; dx < outW; dx++) {
      var w3 = H[6]*dx + H[7]*dy + H[8];
      var sx = (H[0]*dx + H[1]*dy + H[2]) / w3;
      var sy = (H[3]*dx + H[4]*dy + H[5]) / w3;
      var x0 = Math.floor(sx), y0 = Math.floor(sy);
      var x1 = x0 + 1, y1 = y0 + 1;
      var fx = sx - x0, fy = sy - y0;
      var oi = (dy * outW + dx) * 4;
      if (x0 < 0 || y0 < 0 || x1 >= sw || y1 >= sh) {
        od[oi] = od[oi+1] = od[oi+2] = 255; od[oi+3] = 255; continue;
      }
      var i00 = (y0*sw+x0)*4, i10 = (y0*sw+x1)*4;
      var i01 = (y1*sw+x0)*4, i11 = (y1*sw+x1)*4;
      for (var ch = 0; ch < 3; ch++) {
        od[oi+ch] = Math.round(
          sd[i00+ch]*(1-fx)*(1-fy) + sd[i10+ch]*fx*(1-fy) +
          sd[i01+ch]*(1-fx)*fy     + sd[i11+ch]*fx*fy
        );
      }
      od[oi+3] = 255;
    }
  }
  outCtx.putImageData(outImgData, 0, 0);
  return out;
}

// ── MRZ REGION LOCATOR (simplified row-density projection, no external deps) ──

function visionLocateMRZRegions(canvas) {
  var w = canvas.width, h = canvas.height;
  if (w < 50 || h < 50) return [];
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var data = ctx.getImageData(0, 0, w, h).data;

  // Row dark-pixel fraction
  var rowDensity = new Float32Array(h);
  for (var y = 0; y < h; y++) {
    var dark = 0;
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      if (lum < 128) dark++;
    }
    rowDensity[y] = dark / w;
  }

  // Smooth
  var smooth = new Float32Array(h);
  var k = Math.max(2, Math.round(h * 0.005));
  for (var y = k; y < h - k; y++) {
    var sum = 0;
    for (var j = -k; j <= k; j++) sum += rowDensity[y + j];
    smooth[y] = sum / (2 * k + 1);
  }

  // Adaptive threshold
  var vals = [];
  for (var y = 0; y < h; y++) { if (smooth[y] > 0) vals.push(smooth[y]); }
  vals.sort(function(a, b) { return a - b; });
  var median = vals.length ? vals[Math.floor(vals.length * 0.5)] : 0;
  var thresh = Math.max(median * 1.5, 0.03);

  // Peak detection
  var peaks = [];
  var inPeak = false, peakStart = 0;
  var minPH = Math.max(5, Math.round(h * 0.02));
  var maxPH = Math.round(h * 0.25);

  for (var y = 0; y < h; y++) {
    if (smooth[y] > thresh && !inPeak) { inPeak = true; peakStart = y; }
    else if ((smooth[y] <= thresh || y === h - 1) && inPeak) {
      inPeak = false;
      var pw = y - peakStart;
      if (pw >= minPH && pw <= maxPH) {
        var dsum = 0;
        for (var p = peakStart; p < y; p++) dsum += smooth[p];
        peaks.push({ start: peakStart, end: y, density: dsum / pw });
      }
    }
  }

  if (!peaks.length) return [];

  // Find best cluster of 1-3 consecutive peaks
  var maxGap = Math.round(h * 0.10);
  var bestCluster = null, bestScore = -1;

  for (var i = 0; i < peaks.length; i++) {
    // 3-peak (TD1)
    if (i + 2 < peaks.length &&
        peaks[i+1].start - peaks[i].end <= maxGap &&
        peaks[i+2].start - peaks[i+1].end <= maxGap) {
      var s3 = (peaks[i].density + peaks[i+1].density + peaks[i+2].density) / 3 * 1.5;
      if (s3 > bestScore) { bestScore = s3; bestCluster = [peaks[i], peaks[i+1], peaks[i+2]]; }
    }
    // 2-peak (TD3)
    if (i + 1 < peaks.length && peaks[i+1].start - peaks[i].end <= maxGap) {
      var s2 = (peaks[i].density + peaks[i+1].density) / 2 * 1.2;
      if (s2 > bestScore) { bestScore = s2; bestCluster = [peaks[i], peaks[i+1]]; }
    }
    // single peak fallback
    if (peaks[i].density > bestScore) { bestScore = peaks[i].density; bestCluster = [peaks[i]]; }
  }

  if (!bestCluster) return [];

  var cStart = bestCluster[0].start;
  var cEnd   = bestCluster[bestCluster.length - 1].end;
  var pad    = Math.round((cEnd - cStart) * 0.5);
  return [{
    y:        Math.max(0, cStart - pad),
    h:        Math.min(h, cEnd + pad) - Math.max(0, cStart - pad),
    lines:    bestCluster.length,
    score:    bestScore,
    rawStart: cStart,
    rawEnd:   cEnd
  }];
}

// ── SIMPLE CROP ───────────────────────────────────────────────────────────

function visionCropRegion(srcCanvas, y, cropH) {
  var c = document.createElement('canvas');
  c.width = srcCanvas.width; c.height = cropH;
  c.getContext('2d').drawImage(srcCanvas, 0, y, srcCanvas.width, cropH, 0, 0, srcCanvas.width, cropH);
  return c;
}

// ── MAIN ANALYSIS ENTRY POINT ─────────────────────────────────────────────

// srcCanvas is READ-ONLY — never mutated
function visionAnalyzeImage(srcCanvas) {
  var t0 = performance.now();

  // Step 1: Document quad detection
  var quad = null;
  try { quad = visionDetectDocumentQuad(srcCanvas); } catch(e) {}
  var documentFound = quad !== null;
  var t1 = performance.now();

  // Step 2: Perspective warp (only if quad found)
  var warpCanvas = null, docType = null;
  if (documentFound) {
    try {
      docType = visionClassifyDocType(quad.corners);
      warpCanvas = visionWarpMRZStrip(srcCanvas, quad.corners, docType);
    } catch(e) { warpCanvas = null; }
  }
  var t2 = performance.now();

  // Step 3: MRZ region detection — prefer warp, fallback to original
  var detectSrc = warpCanvas || srcCanvas;
  var sourceUsedForMrz = warpCanvas ? 'warp' : 'original';
  var regions = [];
  try { regions = visionLocateMRZRegions(detectSrc) || []; } catch(e) {}
  var mrzFound = regions.length > 0;
  var bestRegion = mrzFound ? regions[0] : null;

  // Step 4: Crop MRZ region
  var mrzCrop = null;
  if (bestRegion) {
    try { mrzCrop = visionCropRegion(detectSrc, bestRegion.y, bestRegion.h); } catch(e) {}
  }
  var t3 = performance.now();

  return {
    images: {
      original:     srcCanvas,   // referans, kopyalanmaz
      documentWarp: warpCanvas,  // null olabilir
      mrzCrop:      mrzCrop      // null olabilir
    },
    meta: {
      documentFound:    documentFound,
      docType:          docType,
      docCorners:       quad ? quad.corners : null,
      mrzFound:         mrzFound,
      mrzBox:           bestRegion ? { y: bestRegion.y, h: bestRegion.h, lines: bestRegion.lines } : null,
      sourceUsedForMrz: sourceUsedForMrz,
      regionCount:      regions.length,
      detectMs:         Math.round(t1 - t0),
      warpMs:           Math.round(t2 - t1),
      mrzLocateMs:      Math.round(t3 - t2),
      totalMs:          Math.round(t3 - t0)
    }
  };
}

// ── PANEL RENDERER ────────────────────────────────────────────────────────

function visionRenderPanel(containerEl, vd) {
  var MAX_W = 280;

  function makeDisplayCanvas(src) {
    if (!src) return null;
    var scale = Math.min(MAX_W / src.width, 1.0);
    var dw = Math.round(src.width * scale);
    var dh = Math.round(src.height * scale);
    var c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    c.getContext('2d').drawImage(src, 0, 0, dw, dh);
    return c;
  }

  function makeSlot(label, srcCanvas) {
    var slot = document.createElement('div');
    slot.className = 'vision-img-slot';

    var lbl = document.createElement('span');
    lbl.className = 'vision-slot-label';
    lbl.textContent = label;
    slot.appendChild(lbl);

    if (srcCanvas) {
      var disp = makeDisplayCanvas(srcCanvas);
      slot.appendChild(disp);
      var dim = document.createElement('span');
      dim.className = 'vision-slot-dim';
      dim.textContent = srcCanvas.width + '\u00d7' + srcCanvas.height;
      slot.appendChild(dim);
    } else {
      var ph = document.createElement('div');
      ph.className = 'vision-img-null';
      ph.textContent = 'Bulunamad\u0131';
      slot.appendChild(ph);
    }
    return slot;
  }

  var m = vd.meta;
  var panel = document.createElement('div');
  panel.className = 'vision-panel';

  // Image row
  var imgRow = document.createElement('div');
  imgRow.className = 'vision-images';
  imgRow.appendChild(makeSlot('Original', vd.images.original));
  imgRow.appendChild(makeSlot('Document Warp', vd.images.documentWarp));
  imgRow.appendChild(makeSlot('MRZ Crop', vd.images.mrzCrop));
  panel.appendChild(imgRow);

  // Meta row
  var metaDiv = document.createElement('div');
  metaDiv.className = 'vision-meta';

  var fields = [
    ['documentFound', m.documentFound ? '\u2705 evet' : '\u274c hay\u0131r'],
    ['docType',       m.docType || '\u2014'],
    ['mrzFound',      m.mrzFound ? '\u2705 evet' : '\u274c hay\u0131r'],
    ['source',        m.sourceUsedForMrz],
    ['regions',       String(m.regionCount)],
    m.mrzBox ? ['mrzBox', 'y=' + m.mrzBox.y + ' h=' + m.mrzBox.h + ' lines=' + m.mrzBox.lines] : null,
    ['detectMs',      m.detectMs + 'ms'],
    ['warpMs',        m.warpMs + 'ms'],
    ['mrzLocateMs',   m.mrzLocateMs + 'ms'],
    ['total',         m.totalMs + 'ms'],
  ].filter(Boolean);

  fields.forEach(function(f) {
    var chip = document.createElement('span');
    chip.innerHTML = f[0] + ': <b>' + f[1] + '</b>';
    metaDiv.appendChild(chip);
  });
  panel.appendChild(metaDiv);

  containerEl.appendChild(panel);
}

// ── TOGGLE HANDLER (called from batch table button onclick) ───────────────

function toggleVisionPanel(rowIdx, btnEl) {
  var rowEl = btnEl.closest('tr');
  var nextEl = rowEl.nextElementSibling;
  // Toggle off if panel already open
  if (nextEl && nextEl.classList.contains('vision-panel-row')) {
    nextEl.remove();
    return;
  }
  var entry = batchVisionCache.get(rowIdx);
  if (!entry) return;

  // Lazy analysis: only run on first click
  if (!entry.vd) {
    var prevText = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.textContent = '\u23f3';
    try {
      entry.vd = visionAnalyzeImage(entry.imgCanvas);
    } catch(e) {
      btnEl.disabled = false;
      btnEl.textContent = prevText;
      return;
    }
    btnEl.disabled = false;
    btnEl.textContent = prevText;
  }

  // Insert panel row after current row
  var panelTr = document.createElement('tr');
  panelTr.className = 'vision-panel-row';
  var td = document.createElement('td');
  td.colSpan = 99; // büyük değer — tüm sütunları kapsar
  visionRenderPanel(td, entry.vd);
  panelTr.appendChild(td);
  rowEl.after(panelTr);
}
