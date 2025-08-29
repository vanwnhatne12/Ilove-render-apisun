/**
 * server.js
 * Taixiu VIP predictor - Node.js + Express
 * - Poll: https://toilavinhmaycays23.onrender.com/vinhmaycay
 * - History persisted -> data.json
 * - Markov k=1..10, pattern analysis, sliding-window heuristic
 * - Endpoints: /predict, /stats, /history, /poll, /reset
 *
 * Author: ChatGPT (tailored)
 */

const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const writeFileAtomic = require('write-file-atomic');

const DATA_FILE = path.join(__dirname, 'data.json');
const POLL_URL = "https://toilavinhmaycays23.onrender.com/vinhmaycay";
const POLL_INTERVAL_SEC = 30;
const POLL_INTERVAL_MS = POLL_INTERVAL_SEC * 1000;
const MAX_HISTORY = 500; // tối đa lưu
const APP_ID = "Tele@idol_vannhat";

// ======================
// Trọng số (có thể chỉnh)
const W_MARKOV = 0.46;
const W_PATTERN = 0.28;
const W_LOCAL_TREND = 0.14;
const W_GLOBAL_FREQ = 0.12;
const CONF_MIN = 52.0;
const CONF_MAX = 97.5;
// ======================

/* ---------- Helper IO: đảm bảo data.json tồn tại ---------- */
function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { history: [], pattern: "" };
    writeFileAtomic.sync(DATA_FILE, JSON.stringify(init, null, 2));
  }
}
ensureDataFile();

function loadData() {
  try {
    const txt = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return { history: [], pattern: "" };
  }
}

function saveDataAtomic(obj) {
  writeFileAtomic.sync(DATA_FILE, JSON.stringify(obj, null, 2));
}

/* ---------- In-memory structures ---------- */
let store = loadData(); // { history: [{phien, ket_qua, dice:[..], total, time}], pattern: "TXXT..." }
if (!store.history) store.history = [];
if (!store.pattern) store.pattern = "";

let markovCounts = {}; // markovCounts[k][pattern] = { 'Tài': n, 'Xỉu': m }
for (let k=1;k<=10;k++) markovCounts[k] = {};

let lastPhien = store.history.length ? store.history[store.history.length-1].phien : null;
let isPolling = false;

/* ---------- Utils ---------- */
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const asTX = (r) => (r === 'Tài' || r === 'Tai' || r === 'T' ? 'T' : 'X');
const fromTX = (ch) => (ch === 'T' ? 'Tài' : 'Xỉu');

function currentStreak(arr) {
  if (!arr.length) return { len: 0, side: null };
  const last = arr[arr.length-1];
  let len = 1;
  for (let i = arr.length-2; i >= 0; i--) {
    if (arr[i] === last) len++; else break;
  }
  return { len, side: last };
}

function entropyBinary(p) {
  if (p <= 0 || p >= 1) return 0;
  return - (p * Math.log2(p) + (1-p) * Math.log2(1-p)); // range 0..1
}

/* ---------- Markov build/update ---------- */
function rebuildMarkov(allResults) {
  for (let k=1;k<=10;k++) markovCounts[k] = {};
  if (!allResults || allResults.length < 2) return;
  const tx = allResults.map(asTX);
  for (let k=1;k<=10;k++){
    if (tx.length <= k) continue;
    for (let i=0;i<tx.length - k;i++){
      const pattern = tx.slice(i, i+k).join('');
      const nxt = tx[i+k];
      const out = fromTX(nxt);
      markovCounts[k][pattern] = markovCounts[k][pattern] || { 'Tài':0, 'Xỉu':0 };
      markovCounts[k][pattern][out] += 1;
    }
  }
}

