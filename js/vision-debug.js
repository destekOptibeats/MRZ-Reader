// ═══════════════════════════════════════════════════════════════════════
// VISION DEBUG — Batch/Regression test görsel analiz modülü
// Rotation-first, best-match region selection, warp advantage.
// OCR çağrısı yapmaz. LocalStorage kullanmaz. Pipeline'a dokunmaz.
// ═══════════════════════════════════════════════════════════════════════

var batchVisionCache = new Map();

// ── HELPERS ───────────────────────────────────────────────────────────────

function visionCropRegion(srcCanvas, y, cropH) {
  var c = document.createElement('canvas');
  c.width = srcCanvas.width;
  c.height = Math.max(1, cropH);
  c.getContext('2d').drawImage(srcCanvas, 0, y, srcCanvas.width, cropH, 0, 0, srcCanvas.width, cropH);
  return c;
}

function visionClassifyDocType(corners) {
  var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
  var w = (Math.hypot(tr.x-tl.x, tr.y-tl.y) + Math.hypot(br.x-bl.x, br.y-bl.y)) / 2;
  var h = (Math.hypot(bl.x-tl.x, bl.y-tl.y) + Math.hypot(br.x-tr.x, br.y-tr.y)) / 2;
  var aspect = w / Math.max(h, 1);
  return aspect > 1.50 ? 'TD1' : aspect > 1.38 ? 'TD3' : 'TD2';
}

// ── DOCUMENT QUAD DETECTION ───────────────────────────────────────────────
// Sobel edge → bounding box → corner refinement.
// Aspect ratio check [1.1, 2.5] selects landscape documents.

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

// ── PERSPECTIVE WARP ──────────────────────────────────────────────────────

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

function visionWarpDocument(srcCanvas, corners, docType) {
  var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
  var docW = Math.round((Math.hypot(tr.x-tl.x, tr.y-tl.y) + Math.hypot(br.x-bl.x, br.y-bl.y)) / 2);
  var docH = Math.round((Math.hypot(bl.x-tl.x, bl.y-tl.y) + Math.hypot(br.x-tr.x, br.y-tr.y)) / 2);
  var outW = Math.max(docW, 200), outH = Math.max(docH, 100);

  var out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  var outCtx = out.getContext('2d');

  var srcPts = [tl, tr, br, bl];
  var dstPts = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  var H = visionComputeHomography(dstPts, srcPts);

  var srcData = srcCanvas.getContext('2d', { willReadFrequently: true })
                          .getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  var sd = srcData.data, sw = srcCanvas.width, sh = srcCanvas.height;
  var outData = outCtx.createImageData(outW, outH);
  var od = outData.data;

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
  outCtx.putImageData(outData, 0, 0);
  return out;
}

// ── MAIN ANALYSIS ─────────────────────────────────────────────────────────
//
// Strategy:
//   For each rotation in [0, 90, 180, 270]:
//     1. Rotate image
//     2. Binarize (Otsu — same as pipeline)
//     3. scoreMRZPresence → origScore (+ bottom-half bonus)
//     4. Try visionDetectDocumentQuad → if found, warp whole document
//     5. scoreMRZPresence on warp → warpScore (× 1.2 advantage)
//     6. effectiveScore = max(origScore, warpScore)
//   Best effectiveScore across all rotations wins.
//   MRZ crop taken from winner's best source (warp > original).
//
// srcCanvas: READ-ONLY, never mutated.

