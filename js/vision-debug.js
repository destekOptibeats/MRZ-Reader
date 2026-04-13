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
// Contour-based detector: finds real document boundaries, not full-canvas bounding boxes.
//
// Algorithm:
//   1. Downsample to 25% for fast component analysis
//   2. Grayscale + Sobel edges (threshold 25)
//   3. 3×3 dilation to close edge gaps
//   4. BFS connected component labeling (border pixels excluded)
//   5. Only keep components > 3% of analysis area (rejects scattered text/noise)
//   6. For each large component: quadrant corner selection → scale to full res
//   7. Validate: coverage [0.10, 0.85], aspect [1.1, 2.5], edgePenalty > 0
//   8. Return best valid quad, or null
//
// Returns null for full-frame images (document fills canvas → no inset boundary found).
// Called only when frameMode === 'full-frame'; scene images use visionDetectSceneDocumentQuad.

function visionDetectDocumentQuad(canvas) {
  var W = canvas.width, H = canvas.height;

  // ── Downsample to 25% for fast component analysis ─────────────────────
  var SCALE = 0.25;
  var sw = Math.max(4, Math.round(W * SCALE));
  var sh = Math.max(4, Math.round(H * SCALE));
  var sc = document.createElement('canvas');
  sc.width = sw; sc.height = sh;
  sc.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
  var sctx = sc.getContext('2d', { willReadFrequently: true });
  var sd = sctx.getImageData(0, 0, sw, sh).data;

  // ── Grayscale ─────────────────────────────────────────────────────────
  var gray = new Uint8Array(sw * sh);
  for (var i = 0; i < sw * sh; i++) {
    gray[i] = Math.round(0.299 * sd[i*4] + 0.587 * sd[i*4+1] + 0.114 * sd[i*4+2]);
  }

  // ── Sobel edges (threshold 25 — slightly lower at quarter-res) ─────────
  var edge = new Uint8Array(sw * sh);
  for (var y = 1; y < sh - 1; y++) {
    for (var x = 1; x < sw - 1; x++) {
      var gx = -gray[(y-1)*sw+(x-1)] + gray[(y-1)*sw+(x+1)]
               - 2*gray[y*sw+(x-1)]  + 2*gray[y*sw+(x+1)]
               - gray[(y+1)*sw+(x-1)] + gray[(y+1)*sw+(x+1)];
      var gy = -gray[(y-1)*sw+(x-1)] - 2*gray[(y-1)*sw+x] - gray[(y-1)*sw+(x+1)]
               + gray[(y+1)*sw+(x-1)] + 2*gray[(y+1)*sw+x] + gray[(y+1)*sw+(x+1)];
      edge[y*sw+x] = (Math.sqrt(gx*gx + gy*gy) > 25) ? 1 : 0;
    }
  }

  // ── 3×3 dilation to close edge gaps ───────────────────────────────────
  var dil = new Uint8Array(sw * sh);
  for (var y = 1; y < sh - 1; y++) {
    for (var x = 1; x < sw - 1; x++) {
      if (edge[y*sw+x] || edge[(y-1)*sw+x] || edge[(y+1)*sw+x] ||
          edge[y*sw+(x-1)] || edge[y*sw+(x+1)]) dil[y*sw+x] = 1;
    }
  }

  // ── Connected component labeling (BFS, skip border pixels) ────────────
  // BORD: ignore pixels within 3% of analysis image edge (image border ≠ doc border)
  // MINPX: component must be > 3% of analysis area to count as a real boundary
  var BORD   = Math.max(1, Math.round(Math.min(sw, sh) * 0.03));
  var MINPX  = Math.round(sw * sh * 0.03);
  var label  = new Int32Array(sw * sh); // 0 = unlabeled / unvisited
  var bestQuad = null, bestScore = -1;

  for (var sy = BORD; sy < sh - BORD; sy++) {
    for (var sx = BORD; sx < sw - BORD; sx++) {
      if (!dil[sy*sw+sx] || label[sy*sw+sx]) continue;

      // BFS flood fill from this seed pixel
      var seedIdx = sy * sw + sx;
      label[seedIdx] = 1;
      var stack = [seedIdx];
      var pixels = [];

      while (stack.length > 0) {
        var idx = stack.pop();
        var py = (idx / sw) | 0, px = idx % sw;
        pixels.push({ x: px, y: py });

        var nbrs = [idx - sw, idx + sw, idx - 1, idx + 1];
        for (var ni = 0; ni < 4; ni++) {
          var nidx = nbrs[ni];
          if (nidx < 0 || nidx >= sw * sh) continue;
          var ny = (nidx / sw) | 0, nx = nidx % sw;
          if (nx < BORD || nx >= sw - BORD || ny < BORD || ny >= sh - BORD) continue;
          if (dil[nidx] && !label[nidx]) {
            label[nidx] = 1;
            stack.push(nidx);
          }
        }
      }

      if (pixels.length < MINPX) continue; // component too small — noise, skip

      // ── Quadrant corner selection on component pixels ──────────────────
      var cx = 0, cy = 0;
      for (var pi = 0; pi < pixels.length; pi++) { cx += pixels[pi].x; cy += pixels[pi].y; }
      cx /= pixels.length; cy /= pixels.length;

      var tl = {x: sw, y: sh}, tr = {x: 0, y: sh};
      var bl = {x: sw, y: 0},  br = {x: 0, y: 0};
      for (var pi = 0; pi < pixels.length; pi++) {
        var p = pixels[pi];
        if (p.x <= cx && p.y <= cy) {
          if (p.x + p.y < tl.x + tl.y) { tl.x = p.x; tl.y = p.y; }
        } else if (p.x > cx && p.y <= cy) {
          if (-p.x + p.y < -tr.x + tr.y) { tr.x = p.x; tr.y = p.y; }
        } else if (p.x <= cx && p.y > cy) {
          if (p.x - p.y < bl.x - bl.y) { bl.x = p.x; bl.y = p.y; }
        } else {
          if (-p.x - p.y < -br.x - br.y) { br.x = p.x; br.y = p.y; }
        }
      }

      // ── Scale corners back to full resolution ─────────────────────────
      var invS = 1.0 / SCALE;
      var ftl = { x: Math.round(tl.x * invS), y: Math.round(tl.y * invS) };
      var ftr = { x: Math.round(tr.x * invS), y: Math.round(tr.y * invS) };
      var fbr = { x: Math.round(br.x * invS), y: Math.round(br.y * invS) };
      var fbl = { x: Math.round(bl.x * invS), y: Math.round(bl.y * invS) };

      // ── Score and validate ─────────────────────────────────────────────
      var quality = computeQuadQuality([ftl, ftr, fbr, fbl], W, H);
      // coverage > 0.85 → full-canvas false positive → reject
      if (quality.coverage < 0.10 || quality.coverage > 0.85) continue;
      // aspect outside [1.1, 2.5] → not a landscape document → reject
      if (quality.aspect < 1.1 || quality.aspect > 2.5) continue;
      // edgePenalty === 0 → corners at image boundary → image border, not doc border → reject
      if (quality.edgePenalty === 0) continue;

      if (quality.score > bestScore) {
        bestScore = quality.score;
        bestQuad  = { corners: [ftl, ftr, fbr, fbl], quality: quality };
      }
    }
  }

  return bestQuad; // null when no inset document boundary found (correct for full-frame scans)
}