function updateMarkovIncremental(allResults) {
  if (!allResults || allResults.length < 2) return;
  const tx = allResults.map(asTX);
  for (let k=1;k<=10;k++){
    if (tx.length > k){
      const pattern = tx.slice(-(k+1), -1).join('');
      const nxt = tx[tx.length-1];
      const out = fromTX(nxt);
      markovCounts[k][pattern] = markovCounts[k][pattern] || { 'Tài':0, 'Xỉu':0 };
      markovCounts[k][pattern][out] += 1;
    }
  }
}

/* ---------- Pattern analysis (nâng cấp) ---------- */
function smartPatternAnalysis(results) {
  // results: array of 'Tài'/'Xỉu'
  const labels = [];
  const vote = { 'Tài': 0.0, 'Xỉu': 0.0 };
  const n = results.length;
  if (!n) {
    labels.push("Không có dữ liệu");
    return { labels, vote };
  }

  // bệt (streak)
  const streak = currentStreak(results);
  if (streak.len >= 3) {
    labels.push(`Cầu bệt ${streak.side} (${streak.len})`);
    const s = Math.min(12.0 + (streak.len - 3) * 2.5, 28.0);
    vote[streak.side] += s;
  }

  // 1-1
  if (n >= 4) {
    const last4 = results.slice(-4).join('|');
    if (last4 === 'Tài|Xỉu|Tài|Xỉu' || last4 === 'Xỉu|Tài|Xỉu|Tài') {
      labels.push("Cầu 1-1");
      const nextSide = results[n-1] === 'Xỉu' ? 'Tài' : 'Xỉu';
      vote[nextSide] += 18.0;
    }
  }

  // 2-2
  if (n >= 4) {
    const last4arr = results.slice(-4);
    if (JSON.stringify(last4arr) === JSON.stringify(['Tài','Tài','Xỉu','Xỉu'])) {
      labels.push("Cầu 2-2");
      vote['Tài'] += 12.0;
    }
    if (JSON.stringify(last4arr) === JSON.stringify(['Xỉu','Xỉu','Tài','Tài'])) {
      labels.push("Cầu 2-2");
      vote['Xỉu'] += 12.0;
    }
  }

  // 2-1
  if (n >= 3) {
    const last3 = results.slice(-3);
    if (JSON.stringify(last3) === JSON.stringify(['Tài','Tài','Xỉu'])) {
      labels.push("Cầu 2-1");
      vote['Tài'] += 10.0;
    }
    if (JSON.stringify(last3) === JSON.stringify(['Xỉu','Xỉu','Tài'])) {
      labels.push("Cầu 2-1");
      vote['Xỉu'] += 10.0;
    }
  }

  // 2-3
  if (n >= 5) {
    const last5 = results.slice(-5);
    if (JSON.stringify(last5) === JSON.stringify(['Tài','Tài','Xỉu','Xỉu','Xỉu'])) {
      labels.push("Cầu 2-3");
      vote['Xỉu'] += 14.0;
    }
    if (JSON.stringify(last5) === JSON.stringify(['Xỉu','Xỉu','Tài','Tài','Tài'])) {
      labels.push("Cầu 2-3");
      vote['Tài'] += 14.0;
    }
  }

  // Sliding-window pattern matching: tìm các window lịch sử giống window cuối và vote theo follower distribution
  function slidingWindowVotes(arr, maxWindow=6) {
    const seq = arr.map(asTX);
    const nseq = seq.length;
    let totalVote = { 'Tài':0, 'Xỉu':0 };
    for (let w=2; w<=maxWindow; w++){
      if (nseq <= w) continue;
      const recent = seq.slice(-w).join('');
      // scan earlier windows
      for (let i=0;i<=nseq - w - 1; i++){
        const patt = seq.slice(i, i+w).join('');
        if (patt === recent) {
          const nxt = seq[i+w];
          totalVote[fromTX(nxt)] += 1;
        }
      }
    }
    return totalVote;
  }

  const swVotes = slidingWindowVotes(results, 6);
  // convert counts to score (give moderate weight)
  vote['Tài'] += swVotes['Tài'] * 2.0;
  vote['Xỉu'] += swVotes['Xỉu'] * 2.0;
  if (swVotes['Tài'] + swVotes['Xỉu'] > 0) labels.push(`SlidingWindow:${swVotes['Tài']}/${swVotes['Xỉu']}`);

  // If no patterns found, fallback message
  if (!labels.length) labels.push("Không có cầu rõ ràng");

  return { labels, vote };
}

