// server.js
// Taixiu VIP - All-in-one (Markov, Pattern, THUAT_TOAN_400, Bayes, Monte Carlo, 7 AI-cầu, ensemble)
// Run: node server.js
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
const MAX_HISTORY = 500;
const APP_ID = "Tele@idol_vannhat";

// ------------------ Config weights ------------------
let W_MARKOV = 0.30;
let W_PATTERN = 0.30;
let W_LOCAL_TREND = 0.10;
let W_GLOBAL_FREQ = 0.08;
let W_AI_SELF_LEARN = 0.07;
let W_THUAT_TOAN_400 = 0.15;
let W_BAYES = 0.10;
let W_MONTECARLO = 0.08;

const CONF_MIN = 55.0;
const CONF_MAX = 99.0;

// ------------------ Utilities ------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const asTX = r => (r === 'Tài' || r === 'Tai' || r === 'T' ? 'T' : 'X');
const fromTX = ch => (ch === 'T' ? 'Tài' : 'Xỉu');

function currentStreak(arr) {
  if (!arr.length) return { len: 0, side: null };
  const last = arr[arr.length - 1];
  let len = 1;
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i] === last) len++; else break;
  }
  return { len, side: last };
}
function entropyBinary(p) {
  if (p <= 0 || p >= 1) return 0;
  return - (p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}
function doBen(results) {
  return currentStreak(results).len;
}
function softmax2(sT, sX, scale = 12.0) {
  const eT = Math.exp(sT / scale);
  const eX = Math.exp(sX / scale);
  return eT / (eT + eX);
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// tinhLyDo helper
function tinhLyDo(chuoiCau) {
  if (!chuoiCau) return '';
  let nhom = [];
  let dem = 1;
  for (let i = 1; i < chuoiCau.length; i++) {
    if (chuoiCau[i] === chuoiCau[i - 1]) dem++;
    else { nhom.push(dem); dem = 1; }
  }
  nhom.push(dem);
  return "cầu " + nhom.join(" ");
}

// ------------------ Data file handling ------------------
function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = {
      history: [],
      pattern: "",
      pattern_memory: {},
      error_memory: {},
      dem_sai: 0,
      pattern_sai: [],
      diem_lich_su: [],
      da_be_tai: false,
      da_be_xiu: false,
      cau_moi: {}
    };
    writeFileAtomic.sync(DATA_FILE, JSON.stringify(init, null, 2));
  }
}
ensureDataFile();

function loadData() {
  try {
    const txt = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(txt || '{}');
    return data;
  } catch (e) {
    return { history: [], pattern: "", pattern_memory: {}, error_memory: {}, dem_sai: 0, pattern_sai: [], diem_lich_su: [], da_be_tai: false, da_be_xiu: false, cau_moi: {} };
  }
}
function saveDataAtomic(obj) {
  writeFileAtomic.sync(DATA_FILE, JSON.stringify(obj, null, 2));
}

// ------------------ In-memory state ------------------
let store = loadData();
if (!store.history) store.history = [];
if (!store.pattern) store.pattern = "";
if (!store.pattern_memory) store.pattern_memory = {};
if (!store.error_memory) store.error_memory = {};
if (!store.dem_sai) store.dem_sai = 0;
if (!store.pattern_sai) store.pattern_sai = [];
if (!store.diem_lich_su) store.diem_lich_su = [];
if (store.da_be_tai === undefined) store.da_be_tai = false;
if (store.da_be_xiu === undefined) store.da_be_xiu = false;
if (!store.cau_moi) store.cau_moi = {};
let CauMoi = store.cau_moi || {};

// ------------------ Markov counts ------------------
let markovCounts = {};
for (let k = 1; k <= 10; k++) markovCounts[k] = {};
let lastPhien = store.history.length ? store.history[store.history.length - 1].phien : null;