// ── SCENE-MODE DOCUMENT QUAD DETECTOR ────────────────────────────────────
// Used when frameMode === 'scene'. Finds the inset document rectangle using
// Otsu brightness thresholding instead of a global Sobel bounding box.
//
// Why: in scene images, background clutter fills the Sobel bounding box.
// Otsu separates bright document (passport/ID paper) from dark background,
// giving a meaningful inset bounding box that can be used for perspective warp.
//
// Algorithm:
//   1. Grayscale + Otsu threshold → bright mask
//   2. Bounding box of bright region → candidate document rectangle
//   3. Reject if too small, wrong aspect, or covers ≥ 85% of canvas (≈ full-frame)
//   4. Refine corners using Sobel edge pixels within the bounding box ±5% margin
//   5. Return { corners, quality } or null

function visionDetectSceneDocumentQuad(canvas) {
  var W = canvas.width, H = canvas.height;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var d = ctx.getImageData(0, 0, W, H).data;

  // ── Grayscale ─────────────────────────────────────────────────────────────
  var gray = new Uint8Array(W * H);
  for (var i = 0; i < W * H; i++) {
    gray[i] = Math.round(0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]);
  }

  // ── Otsu threshold ────────────────────────────────────────────────────────
  var hist = new Int32Array(256);
  for (var i = 0; i < gray.length; i++) hist[gray[i]]++;
  var total = W * H, sum = 0;
  for (var t = 0; t < 256; t++) sum += t * hist[t];
  var sumB = 0, wB = 0, maxVar = 0, threshold = 128;
  for (var t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    var wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    var mB = sumB / wB, mF = (sum - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }

  // ── Bounding box of bright pixels ─────────────────────────────────────────
  var minX = W, minY = H, maxX = 0, maxY = 0;
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      if (gray[y*W+x] > threshold) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }

  var quadW = maxX - minX, quadH = maxY - minY;
  if (quadW < W * 0.10 || quadH < H * 0.10) return null;

  var aspect = quadW / Math.max(quadH, 1);
  if (aspect < 1.0 || aspect > 2.6) return null;

  // Reject if bright region covers ≥ 90% of canvas — this would be a full-frame
  // image mis-classified as scene, or a scene with near-white background.
  // 0.90 (not 0.85) because close-up scene images can have coverage up to ~0.86.
  var coverage = (quadW * quadH) / (W * H);
  if (coverage >= 0.90 || coverage < 0.05) return null;

  // ── Sobel corner refinement within the bright bounding box ────────────────
  // Compute Sobel edges and refine corners within ±pad region of the bbox.
  var edge = new Uint8Array(W * H);
  for (var y = 1; y < H - 1; y++) {
    for (var x = 1; x < W - 1; x++) {
      var gx = -gray[(y-1)*W+(x-1)] + gray[(y-1)*W+(x+1)]
               - 2*gray[y*W+(x-1)]  + 2*gray[y*W+(x+1)]
               - gray[(y+1)*W+(x-1)] + gray[(y+1)*W+(x+1)];
      var gy = -gray[(y-1)*W+(x-1)] - 2*gray[(y-1)*W+x] - gray[(y-1)*W+(x+1)]
               + gray[(y+1)*W+(x-1)] + 2*gray[(y+1)*W+x] + gray[(y+1)*W+(x+1)];
      edge[y*W+x] = Math.min(255, Math.sqrt(gx*gx + gy*gy)) > 30 ? 255 : 0;
    }
  }

  var pad = Math.round(Math.max(W, H) * 0.05);
  var rx0 = Math.max(0, minX - pad), ry0 = Math.max(0, minY - pad);
  var rx1 = Math.min(W, maxX + pad), ry1 = Math.min(H, maxY + pad);
  var cx = (rx0 + rx1) / 2, cy = (ry0 + ry1) / 2;

  var tl = {x: rx1, y: ry1}, tr = {x: rx0, y: ry1};
  var bl = {x: rx1, y: ry0}, br = {x: rx0, y: ry0};

  for (var y = ry0; y < ry1; y++) {
    for (var x = rx0; x < rx1; x++) {
      if (!edge[y*W+x]) continue;
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

  var quality = computeQuadQuality([tl, tr, br, bl], W, H);
  return { corners: [tl, tr, br, bl], quality: quality };
}

// ── QUAD QUALITY VALIDATOR ────────────────────────────────────────────────
// Scores how document-like the detected corners are.
// Used as a DIAGNOSTIC METRIC only — not a hard gate.
// isValid threshold 0.55 is informational; rotation decisions use warpAspect + warpMrzBR.

function computeQuadQuality(corners, W, H) {
  var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];

  // ── Aspect score ─────────────────────────────────────────────────────────
  var wTop   = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  var wBot   = Math.hypot(br.x - bl.x, br.y - bl.y);
  var hLeft  = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  var hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  var avgW   = (wTop + wBot) / 2;
  var avgH   = (hLeft + hRight) / 2;
  var aspect = avgW / Math.max(avgH, 1);
  // Peak at ~1.65 (midpoint of TD1/TD2/TD3), falls to 0 at edges of [1.1, 2.2]
  var aspectScore = (aspect >= 1.1 && aspect <= 2.2)
    ? 1 - Math.abs(aspect - 1.65) / 0.55
    : 0;
  aspectScore = Math.max(0, Math.min(1, aspectScore));

  // ── Coverage score ────────────────────────────────────────────────────────
  // Shoelace area of the quad vs canvas area. Valid range: [0.15, 0.92]
  var area = Math.abs(
    (tl.x*(tr.y - bl.y) + tr.x*(br.y - tl.y) +
     br.x*(bl.y - tr.y) + bl.x*(tl.y - br.y)) / 2
  );
  var coverage = area / (W * H);
  var coverageScore = (coverage >= 0.15 && coverage <= 0.92)
    ? 1 - Math.abs(coverage - 0.50) / 0.42
    : 0;
  coverageScore = Math.max(0, Math.min(1, coverageScore));

  // ── Rectangularity score ──────────────────────────────────────────────────
  // Opposite sides parallel (similar length) + corner angle near 90°
  var wSymmetry = 1 - Math.min(1, Math.abs(wTop - wBot) / Math.max(avgW, 1));
  var hSymmetry = 1 - Math.min(1, Math.abs(hLeft - hRight) / Math.max(avgH, 1));
  var vRight = { x: tr.x - tl.x, y: tr.y - tl.y };
  var vDown  = { x: bl.x - tl.x, y: bl.y - tl.y };
  var dot = vRight.x*vDown.x + vRight.y*vDown.y;
  var lenR = Math.hypot(vRight.x, vRight.y), lenD = Math.hypot(vDown.x, vDown.y);
  var cosAngle = (lenR > 0 && lenD > 0) ? dot / (lenR * lenD) : 1;
  // cos≈0 → ~90° → good; cos≈1 → parallel → bad
  var angleScore = 1 - Math.min(1, Math.abs(cosAngle) / 0.5);
  var rectangularityScore = (wSymmetry + hSymmetry + angleScore) / 3;

  // ── Edge proximity check ──────────────────────────────────────────────────
  // >2 corners hugging the image border → the "quad" is just the image frame
  var margin = 0.03;
  var nearEdge = [tl, tr, br, bl].filter(function(c) {
    return c.x < W * margin || c.x > W * (1 - margin) ||
           c.y < H * margin || c.y > H * (1 - margin);
  }).length;
  var edgePenalty = nearEdge > 2 ? 0 : 1;

  var score = (aspectScore + coverageScore + rectangularityScore) / 3 * edgePenalty;

  return {
    aspect:         Math.round(aspect * 100) / 100,
    coverage:       Math.round(coverage * 100) / 100,
    aspectScore:    Math.round(aspectScore * 100) / 100,
    coverageScore:  Math.round(coverageScore * 100) / 100,
    rectangularity: Math.round(rectangularityScore * 100) / 100,
    edgePenalty:    edgePenalty,
    score:          Math.round(score * 100) / 100,
    isValid:        score >= 0.55
  };
}