/* ---------- Markov prediction ---------- */
function markovPredict(results) {
  // returns {probT, info, cover}
  if (!results || results.length < 2) return { probT: 0.5, info: "Markov: thiếu dữ liệu", cover: 0 };
  const tx = results.map(asTX);
  let aggWeight = 0;
  let aggProbT = 0;
  let totalFollowers = 0;
  const details = [];
  for (let k=1;k<=10;k++){
    if (tx.length <= k) continue;
    const prefix = tx.slice(-k).join('');
    const counts = markovCounts[k][prefix];
    if (!counts) continue;
    const cT = counts['Tài'] || 0;
    const cX = counts['Xỉu'] || 0;
    const total = cT + cX;
    if (!total) continue;
    const pT = cT / total;
    const w = k * Math.log2(1 + total);
    aggProbT += pT * w;
    aggWeight += w;
    totalFollowers += total;
    details.push(`k=${k}:${cT}/${total}T`);
  }
  if (aggWeight === 0) return { probT: 0.5, info: "Markov: chưa khớp pattern", cover: 0 };
  const probT = aggProbT / aggWeight;
  const info = `Markov[${details.slice(0,6).join(',')}${details.length>6? ',...':''}]`;
  return { probT, info, cover: totalFollowers };
}

/* ---------- Local trend & global freq ---------- */
function localTrend(results, lookback=10) {
  if (!results || !results.length) return { prob: 0.5, n: 0 };
  const m = Math.min(lookback, results.length);
  const seg = results.slice(-m);
  const cT = seg.filter(r => r === 'Tài').length;
  return { prob: cT / m, n: m };
}
function globalFreq(results) {
  if (!results || !results.length) return { prob: 0.5, n: 0 };
  const cT = results.filter(r => r === 'Tài').length;
  return { prob: cT / results.length, n: results.length };
}

/* ---------- Combine votes & compute confidence ---------- */
function softmax2(sT, sX, scale=12.0) {
  const eT = Math.exp(sT/scale);
  const eX = Math.exp(sX/scale);
  return eT / (eT + eX);
}

function combineVotes(probMarkov, patternVote, probLocal, probGlobal, coverMarkov, nLocal, nGlobal, bridgesLabels) {
  // convert patternVote to prob
  const sT = patternVote['Tài'] || 0;
  const sX = patternVote['Xỉu'] || 0;
  const probPattern = (sT===0 && sX===0) ? 0.5 : softmax2(sT, sX, 12.0);

  // coverage weighting to prevent overtrusting tiny samples
  const wM = 0.5 + Math.min(0.5, Math.log2(1 + coverMarkov) / 5.0);
  const wL = 0.5 + Math.min(0.5, Math.log2(1 + nLocal) / 5.0);
  const wG = 0.5 + Math.min(0.5, Math.log2(1 + nGlobal) / 5.0);

  const WM = W_MARKOV * wM;
  const WP = W_PATTERN;
  const WL = W_LOCAL_TREND * wL;
  const WG = W_GLOBAL_FREQ * wG;

  const denom = (WM + WP + WL + WG) || 1.0;
  let p = (probMarkov * WM + probPattern * WP + probLocal * WL + probGlobal * WG) / denom;

  // entropy-based confidence
  const H = entropyBinary(p);
  let conf = (1.0 - H) * 100.0;

  // small adjustment if clear patterns exist
  const clearCount = bridgesLabels.filter(b => b !== 'Không có cầu rõ ràng').length;
  if (clearCount) conf *= Math.min(1.15, 1.03 + 0.03 * clearCount);
  else conf *= 0.96;

  // clamp
  conf = Math.max(CONF_MIN, Math.min(CONF_MAX, conf));

  const predict = p >= 0.5 ? 'Tài' : 'Xỉu';

  return { predict, confidence: Number(conf.toFixed(2)), probPattern, p };
}

