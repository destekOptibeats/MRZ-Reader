// mrz-core.js
// DOM referansı yok — window, document, video, canvas erişimi yok

(function() {
  // ── CHECKSUM ──────────────────────────────────────────────────────────
  const CW = [7,3,1];
  function cv(c) { if(c==='<')return 0; if(c>='0'&&c<='9')return+c; return c.charCodeAt(0)-55; }
  function chk(s) { return [...s].reduce((a,c,i) => a+cv(c)*CW[i%3], 0) % 10; }

  // ── CLEAN ─────────────────────────────────────────────────────────────
  function cleanLine(t) { return t.toUpperCase().replace(/[^A-Z0-9<]/g, ''); }
  function clean(t) {
    return t.toUpperCase()
      .split('\n')
      .map(l => l.replace(/[^A-Z0-9<]/g, ''))
      .join('\n');
  }

  // ── FIX LINE (satır tipi bilinçli) ────────────────────────────────────
  // kind: 'TD1_L1' | 'TD1_L2' | 'TD1_L3' | 'TD3_L1' | 'TD3_L2'
  function fixLine(s, { targetLen, kind }) {
    if (!s) return null;

    if (s.length > targetLen && s.length - targetLen <= 5) {
      // TD1_L3: pick position with most trailing '<' (best alignment)
      if (kind === 'TD1_L3') {
        let bestL3 = null, bestTrailing = -1;
        for (let skip = 0; skip <= s.length - targetLen; skip++) {
          const c = s.substring(skip, skip + targetLen);
          if (!c.includes('<<')) continue;
          const clean = /^[A-Z<]+$/.test(c);
          let trailing = 0;
          for (let t = c.length - 1; t >= 0 && c[t] === '<'; t--) trailing++;
          // Prefer clean (no digits), then most trailing '<'
          if (clean && trailing > bestTrailing) { bestTrailing = trailing; bestL3 = c; }
        }
        if (bestL3) return bestL3;
        // Relaxed: allow digits
        for (let skip = 0; skip <= s.length - targetLen; skip++) {
          const c = s.substring(skip, skip + targetLen);
          if (c.includes('<<')) return c;
        }
        return s.substring(0, targetLen);
      }

      for (let skip = 0; skip <= s.length - targetLen; skip++) {
        const c = s.substring(skip, skip + targetLen);
        if (kind === 'TD1_L1' && /^[IAC]/.test(c)) return applyDigitFixes(c, kind);
        if (kind === 'TD3_L1' && c[0] === 'P') return c;
        // L2: digit fix ÖNCE uygula, sonra validate (OCR S→5, O→0 gibi düzeltmeler)
        if (kind === 'TD1_L2') {
          const fixed = applyDigitFixes(c, kind);
          if (/^\d{6}/.test(fixed)) return fixed;
        }
        if (kind === 'TD3_L2') {
          const fixed = applyDigitFixes(c, kind);
          if (/^\d/.test(fixed)) return fixed;
        }
      }
      return applyDigitFixes(s.substring(0, targetLen), kind);
    }

    if (s.length === targetLen) return applyDigitFixes(s, kind);
    if (s.length === targetLen - 1) return null;
    return null;
  }

  function applyDigitFixes(s, kind) {
    // İsim satırlarında digit fix YOK
    if (kind === 'TD3_L1' || kind === 'TD1_L3') return s;

    const map = {'B':'8','O':'0','D':'0','S':'5','G':'6',
                 'Z':'2','I':'1','L':'1','Q':'0','U':'0'};
    const fix = c => map[c] ?? c;
    const a = s.split('');

    if (kind === 'TD1_L1') {
      a[14] = fix(a[14]);  // doc no check
      a[29] = fix(a[29]);  // composite check
    }

    if (kind === 'TD1_L2') {
      for (let i=0;i<=5;i++)  a[i] = fix(a[i]);   // DOB
      a[6]  = fix(a[6]);                            // DOB check
      for (let i=8;i<=13;i++) a[i] = fix(a[i]);    // EXP
      a[14] = fix(a[14]);                           // EXP check
      a[29] = fix(a[29]);                           // composite check
    }

    if (kind === 'TD3_L2') {
      for (let i=0;i<=8;i++)   a[i] = fix(a[i]);   // passport no
      a[9]  = fix(a[9]);                            // passport no check
      for (let i=13;i<=18;i++) a[i] = fix(a[i]);   // DOB
      a[19] = fix(a[19]);                           // DOB check
      for (let i=21;i<=26;i++) a[i] = fix(a[i]);   // EXP
      a[27] = fix(a[27]);                           // EXP check
      for (let i=28;i<=41;i++) a[i] = fix(a[i]);   // personal no
      a[42] = fix(a[42]);                           // personal no check
      a[43] = fix(a[43]);                           // composite check
    }

    return a.join('');
  }

  // ── TD3: Pasaport — 2 × 44 karakter ──────────────────────────────────
  function isL1_TD3(l) {
    return l && l.length===44 && l[0]==='P' && /^[A-Z<]{3}/.test(l.substring(1)) && /^[A-Z0-9<]{44}$/.test(l);
  }
  function isL2_TD3(l) {
    if (!l || l.length !== 44 || !/^[A-Z0-9<]{44}$/.test(l)) return false;
    const dob = l.substring(13,19), exp = l.substring(21,27);
    if (!/^\d{6}$/.test(dob) || !/^\d{6}$/.test(exp)) return false;
    const dobMM = +dob.substring(2,4), dobDD = +dob.substring(4,6);
    const expMM = +exp.substring(2,4), expDD = +exp.substring(4,6);
    if (dobMM < 1 || dobMM > 12 || dobDD < 1 || dobDD > 31) return false;
    if (expMM < 1 || expMM > 12 || expDD < 1 || expDD > 31) return false;
    return true;
  }

  // ── TD1: TC Kimlik / ID Kartı — 3 × 30 karakter ──────────────────────
  function isL1_TD1(l) {
    if (!l || l.length !== 30 || !/^[A-Z0-9<]{30}$/.test(l)) return false;
    return /^[IAC][A-Z<]/.test(l);
  }
  function isL2_TD1(l) {
    if (!l || l.length !== 30 || !/^[A-Z0-9<]{30}$/.test(l)) return false;
    if (!/^\d{6}/.test(l)) return false;
    if (!/^\d{6}$/.test(l.substring(8,14))) return false;
    const dobMM = +l.substring(2,4), dobDD = +l.substring(4,6);
    const expMM = +l.substring(10,12), expDD = +l.substring(12,14);
    if (dobMM < 1 || dobMM > 12 || dobDD < 1 || dobDD > 31) return false;
    if (expMM < 1 || expMM > 12 || expDD < 1 || expDD > 31) return false;
    return true;
  }
  function isL3_TD1(l) {
    return l && l.length===30 && /^[A-Z0-9<]{30}$/.test(l) && l.includes('<<');
  }

  // ── MRZ EXTRACTION — satır bazlı ─────────────────────────────────────
  function extractMRZ(rawOCR) {
    if (!rawOCR || rawOCR.length < 60) return null;

    const rawLines = rawOCR.split(/\n+/).map(l => l.trim()).filter(l => l.length > 10);
    const lines = rawLines.map(l => l.toUpperCase().replace(/[^A-Z0-9<]/g, ''));

    // Try TD1 (3×30)
    for (let i = 0; i < lines.length - 1; i++) {
      for (let j = i; j < Math.min(i+3, lines.length); j++) {
        const l1f = fixLine(lines[j], {targetLen:30, kind:'TD1_L1'});
        if (!l1f || !isL1_TD1(l1f)) continue;
        for (let k = j+1; k < Math.min(j+3, lines.length); k++) {
          const l2f = fixLine(lines[k], {targetLen:30, kind:'TD1_L2'});
          if (!l2f || !isL2_TD1(l2f)) continue;
          for (let m = k+1; m < Math.min(k+3, lines.length); m++) {
            const l3f = fixLine(lines[m], {targetLen:30, kind:'TD1_L3'});
            if (l3f && isL3_TD1(l3f))
              return { type:'TD1', lines:[l1f, l2f, l3f] };
          }
        }
      }
    }

    // Try TD3 (2×44)
    for (let i = 0; i < lines.length; i++) {
      const l1f = fixLine(lines[i], {targetLen:44, kind:'TD3_L1'});
      if (!l1f || !isL1_TD3(l1f)) continue;
      for (let j = i+1; j < Math.min(i+3, lines.length); j++) {
        const l2f = fixLine(lines[j], {targetLen:44, kind:'TD3_L2'});
        if (l2f && isL2_TD3(l2f))
          return { type:'TD3', lines:[l1f, l2f] };
      }
    }

    // Fallback: flat sliding window — TD3
    const flat = lines.join('');
    if (flat.length >= 88) {
      for (let i = 0; i <= flat.length - 88; i++) {
        const l1 = flat.substring(i, i+44);
        const l2 = fixLine(flat.substring(i+44, i+88), {targetLen:44, kind:'TD3_L2'});
        if (isL1_TD3(l1) && l2 && isL2_TD3(l2)) return { type:'TD3', lines:[l1, l2] };
      }
    }
    // Fallback: flat sliding window — TD1
    if (flat.length >= 90) {
      for (let i = 0; i <= flat.length - 90; i++) {
        const l1 = fixLine(flat.substring(i,i+30), {targetLen:30, kind:'TD1_L1'});
        const l2 = fixLine(flat.substring(i+30,i+60), {targetLen:30, kind:'TD1_L2'});
        const l3 = fixLine(flat.substring(i+60,i+90), {targetLen:30, kind:'TD1_L3'});
        if (l1 && isL1_TD1(l1) && l2 && isL2_TD1(l2) && l3 && isL3_TD1(l3))
          return { type:'TD1', lines:[l1,l2,l3] };
      }
    }

    return null;
  }

  // ── CHECKSUMS TD3 ─────────────────────────────────────────────────────
  function getChecksums_TD3(l2) {
    try {
      return {
        passOk: chk(l2.substring(0,9))  === +l2[9],
        dobOk:  chk(l2.substring(13,19))=== +l2[19],
        expOk:  chk(l2.substring(21,27))=== +l2[27],
        compOk: chk(l2.substring(0,10)+l2.substring(13,20)+l2.substring(21,43)) === +l2[43],
      };
    } catch { return {passOk:false,dobOk:false,expOk:false,compOk:false}; }
  }

  // ── PARSE RESULT ──────────────────────────────────────────────────────
  function parseResult(result) {
    if (result.type === 'TD1') return parseTD1(result.lines);
    return parseTD3(result.lines[0], result.lines[1]);
  }

  function cleanSurname(raw) {
    let s = raw;
    // Strip leading OCR garbage: everything up to and including last leading digit
    // e.g. "E2ALMALEH" → "ALMALEH", "2SMITH" → "SMITH"
    s = s.replace(/^[A-Z0-9]*\d/, '');
    while (s.length > 0 && /^[BJL]/.test(s)) s = s.substring(1);
    if (/^C[A-Z]{5,}/.test(s)) s = s.substring(1);
    return s.replace(/</g,' ').trim();
  }

  function parseTD3(l1, l2) {
    const namePart = l1.substring(5, 44);
    const dblIdx   = namePart.indexOf('<<');
    const surnameRaw = dblIdx >= 0 ? namePart.substring(0, dblIdx) : namePart;
    const givenRaw   = dblIdx >= 0 ? namePart.substring(dblIdx+2) : '';
    const cs = getChecksums_TD3(l2);
    return {
      docType: 'Pasaport',
      surname: cleanSurname(surnameRaw),
      given:   givenRaw.split('<<')[0].replace(/</g,' ').trim(),
      passNo:  l2.substring(0,9).replace(/</g,''),
      nation:  l2.substring(10,13).replace(/</g,''),
      issuer:  l1.substring(2,5).replace(/</g,''),
      dob:     l2.substring(13,19),
      sex:     l2[20],
      expiry:  l2.substring(21,27),
      cs,
    };
  }

  // ── TC KİMLİK NO VALIDATION ────────────────────────────────────────────
  function validateNationalId(id) {
    if (!id || id.length !== 11) return false;
    if (!/^\d{11}$/.test(id)) return false;
    if (id[0] === '0') return false;
    const d = id.split('').map(Number);
    // Rule 1: ((d1+d3+d5+d7+d9)*7 - (d2+d4+d6+d8)) % 10 === d10
    const r1 = ((d[0]+d[2]+d[4]+d[6]+d[8]) * 7 - (d[1]+d[3]+d[5]+d[7])) % 10;
    if ((r1 < 0 ? r1 + 10 : r1) !== d[9]) return false;
    // Rule 2: (d1+d2+...+d10) % 10 === d11
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += d[i];
    if (sum % 10 !== d[10]) return false;
    return true;
  }

  function parseTD1(lines) {
    const [l1, l2, l3] = lines;
    const namePart = l3 || '';
    const dblIdx   = namePart.indexOf('<<');
    const surnameRaw = dblIdx >= 0 ? namePart.substring(0, dblIdx) : namePart;
    const givenRaw   = dblIdx >= 0 ? namePart.substring(dblIdx+2) : '';
    const dob    = l2.substring(0,6);
    const expiry = l2.substring(8,14);
    // TC Kimlik No: line1 positions 15 onward (11 digits after stripping fillers)
    const rawNatId = l1.substring(15).replace(/</g,'').replace(/\s/g,'').replace(/[^0-9]/g,'');
    const nationalId = rawNatId.length === 11 ? rawNatId : null;
    return {
      docType: 'TC Kimlik',
      surname: cleanSurname(surnameRaw),
      given:   givenRaw.split('<<')[0].replace(/</g,' ').trim(),
      passNo:  l1.substring(5,14).replace(/</g,''),
      nation:  l2.substring(15,18).replace(/</g,''),
      issuer:  l1.substring(2,5).replace(/</g,''),
      dob,
      sex:     l2[7],
      expiry,
      nationalId,
      nationalIdValid: nationalId ? validateNationalId(nationalId) : false,
      cs: {
        passOk: chk(l1.substring(5,14)) === +l1[14],
        dobOk:  chk(dob) === +l2[6],
        expOk:  chk(expiry) === +l2[14],
        compOk: null,
      },
    };
  }

  // ── VALIDATE MRZ ──────────────────────────────────────────────────────
  function validateMRZ(result) {
    if (!result || !result.lines || !result.lines[1]) {
      return { valid: false, errors: ['MRZ satırları bulunamadı'], checksums: {} };
    }
    const errors = [];
    let cs;
    if (result.type === 'TD1') {
      const l1 = result.lines[0], l2 = result.lines[1];
      cs = {
        passOk: chk(l1.substring(5,14)) === +l1[14],
        dobOk:  chk(l2.substring(0,6))  === +l2[6],
        expOk:  chk(l2.substring(8,14)) === +l2[14],
        passExpected: chk(l1.substring(5,14)), passFound: +l1[14],
        dobExpected:  chk(l2.substring(0,6)),  dobFound:  +l2[6],
        expExpected:  chk(l2.substring(8,14)), expFound:  +l2[14],
      };
    } else {
      const l2 = result.lines[1];
      const raw = getChecksums_TD3(l2);
      cs = {
        ...raw,
        passExpected: chk(l2.substring(0,9)),   passFound: +l2[9],
        dobExpected:  chk(l2.substring(13,19)), dobFound:  +l2[19],
        expExpected:  chk(l2.substring(21,27)), expFound:  +l2[27],
      };
    }
    if (!cs.passOk) errors.push('Pasaport/Belge No checksum hatası (beklenen: ' + cs.passExpected + ', bulunan: ' + cs.passFound + ')');
    if (!cs.dobOk)  errors.push('Doğum tarihi checksum hatası (beklenen: ' + cs.dobExpected + ', bulunan: ' + cs.dobFound + ')');
    if (!cs.expOk)  errors.push('Geçerlilik tarihi checksum hatası (beklenen: ' + cs.expExpected + ', bulunan: ' + cs.expFound + ')');
    const valid = cs.passOk || (cs.dobOk && cs.expOk);
    return { valid, errors, checksums: cs };
  }

  // ── DIAGNOSE MRZ ─────────────────────────────────────────────────────
  function diagnoseMRZ(rawText) {
    const failureReasons = [];
    if (!rawText || rawText.trim().length < 20) {
      failureReasons.push('OCR çıktısı çok kısa veya boş');
      return { rawText: rawText || '', cleaned: '', extracted: null, checksums: {}, parseResult: null, failureReasons };
    }
    const cleaned = clean(rawText);
    const extracted = extractMRZ(cleaned);
    if (!extracted) {
      failureReasons.push('MRZ pattern bulunamadı');
      const lines = cleaned.split(/\n+/).filter(l => l.length > 10);
      if (lines.length < 2) failureReasons.push('Yeterli uzunlukta satır yok (en az 2 satır gerekli)');
      lines.forEach((l, i) => {
        if (l.length < 28) failureReasons.push('Satır ' + (i+1) + ': çok kısa (' + l.length + ' karakter)');
      });
      return { rawText, cleaned, extracted: null, checksums: {}, parseResult: null, failureReasons };
    }
    const validation = validateMRZ(extracted);
    const parsed = parseResult(extracted);
    if (!validation.valid) {
      failureReasons.push(...validation.errors);
    }
    return {
      rawText,
      cleaned,
      extracted,
      checksums: validation.checksums,
      parseResult: parsed,
      failureReasons
    };
  }

  // ── MRZ NAME PARSE (doğrudan MRZ satırından) ──────────────────────────
  // TD1: name line = L3 (index 2), TD3: name line = L1 (index 0)
  // Digit-fix uygulanmaz, '<' ayırıcı/padding olarak işlenir
  function parseMRZName(result) {
    if (!result || !result.lines) return { surname: '', given: '' };
    let nameLine;
    if (result.type === 'TD1') {
      nameLine = result.lines[2] || '';
    } else {
      // TD3: L1 — ilk 5 karakter tip/ülke, geri kalanı isim
      nameLine = (result.lines[0] || '').substring(5);
    }
    const dblIdx = nameLine.indexOf('<<');
    const surnameRaw = dblIdx >= 0 ? nameLine.substring(0, dblIdx) : nameLine;
    const givenRaw   = dblIdx >= 0 ? nameLine.substring(dblIdx + 2) : '';
    return {
      surname: surnameRaw.replace(/</g, ' ').trim(),
      given:   givenRaw.split('<<')[0].replace(/</g, ' ').trim(),
    };
  }

  // ── EXPORT ────────────────────────────────────────────────────────────
  window.MRZCore = {
    chk, clean, cleanLine, fixLine, applyDigitFixes,
    isL1_TD1, isL2_TD1, isL3_TD1, isL1_TD3, isL2_TD3,
    extractMRZ, getChecksums_TD3, parseResult, parseMRZName,
    validateMRZ, diagnoseMRZ, validateNationalId
  };
})();
