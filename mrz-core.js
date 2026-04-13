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

  // ── TD1_L2 EXPIRY RESCUE ──────────────────────────────────────────────
  // Attempts to correct a garbled expiry date (positions 8–13) in a 30-char
  // TD1_L2 string using OCR confusion substitutions. Validates each candidate
  // against the expiry check digit (pos 14). Returns corrected string iff
  // exactly ONE candidate produces valid MM/DD AND matches expiry CD.
  // Called only when DOB is valid but expiry is invalid. Never touches DOB,
  // nationality, or optional fields. TD3 excluded.
  function rescueL2Expiry(s30) {
    if (!s30 || s30.length !== 30) return null;
    const expRaw = s30.substring(8, 14);
    if (!/^\d{6}$/.test(expRaw)) return null;       // expiry must be digits
    const rawMM = +expRaw.slice(2, 4), rawDD = +expRaw.slice(4, 6);
    if (rawMM >= 1 && rawMM <= 12 && rawDD >= 1 && rawDD <= 31) return null; // already valid
    const dobMM = +s30.slice(2, 4), dobDD = +s30.slice(4, 6);
    if (dobMM < 1 || dobMM > 12 || dobDD < 1 || dobDD > 31) return null;    // DOB invalid — no rescue
    const expCD = +s30[14];  // expiry check digit (reference for candidate validation)

    // OCR confusion map: what could each OCR-read character really be?
    // User-specified: O↔0, I↔1, L↔1, Z↔2, S↔5, B↔8, G↔6, Q↔0
    // Added: 7↔1 — OCR-B font: digit 1 commonly misread as 7 (critical for img_1914)
    const CONF = { '7':'1','1':'7','O':'0','Q':'0','G':'0','I':'1','L':'1','Z':'2','S':'5','B':'8' };
    function alts(ch) {
      const r = new Set([ch]);
      if (CONF[ch]) for (const c of CONF[ch]) r.add(c);
      return [...r];
    }

    const ec = expRaw.split('');
    const valid = new Set();

    // ── 1-char corrections ────────────────────────────────────────────────
    for (let i = 0; i < 6; i++) {
      for (const alt of alts(ec[i])) {
        if (alt === ec[i]) continue;
        const t = ec.slice(); t[i] = alt;
        const s = t.join('');
        if (!/^\d{6}$/.test(s)) continue;
        const mm = +s.slice(2,4), dd = +s.slice(4,6);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
        if (chk(s) !== expCD) continue;   // check digit must match
        valid.add(s);
      }
    }
    // ── 2-char corrections (only if single-char produced no unique match) ─
    if (valid.size !== 1) {
      valid.clear();
      for (let i = 0; i < 6; i++) for (const altI of alts(ec[i])) {
        if (altI === ec[i]) continue;
        for (let j = i+1; j < 6; j++) for (const altJ of alts(ec[j])) {
          if (altJ === ec[j]) continue;
          const t = ec.slice(); t[i] = altI; t[j] = altJ;
          const s = t.join('');
          if (!/^\d{6}$/.test(s)) continue;
          const mm = +s.slice(2,4), dd = +s.slice(4,6);
          if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
          if (chk(s) !== expCD) continue;
          valid.add(s);
        }
      }
    }

    if (valid.size !== 1) return null;   // ambiguous or no fix — preserve original behaviour
    const fixedExp = [...valid][0];
    const arr = s30.split('');
    for (let i = 0; i < 6; i++) arr[8+i] = fixedExp[i];
    return arr.join('');   // pos14 (expiry CD) left as-is; correctCheckDigits recomputes if needed
  }

  // ── FIX LINE (satır tipi bilinçli) ────────────────────────────────────
  // kind: 'TD1_L1' | 'TD1_L2' | 'TD1_L3' | 'TD3_L1' | 'TD3_L2'
  function fixLine(s, { targetLen, kind }) {
    if (!s) return null;

    // ── TD1 over-read trim: +1..+6 chars, full validator gating ──────────
    // Generates all targetLen-length substrings from the over-read string,
    // applies fixes, validates with the relevant TD1 isL*_TD1 function.
    // Returns first (earliest, least trim) valid candidate; falls through
    // to existing logic if no valid candidate found.
    // TD3 intentionally excluded — separate handling below.
    if (s.length > targetLen && s.length <= targetLen + 6 &&
        (kind === 'TD1_L1' || kind === 'TD1_L2' || kind === 'TD1_L3')) {
      const overValid = [];
      for (let skip = 0; skip <= s.length - targetLen; skip++) {
        const c = s.substring(skip, skip + targetLen);
        const f = (kind === 'TD1_L3') ? applyNameFixes(c, kind) : applyDigitFixes(c, kind);
        if (kind === 'TD1_L1' && isL1_TD1(f)) overValid.push(f);
        if (kind === 'TD1_L2') {
          if (isL2_TD1(f)) overValid.push(f);
          else { const r = rescueL2Expiry(f); if (r && isL2_TD1(r)) overValid.push(r); }
        }
        if (kind === 'TD1_L3' && isL3_TD1(f)) overValid.push(f);
      }
      if (overValid.length >= 1) return overValid[0]; // earliest valid wins
      // else: fall through to existing logic
    }

    if (s.length > targetLen && s.length - targetLen <= 15) {
      // TD1_L3: two strategies based on leading char of OCR line
      //   s[0] !== '<' → padding extends at the END  → minimum skip (first valid non-<-starting)
      //   s[0] === '<' → garbage prefix at the START → most-trailing-< among non-<-starting
      // Both exclude candidates starting with '<' (real surnames never start with filler)
      if (kind === 'TD1_L3') {
        let bestL3 = null, bestTrailing = -1;
        const leadingGarbage = s[0] === '<';
        for (let skip = 0; skip <= s.length - targetLen; skip++) {
          const c = s.substring(skip, skip + targetLen);
          if (!c.includes('<<') || c.length < 25) continue;
          if (!/^[A-Z<]+$/.test(c)) continue;   // must be clean
          if (c[0] === '<') continue;             // surname must start with a letter
          if (!leadingGarbage) {
            // Strategy A: minimum skip — first valid candidate wins
            bestL3 = c; break;
          } else {
            // Strategy B: most trailing '<' — scan all, keep best
            let trailing = 0;
            for (let t = c.length - 1; t >= 0 && c[t] === '<'; t--) trailing++;
            if (trailing > bestTrailing) { bestTrailing = trailing; bestL3 = c; }
          }
        }
        if (bestL3) return applyNameFixes(bestL3, kind);
        // Relaxed: allow digits → convert to letters
        for (let skip = 0; skip <= s.length - targetLen; skip++) {
          const c = s.substring(skip, skip + targetLen);
          if (c.includes('<<')) return applyNameFixes(c, kind);
        }
        return applyNameFixes(s.substring(0, targetLen), kind);
      }

      for (let skip = 0; skip <= s.length - targetLen; skip++) {
        const c = s.substring(skip, skip + targetLen);
        if (kind === 'TD1_L1' && /^[IAC]/.test(c)) return applyDigitFixes(c, kind);
        if (kind === 'TD3_L1' && c[0] === 'P') return applyNameFixes(c, kind);
        // L2: digit fix ÖNCE uygula, sonra validate (OCR S→5, O→0 gibi düzeltmeler)
        if (kind === 'TD1_L2') {
          const fixed = applyDigitFixes(c, kind);
          if (/^\d{6}/.test(fixed)) {
            const mm = +fixed.slice(2, 4), dd = +fixed.slice(4, 6);
            if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return fixed;
            // Invalid date (e.g. MM=79) — continue loop to try next skip offset
          }
        }
        if (kind === 'TD3_L2') {
          const fixed = applyDigitFixes(c, kind);
          if (/^\d/.test(fixed)) return fixed;
        }
      }
      return applyDigitFixes(s.substring(0, targetLen), kind);
    }

    if (s.length === targetLen) return applyDigitFixes(s, kind);

    // 1-char-short: pad and try — OCR occasionally drops the last character
    // Name lines: pad with '<' (trailing filler in ICAO format)
    // Data lines: pad with '0' (placeholder — correctCheckDigits will recompute check digit)
    if (s.length === targetLen - 1) {
      if (kind === 'TD3_L1' || kind === 'TD1_L3') return applyNameFixes(s + '<', kind);
      if (kind === 'TD3_L2' || kind === 'TD1_L2' || kind === 'TD1_L1') {
        return applyDigitFixes(s + '0', kind);
      }
    }

    // 1-char-long trim for TD1 only (TD3 untouched)
    // Handles OCR adding one extra character at line start or end.
    // Two candidates tried; accepted only if exactly ONE passes structural validation —
    // ambiguous (both valid) or unresolvable (neither valid) cases fall through to null.
    if (s.length === targetLen + 1 &&
        (kind === 'TD1_L1' || kind === 'TD1_L2' || kind === 'TD1_L3')) {
      const trimCandidates = [
        s.substring(0, targetLen),      // trim last char
        s.substring(1, targetLen + 1),  // trim first char
      ];
      const valid = [];
      for (const c of trimCandidates) {
        const f = applyDigitFixes(c, kind);
        if (kind === 'TD1_L1' &&
            /^[IAC][A-Z<]/.test(f) && /^[A-Z0-9<]{30}$/.test(f))
          valid.push(f);
        if (kind === 'TD1_L2' &&
            /^\d{6}/.test(f) && /^\d{6}$/.test(f.substring(8, 14))) {
          const mm = +f.slice(2, 4), dd = +f.slice(4, 6), em = +f.slice(10, 12);
          if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && em >= 1 && em <= 12)
            valid.push(f);
        }
        if (kind === 'TD1_L3' &&
            f.includes('<<') && /^[A-Z]/.test(f) && /^[A-Z0-9<]{30}$/.test(f))
          valid.push(f);
      }
      if (valid.length === 1) return valid[0];
      // 0 valid → fall through to null; 2 valid (ambiguous) → fall through to null
    }

    return null;
  }

  // İsim satırlarında rakam→harf düzeltme (bulanık OCR'da 0→O, 8→B gibi)
  const nameCharMap = {'0':'O','8':'B','5':'S','6':'G','1':'I','2':'Z','3':'B','4':'A','9':'P'};
  function applyNameFixes(s, kind) {
    const a = s.split('');
    // TD3_L1: skip positions 0-4 (P + type + issuer), fix only name part (5+)
    // TD1_L3: entire line is name, fix all positions
    const startPos = kind === 'TD3_L1' ? 5 : 0;
    for (let i = startPos; i < a.length; i++) {
      if (a[i] !== '<' && nameCharMap[a[i]]) a[i] = nameCharMap[a[i]];
    }
    return a.join('');
  }

  function applyDigitFixes(s, kind) {
    // İsim satırlarında rakam→harf düzeltme uygula
    if (kind === 'TD3_L1' || kind === 'TD1_L3') return applyNameFixes(s, kind);

    // Full map — positions that MUST be digits (check digits, DOB, EXP)
    const digitMap = {'B':'8','O':'0','D':'0','S':'5','G':'6',
                      'Z':'2','I':'1','L':'1','Q':'0','U':'0'};
    // Restricted map — alphanumeric positions (doc number, personal no)
    // Only fix letters visually identical to digits in OCR-B font
    const alphaMap = {'O':'0','I':'1','L':'1','Q':'0'};
    const fixD = c => digitMap[c] ?? c;
    const fixA = c => alphaMap[c] ?? c;
    const a = s.split('');

    if (kind === 'TD1_L1') {
      // positions 5–13: doc no — alphanumeric (D is a valid letter)
      for (let i=5;i<=13;i++) a[i] = fixA(a[i]);
      a[14] = fixD(a[14]);  // doc no check — must be digit
      a[29] = fixD(a[29]);  // composite check — must be digit
    }

    if (kind === 'TD1_L2') {
      for (let i=0;i<=5;i++)  a[i] = fixD(a[i]);   // DOB — all digits
      a[6]  = fixD(a[6]);                            // DOB check
      for (let i=8;i<=13;i++) a[i] = fixD(a[i]);    // EXP — all digits
      a[14] = fixD(a[14]);                           // EXP check
      a[29] = fixD(a[29]);                           // composite check
    }

    if (kind === 'TD3_L2') {
      for (let i=0;i<=8;i++)   a[i] = fixA(a[i]);  // passport no — alphanumeric
      a[9]  = fixD(a[9]);                            // passport no check
      for (let i=13;i<=18;i++) a[i] = fixD(a[i]);  // DOB — all digits
      a[19] = fixD(a[19]);                           // DOB check
      for (let i=21;i<=26;i++) a[i] = fixD(a[i]);  // EXP — all digits
      a[27] = fixD(a[27]);                           // EXP check
      for (let i=28;i<=41;i++) a[i] = fixA(a[i]);  // personal no — alphanumeric
      a[42] = fixD(a[42]);                           // personal no check
      a[43] = fixD(a[43]);                           // composite check
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
    // Fallback: pattern-based TD3 sliding window — variable L1/L2 lengths (43–45)
    // Handles OCR that drops 1–2 trailing chars per line (longestLine = 43 instead of 44).
    // rawFlat strips ALL non-MRZ chars so adjacent OCR lines are found as one flat string.
    // Guards: P< prefix check, chevron density on each candidate, isL1_TD3/isL2_TD3, max 100 P< hits.
    const rawFlat = rawOCR.toUpperCase().replace(/[^A-Z0-9<]/g, '');
    let pHits = 0;
    for (let i = 0; i <= rawFlat.length - 86 && pHits < 100; i++) {
      if (rawFlat[i] !== 'P' || rawFlat[i + 1] !== '<') continue;  // fast reject
      pHits++;
      for (let l1len = 43; l1len <= 45 && i + l1len <= rawFlat.length; l1len++) {
        const l1raw = rawFlat.substring(i, i + l1len);
        if ((l1raw.match(/</g) || []).length < 5) continue;  // chevron density guard
        const l1f = fixLine(l1raw, { targetLen: 44, kind: 'TD3_L1' });
        if (!l1f || !isL1_TD3(l1f)) continue;
        for (let l2len = 43; l2len <= 45 && i + l1len + l2len <= rawFlat.length; l2len++) {
          const l2raw = rawFlat.substring(i + l1len, i + l1len + l2len);
          // No chevron guard on L2 — personal number may be fully alphanumeric (no <)
          // isL2_TD3 (DOB + EXP digit format validation) is sufficient guard
          const l2f = fixLine(l2raw, { targetLen: 44, kind: 'TD3_L2' });
          if (l2f && isL2_TD3(l2f)) return { type: 'TD3', lines: [l1f, l2f] };
        }
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
    // Rule-based tier: passOk is a hard prerequisite gate
    // additionalSignals = count of {dobOk, expOk, compOk} that are true
    // >= 2 → STRONG (accept on 2 consistent reads)
    // == 1 → VALID  (accept on 3 consistent reads)
    // == 0 → REJECT (even if passOk, not enough corroboration)
    const additionalSignals = [cs.dobOk, cs.expOk, cs.compOk].filter(Boolean).length;
    let level, valid, strong;
    if (!cs.passOk) {
      level = 'reject'; valid = false; strong = false;
    } else if (additionalSignals >= 2) {
      level = 'strong'; valid = true; strong = true;
    } else if (additionalSignals === 1) {
      level = 'valid'; valid = true; strong = false;
    } else {
      level = 'reject'; valid = false; strong = false;
    }
    // score field kept for backward compatibility and debug logging
    const score =
      (cs.passOk ? 40 : 0) +
      (cs.dobOk  ? 30 : 0) +
      (cs.expOk  ? 20 : 0) +
      (cs.compOk ? 10 : 0);
    return { valid, strong, level, score, errors, checksums: cs };
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

  // ── CHECK-DIGIT-GUIDED DOC NUMBER RESCUE ─────────────────────────────
  // When the OCR-read doc check digit does NOT match chk(docNo), the check
  // may be correct for the REAL character while the doc no char is mis-read.
  // Try single-char substitutions from the OCR-B confusion set and accept
  // only if exactly 1 unique substitution satisfies the original check.
  // Conservative set — excludes pairs already handled by alphaMap (O/I/L/Q)
  // and excludes D↔0 which creates ambiguity on typical doc numbers.
  const DOC_CONFUSION = {
    'K': ['X'], 'X': ['K'],
    'F': ['E'], 'E': ['F'],
    'B': ['8'], '8': ['B'],
  };
  function tryDocNoRescue(docNo, origCheck) {
    if (chk(docNo) === origCheck) return null;  // already consistent — no rescue needed
    const candidates = [];
    for (let pos = 0; pos < docNo.length; pos++) {
      const alts = DOC_CONFUSION[docNo[pos]];
      if (!alts) continue;
      for (const alt of alts) {
        const modified = docNo.substring(0, pos) + alt + docNo.substring(pos + 1);
        if (chk(modified) === origCheck) candidates.push(modified);
      }
    }
    const unique = [...new Set(candidates)];
    return unique.length === 1 ? unique[0] : null;  // only accept unambiguous rescue
  }

  // ── CHECK DIGIT AUTO-CORRECTION ──────────────────────────────────────
  // Rescue layer: after extractMRZ finds structure but validateMRZ fails,
  // compute the deterministic expected check digit from each field and substitute.
  // Safe: if data chars are correct but check digits are wrong OCR reads → PASS.
  // If data chars are also wrong → corrected check passes internally but
  // compareCase mrz_expected comparison catches it → FAIL with diffs.
  function correctCheckDigits(type, lines) {
    const [l1, l2, l3] = lines;
    if (type === 'TD3') {
      const a = l2.split('');
      // Doc number rescue: try before recomputing check —
      // if OCR misread one char but got the check right (for the REAL char),
      // we can recover the original character.
      const rescuedDocNo = tryDocNoRescue(l2.substring(0, 9), +l2[9]);
      if (rescuedDocNo) {
        for (let i = 0; i < 9; i++) a[i] = rescuedDocNo[i];
        // a[9] stays as l2[9] — original check is correct for rescued doc no
      } else {
        a[9] = String(chk(l2.substring(0, 9)));                   // docNo check (normal path)
      }
      a[19] = String(chk(l2.substring(13, 19)));                  // dob check
      a[27] = String(chk(l2.substring(21, 27)));                  // exp check
      // composite must use CORRECTED values (a[] not l2) so that a fixed docNo check
      // is included in the composite, not the original OCR garbage value
      const ac = a.join('');
      a[43] = String(chk(ac.substring(0, 10) + ac.substring(13, 20) + ac.substring(21, 43)));
      return [l1, a.join('')];
    }
    if (type === 'TD1') {
      const a1 = l1.split(''), a2 = l2.split('');
      // Doc number rescue for TD1 (doc no is L1[5:14], check at L1[14])
      const rescuedDocNo1 = tryDocNoRescue(l1.substring(5, 14), +l1[14]);
      if (rescuedDocNo1) {
        for (let i = 0; i < 9; i++) a1[5 + i] = rescuedDocNo1[i];
        // a1[14] stays as l1[14] — original check is correct for rescued doc no
      } else {
        a1[14] = String(chk(l1.substring(5, 14)));                // docNo check (normal path)
      }
      a2[6]  = String(chk(l2.substring(0, 6)));                   // dob check
      a2[14] = String(chk(l2.substring(8, 14)));                  // exp check
      // composite must use CORRECTED values (a1[], a2[] not l1/l2 strings)
      const a1c = a1.join(''), a2c = a2.join('');
      a2[29] = String(chk(
        a1c.substring(5, 30) + a2c.substring(0, 7) + a2c.substring(8, 15) + a2c.substring(18, 29)
      ));
      return [a1.join(''), a2.join(''), l3];
    }
    return lines;
  }

  // ── EXPORT ────────────────────────────────────────────────────────────
  window.MRZCore = {
    chk, clean, cleanLine, fixLine, applyDigitFixes,
    isL1_TD1, isL2_TD1, isL3_TD1, isL1_TD3, isL2_TD3,
    extractMRZ, getChecksums_TD3, parseResult, parseMRZName,
    validateMRZ, diagnoseMRZ, validateNationalId,
    correctCheckDigits,
  };
})();