// ── FRAME MODE CLASSIFIER ─────────────────────────────────────────────────
// Distinguishes full-frame document crops from scene images with background.
// Signal: mean luminance of the outer 8% ring of the canvas.
//   bright border (>90) → document paper fills the frame → 'full-frame'
//   dark border  (≤90) → background/clutter at edges    → 'scene'

function visionClassifyFrameMode(canvas) {
  var W = canvas.width, H = canvas.height;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });

  var bW = Math.max(4, Math.round(W * 0.08));
  var bH = Math.max(4, Math.round(H * 0.08));

  var total = 0, count = 0;
  var step = 3; // sample every 3rd pixel for speed

  function sampleStrip(x0, y0, x1, y1) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    if (x1 <= x0 || y1 <= y0) return;
    var d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    for (var i = 0; i < d.length; i += 4 * step) {
      total += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      count++;
    }
  }

  sampleStrip(0,    0,    W,    bH);       // top
  sampleStrip(0,    H-bH, W,    H);        // bottom
  sampleStrip(0,    bH,   bW,   H-bH);     // left  (corners excluded)
  sampleStrip(W-bW, bH,   W,    H-bH);     // right (corners excluded)

  var borderBrightness = count > 0 ? Math.round(total / count) : 0;

  return {
    mode:             borderBrightness > 90 ? 'full-frame' : 'scene',
    borderBrightness: borderBrightness
  };
}

