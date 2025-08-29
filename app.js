// app.js
// Node.js API: poll nguồn -> phân tích -> predict T/X
// Author: ChatGPT (tailored for user id Tele@idol_vannhat)

const express = require('express');
const fetch = require('node-fetch'); // nếu node >=18 có thể bỏ và dùng global fetch
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const POLL_URL = "https://toilavinhmaycays23.onrender.com/vinhmaycay";
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds
const DATA_FILE = path.join(__dirname, 'data.json');
const APP_ID = "Tele@idol_vannhat";

// ensure data file exists
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    history: [],      // array of {phien, dice: [a,b,c], total, result, time}
    pattern: ""       // eg "TTXXT..." where T = Tai, X = Xiu
  }, null, 2));
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { history: [], pattern: "" };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Helpers
 */
function normalizeResult(raw) {
  // Map result to 'T' (Tài) or 'X' (Xỉu)
  // Accepts different raw forms; user API hopefully returns string like "Tài" or "Xỉu" or "Tai"/"Xiu"
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes('t')) return 'T';
  if (s.includes('x') || s.includes('xi')) return 'X';
  // fallback: if numeric total available, total >= 11 -> Tai (3..18) typical rule: Tai 11-17 ? Common rule Tài: sum 11-17, Xỉu: 4-10 (assuming 3 dice 1..6)
  return null;
}

/**
 * Prediction engine (heuristic + lightweight "ai")
 * - Analyze last N results and last pattern substring
 * - Detect streaks (bệt), alternation (1-1), 2-2, 2-1, 2-3 patterns
 * - Compute score for T and X -> predict the higher
 * - Compute confidence (do_tin_cay) in percent
 */