function visionAnalyzeImage(srcCanvas) {
  var t0 = performance.now();
  var ROTATIONS = [0, 90, 180, 270];
  var best = null; // { deg, rotated, origScore, warpCanvas, warpScore, effectiveScore, origPresence, warpPresence, quad, docType }

  for (var ri = 0; ri < ROTATIONS.length; ri++) {
    var deg = ROTATIONS[ri];
    var rotated, binary, origPresence, origScore;

    try {
      rotated = (deg === 0) ? srcCanvas : window.MRZPipeline.rotateCanvas(srcCanvas, deg);
      binary = window.MRZPipeline.batchPreprocessMRZ(rotated);
      origPresence = window.MRZPipeline.scoreMRZPresence(binary);
    } catch(e) { continue; }

    // Bottom-half bonus: MRZ should be in lower portion of image
    var mrzCenter = origPresence.cropY + origPresence.cropH / 2;
    var bottomBonus = (mrzCenter > rotated.height * 0.40) ? 1.15 : 1.0;
    origScore = origPresence.score * bottomBonus;

    // Try document quad + full-document warp
    var quad = null, warpCanvas = null, warpBinary = null, warpPresence = null, warpScore = 0, docType = null;
    try {
      quad = visionDetectDocumentQuad(rotated);
      if (quad) {
        docType = visionClassifyDocType(quad.corners);
        warpCanvas = visionWarpDocument(rotated, quad.corners, docType);
        warpBinary = window.MRZPipeline.batchPreprocessMRZ(warpCanvas);
        warpPresence = window.MRZPipeline.scoreMRZPresence(warpBinary);
        warpScore = warpPresence.score * 1.2; // warp advantage: perspective-corrected text scores better
      }
    } catch(e) { warpCanvas = null; warpScore = 0; }

    var effectiveScore = Math.max(origScore, warpScore);

    if (!best || effectiveScore > best.effectiveScore) {
      best = { deg, rotated, binary, origPresence, origScore, quad, docType,
               warpCanvas, warpBinary, warpPresence, warpScore, effectiveScore };
    }
  }

  if (!best) best = { deg: 0, rotated: srcCanvas, binary: srcCanvas,
                      origPresence: { score: 0, cropY: 0, cropH: srcCanvas.height },
                      origScore: 0, warpCanvas: null, warpScore: 0, effectiveScore: 0 };

  var t1 = performance.now();

  // Select best source: warp beats original when warpScore > origScore
  var useWarp = best.warpCanvas && (best.warpScore > best.origScore);
  var detectSrc    = useWarp ? best.warpCanvas    : best.rotated;
  var detectBinary = useWarp ? best.warpBinary    : best.binary;
  var presence     = useWarp ? best.warpPresence  : best.origPresence;
  var selectedWhy  = useWarp ? 'warp_score_higher' : 'orig_score_higher';

  // MRZ crop: color + binary version
  var mrzCrop = null, mrzBinary = null;
  try { mrzCrop   = visionCropRegion(detectSrc,    presence.cropY, presence.cropH); } catch(e) {}
  try { mrzBinary = visionCropRegion(detectBinary, presence.cropY, presence.cropH); } catch(e) {}

  var t2 = performance.now();

  return {
    images: {
      original:     best.rotated,     // rotation-normalized source
      documentWarp: best.warpCanvas,  // full-document warp (null if quad not found)
      mrzCrop:      mrzCrop           // horizontal MRZ strip (best source)
    },
    meta: {
      detectedRotation:  best.deg,
      mrzFound:          best.effectiveScore > 0,
      sourceUsedForMrz:  useWarp ? 'warp' : 'original',
      selectedWhy:       selectedWhy,
      selectedScore:     best.effectiveScore,
      mrzOrigRegions:    { y: best.origPresence.cropY, h: best.origPresence.cropH, score: best.origScore },
      mrzWarpRegions:    best.warpPresence
                           ? { y: best.warpPresence.cropY, h: best.warpPresence.cropH, score: best.warpScore }
                           : null,
      mrzBox:            { y: presence.cropY, h: presence.cropH },
      docType:           best.docType,
      quadFound:         !!best.quad,
      analyzeMs:         Math.round(t1 - t0),
      cropMs:            Math.round(t2 - t1),
      totalMs:           Math.round(t2 - t0)
    }
  };
}

// ── PANEL RENDERER ────────────────────────────────────────────────────────

function visionRenderPanel(containerEl, vd) {
  var MAX_W = 300;

  function makeDisplayCanvas(src) {
    if (!src) return null;
    var scale = Math.min(MAX_W / src.width, 1.0);
    var dw = Math.round(src.width  * scale);
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

  // Image slots
  var imgRow = document.createElement('div');
  imgRow.className = 'vision-images';
  var origLabel = 'Original' + (m.detectedRotation ? ' (rot ' + m.detectedRotation + '\u00b0)' : '');
  imgRow.appendChild(makeSlot(origLabel,        vd.images.original));
  imgRow.appendChild(makeSlot('Document Warp',  vd.images.documentWarp));
  imgRow.appendChild(makeSlot('MRZ Crop ('      + m.sourceUsedForMrz + ')', vd.images.mrzCrop));
  panel.appendChild(imgRow);

  // Meta row
  var metaDiv = document.createElement('div');
  metaDiv.className = 'vision-meta';

  var origR = m.mrzOrigRegions;
  var warpR = m.mrzWarpRegions;
  var fields = [
    ['rotation',      m.detectedRotation + '\u00b0'],
    ['mrzFound',      m.mrzFound ? '\u2705 evet' : '\u274c hay\u0131r'],
    ['source',        m.sourceUsedForMrz],
    ['why',           m.selectedWhy],
    ['score',         m.selectedScore !== undefined ? m.selectedScore.toFixed(3) : '\u2014'],
    ['quadFound',     m.quadFound ? '\u2705' : '\u274c'],
    m.docType ? ['docType', m.docType] : null,
    m.mrzBox  ? ['mrzBox',  'y=' + m.mrzBox.y + ' h=' + m.mrzBox.h] : null,
    origR ? ['origScore', origR.score.toFixed(3) + ' y=' + origR.y + ' h=' + origR.h] : null,
    warpR ? ['warpScore', warpR.score.toFixed(3) + ' y=' + warpR.y + ' h=' + warpR.h] : null,
    ['analyzeMs',     m.analyzeMs + 'ms'],
    ['totalMs',       m.totalMs   + 'ms'],
  ].filter(Boolean);

  fields.forEach(function(f) {
    var chip = document.createElement('span');
    chip.innerHTML = f[0] + ': <b>' + f[1] + '</b>';
    metaDiv.appendChild(chip);
  });
  panel.appendChild(metaDiv);

  containerEl.appendChild(panel);
}

// ── TOGGLE HANDLER ────────────────────────────────────────────────────────

function toggleVisionPanel(rowIdx, btnEl) {
  var rowEl = btnEl.closest('tr');
  var nextEl = rowEl.nextElementSibling;
  if (nextEl && nextEl.classList.contains('vision-panel-row')) {
    nextEl.remove();
    return;
  }
  var entry = batchVisionCache.get(rowIdx);
  if (!entry) return;

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

  var panelTr = document.createElement('tr');
  panelTr.className = 'vision-panel-row';
  var td = document.createElement('td');
  td.colSpan = 99;
  visionRenderPanel(td, entry.vd);
  panelTr.appendChild(td);
  rowEl.after(panelTr);
}
