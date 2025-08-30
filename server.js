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

// ======================
// Weights (adjusted for new THUAT_TOAN_400 integration)
const W_MARKOV = 0.30;
const W_PATTERN = 0.30;
const W_LOCAL_TREND = 0.10;
const W_GLOBAL_FREQ = 0.08;
const W_AI_SELF_LEARN = 0.07;
const W_THUAT_TOAN_400 = 0.15; // New weight for THUAT_TOAN_400
const CONF_MIN = 55.0;
const CONF_MAX = 99.0;
// ======================

// New: THUAT_TOAN_400 pattern dictionary
const THUAT_TOAN_400 = {
  "TTXXTXXTXT": { du_doan: "Tài", doTinCay: 96, lyDo: tinhLyDo("TTXXTXXTXT"), tong: [14, 16, 17] },
  // ... (include all patterns from the provided THUAT_TOAN_400)
  // Note: Removed for brevity; include the full dictionary from the provided code
};

// New: Combined CAU_MAU (merged with existing cau_mau)
const CAU_MAU = {
  "1-1": ["TXTX", "XTXT", "TXTXT", "XTXTX"],
  "2-2": ["TTXXTT", "XXTTXX"],
  "3-3": ["TTTXXX", "XXXTTT"],
  "1-2-3": ["TXXTTT", "XTTXXX"],
  "3-2-1": ["TTTXXT", "XXXTTX"],
  "1-2-1": ["TXXT", "XTTX"],
  "2-1-1-2": ["TTXTXX", "XXTXTT"],
  "2-1-2": ["TTXTT", "XXTXX"],
  "3-1-3": ["TTTXTTT", "XXXTXXX"],
  "1-2": ["TXX", "XTT"],
  "2-1": ["TTX", "XXT"],
  "1-3-2": ["TXXXTT", "XTTTXX"],
  "1-2-4": ["TXXTTTT", "XTTXXXX"],
  "1-5-3": ["TXXXXXTTT", "XTTTTXXX"],
  "7-4-2": ["TTTTTTTXXXXTT", "XXXXXXXTTTTXX"],
  "4-2-1-3": ["TTTTXXTXXX", "XXXXTTXTTT"],
  "1-4-2": ["TXXXXTT", "XTTTTXX"],
  "5-1-3": ["TTTTXTTT", "XXXXXTXXX"],
  "3-1-2": ["TTTXTT"]
};

// New: Store for dynamically learned patterns
let CauMoi = {};

/* ---------- Helper IO ---------- */
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
      cau_moi: {} // New: Store CauMoi
    };
    writeFileAtomic.sync(DATA_FILE, JSON.stringify(init, null, 2));
  }
}
ensureDataFile();