function predictNext(data) {
  const history = data.history || [];
  const pattern = data.pattern || "";

  const lastResults = history.slice(-20); // keep up to last 20 for analysis
  const last10 = lastResults.slice(-10);
  const last10pattern = pattern.slice(-10);

  // Basic counts
  let countT = 0, countX = 0;
  last10.forEach(h => {
    if (h.result === 'T') countT++;
    if (h.result === 'X') countX++;
  });

  // Pattern counts in last 10 pattern string
  let patCountT = 0, patCountX = 0;
  Array.from(last10pattern).forEach(ch => {
    if (ch === 'T') patCountT++;
    if (ch === 'X') patCountX++;
  });

  // Detect streaks (bệt)
  function detectStreak(arr) {
    if (!arr.length) return {type: null, len:0, value:null};
    let last = arr[arr.length-1].result;
    let len = 1;
    for (let i = arr.length-2; i>=0; i--) {
      if (arr[i].result === last) len++;
      else break;
    }
    return { type: len>=3 ? 'streak' : (len>=2 ? 'small_streak' : null), len, value: last };
  }
  const streak = detectStreak(lastResults);

  // Detect alternation 1-1
  function detectAlternation(arr) {
    if (arr.length < 4) return false;
    // check last up to 8 elements for perfect alternation like T X T X ...
    const tail = arr.slice(-8).map(x => x.result);
    if (tail.length < 4) return false;
    let alt = true;
    for (let i = 2; i < tail.length; i++) {
      if (tail[i] !== tail[i%2]) { alt = false; break; }
    }
    return alt;
  }
  const isAlternation = detectAlternation(lastResults);

  // Detect patterns like 2-2, 2-1, 2-3 (simple window checks)
  function detectRunLengths(patternStr) {
    // returns most recent run lengths array e.g. "TTXXXT" -> [2,3,1]
    if (!patternStr) return [];
    const res = [];
    let cur = patternStr[0], cnt = 1;
    for (let i=1;i<patternStr.length;i++){
      if (patternStr[i] === cur) cnt++;
      else { res.push(cnt); cur = patternStr[i]; cnt = 1; }
    }
    res.push(cnt);
    return res;
  }
  const runs = detectRunLengths(data.pattern.slice(-50));

  // Score calculation (weights can be tuned)
  let scoreT = 0.0, scoreX = 0.0;

  // weight recent frequency
  scoreT += countT * 1.0;
  scoreX += countX * 1.0;

  // pattern frequency
  scoreT += patCountT * 0.7;
  scoreX += patCountX * 0.7;

  // streak effect: if there's a long streak, raise probability it continues slightly (or you may drop, choose conservative)
  if (streak.type === 'streak' && streak.len >= 3) {
    if (streak.value === 'T') scoreT += 3.0;
    else scoreX += 3.0;
  } else if (streak.type === 'small_streak') {
    if (streak.value === 'T') scoreT += 1.5;
    else scoreX += 1.5;
  }

  // alternation effect: if alternating pattern detected, favor the opposite of last one
  if (isAlternation && lastResults.length) {
    const last = lastResults[lastResults.length-1].result;
    if (last === 'T') scoreX += 2.4;
    else scoreT += 2.4;
  }

  // run-length detection: if the last run is length 2 and previous also 2 (2-2), then next is likely the same run pattern -> favor flip
  if (runs.length >= 2) {
    const lastRun = runs[runs.length-1];
    const prevRun = runs[runs.length-2];
    if (lastRun === 2 && prevRun === 2) {
      // e.g., TT XX -> maybe TT again? We'll favor flip (opposite of last)
      const last = pattern[pattern.length-1];
      if (last === 'T') scoreX += 1.8; else scoreT += 1.8;
    }
    // 2-1 patterns -> sometimes predict continuation of short run
    if (lastRun === 1 && prevRun === 2) {
      const last = pattern[pattern.length-1];
      if (last === 'T') scoreT += 1.0; else scoreX += 1.0;
    }
  }

  // small "AI" aggregator: we look at sliding windows of size 3..6 and see which side wins more often next
  function slidingWindowHeuristic(arrResults, window) {
    // arrResults: array of 'T'/'X' strings
    const seq = arrResults.map(x=>x.result);
    const n = seq.length;
    if (n < window+1) return 0;
    let voteT = 0, voteX = 0;
    for (let i=0;i<=n-window-1;i++){
      const pat = seq.slice(i, i+window).join('');
      const next = seq[i+window];
      // if last window equals most recent window, give a vote to next
      const recentWindow = seq.slice(n-window, n).join('');
      if (pat === recentWindow) {
        if (next === 'T') voteT++; else voteX++;
      }
    }
    return (voteT - voteX);
  }

  const seqArr = lastResults.map(h => ({result: h.result}));
  const sw3 = slidingWindowHeuristic(seqArr, 3);
  const sw4 = slidingWindowHeuristic(seqArr, 4);
  const sw5 = slidingWindowHeuristic(seqArr, 5);

  scoreT += Math.max(0, sw3 + sw4 + sw5) * 0.8;
  scoreX += Math.max(0, -(sw3 + sw4 + sw5)) * 0.8;

  // final normalization to predict
  const predict = (scoreT > scoreX) ? 'T' : 'X';

  // compute confidence: base on difference and how many signals aligned
  let rawDiff = Math.abs(scoreT - scoreX);
  // map rawDiff to percent range roughly 50->95
  let baseConfidence = Math.min(95, 50 + Math.round(rawDiff * 6)); // tune scale
  // bump if many heuristics align
  let heuristicsAgree = 0;
  if (countT > countX && predict === 'T') heuristicsAgree++;
  if (patCountT > patCountX && predict === 'T') heuristicsAgree++;
  if (streak.value === predict && streak.len >=2) heuristicsAgree++;
  if (isAlternation && lastResults.length) {
    const last = lastResults[lastResults.length-1].result;
    const opposite = (last === 'T' ? 'X' : 'T');
    if (predict === opposite) heuristicsAgree++;
  }
  let do_tin_cay = Math.min(99, baseConfidence + heuristicsAgree * 4);

  // clamp
  if (do_tin_cay < 30) do_tin_cay = 30;
  if (do_tin_cay > 99) do_tin_cay = 99;

  // giai_thich short explanation (vietnamese)
  let giai_thich = [];
  giai_thich.push(`Dựa trên ${last10.length} phiên gần nhất`);
  if (countT > countX) giai_thich.push(`T xuất hiện nhiều hơn (${countT} vs ${countX})`);
  if (countX > countT) giai_thich.push(`X xuất hiện nhiều hơn (${countX} vs ${countT})`);
  if (streak.type) giai_thich.push(`Phát hiện ${streak.type} dài ${streak.len} (${streak.value})`);
  if (isAlternation) giai_thich.push(`Mẫu xen kẽ (1-1) phát hiện`);
  if (runs.length) giai_thich.push(`Chuỗi run gần nhất: ${runs.slice(-5).join('-')}`);
  giai_thich.push(`Kết luận: dự đoán ${predict} với độ tin cậy ~${do_tin_cay}%`);

  return {
    predict,
    do_tin_cay,
    scoreT: Number(scoreT.toFixed(3)),
    scoreX: Number(scoreX.toFixed(3)),
    giai_thich: giai_thich.join('. ')
  };
}

/**
 * Poller: fetch latest result from remote API, parse, save if new
 */