/* ---------- predict main ---------- */
function predictVip(results) {
  if (!results || !results.length) return { predict: 'Tài', confidence: 50.0, explain: 'Chưa có dữ liệu.' };

  const { labels, vote } = smartPatternAnalysis(results);
  const mk = markovPredict(results);
  const local = localTrend(results, 10);
  const global = globalFreq(results);

  const merged = combineVotes(mk.probT, vote, local.prob, global.prob, mk.cover, local.n, global.n, labels);

  // build explanation
  const brief_pattern = labels.join('; ');
  const p_markov_pct = `${(mk.probT*100).toFixed(1)}%`;
  const p_pattern_pct = `${(merged.probPattern*100).toFixed(1)}%`;
  const p_local_pct = `${(local.prob*100).toFixed(1)}%`;
  const p_global_pct = `${(global.prob*100).toFixed(1)}%`;

  const explain = `${brief_pattern}. Markov: ${p_markov_pct} Tài (${mk.info}). Pattern: ${p_pattern_pct} Tài. Gần10: ${p_local_pct} Tài. Toàn cục: ${p_global_pct} Tài. Chốt: ${merged.predict}.`;

  return { predict: merged.predict, do_tin_cay: `${merged.confidence.toFixed(1)}%`, explain, meta: { prob_markov: mk.probT, prob_pattern: merged.probPattern, prob_local: local.prob, prob_global: global.prob } };
}

/* ---------- Poller ---------- */
async function pollOnce() {
  try {
    const res = await fetch(POLL_URL, { timeout: 9000 });
    const data = await res.json();

    // try to map possible keys
    const phien = data.Phien || data.phien || data.session || data.id;
    const xa1 = data.Xuc_xac_1 || data.xuc_xac_1 || data.x1 || (data.dice && data.dice[0]);
    const xa2 = data.Xuc_xac_2 || data.xuc_xac_2 || data.x2 || (data.dice && data.dice[1]);
    const xa3 = data.Xuc_xac_3 || data.xuc_xac_3 || data.x3 || (data.dice && data.dice[2]);
    const total = data.Tong || data.tong || data.total || (xa1!=null && xa2!=null && xa3!=null ? (Number(xa1||0)+Number(xa2||0)+Number(xa3||0)) : null);
    let ket_qua = data.Ket_qua || data.ket_qua || data.result || null;
    // normalize
    if (ket_qua) {
      ket_qua = (String(ket_qua).toLowerCase().includes('t')) ? 'Tài' : 'Xỉu';
    } else if (total != null) {
      const t = Number(total);
      // typical rule: Tài if sum >= 11 else Xỉu
      ket_qua = (t >= 11) ? 'Tài' : 'Xỉu';
    }

    if (!phien || !ket_qua) {
      // invalid payload
      return { ok:false, reason: 'Không đủ dữ liệu từ API' };
    }

    // If new phien
    if (lastPhien == null) {
      // first-run: populate
      store.history.push({ phien, ket_qua, dice: [xa1,xa2,xa3], total, time: new Date().toISOString() });
      store.pattern += (asTX(ket_qua) === 'T' ? 'T' : 'X');
      if (store.pattern.length > 1000) store.pattern = store.pattern.slice(-1000);
      if (store.history.length > MAX_HISTORY) store.history = store.history.slice(-MAX_HISTORY);
      lastPhien = phien;
      rebuildMarkov(store.history.map(h => h.ket_qua));
      saveDataAtomic(store);
      return { ok:true, new: true, phien };
    } else {
      // assume phien numeric or comparable; if not, compare as string
      if (phien > lastPhien) {
        store.history.push({ phien, ket_qua, dice:[xa1,xa2,xa3], total, time: new Date().toISOString() });
        store.pattern += (asTX(ket_qua) === 'T' ? 'T' : 'X');
        if (store.pattern.length > 1000) store.pattern = store.pattern.slice(-1000);
        if (store.history.length > MAX_HISTORY) store.history = store.history.slice(-MAX_HISTORY);
        lastPhien = phien;
        updateMarkovIncremental(store.history.map(h => h.ket_qua));
        saveDataAtomic(store);
        return { ok:true, new: true, phien };
      } else {
        return { ok:true, new:false, phien };
      }
    }

  } catch (err) {
    return { ok:false, error: String(err) };
  }
}