// ── POST-WARP DOCUMENT TRIMMER ────────────────────────────────────────────
// Removes near-white margins from the normalized warp canvas.
// For full-frame scans (content fills canvas): returns as-is (< 2% margin).
// For scene images: removes background clutter outside the document.

function visionTrimWarpMargins(canvas) {
  var W = canvas.width, H = canvas.height;
  if (W < 50 || H < 30) return canvas;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var d = ctx.getImageData(0, 0, W, H).data;

  var minX = W, minY = H, maxX = 0, maxY = 0;
  var thresh = 235; // pixels brighter than this are treated as margins
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var pi = (y * W + x) * 4;
      var lum = 0.299 * d[pi] + 0.587 * d[pi+1] + 0.114 * d[pi+2];
      if (lum < thresh) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) return canvas; // no content found

  // If content bounding box is > 96% of canvas in both axes — image already fills frame.
  // Return as-is to avoid no-op resampling.
  var xMarginFrac = (minX + (W - maxX)) / W;
  var yMarginFrac = (minY + (H - maxY)) / H;
  if (xMarginFrac < 0.04 && yMarginFrac < 0.04) return canvas;

  // Add 2% padding around content bounding box
  var pad = Math.max(4, Math.round(Math.max(W, H) * 0.02));
  var cx0 = Math.max(0, minX - pad), cy0 = Math.max(0, minY - pad);
  var cx1 = Math.min(W, maxX + pad), cy1 = Math.min(H, maxY + pad);
  var cW = cx1 - cx0, cH = cy1 - cy0;
  if (cW < 80 || cH < 40) return canvas; // result too small — bail

  var out = document.createElement('canvas');
  out.width = cW; out.height = cH;
  out.getContext('2d').drawImage(canvas, cx0, cy0, cW, cH, 0, 0, cW, cH);
  return out;
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
  var srcIsLandscape = srcCanvas.width >= srcCanvas.height;
  var frameModeResult  = visionClassifyFrameMode(srcCanvas);
  var frameMode        = frameModeResult.mode;             // 'full-frame' | 'scene'
  var borderBrightness = frameModeResult.borderBrightness; // raw luminance for debug
  var best = null; // { deg, rotated, origScore, warpCanvas, warpScore, effectiveScore, origPresence, warpPresence, quad, docType }
  var rotationScores = []; // per-rotation debug data

  for (var ri = 0; ri < ROTATIONS.length; ri++) {
    var deg = ROTATIONS[ri];
    var rotated, binary, origPresence, origScore;

    try {
      rotated = (deg === 0) ? srcCanvas : window.MRZPipeline.rotateCanvas(srcCanvas, deg);
      binary = window.MRZPipeline.batchPreprocessMRZ(rotated);
      origPresence = window.MRZPipeline.scoreMRZPresence(binary);
    } catch(e) { continue; }

    // origScore: raw density score, no bottom-half multiplier
    origScore = origPresence.score;

    // Try document quad + full-document warp.
    // Scene mode uses Otsu-threshold bright-region detector to find the inset document.
    // Full-frame mode uses Sobel bounding box (existing detector).
    var quad = null, warpCanvas = null, warpBinary = null, warpPresence = null, warpScore = 0, docType = null;
    try {
      quad = (frameMode === 'scene')
        ? visionDetectSceneDocumentQuad(rotated)
        : visionDetectDocumentQuad(rotated);
      if (quad) {
        docType = visionClassifyDocType(quad.corners);
        warpCanvas = visionWarpDocument(rotated, quad.corners, docType);
        warpBinary = window.MRZPipeline.batchPreprocessMRZ(warpCanvas);
        warpPresence = window.MRZPipeline.scoreMRZPresence(warpBinary);
        warpScore = warpPresence.score * 1.2;
      }
    } catch(e) { warpCanvas = null; warpScore = 0; }

    // Document-canonical tier scoring.
    // Tier 1: quad found (document is landscape in this rotation) + MRZ is in lower half of warp
    // Tier 2: quad found + warp exists but MRZ placement uncertain
    // Tier 3: no quad + density detected MRZ in lower half of rotated canvas
    // Tier 4: fallback — just raw density
    //
    // Tie-breaker: 0° gets +3 (very slight preference for no-rotation over 180° upside-down).
    // srcIsLandscape is NOT used for decision — document geometry decides.

    var rotH = (deg === 90 || deg === 270) ? srcCanvas.width : srcCanvas.height;
    var warpAspect = warpCanvas ? (warpCanvas.width / warpCanvas.height) : 0;
    // warpAspect must be in [1.1, 2.2]: excludes portrait warps (wrong rotation)
    // and implausibly wide shapes; covers TD1 (1.59), TD2 (1.38), TD3 (1.42) comfortably.
    // warpQuadOk: quad found + warp has plausible landscape aspect.
    // Both modes use the same check — the detectors already gate on coverage:
    //   full-frame → visionDetectDocumentQuad (aspect-ratio gated)
    //   scene      → visionDetectSceneDocumentQuad (bright-bbox coverage < 0.90 gated)
    // Do NOT re-check quad.quality.coverage here — shoelace area of Sobel-refined
    // corners is larger than the bright-region bbox (due to ±5% padding) and would
    // incorrectly reject valid close-up scene detections.
    var warpQuadOk = !!(quad && warpAspect >= 1.1 && warpAspect <= 2.2);

    var warpMrzBR = 0;
    if (warpPresence && warpCanvas) {
      warpMrzBR = (warpPresence.cropY + warpPresence.cropH) / warpCanvas.height;
    }
    var origMrzBR = (origPresence.cropY + origPresence.cropH) / rotH;

    var effectiveScore;
    if (warpQuadOk && warpMrzBR >= 0.50) {
      // Tier 1: warp confirms document orientation + MRZ at bottom
      effectiveScore = 100 + (warpPresence ? warpPresence.score * 40 : 0);
    } else if (warpQuadOk) {
      // Tier 2: warp found but MRZ not confirmed at bottom
      effectiveScore = 60 + (warpPresence ? warpPresence.score * 30 : 0);
    } else if (origMrzBR >= 0.50) {
      // Tier 3: no warp, density found MRZ in lower half
      effectiveScore = 40 + origPresence.score * 25;
    } else {
      // Tier 4: raw fallback
      effectiveScore = origPresence.score * 15;
    }
    // Slight tie-breaker: prefer 0° (already upright) over upside-down (180°)
    if (deg === 0) effectiveScore += 3;

    var tier = effectiveScore >= 100 ? 1 : effectiveScore >= 60 ? 2 : effectiveScore >= 40 ? 3 : 4;

    rotationScores.push({
      deg:            deg,
      origScore:      origScore,
      warpScore:      warpScore,
      effectiveScore: effectiveScore,
      warpAspect:     warpAspect ? Math.round(warpAspect * 100) / 100 : null,
      warpMrzBR:      Math.round(warpMrzBR * 100) / 100,
      origMrzBR:      Math.round(origMrzBR * 100) / 100,
      tier:           tier,
      quadFound:      !!quad,
      quadQuality:    quad ? quad.quality : null
    });

    if (!best || effectiveScore > best.effectiveScore) {
      best = { deg, rotated, binary, origPresence, origScore, quad, docType,
               warpCanvas, warpBinary, warpPresence, warpScore, effectiveScore,
               warpMrzBR: warpMrzBR, origMrzBR: origMrzBR, tier: tier,
               quadQuality: quad ? quad.quality : null };
    }
  }

  if (!best) best = { deg: 0, rotated: srcCanvas, binary: srcCanvas,
                      origPresence: { score: 0, cropY: 0, cropH: srcCanvas.height },
                      origScore: 0, warpCanvas: null, warpScore: 0, effectiveScore: 0 };

  var t1 = performance.now();

  // Select best source: use warp when quad+docType confirmed and warpScore within 5% of origScore.
  // A confirmed quad+docType means geometry-based strip extraction is available, which is
  // categorically more reliable than density fallback — so don't discard it over noise margins.
  var useWarpStrict = !!(best.warpCanvas && best.docType && (best.warpScore > best.origScore));
  var useWarp       = !!(best.warpCanvas && best.docType && (best.warpScore >= best.origScore * 0.95));
  var warpSelectedByThreshold = useWarp && !useWarpStrict; // true when threshold rule (not strict) decided
  var selectedWhy = useWarp ? 'warp_score_higher' : 'orig_score_higher';

  // ── Post-warp canonical orientation normalization ─────────────────────────
  // warpMrzBR alone is insufficient — scoreMRZPresence can return bottom-half
  // results for sideways canvases (horizontal row scan misaligned with vertical MRZ).
  // Fix: test all 4 rotations of the warp canvas, pick the one with highest MRZ
  // score AND MRZ firmly in the lower portion (>= 0.55). Replace best.warpCanvas.
  var warpNormDeg = 0;
  var warpFlipped = false;
  var ocrUsableRotation = best.deg;

  if (useWarp && best.warpCanvas) {
    var _normBest = { deg: 0, score: -1, canvas: best.warpCanvas,
                      presence: best.warpPresence, mrzBR: best.warpMrzBR || 0 };
    [0, 90, 180, 270].forEach(function(ndeg) {
      try {
        var nc;
        if (ndeg === 0) {
          nc = best.warpCanvas;
        } else {
          nc = document.createElement('canvas');
          nc.width  = (ndeg === 90 || ndeg === 270) ? best.warpCanvas.height : best.warpCanvas.width;
          nc.height = (ndeg === 90 || ndeg === 270) ? best.warpCanvas.width  : best.warpCanvas.height;
          var nctx = nc.getContext('2d');
          nctx.save();
          nctx.translate(nc.width / 2, nc.height / 2);
          nctx.rotate(ndeg * Math.PI / 180);
          nctx.drawImage(best.warpCanvas, -best.warpCanvas.width / 2, -best.warpCanvas.height / 2);
          nctx.restore();
        }
        var nBin  = window.MRZPipeline.batchPreprocessMRZ(nc);
        var nPres = window.MRZPipeline.scoreMRZPresence(nBin);
        var nBR   = (nPres.cropY + nPres.cropH) / nc.height;
        var nAsp  = nc.width / nc.height;
        // Must have MRZ in lower 45% of canvas (br >= 0.55), stay landscape, beat current best
        if (nBR >= 0.55 && nAsp >= 1.0 && nPres.score > _normBest.score) {
          _normBest = { deg: ndeg, score: nPres.score, canvas: nc,
                        presence: nPres, mrzBR: nBR };
        }
      } catch(e) {}
    });

    if (_normBest.deg !== 0) {
      best.warpCanvas   = _normBest.canvas;
      best.warpPresence = _normBest.presence;
      best.warpMrzBR    = _normBest.mrzBR;
      warpNormDeg       = _normBest.deg;
      warpFlipped       = true;
      selectedWhy      += '+warp_norm' + warpNormDeg;
    }
  }

  // ── Post-normalization tight document crop ─────────────────────────────────
  // Trim non-content (white / near-white) margins from the normalized warp.
  // For full-frame images this is a no-op (content fills canvas).
  // For scene images this removes background clutter around the document.
  if (useWarp && best.warpCanvas) {
    var trimmed = visionTrimWarpMargins(best.warpCanvas);
    if (trimmed !== best.warpCanvas) {
      best.warpCanvas = trimmed;
      try {
        var tBin  = window.MRZPipeline.batchPreprocessMRZ(trimmed);
        var tPres = window.MRZPipeline.scoreMRZPresence(tBin);
        best.warpPresence = tPres;
        best.warpMrzBR    = (tPres.cropY + tPres.cropH) / trimmed.height;
      } catch(e) {}
      selectedWhy += '+trim';
    }
  }

  var canonicalRotation = best.deg + (warpNormDeg ? '+' + warpNormDeg : '');
  var isVisuallyUpright = useWarp
    ? (best.warpMrzBR !== undefined && best.warpMrzBR >= 0.55)
    : false;

  // Build human-readable selection reason for debug panel
  var selectionReason = 'rot=' + best.deg + '\u00b0'
    + (warpNormDeg ? '+norm' + warpNormDeg : '')
    + ' tier=' + best.tier
    + ' warpMrzBR=' + (best.warpMrzBR !== undefined ? best.warpMrzBR.toFixed(2) : '\u2014')
    + ' orig=' + best.origScore.toFixed(3)
    + ' warp=' + (best.warpScore > 0 ? best.warpScore.toFixed(3) : '\u2014')
    + ' eff=' + best.effectiveScore.toFixed(3)
    + ' src=' + (useWarp ? 'warp' : 'orig');

  // MRZ crop extraction
  var mrzCrop = null;
  var mrzCropY, mrzCropH;

  if (useWarp) {
    var wH = best.warpCanvas.height;
    var warpP = best.warpPresence; // scoreMRZPresence result on the warped canvas

    // Prefer scoreMRZPresence crop when it found a tight band (score > 0.15 and height < 35% of warp).
    // This gives image-specific crop position instead of always using a fixed bottom percentage.
    // Fall back to docType-based strip when the density scorer fails (warpPresence covers full image).
    var stripRatio = best.docType === 'TD1' ? 0.36 : 0.28;
    var fixedH = Math.round(wH * stripRatio);

    if (warpP && warpP.score > 0.15 && warpP.cropH < wH * 0.35) {
      // Density scorer found a real band — use its coordinates directly
      mrzCropY = warpP.cropY;
      mrzCropH = warpP.cropH;
      selectedWhy += '+warp_density(' + best.docType + ')';
    } else {
      // Fallback: docType-based fixed bottom strip
      mrzCropH = fixedH;
      mrzCropY = wH - mrzCropH;
      selectedWhy += '+doctype_pos(' + best.docType + ')';
    }
    try { mrzCrop = visionCropRegion(best.warpCanvas, mrzCropY, mrzCropH); } catch(e) {}
  } else {
    var p    = best.origPresence;
    var imgH = best.rotated.height;

    if (best.origScore <= 0.05) {
      // Band bulunamadı → sabit alt %22
      mrzCropY = Math.round(imgH * 0.78);
      mrzCropH = Math.round(imgH * 0.22);
    } else {
      var maxH = Math.round(imgH * 0.25);          // 40% → 25%
      mrzCropH = Math.min(p.cropH, maxH);
      mrzCropY = p.cropY;
      var minY = Math.round(imgH * 0.50);          // Alt yarıda zorla
      if (mrzCropY < minY) {
        mrzCropY = minY;
        mrzCropH = Math.min(mrzCropH, imgH - mrzCropY);
      }
    }
    try { mrzCrop = visionCropRegion(best.rotated, mrzCropY, mrzCropH); } catch(e) {}
  }

  var t2 = performance.now();

  return {
    images: {
      original:     srcCanvas,       // yüklenen orijinal — döndürülmemiş
      documentWarp: best.warpCanvas, // döndürülüp perspective düzeltilmiş belge
      mrzCrop:      mrzCrop          // MRZ strip: warp'tan bilinen konumdan, veya density-detected
    },
    meta: {
      detectedRotation:    best.deg,          // kept for backwards compatibility
      ocrUsableRotation:   ocrUsableRotation, // rotation selected for best OCR quality
      canonicalRotation:   canonicalRotation, // visual rotation (may add +flip suffix)
      isVisuallyUpright:   isVisuallyUpright, // true when warp MRZ confirmed at bottom after normalization
      warpFlipped:         warpFlipped,       // true when any post-warp rotation was applied
      warpNormDeg:         warpNormDeg,       // additional rotation applied to warp (0/90/180/270)
      mrzFound:            best.effectiveScore > 0,
      sourceUsedForMrz:    useWarp ? 'warp' : 'original',
      selectedWhy:         selectedWhy,
      selectionReason:     selectionReason,
      selectedScore:       best.effectiveScore,
      selectedRegionScore: useWarp
                             ? (best.warpPresence ? best.warpPresence.score : null)
                             : best.origPresence.score,
      selectedRegionLines: useWarp
                             ? (best.warpPresence && best.warpPresence.lines != null ? best.warpPresence.lines : null)
                             : (best.origPresence.lines != null ? best.origPresence.lines : null),
      origScore:           best.origScore,
      warpScore:           best.warpScore,
      rotationScores:      rotationScores,
      mrzOrigRegions:      { y: best.origPresence.cropY, h: best.origPresence.cropH, score: best.origScore },
      mrzWarpRegions:      best.warpPresence
                             ? { y: best.warpPresence.cropY, h: best.warpPresence.cropH, score: best.warpScore }
                             : null,
      mrzBox:              { y: mrzCropY, h: mrzCropH },
      docType:             best.docType,
      quadFound:           !!best.quad,
      quadQuality:         best.quadQuality || null,
      frameMode:           frameMode,
      borderBrightness:    borderBrightness,
      srcIsLandscape:      srcIsLandscape,
      warpSelectedByThreshold: warpSelectedByThreshold,
      analyzeMs:           Math.round(t1 - t0),
      cropMs:              Math.round(t2 - t1),
      totalMs:             Math.round(t2 - t0)
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
  var warpLabel = 'Document Warp' + (m.detectedRotation > 0 ? ' (rot ' + m.detectedRotation + '\u00b0)' : '');
  imgRow.appendChild(makeSlot('Original',       vd.images.original));
  imgRow.appendChild(makeSlot(warpLabel,        vd.images.documentWarp));
  imgRow.appendChild(makeSlot('MRZ Crop (' + m.sourceUsedForMrz + ')', vd.images.mrzCrop));
  panel.appendChild(imgRow);

  // Meta row
  var metaDiv = document.createElement('div');
  metaDiv.className = 'vision-meta';

  var origR = m.mrzOrigRegions;
  var warpR = m.mrzWarpRegions;

  // Compact per-rotation summary: "➤90°:T1:125.9■ | 0°:T3:50.5 | 270°:T1:110.7■ | 180°:T3:47.2"
  var rotSummary = '';
  if (m.rotationScores && m.rotationScores.length) {
    rotSummary = m.rotationScores.map(function(r) {
      var label = r.deg + '\u00b0:T' + (r.tier || '?') + ':' + r.effectiveScore.toFixed(1);
      if (r.deg === m.detectedRotation) label = '\u27a4' + label;
      if (r.quadFound)                  label += '\u25a0';
      return label;
    }).join(' \u2502 ');
  }

  var fields = [
    // ── selection summary ──
    ['detectedRotation', m.detectedRotation + '\u00b0'],
    ['srcOrientation',   m.srcIsLandscape ? 'landscape' : 'portrait'],
    m.selectionReason ? ['selectionReason', m.selectionReason] : null,
    // ── scores ──
    ['origScore',        m.origScore !== undefined ? m.origScore.toFixed(3) : '\u2014'],
    ['warpScore',        m.warpScore  > 0          ? m.warpScore.toFixed(3)  : '\u2014'],
    ['selectedScore',    m.selectedScore !== undefined ? m.selectedScore.toFixed(3) : '\u2014'],
    m.selectedRegionScore != null
      ? ['selectedRegionScore', m.selectedRegionScore.toFixed(3)] : null,
    m.selectedRegionLines != null
      ? ['selectedRegionLines', String(m.selectedRegionLines)] : null,
    // ── all rotations ──
    rotSummary ? ['rotations', rotSummary] : null,
    // ── source / region ──
    ['source',           m.sourceUsedForMrz],
    ['quadFound',        m.quadFound ? '\u2705' : '\u274c'],
    m.docType ? ['docType', m.docType] : null,
    m.mrzBox  ? ['mrzBox',  'y=' + m.mrzBox.y + ' h=' + m.mrzBox.h] : null,
    origR ? ['origRegion', 'score=' + origR.score.toFixed(3) + ' y=' + origR.y + ' h=' + origR.h] : null,
    warpR ? ['warpRegion', 'score=' + warpR.score.toFixed(3) + ' y=' + warpR.y + ' h=' + warpR.h] : null,
    // ── timing ──
    ['mrzFound',         m.mrzFound ? '\u2705 evet' : '\u274c hay\u0131r'],
    ['analyzeMs',        m.analyzeMs + 'ms'],
    ['totalMs',          m.totalMs   + 'ms'],
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