// ------------------ Build THUAT_TOAN_400 programmatically ------------------
function buildThuậtToan400() {
  // We'll generate 400 distinct patterns length 6..10 using systematic sequences.
  const out = {};
  let idx = 0;
  const lengths = [6,7,8,9,10];
  // generate patterns by repeating short motifs and mixing
  const motifs = ['T','X','TT','XX','TX','XT','TTX','XTT','TXX','XXT','TXT','XTX'];
  for (let L of lengths) {
    for (let m of motifs) {
      if (idx >= 400) break;
      // build pattern by repeating motif until length L then slice
      let s = m.repeat(Math.ceil(L / m.length)).slice(0, L);
      // also add variants with flipped first/last
      const key = s;
      const countT = (s.match(/T/g)||[]).length;
      const du_doan = (countT >= Math.ceil(L/2)) ? 'Tài' : 'Xỉu';
      const doTinCay = Math.min(98, 60 + Math.floor((countT / L) * 40) + (L - 6) * 2);
      const lyDo = `THUAT_TOAN_400 mẫu ${key} → ${tinhLyDo(key)}`;
      const tong = [11,12,13].slice(0,3); // placeholder
      out[key] = { du_doan, doTinCay, lyDo, tong };
      idx++;
      if (idx >= 400) break;
    }
    if (idx >= 400) break;
  }
  // If didn't reach 400 (unlikely), pad with generated binary patterns
  let i = 0;
  const gen = () => (Math.random() < 0.5 ? 'T' : 'X');
  while (Object.keys(out).length < 400) {
    const L = 7 + (i % 4);
    let s = '';
    for (let k = 0; k < L; k++) s += gen();
    if (!out[s]) {
      const countT = (s.match(/T/g)||[]).length;
      const du_doan = (countT >= Math.ceil(L/2)) ? 'Tài' : 'Xỉu';
      const doTinCay = 65 + (countT % 10);
      out[s] = { du_doan, doTinCay, lyDo: `THUAT_TOAN_400 mẫu gen ${s}`, tong: [11] };
    }
    i++;
    if (i>2000) break;
  }
  return out;
}
const THUAT_TOAN_400 = buildThuậtToan400();

// ------------------ CAU_MAU (patterns) ------------------
const CAU_MAU = {
  "1-1": ["TXTX", "XTXT", "TXTXT", "XTXTX"],
  "2-2": ["TTXXTT", "XXTTXX"],
  "3-3": ["TTTXXX", "XXXTTT"],
  "1-2-3": ["TXXTTT", "XTTXXX"],
  "3-2-1": ["TTTXXT", "XXXTTX"],
  "1-2-1": ["TXXT", "XTTX"],
  "2-1-1-2": ["TTXTXX", "XXTXTT"],
  "1-2": ["TXX", "XTT"],
  "2-1": ["TTX", "XXT"],
  "3-1-2": ["TTTXTT"]
};