let pollingLoopRunning = false;
async function startPollingLoop() {
  if (pollingLoopRunning) return;
  pollingLoopRunning = true;
  while (true) {
    const r = await pollOnce();
    // console.log('[poll] ', r);
    await sleep(POLL_INTERVAL_MS);
  }
}
startPollingLoop(); // start in background

/* ---------- Express API ---------- */
const app = express();
app.use(bodyParser.json());

app.get('/predict', async (req, res) => {
  if (!store.history.length) return res.status(503).json({ error: 'No data available yet. Waiting for poll.' });
  const results = store.history.map(h => h.ket_qua);
  const out = predictVip(results);

  // fetch latest payload to include dice/total/result (best-effort)
  let latestRemote = {};
  try {
    const r = await fetch(POLL_URL, { timeout:8000 });
    latestRemote = await r.json();
  } catch (e) {
    latestRemote = {};
  }

  const session = latestRemote.Phien || latestRemote.phien || (store.history.length ? store.history[store.history.length-1].phien : null);
  const diceStr = `${latestRemote.Xuc_xac_1||''} - ${latestRemote.Xuc_xac_2||''} - ${latestRemote.Xuc_xac_3||''}`;
  const total = latestRemote.Tong || latestRemote.tong || (store.history.length ? store.history[store.history.length-1].total : null);
  const result = latestRemote.Ket_qua || latestRemote.ket_qua || (store.history.length ? store.history[store.history.length-1].ket_qua : null);
  const next_session = (typeof session === 'number') ? session + 1 : null;
  const pattern_str = store.pattern.slice(-20);

  res.json({
    session,
    dice: diceStr,
    total,
    result,
    next_session,
    predict: out.predict,
    do_tin_cay: out.do_tin_cay,
    giai_thich: out.explain,
    pattern: pattern_str,
    id: APP_ID,
    meta: out.meta
  });
});

app.get('/stats', (req,res) => {
  const results = store.history.map(h => h.ket_qua);
  const n = results.length;
  const cT = results.filter(r => r === 'Tài').length;
  const cX = n - cT;
  const streak = currentStreak(results);
  const recent10 = results.slice(-10);
  const cT10 = recent10.filter(r => r === 'Tài').length;
  res.json({
    total_samples: n,
    tai_count: cT,
    xiu_count: cX,
    current_streak: streak.len,
    streak_side: streak.side,
    recent10_tai: cT10,
    recent10_xiu: recent10.length - cT10
  });
});

app.get('/history', (req,res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const out = store.history.slice(-limit);
  res.json({ count: out.length, history: out });
});

// manual poll trigger
app.get('/poll', async (req,res) => {
  const r = await pollOnce();
  res.json(r);
});

// reset (POST {confirm:true})
app.post('/reset', (req,res) => {
  const body = req.body || {};
  if (!body.confirm) return res.status(400).json({ error: 'To reset send { "confirm": true }' });
  store = { history: [], pattern: "" };
  for (let k=1;k<=10;k++) markovCounts[k] = {};
  lastPhien = null;
  saveDataAtomic(store);
  return res.json({ ok:true });
});

/* ---------- Start server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taixiu VIP predictor listening on http://0.0.0.0:${PORT}`);
  console.log(`Poll URL: ${POLL_URL} every ${POLL_INTERVAL_SEC}s`);
});