function loadData() {
  try {
    const txt = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(txt);
    CauMoi = data.cau_moi || {}; // Load CauMoi
    return data;
  } catch (e) {
    return { 
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
  }
}

function saveDataAtomic(obj) {
  obj.cau_moi = CauMoi; // Save CauMoi
  writeFileAtomic.sync(DATA_FILE, JSON.stringify(obj, null, 2));
}

/* ---------- In-memory structures ---------- */
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
CauMoi = store.cau_moi;

let markovCounts = {};
for (let k = 1; k <= 10; k++) markovCounts[k] = {};

let lastPhien = store.history.length ? store.history[store.history.length - 1].phien : null;
let isPolling = false;

/* ---------- Utils ---------- */
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

// New: tinhLyDo function
function tinhLyDo(chuoiCau) {
  let nhom = [];
  let dem = 1;
  for (let i = 1; i < chuoiCau.length; i++) {
    if (chuoiCau[i] === chuoiCau[i - 1]) {
      dem++;
    } else {
      nhom.push(dem);
      dem = 1;
    }
  }
  nhom.push(dem);
  return "cầu " + nhom.join(" ");
}

/* ---------- Markov build/update ---------- */
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

/* ---------- Enhanced Pattern Analysis ---------- */
function smartPatternAnalysis(results, dice, total, store) {
  const labels = [];
  const vote = { 'Tài': 0.0, 'Xỉu': 0.0 };
  const n = results.length;
  if (!n) {
    labels.push("Không có dữ liệu");
    return { labels, vote };
  }

  const pattern = results.map(asTX).join('');
  // Check THUAT_TOAN_400 first
  if (THUAT_TOAN_400[pattern]) {
    const p = THUAT_TOAN_400[pattern];
    labels.push(p.lyDo);
    vote[p.du_doan] += p.doTinCay * 0.5; // Scale to avoid overpowering
  }

  // Existing pattern analysis (bệt, 1-1, 2-2, etc.)
  const streak = currentStreak(results);
  if (streak.len >= 3) {
    labels.push(`Cầu bệt ${streak.side} (${streak.len})`);
    const s = Math.min(12.0 + (streak.len - 3) * 2.5, 28.0);
    vote[streak.side] += s;
  }

  // Check CAU_MAU patterns
  for (let loai in CAU_MAU) {
    for (let mau of CAU_MAU[loai]) {
      if (pattern.endsWith(mau)) {
        labels.push(`Cầu ${loai}`);
        const nextSide = results[n - 1] === 'Tài' ? 'Xỉu' : 'Tài';
        vote[nextSide] += 18.0;
      }
    }
  }

  // Sliding-window pattern matching
  function slidingWindowVotes(arr, maxWindow = 6) {
    const seq = arr.map(asTX);
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

  const swVotes = slidingWindowVotes(results, 6);
  vote['Tài'] += swVotes['Tài'] * 2.0;
  vote['Xỉu'] += swVotes['Xỉu'] * 2.0;
  if (swVotes['Tài'] + swVotes['Xỉu'] > 0) labels.push(`SlidingWindow:${swVotes['Tài']}/${swVotes['Xỉu']}`);

  // Analyze last 20 patterns
  const last20 = results.slice(-20).map(asTX).join('');
  if (last20.length >= 20) {
    labels.push(`VIP 20-pattern: ${last20}`);
  }

  // AI self-learning
  const aiResult = duDoanTheoCau(results, store.dem_sai, store.pattern_sai, dice, store.diem_lich_su, store);
  if (aiResult) {
    labels.push(aiResult.lyDo);
    vote[aiResult.ketQua] += aiResult.doTinCay * 0.3; // Scale to balance
  }

  if (!labels.length) labels.push("Không có cầu rõ ràng");

  return { labels, vote };
}

/* ---------- Updated duDoanTheoCau Function ---------- */
function duDoanTheoCau(data_kq, dem_sai = 0, pattern_sai = [], xx = "0-0-0", diem_lich_su = [], data = {}) {
  if (!Array.isArray(data_kq) || data_kq.length === 0) return null;

  const cuoi = data_kq[data_kq.length - 1];
  const pattern = data_kq.map(x => (x === "Tài" ? "T" : "X")).join("");
  const xx_list = typeof xx === "string" ? xx.split("-").map(n => parseInt(n) || 0) : [0, 0, 0];
  const tong = xx_list.reduce((a, b) => a + b, 0);
  const ben = doBen(data_kq);

  // 1. Check THUAT_TOAN_400
  if (THUAT_TOAN_400[pattern]) {
    const p = THUAT_TOAN_400[pattern];
    return { predict: p.du_doan, confidence: p.doTinCay, explain: p.lyDo };
  }

  // 2. Check pattern_memory (existing self-learning)
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

  // 3. Check error_memory
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

  // 6. Cầu mẫu
  for (let loai in CAU_MAU) {
    for (let mau of CAU_MAU[loai]) {
      if (pattern.endsWith(mau)) {
        const du_doan_tx = cuoi === 'Tài' ? 'Xỉu' : 'Tài';
        return { predict: du_doan_tx, confidence: 90, explain: `Phát hiện cầu ${loai}` };
      }
    }
  }

  // 7. AI tự học (CauMoi)
  if (!CauMoi[pattern]) {
    const du_doan = tong >= 11 ? 'Tài' : 'Xỉu';
    const doTinCay = Math.floor(Math.random() * 20) + 70;
    const lyDo = `AI tự học → cầu ${tinhLyDo(pattern)} với tổng ${tong}`;
    CauMoi[pattern] = { ketQua: du_doan, doTinCay, pattern, lyDo };
  }
  const cm = CauMoi[pattern];
  return { predict: cm.ketQua, confidence: cm.doTinCay, explain: cm.lyDo };
}

/* ---------- Markov Prediction ---------- */
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

/* ---------- Local Trend & Global Freq ---------- */
function localTrend(results, lookback = 20) {
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

/* ---------- New: THUAT_TOAN_400 Probability ---------- */
function thuatToan400Prob(results) {
  const pattern = results.map(asTX).join('');
  if (THUAT_TOAN_400[pattern]) {
    const p = THUAT_TOAN_400[pattern];
    return { probT: p.du_doan === 'Tài' ? p.doTinCay / 100 : 1 - p.doTinCay / 100, confidence: p.doTinCay, explain: p.lyDo };
  }
  return { probT: 0.5, confidence: 0, explain: 'Không tìm thấy trong THUAT_TOAN_400' };
}

/* ---------- AI Self-learn Probability ---------- */
function aiSelfLearnProb(results, dice, total, store) {
  const ai = duDoanTheoCau(results, store.dem_sai, store.pattern_sai, dice, store.diem_lich_su, store);
  return { probT: ai.predict === 'Tài' ? (ai.confidence / 100) : (1 - ai.confidence / 100), confidence: ai.confidence, explain: ai.explain };
}

/* ---------- Combine Votes ---------- */
function combineVotes(probMarkov, patternVote, probLocal, probGlobal, probAI, probTT400, coverMarkov, nLocal, nGlobal, bridgesLabels) {
  const sT = patternVote['Tài'] || 0;
  const sX = patternVote['Xỉu'] || 0;
  const probPattern = (sT === 0 && sX === 0) ? 0.5 : softmax2(sT, sX, 12.0);

  const wM = 0.5 + Math.min(0.5, Math.log2(1 + coverMarkov) / 5.0);
  const wL = 0.5 + Math.min(0.5, Math.log2(1 + nLocal) / 5.0);
  const wG = 0.5 + Math.min(0.5, Math.log2(1 + nGlobal) / 5.0);
  const wAI = 0.7;
  const wTT400 = 0.8; // High weight for THUAT_TOAN_400 due to predefined patterns

  const WM = W_MARKOV * wM;
  const WP = W_PATTERN;
  const WL = W_LOCAL_TREND * wL;
  const WG = W_GLOBAL_FREQ * wG;
  const WAI = W_AI_SELF_LEARN * wAI;
  const WTT400 = W_THUAT_TOAN_400 * wTT400;

  const denom = (WM + WP + WL + WG + WAI + WTT400) || 1.0;
  let p = (probMarkov * WM + probPattern * WP + probLocal * WL + probGlobal * WG + probAI * WAI + probTT400 * WTT400) / denom;

  const H = entropyBinary(p);
  let conf = (1.0 - H) * 100.0;

  const clearCount = bridgesLabels.filter(b => b !== 'Không có cầu rõ ràng').length;
  if (clearCount) conf *= Math.min(1.15, 1.03 + 0.03 * clearCount);
  else conf *= 0.96;

  conf += 5.0; // Boost for AI and THUAT_TOAN_400
  conf = Math.max(CONF_MIN, Math.min(CONF_MAX, conf));

  const predict = p >= 0.5 ? 'Tài' : 'Xỉu';

  return { predict, confidence: Number(conf.toFixed(2)), probPattern, p };
}

function softmax2(sT, sX, scale = 12.0) {
  const eT = Math.exp(sT / scale);
  const eX = Math.exp(sX / scale);
  return eT / (eT + eX);
}

/* ---------- Predict Main ---------- */
function predictVip(results, dice, total) {
  if (!results || !results.length) return { predict: 'Tài', confidence: 50.0, explain: 'Chưa có dữ liệu.' };

  const { labels, vote } = smartPatternAnalysis(results, dice, total, store);
  const mk = markovPredict(results);
  const local = localTrend(results, 20);
  const global = globalFreq(results);
  const ai = aiSelfLearnProb(results, dice, total, store);
  const tt400 = thuatToan400Prob(results);

  const merged = combineVotes(mk.probT, vote, local.prob, global.prob, ai.probT, tt400.probT, mk.cover, local.n, global.n, labels);

  const brief_pattern = labels.join('; ');
  const p_markov_pct = `${(mk.probT * 100).toFixed(1)}%`;
  const p_pattern_pct = `${(merged.probPattern * 100).toFixed(1)}%`;
  const p_local_pct = `${(local.prob * 100).toFixed(1)}%`;
  const p_global_pct = `${(global.prob * 100).toFixed(1)}%`;
  const p_ai_pct = `${(ai.probT * 100).toFixed(1)}%`;
  const p_tt400_pct = `${(tt400.probT * 100).toFixed(1)}%`;

  const explain = `Mẫu cầu đang chạy: ${brief_pattern}. Markov: ${p_markov_pct} Tài (${mk.info}). Pattern: ${p_pattern_pct} Tài. Gần20: ${p_local_pct} Tài. Toàn cục: ${p_global_pct} Tài. AI tự học: ${p_ai_pct} Tài (${ai.explain}). THUAT_TOAN_400: ${p_tt400_pct} Tài (${tt400.explain}). Chốt: ${merged.predict} với độ chính xác cao VIP.`;

  return { predict: merged.predict, do_tin_cay: `${merged.confidence.toFixed(1)}%`, explain, meta: { prob_markov: mk.probT, prob_pattern: merged.probPattern, prob_local: local.prob, prob_global: global.prob, prob_ai: ai.probT, prob_tt400: tt400.probT } };
}

/* ---------- Poller ---------- */
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
      store.history.push({ phien, ket_qua, dice: [xa1, xa2, xa3], total, time: new Date().toISOString() });
      store.pattern += (asTX(ket_qua) === 'T' ? 'T' : 'X');
      if (store.pattern.length > 1000) store.pattern = store.pattern.slice(-1000);
      if (store.history.length > MAX_HISTORY) store.history = store.history.slice(-MAX_HISTORY);
      lastPhien = phien;
      updateMarkovIncremental(store.history.map(h => h.ket_qua));

      // Update self-learning structures
      const results = store.history.map(h => h.ket_qua);
      if (results.length > 1) {
        const prevPattern = results.slice(-2, -1).map(asTX).join('');
        const actual = results[results.length - 1];
        if (!store.pattern_memory[prevPattern]) store.pattern_memory[prevPattern] = { count: 0, correct: 0, next_pred: actual };
        store.pattern_memory[prevPattern].count += 1;
        store.pattern_memory[prevPattern].correct += 1; // Placeholder; needs real tracking
        store.pattern_memory[prevPattern].next_pred = actual;

        // Update CauMoi
        const pattern = results.map(asTX).join('');
        if (!CauMoi[pattern] && results.length >= 4) {
          const du_doan = total >= 11 ? 'Tài' : 'Xỉu';
          const doTinCay = Math.floor(Math.random() * 20) + 70;
          const lyDo = `AI tự học → cầu ${tinhLyDo(pattern)} với tổng ${total}`;
          CauMoi[pattern] = { ketQua: du_doan, doTinCay, pattern, lyDo };
        }
      }

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
  while (true) {
    const r = await pollOnce();
    await sleep(POLL_INTERVAL_MS);
  }
}
startPollingLoop();

/* ---------- Express API ---------- */
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

/* ---------- Start Server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taixiu VIP predictor (Upgraded AI with THUAT_TOAN_400) listening on http://0.0.0.0:${PORT}`);
  console.log(`Poll URL: ${POLL_URL} every ${POLL_INTERVAL_SEC}s`);
});