// ------------------ Markov functions ------------------
function rebuildMarkov(allResults) {
  for (let k = 1; k <= 10; k++) markovCounts[k] = {};
  if (!allResults || allResults.length < 2) return;
  const tx = allResults.map(asTX);
  for (let k = 1; k <= 10; k++) {
    if (tx.length <= k) continue;
    for (let i = 0; i < tx.length - k; i++) {
      const pattern = tx.slice(i, i + k).join('');
      const nxt = tx[i + k];
      const out = fromTX(nxt);
      markovCounts[k][pattern] = markovCounts[k][pattern] || { 'Tài': 0, 'Xỉu': 0 };
      markovCounts[k][pattern][out] += 1;
    }
  }
}
function updateMarkovIncremental(allResults) {
  if (!allResults || allResults.length < 2) return;
  const tx = allResults.map(asTX);
  for (let k = 1; k <= 10; k++) {
    if (tx.length > k) {
      const pattern = tx.slice(-(k + 1), -1).join('');
      const nxt = tx[tx.length - 1];
      const out = fromTX(nxt);
      markovCounts[k][pattern] = markovCounts[k][pattern] || { 'Tài': 0, 'Xỉu': 0 };
      markovCounts[k][pattern][out] += 1;
    }
  }
}
function markovPredict(results) {
  if (!results || results.length < 2) return { probT: 0.5, info: "Markov: thiếu dữ liệu", cover: 0 };
  const tx = results.map(asTX);
  let aggWeight = 0;
  let aggProbT = 0;
  let totalFollowers = 0;
  const details = [];
  for (let k = 1; k <= 10; k++) {
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
  const info = `Markov[${details.slice(0, 6).join(',')}${details.length > 6 ? ',...' : ''}]`;
  return { probT, info, cover: totalFollowers };
}

// ------------------ Pattern / Sliding window ------------------
function slidingWindowVotes(results, maxWindow = 6) {
  const seq = results.map(asTX);
  const nseq = seq.length;
  let totalVote = { 'Tài': 0, 'Xỉu': 0 };
  for (let w = 2; w <= maxWindow; w++) {
    if (nseq <= w) continue;
    const recent = seq.slice(-w).join('');
    for (let i = 0; i <= nseq - w - 1; i++) {
      const patt = seq.slice(i, i + w).join('');
      if (patt === recent) {
        const nxt = seq[i + w];
        totalVote[fromTX(nxt)] += 1;
      }
    }
  }
  return totalVote;
}

// ------------------ Local & Global freq ------------------
function localTrend(results, lookback = 10) {
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

// ------------------ duDoanTheoCau (AI self-learn) ------------------
function duDoanTheoCau(data_kq, dem_sai = 0, pattern_sai = [], xx = "0-0-0", diem_lich_su = [], data = {}) {
  if (!Array.isArray(data_kq) || data_kq.length === 0) return null;
  const cuoi = data_kq[data_kq.length - 1];
  const pattern = data_kq.map(x => (x === "Tài" ? "T" : "X")).join("");
  const xx_list = typeof xx === "string" ? xx.split("-").map(n => parseInt(n) || 0) : [0, 0, 0];
  const tong = xx_list.reduce((a, b) => a + b, 0);
  const ben = doBen(data_kq);

  // 1. THUAT_TOAN_400
  if (THUAT_TOAN_400[pattern]) {
    const p = THUAT_TOAN_400[pattern];
    return { predict: p.du_doan, confidence: p.doTinCay, explain: p.lyDo };
  }

  // 2. pattern_memory
  const pattern_memory = data.pattern_memory || {};
  let matched_pattern = null;
  let matched_confidence = 0;
  let matched_pred = null;
  for (let pat in pattern_memory) {
    if (pattern.endsWith(pat)) {
      const stats = pattern_memory[pat];
      const count = stats.count || 0;
      const correct = stats.correct || 0;
      const confidence = count > 0 ? correct / count : 0;
      if (confidence > matched_confidence && count >= 3 && confidence >= 0.6) {
        matched_confidence = confidence;
        matched_pattern = pat;
        matched_pred = stats.next_pred;
      }
    }
  }
  if (matched_pattern && matched_pred) {
    const score = 90 + Math.floor(matched_confidence * 10);
    return { predict: matched_pred, confidence: score, explain: `Dự đoán theo mẫu cầu đã học '${matched_pattern}' với tin cậy ${matched_confidence.toFixed(2)}` };
  }

  // 3. error_memory
  if (data_kq.length >= 3) {
    const last3 = data_kq.slice(-3).join(',');
    if (data.error_memory[last3] >= 2) {
      const du_doan_tx = cuoi === 'Tài' ? 'Xỉu' : 'Tài';
      return { predict: du_doan_tx, confidence: 89, explain: `AI tự học lỗi: mẫu [${last3}] đã gây sai nhiều lần → Đổi sang ${du_doan_tx}` };
    }
  }

  // 4. Sai liên tiếp
  if (dem_sai >= 3) {
    const du_doan_tx = cuoi === 'Tài' ? 'Xỉu' : 'Tài';
    return { predict: du_doan_tx, confidence: 88, explain: `Sai ${dem_sai} lần liên tiếp → Đổi chiều` };
  }

  // 5. Bệt
  if (ben >= 3) {
    if (cuoi === 'Tài') {
      if (ben >= 5 && !xx_list.includes(3)) {
        if (!data.da_be_tai) {
          data.da_be_tai = true;
          return { predict: 'Xỉu', confidence: 80, explain: '⚠️ Bệt Tài ≥5 chưa có xx3 → Bẻ thử' };
        } else {
          return { predict: 'Tài', confidence: 90, explain: 'Ôm tiếp bệt Tài chờ xx3' };
        }
      } else if (xx_list.includes(3)) {
        data.da_be_tai = false;
        return { predict: 'Xỉu', confidence: 95, explain: 'Bệt Tài + Xí ngầu 3 → Bẻ' };
      }
    } else if (cuoi === 'Xỉu') {
      if (ben >= 5 && !xx_list.includes(5)) {
        if (!data.da_be_xiu) {
          data.da_be_xiu = true;
          return { predict: 'Tài', confidence: 80, explain: '⚠️ Bệt Xỉu ≥5 chưa có xx5 → Bẻ thử' };
        } else {
          return { predict: 'Xỉu', confidence: 90, explain: 'Ôm tiếp bệt Xỉu chờ xx5' };
        }
      } else if (xx_list.includes(5)) {
        data.da_be_xiu = false;
        return { predict: 'Tài', confidence: 95, explain: 'Bệt Xỉu + Xí ngầu 5 → Bẻ' };
      }
    }
    return { predict: cuoi, confidence: 93, explain: `Bệt ${cuoi} (${ben} tay)` };
  }

  // 6. CAU_MAU
  for (let loai in CAU_MAU) {
    for (let mau of CAU_MAU[loai]) {
      if (pattern.endsWith(mau)) {
        const du_doan_tx = cuoi === 'Tài' ? 'Xỉu' : 'Tài';
        return { predict: du_doan_tx, confidence: 90, explain: `Phát hiện cầu ${loai}` };
      }
    }
  }

  // 7. AI tự học (CauMoi) - nếu pattern đã học
  if (CauMoi[pattern]) {
    const cm = CauMoi[pattern];
    return { predict: cm.ketQua, confidence: cm.doTinCay, explain: cm.lyDo };
  }

  // 8. Fallback: guess by total
  const du_doan = tong >= 11 ? 'Tài' : 'Xỉu';
  const doTinCay = 72;
  const lyDo = `Fallback: dựa trên tổng ${tong}`;
  // create learning entry
  CauMoi[pattern] = { ketQua: du_doan, doTinCay, pattern, lyDo };
  return { predict: du_doan, confidence: doTinCay, explain: lyDo };
}

// ------------------ Bayes algorithm ------------------
function bayesPrediction(history, featureLen = 6) {
  // Use last featureLen results as the feature vector
  if (!history || history.length < 3) return { du_doan: 'Tài', doTinCay: 50, explain: 'Bayes: thiếu dữ liệu' };
  const L = Math.min(featureLen, history.length - 1);
  const seq = history.map(asTX);
  const targetFeature = seq.slice(-L).join('');
  // Compute priors
  const priorT = history.filter(r => r === 'Tài').length / history.length;
  const priorX = 1 - priorT;
  // Likelihood: count occurrences of feature preceding a T or X
  let countFeatureGivenT = 0, countFeatureGivenX = 0, totalT = 0, totalX = 0;
  for (let i = 0; i <= seq.length - L - 1; i++) {
    const patt = seq.slice(i, i + L).join('');
    const nxt = seq[i + L];
    if (patt === targetFeature) {
      if (nxt === 'T') countFeatureGivenT++;
      else countFeatureGivenX++;
    }
    if (nxt === 'T') totalT++; else totalX++;
  }
  // Laplace smoothing
  const likelihoodT = (countFeatureGivenT + 1) / ( (countFeatureGivenT + countFeatureGivenX) + 2 );
  const likelihoodX = (countFeatureGivenX + 1) / ( (countFeatureGivenT + countFeatureGivenX) + 2 );
  // posterior (unnormalized)
  const postT = likelihoodT * (priorT || 0.5);
  const postX = likelihoodX * (priorX || 0.5);
  const evidence = postT + postX || 1;
  const posteriorT = postT / evidence;
  const posteriorX = postX / evidence;
  const predict = posteriorT >= posteriorX ? 'Tài' : 'Xỉu';
  const conf = Math.round(Math.max(0.5, Math.abs(posteriorT - posteriorX)) * 100);
  const explain = `Bayes: P(T|feat)=${(posteriorT*100).toFixed(1)}% P(X|feat)=${(posteriorX*100).toFixed(1)}% (feature=${targetFeature})`;
  return { du_doan: predict, doTinCay: clamp(conf, 50, 99), explain, posteriorT, posteriorX };
}

// ------------------ Monte Carlo algorithm ------------------
function monteCarloEstimate(history, diceHistory, sims = 2000) {
  // We'll estimate P(Tài) by simulating next roll based on empirical dice distribution
  // Build empirical distribution for each die face from diceHistory (array of [a,b,c])
  let counts = [Array(6).fill(1), Array(6).fill(1), Array(6).fill(1)]; // Laplace smoothing (1)
  diceHistory.forEach(d => {
    if (!d || !Array.isArray(d) || d.length < 3) return;
    for (let i = 0; i < 3; i++) {
      const v = Number(d[i]) || 1;
      if (v >= 1 && v <= 6) counts[i][v - 1] += 1;
    }
  });
  // create cumulative distributions
  const cdfs = counts.map(arr => {
    const total = arr.reduce((a,b)=>a+b,0);
    let c = 0;
    return arr.map(x => { c += x/total; return c; });
  });
  let tai = 0;
  for (let s = 0; s < sims; s++) {
    const r = [];
    for (let i = 0; i < 3; i++) {
      const u = Math.random();
      const face = cdfs[i].findIndex(v => v >= u) + 1;
      r.push(face);
    }
    const total = r[0] + r[1] + r[2];
    if (total >= 11) tai++;
  }
  const probT = tai / sims;
  const conf = Math.round(clamp((Math.abs(probT - 0.5) * 2) * 100, 20, 98)); // confidence heuristic
  return { probT, doTinCay: conf, explain: `MonteCarlo ${sims} sims, P(T)=${(probT*100).toFixed(1)}%` };
}

// ------------------ 7 AI cầu (experts) ------------------
function ai_cau_bet(results) {
  // if last N all same -> follow or break depending
  const streak = currentStreak(results);
  if (streak.len >= 4) {
    // suggests change with moderate confidence
    return { predict: streak.side === 'Tài' ? 'Xỉu' : 'Tài', conf: 78, reason: `AI_cau_bet: bệt ${streak.side} ${streak.len}` };
  }
  return { predict: results[results.length-1], conf: 60, reason: 'AI_cau_bet: no strong bệt' };
}
function ai_cau_dao(results) {
  // detects alternating patterns
  if (results.length < 6) return { predict: results[results.length-1], conf: 50, reason: 'AI_cau_dao: not enough' };
  const seq = results.slice(-6).map(asTX).join('');
  const isAlt = seq.match(/^(TX){3}$/) || seq.match(/^(XT){3}$/);
  if (isAlt) return { predict: results[results.length-1] === 'Tài' ? 'Xỉu' : 'Tài', conf: 76, reason: 'AI_cau_dao: alternating' };
  return { predict: results[results.length-1], conf: 48, reason: 'AI_cau_dao: none' };
}
function ai_cau_312(results) {
  // look for 3-1 pattern
  const seq = results.map(asTX).join('');
  if (seq.endsWith('TTTX')) return { predict: 'Tài', conf: 72, reason: 'AI_cau_312: TTTX' };
  if (seq.endsWith('XXXT')) return { predict: 'Xỉu', conf: 72, reason: 'AI_cau_312: XXXT' };
  return { predict: results[results.length-1], conf: 50, reason: 'AI_cau_312: none' };
}
function ai_cau_sonha(results) {
  // numeric feature: count of T in last 10
  const last = results.slice(-10);
  const cT = last.filter(x=>x==='Tài').length;
  if (cT >= 7) return { predict: 'Xỉu', conf: 68, reason: 'AI_cau_sonha: T quá nhiều' };
  if (cT <= 3) return { predict: 'Tài', conf: 68, reason: 'AI_cau_sonha: X quá nhiều' };
  return { predict: results[results.length-1], conf: 50, reason: 'AI_cau_sonha: neutral' };
}
function ai_cau_dice_repeat(diceHistory) {
  // if identical dice triple appears often, favor that side
  if (!diceHistory || diceHistory.length < 3) return { predict: 'Tài', conf: 50, reason: 'AI_cau_dice_repeat: not enough' };
  const map = {};
  diceHistory.slice(-50).forEach(d => {
    const key = d.join('-');
    map[key] = (map[key]||0) + 1;
  });
  const top = Object.entries(map).sort((a,b)=>b[1]-a[1])[0];
  if (!top) return { predict: 'Tài', conf: 50, reason: 'AI_cau_dice_repeat: none' };
  const faces = top[0].split('-').map(n=>Number(n));
  const tot = faces.reduce((a,b)=>a+b,0);
  const pred = tot >= 11 ? 'Tài' : 'Xỉu';
  return { predict: pred, conf: 65, reason: `AI_cau_dice_repeat: common ${top[0]} x${top[1]}` };
}
function ai_cau_song(results, totalsHistory) {
  // detects up/down wave: if totals alternate increasing/decreasing
  if (!totalsHistory || totalsHistory.length < 6) return { predict: results[results.length-1], conf: 50, reason: 'AI_cau_song: not enough' };
  const last5 = totalsHistory.slice(-5);
  let up = 0, down = 0;
  for (let i = 1; i < last5.length; i++) {
    if (last5[i] > last5[i-1]) up++; else if (last5[i] < last5[i-1]) down++;
  }
  if (up >= 3) return { predict: 'Tài', conf: 66, reason: 'AI_cau_song: trending up' };
  if (down >= 3) return { predict: 'Xỉu', conf: 66, reason: 'AI_cau_song: trending down' };
  return { predict: results[results.length-1], conf: 50, reason: 'AI_cau_song: neutral' };
}
function ai_cau_bias_near(results) {
  // bias on last 10
  const last = results.slice(-10);
  const cT = last.filter(r=>r==='Tài').length;
  const predict = cT >= 6 ? 'Tài' : (cT <= 4 ? 'Xỉu' : results[results.length-1]);
  const conf = 50 + Math.abs(cT - 5) * 5;
  return { predict, conf: clamp(conf, 45, 90), reason: `AI_cau_bias_near: last10_T=${cT}` };
}

// ------------------ smartPatternAnalysis (combine pattern votes) ------------------
function smartPatternAnalysis(results, dice, total, store) {
  const labels = [];
  const vote = { 'Tài': 0.0, 'Xỉu': 0.0 };
  const n = results.length;
  if (!n) {
    labels.push("Không có dữ liệu");
    return { labels, vote };
  }
  const pattern = results.map(asTX).join('');
  // THUAT_TOAN_400
  if (THUAT_TOAN_400[pattern]) {
    const p = THUAT_TOAN_400[pattern];
    labels.push(p.lyDo);
    vote[p.du_doan] += p.doTinCay * 0.6;
  }
  // bệt
  const streak = currentStreak(results);
  if (streak.len >= 3) {
    labels.push(`Cầu bệt ${streak.side} (${streak.len})`);
    const s = Math.min(12.0 + (streak.len - 3) * 2.5, 28.0);
    vote[streak.side] += s;
  }
  // CAU_MAU
  for (let loai in CAU_MAU) {
    for (let mau of CAU_MAU[loai]) {
      if (pattern.endsWith(mau)) {
        labels.push(`Cầu ${loai}`);
        const nextSide = results[n - 1] === 'Tài' ? 'Xỉu' : 'Tài';
        vote[nextSide] += 18.0;
      }
    }
  }
  // Sliding window
  const swVotes = slidingWindowVotes(results, 6);
  vote['Tài'] += swVotes['Tài'] * 2.0;
  vote['Xỉu'] += swVotes['Xỉu'] * 2.0;
  if (swVotes['Tài'] + swVotes['Xỉu'] > 0) labels.push(`SlidingWindow:${swVotes['Tài']}/${swVotes['Xỉu']}`);
  // AI self-learn
  const aiResult = duDoanTheoCau(results, store.dem_sai, store.pattern_sai, dice, store.diem_lich_su, store);
  if (aiResult) {
    labels.push(aiResult.explain || aiResult.lyDo || 'AI tự học');
    vote[aiResult.predict || aiResult.du_doan] += (aiResult.confidence || aiResult.doTinCay || 75) * 0.35;
  }
  if (!labels.length) labels.push("Không có cầu rõ ràng");
  return { labels, vote };
}

// ------------------ aiSelfLearnProb wrapper ------------------
function aiSelfLearnProb(results, dice, total, store) {
  const ai = duDoanTheoCau(results, store.dem_sai, store.pattern_sai, dice, store.diem_lich_su, store);
  if (!ai) return { probT: 0.5, confidence: 50, explain: 'AI self-learn no data' };
  const probT = (ai.predict === 'Tài' || ai.du_doan === 'Tài') ? (ai.confidence / 100) : (1 - ai.confidence / 100);
  return { probT, confidence: ai.confidence, explain: ai.explain || ai.lyDo || '' };
}

// ------------------ Combine Votes (ensemble of many algos) ------------------
function combineVotes(probMarkov, patternVote, probLocal, probGlobal, probAI, probTT400, probBayes, probMC, coverMarkov, nLocal, nGlobal, bridgesLabels, expertVotes) {
  // patternVote: scores sT/sX
  const sT = patternVote['Tài'] || 0;
  const sX = patternVote['Xỉu'] || 0;
  const probPattern = (sT === 0 && sX === 0) ? 0.5 : softmax2(sT, sX, 12.0);

  // weights adjusted by coverage
  const wM = 0.5 + Math.min(0.5, Math.log2(1 + coverMarkov) / 5.0);
  const wL = 0.5 + Math.min(0.5, Math.log2(1 + nLocal) / 5.0);
  const wG = 0.5 + Math.min(0.5, Math.log2(1 + nGlobal) / 5.0);
  const wAI = 0.7;
  const wTT400 = 0.8;

  const WM = W_MARKOV * wM;
  const WP = W_PATTERN;
  const WL = W_LOCAL_TREND * wL;
  const WG = W_GLOBAL_FREQ * wG;
  const WAI = W_AI_SELF_LEARN * wAI;
  const WTT400 = W_THUAT_TOAN_400 * wTT400;
  const WBAYES = W_BAYES;
  const WMC = W_MONTECARLO;

  const denom = (WM + WP + WL + WG + WAI + WTT400 + WBAYES + WMC) || 1.0;

  let p = (probMarkov * WM + probPattern * WP + probLocal * WL + probGlobal * WG + probAI * WAI + probTT400 * WTT400 + probBayes * WBAYES + probMC * WMC) / denom;

  // integrate expertVotes (7 experts) as small bonuses
  let expertScore = 0;
  let expertTotalWeight = 0;
  for (let ev of expertVotes) {
    const sign = (ev.predict === 'Tài') ? 1 : -1;
    expertScore += sign * (ev.conf / 100);
    expertTotalWeight += 1;
  }
  if (expertTotalWeight > 0) {
    const exAdj = (expertScore / expertTotalWeight) * 0.03; // small bias
    p = clamp(p + exAdj, 0.01, 0.99);
  }

  const H = entropyBinary(p);
  let conf = (1.0 - H) * 100.0;

  const clearCount = bridgesLabels.filter(b => b !== 'Không có cầu rõ ràng').length;
  if (clearCount) conf *= Math.min(1.15, 1.03 + 0.03 * clearCount);
  else conf *= 0.98;

  conf += 5.0;
  conf = clamp(conf, CONF_MIN, CONF_MAX);

  const predict = p >= 0.5 ? 'Tài' : 'Xỉu';
  return { predict, confidence: Number(conf.toFixed(2)), probPattern, p };
}

// ------------------ Main predictVip (assemble everything) ------------------
function predictVip(results, diceStr, total) {
  if (!results || !results.length) return { predict: 'Tài', do_tin_cay: '50.0%', explain: 'Chưa có dữ liệu.' };

  // parse diceStr into array
  const dice = (typeof diceStr === 'string') ? diceStr.split('-').map(s=>parseInt(s)||0) : (Array.isArray(diceStr)?diceStr:[0,0,0]);
  const totalsHistory = store.history.map(h => h.total || ( (h.dice && Array.isArray(h.dice)) ? h.dice.reduce((a,b)=>a+(b||0),0) : null )).filter(x=>x!=null);

  // pattern analysis
  const { labels, vote } = smartPatternAnalysis(results, dice, total, store);

  // Markov
  const mk = markovPredict(results);
  // local & global
  const local = localTrend(results, 20);
  const global = globalFreq(results);
  // AI self-learn
  const ai = aiSelfLearnProb(results, dice, total, store);
  // THUAT_TOAN_400 prob
  const tt400 = (function(){
    const pattern = results.map(asTX).join('');
    if (THUAT_TOAN_400[pattern]) {
      const p = THUAT_TOAN_400[pattern];
      const probT = (p.du_doan === 'Tài') ? p.doTinCay/100 : (1 - p.doTinCay/100);
      return { probT, confidence: p.doTinCay, explain: p.lyDo };
    }
    return { probT: 0.5, confidence: 0, explain: 'Không tìm thấy' };
  })();

  // Bayes
  const bay = bayesPrediction(results, 6);

  // Monte Carlo
  const diceHistory = store.history.map(h => (h.dice && Array.isArray(h.dice)) ? h.dice : (typeof h.dice === 'string' ? h.dice.split('-').map(n=>parseInt(n)||1) : [1,1,1]));
  const mc = monteCarloEstimate(results, diceHistory, 1800);

  // 7 experts
  const experts = [
    ai_cau_bet(results),
    ai_cau_dao(results),
    ai_cau_312(results),
    ai_cau_sonha(results),
    ai_cau_dice_repeat(diceHistory),
    ai_cau_song(results, totalsHistory),
    ai_cau_bias_near(results)
  ];

  // convert experts to standard format (predict/conf/reason)
  const expertVotes = experts.map(e => ({ predict: e.predict, conf: e.conf || e.doTinCay || 50, reason: e.reason || '' }));

  // combine votes
  const merged = combineVotes(mk.probT, vote, local.prob, global.prob, ai.probT, tt400.probT, bay.posteriorT || (bay.du_doan==='Tài'?bay.doTinCay/100:1-bay.doTinCay/100), mc.probT, mk.cover, local.n, global.n, labels, expertVotes);

  // Build detailed meta
  const meta = {
    markov: mk,
    pattern_vote: vote,
    labels,
    local,
    global,
    ai_selflearn: ai,
    thuat_toan_400: tt400,
    bayes: bay,
    montecarlo: mc,
    experts: expertVotes
  };

  const explain = `Mẫu cầu: ${labels.join('; ')}. Markov:${(mk.probT*100).toFixed(1)}% (${mk.info}). Bayes:${(bay.posteriorT? (bay.posteriorT*100).toFixed(1)+'%': bay.doTinCay+'%')}. MonteCarlo:${(mc.probT*100).toFixed(1)}%. THUAT_TOAN_400:${(tt400.probT*100).toFixed(1)}%. AI-self:${(ai.probT*100).toFixed(1)}%. Experts: ${expertVotes.map(e=>`${e.predict}(${e.conf})`).join(', ')}. Chốt: ${merged.predict} ${merged.confidence}%`;

  return { predict: merged.predict, do_tin_cay: `${merged.confidence.toFixed(1)}%`, explain, meta };
}

// ------------------ Poller ------------------
async function pollOnce() {
  try {
    const res = await fetch(POLL_URL, { timeout: 9000 });
    const data = await res.json();

    const phien = data.Phien || data.phien || data.session || data.id;
    const xa1 = data.Xuc_xac_1 || data.xuc_xac_1 || data.x1 || (data.dice && data.dice[0]);
    const xa2 = data.Xuc_xac_2 || data.xuc_xac_2 || data.x2 || (data.dice && data.dice[1]);
    const xa3 = data.Xuc_xac_3 || data.xuc_xac_3 || data.x3 || (data.dice && data.dice[2]);
    const total = data.Tong || data.tong || data.total || (xa1 != null && xa2 != null && xa3 != null ? (Number(xa1 || 0) + Number(xa2 || 0) + Number(xa3 || 0)) : null);
    let ket_qua = data.Ket_qua || data.ket_qua || data.result || null;
    if (ket_qua) {
      ket_qua = (String(ket_qua).toLowerCase().includes('t')) ? 'Tài' : 'Xỉu';
    } else if (total != null) {
      const t = Number(total);
      ket_qua = (t >= 11) ? 'Tài' : 'Xỉu';
    }

    if (!phien || !ket_qua) {
      return { ok: false, reason: 'Không đủ dữ liệu từ API' };
    }

    if (lastPhien == null || phien > lastPhien) {
      const entry = { phien, ket_qua, dice: [xa1, xa2, xa3], total, time: new Date().toISOString() };
      store.history.push(entry);
      store.pattern += (asTX(ket_qua) === 'T' ? 'T' : 'X');
      if (store.pattern.length > 1000) store.pattern = store.pattern.slice(-1000);
      if (store.history.length > MAX_HISTORY) store.history = store.history.slice(-MAX_HISTORY);
      lastPhien = phien;
      updateMarkovIncremental(store.history.map(h => h.ket_qua));

      // update pattern_memory naive
      const results = store.history.map(h => h.ket_qua);
      if (results.length > 1) {
        const prevPattern = results.slice(-2, -1).map(asTX).join('');
        const actual = results[results.length - 1];
        if (!store.pattern_memory[prevPattern]) store.pattern_memory[prevPattern] = { count: 0, correct: 0, next_pred: actual };
        store.pattern_memory[prevPattern].count += 1;
        store.pattern_memory[prevPattern].correct += 1;
        store.pattern_memory[prevPattern].next_pred = actual;

        // update CauMoi
        const patternStr = results.map(asTX).join('');
        if (!CauMoi[patternStr] && results.length >= 4) {
          const du_doan = total >= 11 ? 'Tài' : 'Xỉu';
          const doTinCay = 70 + Math.floor(Math.random() * 25);
          const lyDo = `AI tự học → cầu ${tinhLyDo(patternStr)} với tổng ${total}`;
          CauMoi[patternStr] = { ketQua: du_doan, doTinCay, pattern: patternStr, lyDo };
        }
      }

      store.cau_moi = CauMoi;
      saveDataAtomic(store);
      return { ok: true, new: true, phien };
    } else {
      return { ok: true, new: false, phien };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

let pollingLoopRunning = false;
async function startPollingLoop() {
  if (pollingLoopRunning) return;
  pollingLoopRunning = true;
  // rebuild markov from existing history
  rebuildMarkov(store.history.map(h => h.ket_qua));
  while (true) {
    const r = await pollOnce();
    await sleep(POLL_INTERVAL_MS);
  }
}
startPollingLoop();

// ------------------ Express API ------------------
const app = express();
app.use(bodyParser.json());

app.get('/predict', async (req, res) => {
  if (!store.history.length) return res.status(503).json({ error: 'No data available yet. Waiting for poll.' });
  const results = store.history.map(h => h.ket_qua);
  const latest = store.history[store.history.length - 1];
  const dice = latest.dice.join('-');
  const total = latest.total;
  const out = predictVip(results, dice, total);

  let latestRemote = {};
  try {
    const r = await fetch(POLL_URL, { timeout: 8000 });
    latestRemote = await r.json();
  } catch (e) {
    latestRemote = {};
  }

  const session = latestRemote.Phien || latestRemote.phien || (store.history.length ? store.history[store.history.length - 1].phien : null);
  const diceStr = `${latestRemote.Xuc_xac_1 || ''} - ${latestRemote.Xuc_xac_2 || ''} - ${latestRemote.Xuc_xac_3 || ''}`;
  const totalRemote = latestRemote.Tong || latestRemote.tong || (store.history.length ? store.history[store.history.length - 1].total : null);
  const result = latestRemote.Ket_qua || latestRemote.ket_qua || (store.history.length ? store.history[store.history.length - 1].ket_qua : null);
  const next_session = (typeof session === 'number') ? session + 1 : null;
  const pattern_str = store.pattern.slice(-20);

  res.json({
    session,
    dice: diceStr,
    total: totalRemote,
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

app.get('/stats', (req, res) => {
  const results = store.history.map(h => h.ket_qua);
  const n = results.length;
  const cT = results.filter(r => r === 'Tài').length;
  const cX = n - cT;
  const streak = currentStreak(results);
  const recent20 = results.slice(-20);
  const cT20 = recent20.filter(r => r === 'Tài').length;
  res.json({
    total_samples: n,
    tai_count: cT,
    xiu_count: cX,
    current_streak: streak.len,
    streak_side: streak.side,
    recent20_tai: cT20,
    recent20_xiu: recent20.length - cT20
  });
});

app.get('/history', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const out = store.history.slice(-limit);
  res.json({ count: out.length, history: out });
});

app.get('/poll', async (req, res) => {
  const r = await pollOnce();
  res.json(r);
});

app.post('/reset', (req, res) => {
  const body = req.body || {};
  if (!body.confirm) return res.status(400).json({ error: 'To reset send { "confirm": true }' });
  store = {
    history: [],
    pattern: "",
    pattern_memory: {},
    error_memory: {},
    dem_sai: 0,
    pattern_sai: [],
    diem_lich_su: [],
    da_be_tai: false,
    da_be_xiu: false,
    cau_moi: {}
  };
  CauMoi = {};
  for (let k = 1; k <= 10; k++) markovCounts[k] = {};
  lastPhien = null;
  saveDataAtomic(store);
  return res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taixiu VIP predictor (All-in-one) listening on http://0.0.0.0:${PORT}`);
  console.log(`Poll URL: ${POLL_URL} every ${POLL_INTERVAL_SEC}s`);
});
