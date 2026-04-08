// ── OVERLAY ─────────────────────────────────────────────────────────────

// Sync canvas drawing resolution to container — always update, no shrink guard
function resizeOverlay() {
  const wrap = document.getElementById('video-wrap');
  const w = wrap.offsetWidth;
  const h = wrap.offsetHeight;
  if (w < 50 || h < 50) return; // reject truly invalid
  // Only update if size actually changed (avoid unnecessary canvas clear)
  if (camOvl.width !== w || camOvl.height !== h) {
    camOvl.width  = w;
    camOvl.height = h;
  }
}

// Calculate where the video actually displays inside the container.
// Handles both object-fit:contain (letterbox) and object-fit:cover (fill+clip).
// Cover mode is active on portrait mobile via CSS media query.
function getVideoDisplayRect() {
  const wrap = document.getElementById('video-wrap');
  const cw = wrap.offsetWidth, ch = wrap.offsetHeight;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!cw || !ch || !vw || !vh) return null;

  // Detect cover mode: tüm mobil cihazlar (portre + yatay)
  // Math.min(w,h) ≤ 768 → kısa kenar bazlı mobil tespiti, her iki yönde çalışır
  const isCover = Math.min(window.innerWidth, window.innerHeight) <= 768;

  let dw, dh, dx, dy;
  if (isCover) {
    // object-fit:cover — scale so video fills container entirely (may clip sides or top/bottom)
    const scale = Math.max(cw / vw, ch / vh);
    dw = vw * scale;
    dh = vh * scale;
    dx = (cw - dw) / 2;
    dy = (ch - dh) / 2;
  } else {
    const containerAR = cw / ch;
    const videoAR = vw / vh;
    if (videoAR > containerAR) {
      // Video wider than container → letterbox top/bottom
      dw = cw;
      dh = cw / videoAR;
      dx = 0;
      dy = (ch - dh) / 2;
    } else {
      // Video taller than container → letterbox left/right
      dh = ch;
      dw = ch * videoAR;
      dx = (cw - dw) / 2;
      dy = 0;
    }
  }
  return { dx, dy, dw, dh, sx: dw / vw, sy: dh / vh };
}

function drawCorners(x, y, w, h, color, size, lineW) {
  lineW = lineW || 3;
  [[x,y,1,1],[x+w,y,-1,1],[x,y+h,1,-1],[x+w,y+h,-1,-1]].forEach(([cx,cy,ox,oy]) => {
    camCtx.beginPath();
    camCtx.strokeStyle = color;
    camCtx.lineWidth = lineW;
    camCtx.moveTo(cx+ox*size, cy);
    camCtx.lineTo(cx, cy);
    camCtx.lineTo(cx, cy+oy*size);
    camCtx.stroke();
  });
}

function drawOverlayState(state) {
  const colors = {
    searching:  '#3b82f6',
    found:      '#f59e0b',
    confirming: '#f59e0b',
    accepted:   '#10b981',
    blurry:     '#ef4444',
  };
  const hints = {
    searching:  '📏 MRZ satırlarını çerçeveye hizalayın',
    found:      '✋ Sabit tutun…',
    confirming: '✓ Sabit tutun...',
    accepted:   '✅ Okundu!',
    blurry:     '✋ Sabit tutun',
  };

  // Always sync canvas to current container size for responsive behavior
  resizeOverlay();
  const ovlW = camOvl.width, ovlH = camOvl.height;
  if (!ovlW || !ovlH || !video.videoWidth || !video.videoHeight) return;

  const vdr = getVideoDisplayRect();
  if (!vdr) return;

  // Dark overlay over entire canvas
  camCtx.clearRect(0, 0, ovlW, ovlH);
  camCtx.fillStyle = 'rgba(0,0,0,0.50)';
  camCtx.fillRect(0, 0, ovlW, ovlH);

  // MRZ band — mapped from video pixel space to display space via letterbox offset
  const band = getMRZBand(video.videoWidth, video.videoHeight);
  const bx = vdr.dx + band.x * vdr.sx;
  const by = vdr.dy + band.y * vdr.sy;
  const bw = band.w * vdr.sx;
  const bh = band.h * vdr.sy;

  const color = colors[state] || colors.searching;

  // Clear MRZ region (transparent window)
  camCtx.clearRect(bx, by, bw, bh);

  // Frame border
  const lineW = state === 'accepted' ? 3 : 2;
  camCtx.strokeStyle = color;
  camCtx.lineWidth = lineW;
  camCtx.strokeRect(bx, by, bw, bh);

  // Corner marks
  const cornerW = state === 'accepted' ? 5 : 3;
  const cornerSize = state === 'accepted' ? 22 : 16;
  drawCorners(bx, by, bw, bh, color, cornerSize, cornerW);

  // Accepted pulse
  if (state === 'accepted') {
    camCtx.strokeStyle = color + '55';
    camCtx.lineWidth = 1.5;
    camCtx.strokeRect(bx - 3, by - 3, bw + 6, bh + 6);
  }

  // "MRZ ALANI" label — ABOVE the frame, not inside
  const labelFontSize = Math.max(9, Math.round(bw * 0.032));
  camCtx.font = '600 ' + labelFontSize + 'px -apple-system, sans-serif';
  camCtx.textAlign = 'center';
  camCtx.textBaseline = 'bottom';
  const labelText = 'MRZ ALANI';
  const lw = camCtx.measureText(labelText).width + 14;
  const lh = labelFontSize + 8;
  const lx = bx + bw / 2 - lw / 2;
  const ly = by - 6;
  camCtx.fillStyle = 'rgba(0,0,0,0.65)';
  camCtx.beginPath();
  camCtx.roundRect(lx, ly - lh, lw, lh, 4);
  camCtx.fill();
  camCtx.fillStyle = color;
  camCtx.fillText(labelText, bx + bw / 2, ly - 3);

  // Hint
  const hintType = state === 'accepted' ? 'ok' : state === 'searching' ? '' : 'warn';
  setHint(hints[state] || hints.searching, hintType);
}