let polling = true;
async function pollOnce() {
  try {
    const res = await fetch(POLL_URL, { method: 'GET', timeout: 8000 });
    const body = await res.json();

    // Here we assume the remote API returns an object with fields we can map.
    // We'll attempt to extract Phien, Xuc_xac_1..3, Tong, Ket_qua
    // If the structure differs, adapt mapping.
    // Try common shapes:
    let phien = body.phien || body.Phien || body.session || body.id || body.phien_truoc || body.session_id;
    // If remote sends an array or nested, try to handle
    if (!phien) {
      if (Array.isArray(body) && body.length) {
        // take first
        const b0 = body[0];
        phien = b0.phien || b0.session || b0.id;
      }
    }

    // try xuc xac
    let xa1 = body.xuc_xac_1 || body.xucac1 || body.dice1 || (body.dice && body.dice[0]);
    let xa2 = body.xuc_xac_2 || body.xucac2 || body.dice2 || (body.dice && body.dice[1]);
    let xa3 = body.xuc_xac_3 || body.xucac3 || body.dice3 || (body.dice && body.dice[2]);

    // if still missing, check nested fields
    if (!xa1 && body.dice && Array.isArray(body.dice) && body.dice.length>=3) {
      xa1 = body.dice[0]; xa2 = body.dice[1]; xa3 = body.dice[2];
    }

    let total = body.tong || body.total || (xa1 && xa2 && xa3 ? (Number(xa1)+Number(xa2)+Number(xa3)) : null);
    let rawResult = body.ket_qua || body.result || body.ketqua || body.ket_qua_phien || body.ket_qua_text;

    // fallback: determine result from total (assuming Tài 11-17, Xỉu 4-10)
    let resultMapped = normalizeResult(rawResult);
    if (!resultMapped && total != null) {
      const t = Number(total);
      if (!isNaN(t)) {
        if (t >= 11) resultMapped = 'T';
        else resultMapped = 'X';
      }
    }

    // If phien missing, fallback to timestamp key
    const timeNow = new Date().toISOString();
    const data = loadData();

    // Compose record
    const record = {
      phien: phien || (`p_${Date.now()}`),
      dice: [Number(xa1)||0, Number(xa2)||0, Number(xa3)||0],
      total: total != null ? Number(total) : (Number(xa1||0)+Number(xa2||0)+Number(xa3||0)),
      result: resultMapped || 'X',
      rawResult: rawResult || null,
      time: timeNow
    };

    // check if already present (by phien)
    const exists = data.history.find(h => String(h.phien) === String(record.phien));
    if (!exists) {
      data.history.push(record);
      // append to pattern
      data.pattern = (data.pattern || '') + (record.result === 'T' ? 'T' : 'X');
      // keep pattern length reasonable but at least 200 chars
      if (data.pattern.length > 1000) data.pattern = data.pattern.slice(-1000);
      // trim history to 500 entries
      if (data.history.length > 1000) data.history = data.history.slice(-1000);
      saveData(data);
      console.log(`[poll] saved phien=${record.phien} result=${record.result} total=${record.total}`);
    } else {
      // existing - ignore
      // console.log('[poll] no new phien');
    }

    return { ok: true, record };

  } catch (e) {
    console.error('[poll] error', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

// start periodic poller
setInterval(() => {
  if (polling) pollOnce();
}, POLL_INTERVAL_MS);

// Express app
const app = express();
app.use(bodyParser.json());

// GET /api/history?limit=20
app.get('/api/history', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit||20));
  const data = loadData();
  const out = data.history.slice(-limit);
  res.json({ id: APP_ID, count: out.length, history: out });
});

// GET /api/pattern
app.get('/api/pattern', (req, res) => {
  const data = loadData();
  res.json({ id: APP_ID, pattern: data.pattern });
});

// GET /api/poll -> manual trigger
app.get('/api/poll', async (req, res) => {
  const r = await pollOnce();
  res.json(r);
});

// GET /api/predict -> returns prediction for next session
app.get('/api/predict', (req, res) => {
  const data = loadData();
  const eng = predictNext(data);
  // compute next session id roughly by last phien + 1 if numeric
  const last = data.history[data.history.length-1];
  let nex_session = null;
  if (last) {
    const p = last.phien;
    const pn = Number(p);
    if (!isNaN(pn)) nex_session = pn + 1;
    else nex_session = String(p) + "_next";
  } else {
    nex_session = "1";
  }

  // Compose final response like requested by user
  const dice = last ? last.dice : [0,0,0];
  const total = last ? last.total : 0;
  const result = last ? last.result : null;
  const response = {
    session: last ? last.phien : null,
    dice: dice,
    total: total,
    result: result,
    nex_session: nex_session,
    predict: eng.predict,
    do_tin_cay: eng.do_tin_cay,
    giai_thich: eng.giai_thich,
    pattern: (data.pattern || '').slice(-200),
    id: APP_ID,
    meta: {
      scoreT: eng.scoreT,
      scoreX: eng.scoreX
    }
  };
  res.json(response);
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const data = loadData();
  res.json({
    id: APP_ID,
    history_count: data.history.length,
    pattern_len: data.pattern.length,
    polling_interval_s: POLL_INTERVAL_MS / 1000
  });
});

// POST /api/reset (reset pattern/history) - use with caution
app.post('/api/reset', (req, res) => {
  const body = req.body || {};
  if (!body.confirm || body.confirm !== true) {
    return res.status(400).json({ error: "To reset, POST { confirm: true }" });
  }
  const empty = { history: [], pattern: "" };
  saveData(empty);
  res.json({ ok: true });
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taixiu predict API listening on port ${PORT}`);
  console.log(`Poll URL: ${POLL_URL} every ${POLL_INTERVAL_MS/1000}s`);
});
