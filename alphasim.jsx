import { useState, useEffect, useCallback, useRef } from "react";

const SK = "alphasim_v8";
const STOP_PCT = 0.025;
const SLIP = 0.003;
const FEE = 0.001;
const TGT = 0.035;
const MAX_SWAPS = 2;
const GOAL = 0.03;
const LOSS_BUF = 0.20;
const START_GBP = 1000;
const FALLBACK_RATE = 1.27;
const WIN_A = ["09:30","10:30","12:00","14:00","15:30"];
const WIN_B = ["12:30","13:30","14:30","15:30"];

// Colour palette — no template literals, just plain strings
const BG      = "#ffffff";
const SURFACE = "#f8fafc";
const CARD    = "#ffffff";
const BDR     = "#e2e8f0";
const DIM     = "#cbd5e1";
const TXT     = "#0f172a";
const MUTED   = "#64748b";
const ACCENT  = "#0284c7";
const GREEN   = "#16a34a";
const RED     = "#dc2626";
const AMBER   = "#d97706";
const PURPLE  = "#7c3aed";

const UNIVERSE = [
  {symbol:"NVDA",name:"NVIDIA Corp",sector:"Technology"},
  {symbol:"AMD",name:"Advanced Micro Devices",sector:"Technology"},
  {symbol:"TSLA",name:"Tesla Inc",sector:"EV"},
  {symbol:"META",name:"Meta Platforms",sector:"Technology"},
  {symbol:"GOOGL",name:"Alphabet",sector:"Technology"},
  {symbol:"AMZN",name:"Amazon",sector:"Consumer"},
  {symbol:"MSFT",name:"Microsoft",sector:"Technology"},
  {symbol:"AAPL",name:"Apple Inc",sector:"Technology"},
  {symbol:"PLTR",name:"Palantir",sector:"AI"},
  {symbol:"SOFI",name:"SoFi Technologies",sector:"Financials"},
  {symbol:"COIN",name:"Coinbase",sector:"Crypto"},
  {symbol:"MSTR",name:"MicroStrategy",sector:"Crypto"},
  {symbol:"RIVN",name:"Rivian",sector:"EV"},
  {symbol:"SMCI",name:"Super Micro",sector:"Technology"},
  {symbol:"UPST",name:"Upstart",sector:"Financials"},
  {symbol:"AFRM",name:"Affirm",sector:"Financials"},
  {symbol:"HOOD",name:"Robinhood",sector:"Financials"},
  {symbol:"SOUN",name:"SoundHound AI",sector:"AI"},
  {symbol:"CVNA",name:"Carvana",sector:"Consumer"},
  {symbol:"UBER",name:"Uber",sector:"Consumer"},
  {symbol:"XOM",name:"Exxon Mobil",sector:"Energy"},
  {symbol:"ENPH",name:"Enphase Energy",sector:"Energy"},
  {symbol:"JPM",name:"JPMorgan",sector:"Financials"},
  {symbol:"MRNA",name:"Moderna",sector:"Healthcare"},
  {symbol:"FCX",name:"Freeport-McMoRan",sector:"Materials"},
  {symbol:"CAT",name:"Caterpillar",sector:"Industrials"},
  {symbol:"BA",name:"Boeing",sector:"Industrials"},
  {symbol:"IONQ",name:"IonQ",sector:"Technology"},
  {symbol:"PATH",name:"UiPath",sector:"AI"},
  {symbol:"LCID",name:"Lucid Group",sector:"EV"},
];

const BASE_PRICES = {NVDA:118,AMD:112,TSLA:245,META:590,GOOGL:175,AMZN:205,MSFT:415,AAPL:192,PLTR:27,SOFI:15,COIN:215,MSTR:380,RIVN:11,SMCI:44,UPST:68,AFRM:48,HOOD:43,SOUN:8,CVNA:290,UBER:78,XOM:111,ENPH:62,JPM:255,MRNA:38,FCX:41,CAT:380,BA:175,IONQ:12,PATH:28,LCID:3};

const HOLIDAYS = ["2025-01-01","2025-01-20","2025-02-17","2025-04-18","2025-05-26","2025-07-04","2025-09-01","2025-11-27","2025-12-25","2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-07-03","2026-09-07","2026-11-26","2026-12-25"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function etNow() {
  const s = new Date().toLocaleString("en-US", {timeZone:"America/New_York"});
  const d = new Date(s);
  const p = n => String(n).padStart(2,"0");
  const dateStr = d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate());
  return {dateStr, mins: d.getHours()*60+d.getMinutes(), day: d.getDay(), h: d.getHours(), m: d.getMinutes()};
}
function mktOpen() {
  const {dateStr,day,mins} = etNow();
  return day > 0 && day < 6 && !HOLIDAYS.includes(dateStr) && mins >= 570 && mins < 960;
}
function mktDay() {
  const {dateStr,day} = etNow();
  return day > 0 && day < 6 && !HOLIDAYS.includes(dateStr);
}
function getMktStatus() {
  const {dateStr,day,mins} = etNow();
  if (day === 0 || day === 6) return {s:"closed", label:"Weekend — Closed"};
  if (HOLIDAYS.includes(dateStr)) return {s:"closed", label:"Holiday — Closed"};
  if (mins < 570) {
    const d = 570 - mins;
    return {s:"pre", label:"Pre-Market · Opens in " + Math.floor(d/60) + "h " + (d%60) + "m"};
  }
  if (mins >= 960) return {s:"closed", label:"After Hours — Closed"};
  const r = 960 - mins;
  return {s:"open", label:"Live · Closes in " + Math.floor(r/60) + "h " + (r%60) + "m"};
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function usd(n) { return "$" + Math.abs(n).toFixed(2); }
function pct(n) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function signed(n) { return (n >= 0 ? "+" : "") + usd(n); }

// ─── API Queue (4 calls/min) ──────────────────────────────────────────────────
const AQ = [];
let AQrunning = false;
function enq(fn) {
  return new Promise((ok, err) => {
    AQ.push({fn, ok, err});
    if (!AQrunning) runAQ();
  });
}
async function runAQ() {
  AQrunning = true;
  while (AQ.length) {
    const {fn, ok, err} = AQ.shift();
    try { ok(await fn()); } catch(e) { err(e); }
    if (AQ.length) await sleep(15000);
  }
  AQrunning = false;
}
async function polyGet(ep, key) {
  const r = await fetch("https://api.polygon.io" + ep + "&apiKey=" + key);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function apicall(ep, key) { return enq(() => polyGet(ep, key)); }

async function testKey(key) {
  if (!key) return {ok:false, msg:"No key — running in demo mode"};
  try {
    const d = await polyGet("/v1/conversion/GBP/USD?amount=1&precision=4&apiKey=" + key, key);
    if (d && d.converted) return {ok:true, msg:"Connected — live data active. GBP/USD " + d.converted.toFixed(4), rate:d.converted};
    if (d && d.status === "ERROR") return {ok:false, msg:"API error: " + (d.error || "Invalid key")};
    return {ok:false, msg:"Unexpected API response — using demo mode"};
  } catch(e) {
    const m = e.message || "";
    if (m.includes("403")) return {ok:false, msg:"Invalid API key (403) — using demo mode"};
    if (m.includes("429")) return {ok:false, msg:"Rate limit hit — using demo mode"};
    return {ok:false, msg:"Connection failed — using demo mode"};
  }
}

function mockSnap(sym) {
  const base = BASE_PRICES[sym] || 100;
  const price = base * (1 + (Math.random() - 0.45) * 0.08);
  const prev = price * (1 + (Math.random() - 0.5) * 0.04);
  const vol = Math.floor(600000 + Math.random() * 8000000);
  return {
    day: {c:+price.toFixed(2), v:vol, vw:+(price*(0.99+Math.random()*0.02)).toFixed(2), h:+(price*(1+Math.random()*0.025)).toFixed(2), l:+(price*(1-Math.random()*0.025)).toFixed(2)},
    prevDay: {c:+prev.toFixed(2)}
  };
}
async function getSnap(sym, key, live) {
  if (!live) return mockSnap(sym);
  try { const d = await apicall("/v2/snapshot/locale/us/markets/stocks/tickers/" + sym + "?", key); return d && d.ticker ? d.ticker : mockSnap(sym); }
  catch { return mockSnap(sym); }
}
async function getNews(sym, key, live) {
  if (!live) return [];
  try { const d = await apicall("/v2/reference/news?ticker=" + sym + "&limit=5&order=desc&sort=published_utc&", key); return (d && d.results) || []; }
  catch { return []; }
}
async function getRate(key, live) {
  if (!live) return FALLBACK_RATE;
  try { const d = await apicall("/v1/conversion/GBP/USD?amount=1&precision=4&", key); return (d && d.converted) || FALLBACK_RATE; }
  catch { return FALLBACK_RATE; }
}
async function getRegime(key, live) {
  if (!live) return {regime:"neutral", spyChg:0.4, qqqChg:0.6};
  try {
    const spy = await apicall("/v2/snapshot/locale/us/markets/stocks/tickers/SPY?", key);
    const qqq = await apicall("/v2/snapshot/locale/us/markets/stocks/tickers/QQQ?", key);
    const avg = ((spy && spy.ticker ? spy.ticker.todaysChangePerc : 0) + (qqq && qqq.ticker ? qqq.ticker.todaysChangePerc : 0)) / 2;
    return {regime: avg <= -0.5 ? "bearish" : avg >= 0.5 ? "bullish" : "neutral", spyChg: spy && spy.ticker ? spy.ticker.todaysChangePerc : 0, qqqChg: qqq && qqq.ticker ? qqq.ticker.todaysChangePerc : 0};
  } catch { return {regime:"neutral", spyChg:0, qqqChg:0}; }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
const TSRC = ["reuters.com","bloomberg.com","wsj.com","sec.gov","ft.com"];
const MSRC = ["marketwatch.com","benzinga.com","seekingalpha.com","cnbc.com"];
function sw(u) {
  if (!u) return 0.3;
  for (let i = 0; i < TSRC.length; i++) if (u.includes(TSRC[i])) return 1.0;
  for (let i = 0; i < MSRC.length; i++) if (u.includes(MSRC[i])) return 0.7;
  return 0.3;
}
function newsCalc(arts) {
  if (!arts || !arts.length) return {score:0, label:"None", raw:0};
  const now = Date.now(); let ws = 0, wt = 0;
  arts.slice(0,5).forEach(function(a) {
    const h = (now - new Date(a.published_utc).getTime()) / 3600000;
    const r = h < 2 ? 1 : h < 12 ? 0.6 : 0.2;
    const s = sw(a.article_url || "");
    const v = a.insights && a.insights[0] ? (a.insights[0].sentiment === "positive" ? 1 : a.insights[0].sentiment === "negative" ? -1 : 0) : 0;
    ws += v*r*s; wt += r*s;
  });
  const raw = wt > 0 ? ws/wt : 0;
  return {score: +Math.max(0, Math.min((raw+1)/2*5, 5)).toFixed(2), label: raw > 0.3 ? "Positive" : raw < -0.1 ? "Negative" : "Neutral", raw};
}
function wts(t) {
  return t === "B"
    ? {rvol:0.20, gap:0.18, rsi:0.13, atr:0.13, vwap:0.20, news:0.16}
    : {rvol:0.27, gap:0.22, rsi:0.13, atr:0.13, vwap:0.10, news:0.15};
}
function scoreStock(snap, arts, type) {
  if (!snap) return null;
  const w = wts(type);
  const price = (snap.day && snap.day.c) || (snap.prevDay && snap.prevDay.c) || 0;
  const prev = (snap.prevDay && snap.prevDay.c) || price;
  if (!price || price <= 0) return null;
  const vol = (snap.day && snap.day.v) || 0;
  if (vol < 300000) return null;
  const rvol = vol / 2000000;
  const gap = prev > 0 ? ((price - prev) / prev) * 100 : 0;
  const vwap = (snap.day && snap.day.vw) || price;
  const high = (snap.day && snap.day.h) || price;
  const low = (snap.day && snap.day.l) || price;
  const range = high - low;
  const rsi = 30 + (range > 0 ? (price - low) / range : 0.5) * 50;
  const atr = prev > 0 ? (range / prev) * 100 : 2;
  const aboveVwap = price >= vwap;
  const volTier = vol < 500000 ? "low" : vol < 1000000 ? "mid" : "high";
  const rs = Math.min(rvol/3, 1) * 5;
  const gs = gap > 0 && gap <= 8 ? Math.min(gap/8, 1)*5 : gap > 8 ? Math.max(5-(gap-8)*0.5, 0) : gap < -2 ? 0 : 2;
  const ri = rsi >= 55 && rsi <= 72 ? 5 : rsi >= 45 ? 3 : rsi > 72 ? Math.max(5-(rsi-72)*0.2, 0) : 1;
  const as = Math.min(atr/5, 1) * 5;
  const vs = aboveVwap ? 5 : 1;
  const nd = newsCalc(arts);
  const composite = +(rs*w.rvol + gs*w.gap + ri*w.rsi + as*w.atr + vs*w.vwap + nd.score*w.news).toFixed(2);
  return {composite, rvol:+rvol.toFixed(2), gap:+gap.toFixed(2), rsi:+rsi.toFixed(1), atr:+atr.toFixed(2), vwap:+vwap.toFixed(2), aboveVwap, newsLabel:nd.label, newsRaw:+nd.raw.toFixed(3), price, prevClose:prev, volTier, volume:vol};
}
function allocate(picks, cap, regime) {
  const deploy = cap * (regime === "bearish" ? 0.7 : regime === "neutral" ? 0.85 : 1.0);
  const total = picks.reduce(function(s,p) { return s + p.score.composite; }, 0) || 1;
  return picks.map(function(p) {
    const mp = p.score.volTier === "low" ? 0.30 : p.score.volTier === "mid" ? 0.50 : 0.65;
    const pt = Math.min(Math.max(p.score.composite/total, 0.05), mp);
    return Object.assign({}, p, {allocation:+(pt*deploy).toFixed(2), allocationPct:+(pt*100).toFixed(1)});
  });
}
function diversify(picks) {
  const cnt = {};
  return picks.filter(function(p) {
    const c = cnt[p.sector] || 0;
    if (c < 2) { cnt[p.sector] = c+1; return true; }
    return false;
  });
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function exportCSV(fname, rows, hdr) {
  function esc(v) {
    const s = String(v == null ? "" : v);
    return (s.indexOf(",") >= 0 || s.indexOf('"') >= 0) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }
  const body = [hdr].concat(rows).map(function(r) { return r.map(esc).join(","); }).join("\n");
  const url = URL.createObjectURL(new Blob([body], {type:"text/csv"}));
  const a = document.createElement("a");
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
}

// ─── Chart (pure SVG, zero template literals) ────────────────────────────────
function PnLChart(props) {
  const data = props.data;
  const accent = props.accent || ACCENT;
  const W = 500, H = 130, PL = 44, PR = 12, PT = 14, PB = 28;
  const iw = W - PL - PR, ih = H - PT - PB;

  if (!data || data.length < 2) {
    return React.createElement("div", {
      style: {height:H, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8}
    },
      React.createElement("div", {style:{fontSize:28, opacity:0.2}}, "📈"),
      React.createElement("div", {style:{fontSize:10, color:MUTED, letterSpacing:2, fontFamily:"monospace"}}, "AWAITING DATA")
    );
  }

  const vals = data.map(function(d) { return d.v; });
  const minV = Math.min.apply(null, vals.concat([0]));
  const maxV = Math.max.apply(null, vals.concat([0]));
  const rng = maxV - minV || 1;
  const xs = data.map(function(_, i) { return PL + (i / (data.length-1)) * iw; });
  const ys = data.map(function(d) { return PT + ih - (d.v - minV) / rng * ih; });
  const zero = PT + ih - (0 - minV) / rng * ih;

  let linePts = "";
  let areaPts = "";
  for (let i = 0; i < xs.length; i++) {
    linePts += (i === 0 ? "M" : "L") + xs[i].toFixed(1) + "," + ys[i].toFixed(1) + " ";
    areaPts += (i === 0 ? "M" : "L") + xs[i].toFixed(1) + "," + ys[i].toFixed(1) + " ";
  }
  areaPts += "L" + xs[xs.length-1].toFixed(1) + "," + zero.toFixed(1) + " L" + xs[0].toFixed(1) + "," + zero.toFixed(1) + " Z";

  const ticks = [0, 1, 2, 3, 4].map(function(i) { return minV + (i/4) * rng; });
  const gradId = "grad_" + accent.replace("#","");

  const elements = [];
  // Defs
  elements.push(
    React.createElement("defs", {key:"defs"},
      React.createElement("linearGradient", {id:gradId, x1:"0", y1:"0", x2:"0", y2:"1"},
        React.createElement("stop", {offset:"0%", stopColor:accent, stopOpacity:"0.22"}),
        React.createElement("stop", {offset:"100%", stopColor:accent, stopOpacity:"0.01"})
      )
    )
  );
  // Grid lines
  ticks.forEach(function(v, i) {
    const y = PT + ih - (v - minV) / rng * ih;
    elements.push(React.createElement("line", {key:"gl"+i, x1:PL, y1:y, x2:PL+iw, y2:y, stroke:v===0?"#94a3b8":"#e2e8f0", strokeWidth:v===0?1:0.5}));
    elements.push(React.createElement("text", {key:"gt"+i, x:PL-4, y:y+3, textAnchor:"end", fontSize:"8", fill:"#94a3b8"}, "$" + v.toFixed(0)));
  });
  // Area fill
  elements.push(React.createElement("path", {key:"area", d:areaPts, fill:"url(#" + gradId + ")"}));
  // Line
  elements.push(React.createElement("path", {key:"line", d:linePts, fill:"none", stroke:accent, strokeWidth:"1.5", strokeLinecap:"round", strokeLinejoin:"round"}));
  // Dots
  data.forEach(function(d, i) {
    elements.push(React.createElement("circle", {key:"dot"+i, cx:xs[i], cy:ys[i], r:"3", fill:d.v>=0?accent:RED, stroke:BG, strokeWidth:"1.5"}));
  });
  // Labels
  data.forEach(function(d, i) {
    if (data.length <= 8 || i % Math.ceil(data.length/6) === 0) {
      elements.push(React.createElement("text", {key:"lbl"+i, x:xs[i], y:H-4, textAnchor:"middle", fontSize:"7", fill:MUTED}, d.label));
    }
  });

  return React.createElement("svg", {viewBox:"0 0 " + W + " " + H, style:{width:"100%", height:H}}, elements);
}

// ─── Style helpers (no template literals) ────────────────────────────────────
function border(color) { return "1px solid " + color; }
function border2(color) { return "2px solid " + color; }
function bg(color, opacity) {
  // Convert hex to rgba for backgrounds with opacity
  if (opacity !== undefined) {
    const r = parseInt(color.slice(1,3),16);
    const g = parseInt(color.slice(3,5),16);
    const b = parseInt(color.slice(5,7),16);
    return "rgba(" + r + "," + g + "," + b + "," + opacity + ")";
  }
  return color;
}

// ─── UI Atoms ─────────────────────────────────────────────────────────────────
function Tag(props) {
  const c = props.c || ACCENT;
  const size = props.size || 8;
  return React.createElement("span", {
    style: {fontSize:size, letterSpacing:1.5, textTransform:"uppercase", color:c, background:c+"14", border:border(c+"30"), padding:"2px 7px", borderRadius:3, whiteSpace:"nowrap", fontFamily:"monospace"}
  }, props.children);
}

function Dot(props) {
  const c = props.c || GREEN;
  const pulse = props.pulse;
  return React.createElement("div", {
    style: {width:6, height:6, borderRadius:"50%", background:c, boxShadow:pulse?"0 0 6px "+c:"none", animation:pulse?"pulse 1.8s infinite":"none", flexShrink:0}
  });
}

function GBar(props) {
  const pct = Math.min(Math.max(props.pct || 0, 0), 100);
  const c = props.c || ACCENT;
  const h = props.h || 2;
  return React.createElement("div", {style:{height:h, background:DIM, borderRadius:1}},
    React.createElement("div", {style:{height:"100%", width:pct+"%", background:c, borderRadius:1, transition:"width 0.9s ease"}})
  );
}

function Btn(props) {
  const v = props.variant || "default";
  const small = props.small;
  const styles = {
    default: {bg:CARD, bdr:BDR, col:TXT},
    primary: {bg:ACCENT+"18", bdr:ACCENT+"44", col:ACCENT},
    danger:  {bg:RED+"10",   bdr:RED+"33",   col:RED},
    success: {bg:GREEN+"10", bdr:GREEN+"33", col:GREEN},
  };
  const s = styles[v] || styles.default;
  return React.createElement("button", {
    onClick: props.onClick,
    disabled: props.disabled,
    style: {background:s.bg, border:border(s.bdr), color:s.col, padding:small?"4px 10px":"7px 14px", borderRadius:4, fontSize:small?9:11, fontFamily:"monospace", letterSpacing:1, cursor:"pointer", transition:"opacity 0.1s", opacity:props.disabled?0.4:1}
  }, props.children);
}

function StatCard(props) {
  const a = props.accent || ACCENT;
  return React.createElement("div", {
    style: {background:CARD, border:border(BDR), borderRadius:8, padding:"14px 16px", position:"relative", overflow:"hidden"}
  },
    React.createElement("div", {style:{position:"absolute", top:0, left:0, width:10, height:10, borderTop:border(a), borderLeft:border(a)}}),
    React.createElement("div", {style:{fontSize:8, color:MUTED, letterSpacing:2, textTransform:"uppercase", marginBottom:7, fontFamily:"monospace"}}, props.label),
    React.createElement("div", {style:{fontSize:20, fontWeight:700, color:props.valueColor||TXT, letterSpacing:-0.5, fontFamily:"monospace"}}, props.value),
    props.sub ? React.createElement("div", {style:{fontSize:10, color:MUTED, marginTop:3, fontFamily:"monospace"}}, props.sub) : null
  );
}

function ScoreRing(props) {
  const score = props.score || 0;
  const p = score / 5;
  const c = p > 0.7 ? GREEN : p > 0.45 ? AMBER : RED;
  const r = 18, cx = 22, cy = 22, sw = 2.5;
  const ci = 2 * Math.PI * r;
  const dash = (p * ci).toFixed(1) + " " + ci.toFixed(1);
  return React.createElement("div", {style:{position:"relative", width:44, height:44, flexShrink:0}},
    React.createElement("svg", {width:44, height:44, style:{transform:"rotate(-90deg)"}},
      React.createElement("circle", {cx, cy, r, fill:"none", stroke:DIM, strokeWidth:sw}),
      React.createElement("circle", {cx, cy, r, fill:"none", stroke:c, strokeWidth:sw, strokeDasharray:dash, strokeLinecap:"butt"})
    ),
    React.createElement("div", {style:{position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:c, fontFamily:"monospace"}}, score)
  );
}

// ─── Stock Card ───────────────────────────────────────────────────────────────
function StockCard(props) {
  const pick = props.pick;
  const [open, setOpen] = useState(false);
  const pp = (pick.currentPrice && pick.entryPrice) ? ((pick.currentPrice - pick.entryPrice) / pick.entryPrice) * 100 : 0;
  const pu = (pp / 100) * (pick.allocation || 0);
  const stopped = pick.status === "stopped";
  const profit = pick.status === "profit";
  const fading = pick.status === "fading";
  const ac = stopped ? RED : profit ? GREEN : fading ? AMBER : ACCENT;
  const sl = stopped ? "STOP-LOSS" : profit ? "TARGET HIT" : fading ? "FADING" : "ACTIVE";
  const sc = pick.score || {};

  const indicators = [
    {l:"REL VOL", v:Math.min((sc.rvol||0)/3,1)*100, c:ACCENT},
    {l:"GAP",     v:Math.min(Math.abs(sc.gap||0)/8,1)*100, c:GREEN},
    {l:"RSI",     v:((sc.rsi||30)-30)/50*100, c:AMBER},
    {l:"ATR",     v:Math.min((sc.atr||0)/5,1)*100, c:PURPLE},
    {l:"NEWS",    v:((sc.newsRaw||0)+1)/2*100, c:"#ff7755"},
    {l:"VWAP",    v:sc.aboveVwap?100:15, c:ACCENT},
  ];

  const metrics = [
    {l:"ALLOC", v:"$"+(pick.allocation||0).toFixed(0)+" · "+(pick.allocationPct||0)+"%"},
    {l:"ENTRY", v:"$"+(pick.entryPrice||0).toFixed(2)},
    {l:"P&L",   v:null, pnl:pu},
    {l:"SCORE", v:(sc.composite||0)+"/5"},
    {l:"RVOL",  v:(sc.rvol||0)+"×"},
    {l:"GAP",   v:((sc.gap||0)>0?"+":"")+(sc.gap||0)+"%"},
    {l:"RSI",   v:""+(sc.rsi||0)},
    {l:"ATR",   v:(sc.atr||0)+"%"},
  ];

  return React.createElement("div", {
    style: {background:SURFACE, border:border(BDR), borderLeft:border2(ac), borderRadius:"0 6px 6px 0", marginBottom:7, overflow:"hidden"}
  },
    // Header row
    React.createElement("div", {
      style: {padding:"10px 13px", cursor:"pointer", display:"flex", gap:10, alignItems:"center"},
      onClick: function() { setOpen(function(o) { return !o; }); }
    },
      React.createElement(ScoreRing, {score:sc.composite||0}),
      React.createElement("div", {style:{flex:1, minWidth:0}},
        React.createElement("div", {style:{display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", marginBottom:2}},
          React.createElement("span", {style:{fontSize:14, color:TXT, letterSpacing:1, fontFamily:"monospace", fontWeight:600}}, pick.symbol),
          React.createElement(Tag, {c:MUTED, size:7}, pick.sector),
          React.createElement(Tag, {c:ac, size:7}, sl),
          sc.aboveVwap ? React.createElement(Tag, {c:ACCENT, size:7}, "VWAP+") : null,
          sc.newsLabel === "Positive" ? React.createElement(Tag, {c:GREEN, size:7}, "+NEWS") : null,
          sc.newsLabel === "Negative" ? React.createElement(Tag, {c:RED, size:7}, "-NEWS") : null
        ),
        React.createElement("div", {style:{fontSize:9, color:MUTED, fontFamily:"monospace"}}, pick.name)
      ),
      React.createElement("div", {style:{textAlign:"right"}},
        React.createElement("div", {style:{fontSize:14, color:TXT, fontFamily:"monospace"}}, "$"+(pick.currentPrice||pick.entryPrice||0).toFixed(2)),
        React.createElement("div", {style:{fontSize:10, color:pp>=0?GREEN:RED, fontFamily:"monospace"}}, pct(pp))
      ),
      React.createElement("span", {style:{color:DIM, fontSize:10, marginLeft:4}}, open?"▴":"▾")
    ),
    // Expanded detail
    open ? React.createElement("div", {style:{padding:"0 13px 13px", borderTop:border(BDR)}},
      React.createElement("div", {style:{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:5, marginTop:10}},
        metrics.map(function(it) {
          return React.createElement("div", {key:it.l, style:{background:BG, border:border(BDR), borderRadius:3, padding:"6px 8px"}},
            React.createElement("div", {style:{fontSize:7, color:MUTED, letterSpacing:1.5, fontFamily:"monospace", marginBottom:3}}, it.l),
            it.pnl !== undefined
              ? React.createElement("span", {style:{fontSize:11, color:it.pnl>=0?GREEN:RED, fontFamily:"monospace"}}, signed(it.pnl))
              : React.createElement("div", {style:{fontSize:11, color:"#475569", fontFamily:"monospace"}}, it.v)
          );
        })
      ),
      React.createElement("div", {style:{marginTop:9, display:"grid", gridTemplateColumns:"1fr 1fr", gap:"4px 16px"}},
        indicators.map(function(ind) {
          return React.createElement("div", {key:ind.l},
            React.createElement("div", {style:{display:"flex", justifyContent:"space-between", fontSize:7, color:MUTED, letterSpacing:1.5, fontFamily:"monospace", marginBottom:3}},
              React.createElement("span", null, ind.l),
              React.createElement("span", null, (ind.v||0).toFixed(0))
            ),
            React.createElement(GBar, {pct:ind.v, c:ind.c, h:2})
          );
        })
      ),
      stopped && props.canSwap ? React.createElement("button", {
        onClick: function() { props.onSwap(pick.symbol, props.simId); },
        style: {marginTop:10, width:"100%", background:ACCENT+"0f", border:border(ACCENT+"33"), color:ACCENT, padding:"7px", borderRadius:3, cursor:"pointer", fontSize:9, fontFamily:"monospace", letterSpacing:2}
      }, "↻ FIND REPLACEMENT") : null
    ) : null
  );
}

// ─── Sim History Dropdown ─────────────────────────────────────────────────────
function SimHistory(props) {
  const sessions = props.sessions;
  const accent = props.accent;
  const [open, setOpen] = useState(false);

  if (!sessions || !sessions.length) {
    return React.createElement("div", {
      style: {marginTop:10, background:BG, border:"1px dashed "+DIM, borderRadius:6, padding:"10px 14px", fontSize:10, color:MUTED, textAlign:"center", fontFamily:"monospace"}
    }, "SESSION HISTORY APPEARS AFTER MARKET CLOSE");
  }

  return React.createElement("div", {style:{marginTop:10, border:border(BDR), borderRadius:6, overflow:"hidden"}},
    React.createElement("button", {
      onClick: function() { setOpen(function(o) { return !o; }); },
      style: {width:"100%", background:BG, border:"none", padding:"9px 13px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center"}
    },
      React.createElement("span", {style:{fontSize:9, color:accent, letterSpacing:2, fontFamily:"monospace"}}, props.label.toUpperCase() + " HISTORY — " + sessions.length + " SESSIONS"),
      React.createElement("span", {style:{color:MUTED, fontSize:10}}, open?"▴":"▾")
    ),
    open ? sessions.map(function(ses, si) {
      return React.createElement("div", {key:si, style:{borderTop:border(BDR)}},
        // Session header
        React.createElement("div", {style:{padding:"7px 13px", background:SURFACE, display:"flex", justifyContent:"space-between", alignItems:"center"}},
          React.createElement("div", {style:{display:"flex", gap:8, alignItems:"center"}},
            React.createElement("span", {style:{fontSize:11, color:TXT, fontFamily:"monospace"}}, ses.date),
            React.createElement(Tag, {c:ses.totalPnl>=0?GREEN:RED, size:7}, ses.totalPnl>=0?"PROFIT":"LOSS")
          ),
          React.createElement("span", {style:{fontSize:12, color:ses.totalPnl>=0?GREEN:RED, fontFamily:"monospace"}}, signed(ses.totalPnl))
        ),
        // Picks table
        ses.picks && ses.picks.length ? React.createElement("div", {style:{overflowX:"auto"}},
          React.createElement("table", {style:{width:"100%", borderCollapse:"collapse", minWidth:580}},
            React.createElement("thead", null,
              React.createElement("tr", {style:{background:BG}},
                ["SYMBOL","ENTRY TIME","ENTRY $","EXIT $","ALLOC","P&L $","RETURN"].map(function(h) {
                  return React.createElement("th", {key:h, style:{padding:"5px 10px", fontSize:7, color:MUTED, textAlign:"left", letterSpacing:1.5, fontFamily:"monospace", borderBottom:border(BDR)}}, h);
                })
              )
            ),
            React.createElement("tbody", null,
              ses.picks.map(function(p, pi) {
                const ret = p.exitPrice && p.entryPrice ? ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
                const pnl = p.closedPnl !== undefined ? p.closedPnl : (ret/100)*(p.allocation||0);
                return React.createElement("tr", {key:pi, style:{borderBottom:border(DIM)}},
                  React.createElement("td", {style:{padding:"6px 10px", fontSize:11, color:TXT, fontFamily:"monospace", fontWeight:600}}, p.symbol),
                  React.createElement("td", {style:{padding:"6px 10px", fontSize:10, color:MUTED, fontFamily:"monospace"}}, p.entryTime||"09:30"),
                  React.createElement("td", {style:{padding:"6px 10px", fontSize:11, color:TXT, fontFamily:"monospace"}}, p.entryPrice?"$"+p.entryPrice.toFixed(2):"—"),
                  React.createElement("td", {style:{padding:"6px 10px", fontSize:11, color:TXT, fontFamily:"monospace"}}, p.exitPrice?"$"+p.exitPrice.toFixed(2):"Open"),
                  React.createElement("td", {style:{padding:"6px 10px", fontSize:10, color:MUTED, fontFamily:"monospace"}}, p.allocation?"$"+p.allocation.toFixed(0):"—"),
                  React.createElement("td", {style:{padding:"6px 10px", fontSize:11, fontFamily:"monospace", color:pnl>=0?GREEN:RED}}, signed(pnl)),
                  React.createElement("td", {style:{padding:"6px 10px", fontSize:10, fontFamily:"monospace", color:ret>=0?GREEN:RED}}, pct(ret))
                );
              })
            )
          )
        ) : null
      );
    }) : null
  );
}

// ─── Sim Panel ────────────────────────────────────────────────────────────────
function SimPanel(props) {
  const sim = props.sim;
  const accent = props.accent;
  const active = sim.picks.filter(function(p) { return p.status==="active"; }).length;
  const stopped = sim.picks.filter(function(p) { return p.status==="stopped"; }).length;
  const banked = sim.picks.filter(function(p) { return p.status==="profit"; }).length;
  const pnlPct = sim.sessionCapital > 0 ? (sim.totalPnl / sim.sessionCapital) * 100 : 0;
  const goalPct = Math.min((sim.totalPnl / ((sim.sessionCapital||1) * GOAL)) * 100, 100);

  return React.createElement("div", {
    style: {flex:1, minWidth:0, background:CARD, border:border(BDR), borderRadius:10, padding:18, position:"relative", overflow:"hidden"}
  },
    React.createElement("div", {style:{position:"absolute", top:0, left:0, width:12, height:12, borderTop:border(accent), borderLeft:border(accent)}}),
    React.createElement("div", {style:{position:"absolute", bottom:0, right:0, width:12, height:12, borderBottom:border(accent), borderRight:border(accent)}}),
    React.createElement("div", {style:{position:"relative"}},
      // Header
      React.createElement("div", {style:{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12}},
        React.createElement("div", null,
          React.createElement("div", {style:{fontSize:9, color:accent, letterSpacing:3, fontFamily:"monospace", marginBottom:3}}, props.label),
          React.createElement("div", {style:{fontSize:8, color:MUTED, fontFamily:"monospace", letterSpacing:1}}, props.windows.join(" › ") + " ET")
        ),
        React.createElement("div", {style:{textAlign:"right"}},
          React.createElement("div", {style:{fontSize:8, color:MUTED, fontFamily:"monospace", letterSpacing:1, marginBottom:2}}, "SESSION P&L"),
          React.createElement("div", {style:{fontSize:20, color:sim.totalPnl>=0?GREEN:RED, fontFamily:"monospace"}}, signed(sim.totalPnl)),
          React.createElement("div", {style:{fontSize:10, color:pnlPct>=0?GREEN:RED, fontFamily:"monospace"}}, pct(pnlPct))
        )
      ),
      // Badges
      React.createElement("div", {style:{display:"flex", gap:5, marginBottom:10, flexWrap:"wrap"}},
        React.createElement(Tag, {c:GREEN, size:7}, active+" ACTIVE"),
        stopped > 0 ? React.createElement(Tag, {c:RED, size:7}, stopped+" STOPPED") : null,
        banked > 0 ? React.createElement(Tag, {c:ACCENT, size:7}, banked+" BANKED") : null,
        React.createElement(Tag, {c:MUTED, size:7}, "SWAPS "+sim.swapsUsed+"/"+MAX_SWAPS),
        React.createElement(Tag, {c:DIM, size:7}, "$"+(sim.capital||0).toFixed(0))
      ),
      // Goal bar
      React.createElement("div", {style:{marginBottom:12}},
        React.createElement("div", {style:{display:"flex", justifyContent:"space-between", fontSize:8, color:MUTED, fontFamily:"monospace", letterSpacing:1, marginBottom:4}},
          React.createElement("span", null, "TARGET "+(GOAL*100).toFixed(0)+"%"),
          React.createElement("span", {style:{color:goalPct>=100?GREEN:accent}}, goalPct.toFixed(0)+"%")
        ),
        React.createElement(GBar, {pct:goalPct, c:goalPct>=100?GREEN:accent, h:3})
      ),
      // Stock cards
      sim.picks.map(function(p) {
        return React.createElement(StockCard, {key:p.symbol, pick:p, onSwap:props.onSwap, canSwap:sim.swapsUsed<MAX_SWAPS, simId:props.simId});
      }),
      // History
      React.createElement(SimHistory, {sessions:props.sessions, label:props.label, accent})
    )
  );
}

// ─── API Status Banner ────────────────────────────────────────────────────────
function ApiStatusBanner(props) {
  const st = props.status;
  if (!st) return null;
  const typeMap = {
    live:    {c:GREEN,  label:"LIVE DATA"},
    demo:    {c:AMBER,  label:"DEMO MODE"},
    error:   {c:RED,    label:"API ERROR"},
    testing: {c:ACCENT, label:"TESTING..."},
  };
  const m = typeMap[st.type] || typeMap.demo;
  return React.createElement("div", {
    style: {background:m.c+"0c", border:border(m.c+"30"), borderRadius:6, padding:"8px 14px", display:"flex", alignItems:"center", gap:10, marginBottom:14}
  },
    React.createElement(Dot, {c:m.c, pulse:st.type==="live"||st.type==="testing"}),
    React.createElement(Tag, {c:m.c, size:7}, m.label),
    React.createElement("span", {style:{fontSize:11, color:m.c, letterSpacing:0.3}}, st.msg),
    st.type === "demo" ? React.createElement("span", {style:{fontSize:10, color:MUTED, marginLeft:"auto"}}, "Add Polygon.io key for live prices") : null
  );
}

// ─── Sim Health Monitor ───────────────────────────────────────────────────────
function SimHealthMonitor(props) {
  const state = props.state;
  const lastRefresh = props.lastRefresh;
  const nextRefresh = props.nextRefresh;
  const isOpen = props.isOpen;
  if (!state) return null;
  const picksA = (state.simA && state.simA.picks) || [];
  const picksB = (state.simB && state.simB.picks) || [];
  const activeA = picksA.filter(function(p) { return p.status==="active"; }).length;
  const activeB = picksB.filter(function(p) { return p.status==="active"; }).length;
  const items = [
    {l:"SIM A PICKS",    v:picksA.length+" stocks ("+activeA+" active)", ok:picksA.length>0},
    {l:"SIM B PICKS",    v:picksB.length+" stocks ("+activeB+" active)", ok:picksB.length>0},
    {l:"LAST REFRESH",   v:lastRefresh||"Not yet", ok:!!lastRefresh},
    {l:"NEXT REFRESH",   v:isOpen?(nextRefresh||"15 min cycle"):"Market closed", ok:isOpen},
    {l:"SESSION DATE",   v:state.date||"—", ok:!!state.date},
    {l:"CAPITAL",        v:"$"+(state.startUsd||0).toFixed(0), ok:(state.startUsd||0)>0},
  ];
  const allOk = items.every(function(i) { return i.ok; });
  return React.createElement("div", {
    style: {background:CARD, border:border(allOk?GREEN+"30":AMBER+"30"), borderRadius:8, overflow:"hidden", marginBottom:14}
  },
    React.createElement("div", {style:{padding:"9px 14px", borderBottom:border(BDR), display:"flex", alignItems:"center", gap:8}},
      React.createElement(Dot, {c:allOk?GREEN:AMBER, pulse:allOk}),
      React.createElement("span", {style:{fontSize:9, color:allOk?GREEN:AMBER, letterSpacing:2, fontFamily:"monospace"}}, allOk?"SIM RUNNING NORMALLY":"SIM ATTENTION NEEDED")
    ),
    React.createElement("div", {style:{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:0}},
      items.map(function(it, i) {
        return React.createElement("div", {key:it.l,
          style: {padding:"9px 14px", borderRight:i%3!==2?border(BDR):"none", borderBottom:i<3?border(BDR):"none"}
        },
          React.createElement("div", {style:{fontSize:8, color:MUTED, letterSpacing:1.5, fontFamily:"monospace", marginBottom:3}}, it.l),
          React.createElement("div", {style:{fontSize:11, color:it.ok?TXT:AMBER, fontFamily:"monospace"}}, it.v)
        );
      })
    )
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function AlphaSim() {
  const [keyInput, setKeyInput] = useState(function() {
    try { return localStorage.getItem(SK+"_key") || ""; } catch { return ""; }
  });
  const [apiKey, setApiKey] = useState("");
  const [isLive, setIsLive] = useState(false);
  const [apiStatus, setApiStatus] = useState(null);
  const [state, setState] = useState(function() {
    try { const s = localStorage.getItem(SK); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [tlog, setTlog] = useState(function() {
    try { const s = localStorage.getItem(SK+"_t"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState("dashboard");
  const [chartRange, setChartRange] = useState("all");
  const [chartView, setChartView] = useState("combined");
  const [lastRefresh, setLastRefresh] = useState(null);
  const [nextRefresh, setNextRefresh] = useState(null);
  const [mktSt, setMktSt] = useState(getMktStatus);
  const [etStr, setEtStr] = useState(function() {
    const d = etNow();
    return String(d.h).padStart(2,"0") + ":" + String(d.m).padStart(2,"0") + " ET";
  });
  const autoRef = useRef({nd:"", cd:""});
  const hasAutoConnected = useRef(false);

  // Auto-connect on startup if a key was previously saved
  useEffect(function() {
    if (hasAutoConnected.current) return;
    hasAutoConnected.current = true;
    try {
      const savedKey = localStorage.getItem(SK+"_key");
      if (savedKey) {
        addLog("Saved API key found — reconnecting...", "info");
        handleConnect(savedKey);
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addLog = useCallback(function(m, t) {
    t = t || "info";
    const ts = new Date().toLocaleTimeString("en-US",{hour12:false});
    setLog(function(p) { return [{ts,m,t,id:Math.random()}].concat(p).slice(0,200); });
  }, []);

  const persist = useCallback(function(s) {
    setState(s);
    try { localStorage.setItem(SK, JSON.stringify(s)); } catch {}
  }, []);

  const logTrade = useCallback(function(e) {
    setTlog(function(p) {
      const u = [e].concat(p).slice(0,500);
      try { localStorage.setItem(SK+"_t", JSON.stringify(u)); } catch {}
      return u;
    });
  }, []);

  const buildPicks = useCallback(async function(count, capital, key, live, type, excl, regime) {
    excl = excl || []; regime = regime || "neutral";
    const pool = UNIVERSE.filter(function(s) { return excl.indexOf(s.symbol) < 0; }).sort(function() { return Math.random()-0.5; });
    const scored = [];
    const toScore = pool.slice(0, 14);
    for (let i = 0; i < toScore.length; i++) {
      const stock = toScore[i];
      const snap = await getSnap(stock.symbol, key, live);
      const news = await getNews(stock.symbol, key, live);
      const sc = scoreStock(snap, news, type);
      if (!sc) continue;
      if (sc.newsRaw < -0.1) { addLog(stock.symbol + " excluded — negative news", "warn"); continue; }
      scored.push(Object.assign({}, stock, {score:sc, entryPrice:sc.price, currentPrice:sc.price, status:"active", entryTime:new Date().toLocaleTimeString("en-US",{hour12:false,hour:"2-digit",minute:"2-digit"})}));
    }
    scored.sort(function(a,b) { return b.score.composite - a.score.composite; });
    const top = allocate(diversify(scored).slice(0, count), capital, regime);
    const today = new Date().toISOString().split("T")[0];
    const ts = new Date().toLocaleTimeString("en-US",{hour12:false});
    top.forEach(function(p) {
      addLog("Sim "+type+" → "+p.symbol+" | score "+p.score.composite+" | "+usd(p.allocation)+" ("+p.allocationPct+"%)", "success");
      logTrade({date:today, time:ts, sim:"Sim "+type, symbol:p.symbol, sector:p.sector, event:"ENTRY", entryPrice:p.score.price, exitPrice:null, allocation:p.allocation, pnlUsd:null, pnlPct:null, score:p.score.composite, notes:"Regime:"+regime});
    });
    return top;
  }, [addLog, logTrade]);

  const initSim = useCallback(async function(key, live, existing) {
    setBusy(true);
    try {
      setLoadMsg("Fetching GBP/USD rate...");
      const rate = await getRate(key, live);
      addLog("GBP/USD: " + rate.toFixed(4), "info");
      setLoadMsg("Checking market regime...");
      const regime = await getRegime(key, live);
      addLog("Regime: " + regime.regime.toUpperCase() + " | SPY " + regime.spyChg.toFixed(2) + "% | QQQ " + regime.qqqChg.toFixed(2) + "%", "info");
      const history = (existing && existing.history) || [];
      const histA = (existing && existing.histA) || [];
      const histB = (existing && existing.histB) || [];
      let capital = START_GBP * rate;
      if (history.length > 0) {
        const last = history[history.length-1];
        capital = last.totalPnl < 0 ? last.capitalEnd * (1-LOSS_BUF) : last.capitalEnd;
        addLog("Compounding from yesterday: " + usd(capital), "info");
      }
      setLoadMsg("Screening Sim A candidates...");
      const picksA = await buildPicks(5, capital, key, live, "A", [], regime.regime);
      setLoadMsg("Screening Sim B candidates...");
      const picksB = await buildPicks(5, capital, key, live, "B", picksA.map(function(p) { return p.symbol; }), regime.regime);
      const today = new Date().toISOString().split("T")[0];
      const ns = {
        date:today, rate, startUsd:capital, regime,
        simA:{picks:picksA, capital, sessionCapital:capital, swapsUsed:0, windows:WIN_A, totalPnl:0},
        simB:{picks:picksB, capital, sessionCapital:capital, swapsUsed:0, windows:WIN_B, totalPnl:0},
        history, histA, histB
      };
      persist(ns);
      addLog(live ? "Live data active — Polygon.io connected. Auto-refresh every 15 min." : "Demo mode active — realistic mock prices. Auto-refresh every 15 min.", "success");
    } catch(e) {
      addLog("Init error: " + (e && e.message ? e.message : String(e)), "error");
    }
    setBusy(false); setLoadMsg("");
  }, [addLog, buildPicks, persist]);

  const handleConnect = useCallback(async function(key) {
    setApiStatus({type:"testing", msg:"Testing Polygon.io connection..."});
    const result = await testKey(key);
    if (result.ok) {
      setApiKey(key); setIsLive(true);
      try { localStorage.setItem(SK+"_key", key); } catch {}
      setApiStatus({type:"live", msg:result.msg});
      addLog("Polygon.io connected — live data enabled. Key saved.", "success");
      initSim(key, true, state);
    } else {
      setApiKey(""); setIsLive(false);
      try { if (key) localStorage.removeItem(SK+"_key"); } catch {}
      setApiStatus({type:key?"error":"demo", msg:result.msg});
      if (key) addLog("API key test failed: " + result.msg, "error");
      initSim("", false, state);
    }
  }, [addLog, initSim, state]);

  const refreshPrices = useCallback(async function(st, key, live) {
    if (!st || !st.simA) return;
    addLog("Refreshing prices...", "info");
    const today = new Date().toISOString().split("T")[0];
    const ts = new Date().toLocaleTimeString("en-US",{hour12:false});

    async function upd(sim, type) {
      const u = Object.assign({}, sim, {picks: sim.picks.map(function(p) { return Object.assign({},p); })});
      let pnl = 0;
      for (let i = 0; i < u.picks.length; i++) {
        const p = u.picks[i];
        if (p.status === "stopped" || p.status === "profit") {
          pnl += p.closedPnl !== undefined ? p.closedPnl : ((p.currentPrice-p.entryPrice)/p.entryPrice)*p.allocation;
          continue;
        }
        const snap = await getSnap(p.symbol, key, live);
        const price = (snap && snap.day && snap.day.c) ? snap.day.c : p.currentPrice;
        const vwap = (snap && snap.day && snap.day.vw) ? snap.day.vw : ((p.score && p.score.vwap) || price);
        const vol = (snap && snap.day && snap.day.v) ? snap.day.v : 0;
        const chg = (price - p.entryPrice) / p.entryPrice;
        const nr = vol > 0 ? vol/2000000 : ((p.score && p.score.rvol) || 1);
        const prevRvol = (p.score && p.score.rvol) || 1;
        const fade = (nr < prevRvol*0.6 ? 1 : 0) + (price < vwap ? 1 : 0) >= 2;
        let status = fade ? "fading" : "active";
        let cp;
        if (chg <= -STOP_PCT) {
          cp = (chg - SLIP - FEE) * p.allocation; status = "stopped";
          addLog("Stop-loss: "+p.symbol+" "+(chg*100).toFixed(2)+"% | Loss "+usd(Math.abs(cp)), "error");
          logTrade({date:today,time:ts,sim:"Sim "+type,symbol:p.symbol,sector:p.sector||"",event:"STOP-LOSS",entryPrice:p.entryPrice,exitPrice:price,allocation:p.allocation,pnlUsd:cp,pnlPct:chg*100,score:p.score&&p.score.composite,notes:"Slippage applied"});
        } else if (chg >= TGT) {
          cp = (chg - FEE) * p.allocation; status = "profit";
          addLog("Target hit: "+p.symbol+" +"+(chg*100).toFixed(2)+"% | "+usd(cp), "success");
          logTrade({date:today,time:ts,sim:"Sim "+type,symbol:p.symbol,sector:p.sector||"",event:"PROFIT-TARGET",entryPrice:p.entryPrice,exitPrice:price,allocation:p.allocation,pnlUsd:cp,pnlPct:chg*100,score:p.score&&p.score.composite,notes:""});
        } else if (fade) {
          addLog("Fade warning: " + p.symbol, "warn");
        }
        const newScore = Object.assign({}, p.score, {rvol:nr, aboveVwap:price>=vwap, vwap});
        u.picks[i] = Object.assign({}, p, {currentPrice:price, exitPrice:cp!==undefined?price:p.exitPrice, status, closedPnl:cp, score:newScore});
        pnl += cp !== undefined ? cp : chg * p.allocation;
      }
      u.totalPnl = pnl; u.capital = sim.sessionCapital + pnl;
      return u;
    }

    const nA = await upd(st.simA, "A");
    const nB = await upd(st.simB, "B");
    persist(Object.assign({}, st, {simA:nA, simB:nB}));
    const now = new Date().toLocaleTimeString();
    setLastRefresh(now);
    setNextRefresh(new Date(Date.now()+15*60*1000).toLocaleTimeString());
    addLog("Refresh done | A: "+usd(nA.totalPnl)+" | B: "+usd(nB.totalPnl), "info");
  }, [addLog, logTrade, persist]);

  const closeDay = useCallback(function(st) {
    if (!st || !st.simA) return st;
    const pA = st.simA.totalPnl||0, pB = st.simB.totalPnl||0;
    const total = pA+pB, end = st.startUsd+total;
    const rec = {date:st.date, totalPnl:total, capitalEnd:end, capitalStart:st.startUsd, rate:st.rate};
    const sA = {date:st.date, totalPnl:pA, picks:st.simA.picks.map(function(p){return Object.assign({},p,{exitPrice:p.exitPrice||p.currentPrice});})};
    const sB = {date:st.date, totalPnl:pB, picks:st.simB.picks.map(function(p){return Object.assign({},p,{exitPrice:p.exitPrice||p.currentPrice});})};
    const ns = Object.assign({}, st, {
      history:(st.history||[]).concat([rec]),
      histA:(st.histA||[]).concat([sA]),
      histB:(st.histB||[]).concat([sB])
    });
    persist(ns);
    addLog("Day closed. P&L: "+signed(total)+" | Capital: "+usd(end), total>=0?"success":"error");
    return ns;
  }, [persist, addLog]);

  const handleSwap = useCallback(async function(sym, simId) {
    if (!state) return;
    const sim = state[simId];
    if (!sim || sim.swapsUsed >= MAX_SWAPS) { addLog("Max swaps reached","warn"); return; }
    const freed = (sim.picks.find(function(p){return p.symbol===sym;})||{}).allocation||0;
    const excl = ((state.simA&&state.simA.picks)||[]).concat((state.simB&&state.simB.picks)||[]).map(function(p){return p.symbol;}).filter(function(s){return s!==sym;});
    const reps = await buildPicks(1, freed, apiKey, isLive, simId==="simA"?"A":"B", excl, state.regime&&state.regime.regime);
    if (!reps.length) { addLog("No replacement found","warn"); return; }
    const ns = Object.assign({}, state, {[simId]:Object.assign({},sim,{picks:sim.picks.map(function(p){return p.symbol===sym?reps[0]:p;}),swapsUsed:sim.swapsUsed+1})});
    persist(ns);
  }, [state, apiKey, isLive, addLog, buildPicks, persist]);

  // Market clock
  useEffect(function() {
    function tick() {
      const s = getMktStatus(); setMktSt(s);
      const d = etNow();
      setEtStr(String(d.h).padStart(2,"0")+":"+String(d.m).padStart(2,"0")+" ET");
      if (s.s==="open" && d.mins>=570 && d.mins<572 && autoRef.current.nd!==d.dateStr && !busy && (apiKey||state)) {
        autoRef.current.nd = d.dateStr;
        const prev = localStorage.getItem(SK);
        const p = prev ? JSON.parse(prev) : null;
        if (!p || p.date !== d.dateStr) {
          addLog("Auto New Day 09:30 ET","success");
          setTimeout(function() { initSim(apiKey, isLive, p); }, 300);
        }
      }
      if (d.mins>=960 && d.mins<962 && autoRef.current.cd!==d.dateStr && mktDay()) {
        autoRef.current.cd = d.dateStr;
        setState(function(prev) { return prev ? closeDay(prev) : prev; });
      }
    }
    const id = setInterval(tick, 60000); tick();
    return function() { clearInterval(id); };
  }, [busy, apiKey, isLive, state, addLog, initSim, closeDay]);

  // 15-min refresh
  useEffect(function() {
    if (!state) return;
    const id = setInterval(function() {
      if (mktOpen()) { refreshPrices(state, apiKey, isLive); }
      else { addLog("Refresh skipped — market closed","info"); }
    }, 15*60*1000);
    return function() { clearInterval(id); };
  }, [state, apiKey, isLive, refreshPrices, addLog]);

  // Derived
  const pnlA = (state && state.simA && state.simA.totalPnl) || 0;
  const pnlB = (state && state.simB && state.simB.totalPnl) || 0;
  const totalPnl = pnlA + pnlB;
  const rt = (state && state.rate) || FALLBACK_RATE;
  const totalGbp = totalPnl / rt;
  const goalUsd = state ? state.startUsd * GOAL * 2 : 1;
  const goalPct = Math.min((totalPnl / goalUsd) * 100, 100);
  const cumPnl = ((state && state.history) || []).reduce(function(s,d){return s+d.totalPnl;},0);
  const isOpen = mktSt.s === "open";

  function chartData(hist, range) {
    if (!hist || !hist.length) return [];
    const cutoffs = {daily:1, weekly:7, monthly:30, yearly:365, all:9999};
    const days = cutoffs[range] || 9999;
    const cutoff = new Date(Date.now() - days*24*60*60*1000);
    return hist.filter(function(d){return new Date(d.date)>=cutoff;}).map(function(d){return {v:d.totalPnl, label:d.date.slice(5)};});
  }

  const TABS = ["dashboard","chart","history","trades","log"];
  const RANGES = ["daily","weekly","monthly","yearly","all"];

  return React.createElement("div", {style:{minHeight:"100vh", background:BG, color:TXT, fontFamily:"monospace"}},
    React.createElement("style", null, `
      @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: 'Share Tech Mono', monospace !important; background: #ffffff; }
      ::-webkit-scrollbar { width: 3px; height: 3px; }
      ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
      button { cursor: pointer; font-family: inherit; transition: opacity 0.12s; }
      button:hover { opacity: 0.7; }
      input { font-family: inherit; }
      @keyframes fadeIn { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.15; } }
      @keyframes gp { 0%,100% { opacity:0.04; } 50% { opacity:0.08; } }
    `),

    // Grid background
    React.createElement("div", {style:{position:"fixed",inset:0,zIndex:0,pointerEvents:"none",backgroundImage:"linear-gradient(#e2e8f0 1px,transparent 1px),linear-gradient(90deg,#e2e8f0 1px,transparent 1px)",backgroundSize:"38px 38px",animation:"gp 6s ease infinite"}}),
    React.createElement("div", {style:{position:"fixed",inset:0,zIndex:0,pointerEvents:"none",background:"radial-gradient(ellipse at 50% 30%,transparent 60%,#f1f5f9 100%)"}}),

    // ── Header ──
    React.createElement("header", {style:{position:"sticky",top:0,zIndex:100,background:"#fffffffa",backdropFilter:"blur(16px)",borderBottom:border(BDR),boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}},
      React.createElement("div", {style:{maxWidth:1160,margin:"0 auto",padding:"0 22px"}},
        React.createElement("div", {style:{display:"flex",alignItems:"center",justifyContent:"space-between",height:46}},
          React.createElement("div", {style:{display:"flex",alignItems:"center",gap:14}},
            React.createElement("div", {style:{display:"flex",alignItems:"center",gap:7}},
              React.createElement(Dot, {c:state?GREEN:DIM, pulse:!!state}),
              React.createElement("span", {style:{fontSize:12,letterSpacing:4,color:ACCENT}}, "ALPHASIM")
            ),
            React.createElement("div", {style:{width:1,height:14,background:BDR}}),
            React.createElement("span", {style:{fontSize:7,color:DIM,letterSpacing:2}}, "NYSE · NASDAQ"),
            state && state.regime ? React.createElement(Tag, {c:state.regime.regime==="bullish"?GREEN:state.regime.regime==="bearish"?RED:AMBER, size:7},
              state.regime.regime==="bullish"?"▲ BULL":state.regime.regime==="bearish"?"▼ BEAR":"◆ NEUTRAL"
            ) : null
          ),
          React.createElement("div", {style:{display:"flex",alignItems:"center",gap:14}},
            state && state.rate ? React.createElement("span", {style:{fontSize:8,color:DIM,letterSpacing:1}}, "GBP/USD "+state.rate.toFixed(4)) : null,
            React.createElement("span", {style:{fontSize:8,color:MUTED,letterSpacing:1}}, etStr),
            React.createElement("div", {style:{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",border:border(isOpen?"rgba(57,255,143,0.25)":"rgba(255,45,85,0.15)"),borderRadius:3}},
              React.createElement(Dot, {c:isOpen?GREEN:RED, pulse:isOpen}),
              React.createElement("span", {style:{fontSize:7,letterSpacing:2,color:isOpen?GREEN:RED}}, isOpen?"LIVE":"CLOSED")
            ),
            lastRefresh ? React.createElement("span", {style:{fontSize:7,color:DIM,letterSpacing:1}}, "SYNC "+lastRefresh) : null
          )
        ),
        React.createElement("nav", {style:{display:"flex",borderTop:border(BDR)}},
          TABS.map(function(v) {
            return React.createElement("button", {key:v, onClick:function(){setTab(v);},
              style:{background:"none",border:"none",padding:"9px 16px",fontSize:8,letterSpacing:2.5,textTransform:"uppercase",color:tab===v?ACCENT:DIM,borderBottom:tab===v?"1px solid "+ACCENT:"1px solid transparent",marginBottom:-1}
            }, v);
          })
        )
      )
    ),

    // ── Main Content ──
    React.createElement("main", {style:{maxWidth:1160,margin:"0 auto",padding:"22px 22px 60px",position:"relative",zIndex:1}},

      // ── Connect Screen ──
      !state && !busy ? React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:10,padding:32,marginBottom:22,position:"relative"}},
        React.createElement("div", {style:{position:"absolute",top:0,left:0,width:18,height:18,borderTop:border(ACCENT),borderLeft:border(ACCENT)}}),
        React.createElement("div", {style:{position:"absolute",bottom:0,right:0,width:18,height:18,borderBottom:border(ACCENT),borderRight:border(ACCENT)}}),
        React.createElement("div", {style:{fontSize:8,color:ACCENT,letterSpacing:4,marginBottom:10}}, "INITIALISE"),
        React.createElement("div", {style:{fontSize:15,color:TXT,letterSpacing:1,marginBottom:6}}, "CONNECT DATA SOURCE"),
        React.createElement("div", {style:{fontSize:10,color:MUTED,lineHeight:2,marginBottom:20}},
          "Enter Polygon.io API key for live data, or leave blank for demo mode with realistic mock prices.",
          React.createElement("br", null),
          "Free key at ", React.createElement("span", {style:{color:ACCENT}}, "polygon.io"), " → Sign up → API Keys"
        ),
        React.createElement(ApiStatusBanner, {status:apiStatus}),
        React.createElement("div", {style:{display:"flex",gap:10,marginBottom:12}},
          React.createElement("input", {type:"password",value:keyInput,onChange:function(e){setKeyInput(e.target.value);},
            onKeyDown:function(e){if(e.key==="Enter")handleConnect(keyInput);},
            placeholder:"PASTE POLYGON API KEY (OPTIONAL)",
            style:{flex:1,background:BG,border:border(BDR),borderRadius:3,padding:"10px 14px",color:TXT,fontSize:10,letterSpacing:2,outline:"none"}}),
          React.createElement(Btn, {variant:"primary", onClick:function(){handleConnect(keyInput);}}, "CONNECT →")
        ),
        React.createElement("div", {style:{display:"flex",gap:16,alignItems:"center"}},
          React.createElement("button", {onClick:function(){handleConnect("");},
            style:{background:"none",border:"none",color:MUTED,fontSize:10,letterSpacing:1,textDecoration:"underline",cursor:"pointer"}
          }, "Run in demo mode (no key needed)"),
          keyInput ? React.createElement("button", {
            onClick:function(){
              try{localStorage.removeItem(SK+"_key");}catch{}
              setKeyInput("");
              addLog("Saved API key cleared","warn");
            },
            style:{background:"none",border:"none",color:RED,fontSize:10,letterSpacing:1,textDecoration:"underline",cursor:"pointer"}
          }, "✕ Forget saved key") : null
        )
      ) : null,

      // ── Loading ──
      busy ? React.createElement("div", {style:{textAlign:"center",padding:"70px 0"}},
        React.createElement("div", {style:{position:"relative",width:42,height:42,margin:"0 auto 18px"}},
          React.createElement("div", {style:{width:42,height:42,border:border(BDR),borderTop:border(ACCENT),borderRadius:"50%",animation:"spin 0.9s linear infinite"}}),
          React.createElement("div", {style:{position:"absolute",inset:7,border:border(DIM),borderBottom:border(ACCENT+"44"),borderRadius:"50%",animation:"spin 2.5s linear infinite reverse"}})
        ),
        React.createElement("div", {style:{fontSize:9,color:ACCENT,letterSpacing:3}}, loadMsg||"INITIALISING"),
        React.createElement("div", {style:{fontSize:8,color:DIM,letterSpacing:2,marginTop:5}}, "4 CALLS/MIN · FREE TIER")
      ) : null,

      // ── Dashboard ──
      tab==="dashboard" && state && !busy ? React.createElement("div", null,
        React.createElement(ApiStatusBanner, {status:apiStatus||{type:"demo",msg:"Demo mode — add Polygon.io key for live data"}}),
        React.createElement(SimHealthMonitor, {state, lastRefresh, nextRefresh, isOpen}),
        !isOpen ? React.createElement("div", {style:{background:AMBER+"0c",border:border(AMBER+"30"),borderRadius:6,padding:"8px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10}},
          React.createElement(Dot, {c:AMBER}),
          React.createElement("span", {style:{fontSize:8,color:AMBER,letterSpacing:1.5}}, mktSt.label.toUpperCase()),
          React.createElement("span", {style:{fontSize:8,color:MUTED,marginLeft:"auto",letterSpacing:1}}, "AUTO-STARTS 09:30 ET NEXT TRADING DAY")
        ) : null,
        React.createElement("div", {style:{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}},
          React.createElement(StatCard, {label:"COMBINED P&L", value:(totalPnl>=0?"+":"")+usd(totalPnl), sub:"£"+Math.abs(totalGbp).toFixed(2)+" GBP", valueColor:totalPnl>=0?GREEN:RED}),
          React.createElement(StatCard, {label:"CUMULATIVE", value:(cumPnl>=0?"+":"")+usd(cumPnl), sub:"£"+Math.abs(cumPnl/rt).toFixed(2)+" GBP", valueColor:cumPnl>=0?GREEN:RED}),
          React.createElement(StatCard, {label:"DAILY GOAL", value:goalPct.toFixed(0)+"%", sub:"Target "+usd(goalUsd), valueColor:goalPct>=100?GREEN:ACCENT, accent:ACCENT}),
          React.createElement(StatCard, {label:"SESSION", value:state.date, sub:"Base "+usd(state.startUsd||0)})
        ),
        React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:8,padding:"12px 16px",marginBottom:14}},
          React.createElement("div", {style:{display:"flex",justifyContent:"space-between",fontSize:8,color:MUTED,letterSpacing:1.5,marginBottom:7}},
            React.createElement("span", null, "COMBINED DAILY TARGET "+(GOAL*100).toFixed(0)+"%"),
            React.createElement("span", {style:{color:goalPct>=100?GREEN:ACCENT}}, goalPct.toFixed(1)+"% ACHIEVED")
          ),
          React.createElement(GBar, {pct:goalPct, c:goalPct>=100?GREEN:ACCENT, h:4})
        ),
        React.createElement("div", {style:{display:"flex",gap:14,marginBottom:14}},
          React.createElement(SimPanel, {sim:state.simA, simId:"simA", onSwap:handleSwap, label:"SIM-A · MARKET OPEN", windows:WIN_A, accent:ACCENT, sessions:state.histA||[]}),
          React.createElement(SimPanel, {sim:state.simB, simId:"simB", onSwap:handleSwap, label:"SIM-B · MIDDAY ENTRY", windows:WIN_B, accent:PURPLE, sessions:state.histB||[]})
        ),
        React.createElement("div", {style:{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}},
          React.createElement(Btn, {onClick:function(){refreshPrices(state,apiKey,isLive);}}, "↻ MANUAL REFRESH"),
          React.createElement(Btn, {onClick:function(){setState(function(s){return s?closeDay(s):s;});}, variant:"success"}, "✓ CLOSE DAY"),
          React.createElement(Btn, {onClick:function(){initSim(apiKey,isLive,state);}}, "⟳ NEW DAY"),
          React.createElement("span", {style:{fontSize:8,color:DIM,letterSpacing:1,padding:"0 6px"}}, "AUTO 15 MIN · NEW-DAY 09:30 · CLOSE 16:00 ET"),
          isLive ? React.createElement("span", {style:{fontSize:8,color:GREEN,letterSpacing:1}}, "● LIVE DATA") : React.createElement("span", {style:{fontSize:8,color:AMBER,letterSpacing:1}}, "◌ DEMO MODE"),
          React.createElement(Btn, {onClick:function(){persist(null);setState(null);setApiKey("");setKeyInput("");setIsLive(false);setApiStatus(null);try{localStorage.removeItem(SK+"_key");}catch{}addLog("Reset.","warn");}, variant:"danger"}, "✕ RESET")
        )
      ) : null,

      // ── Chart ──
      tab==="chart" ? React.createElement("div", null,
        React.createElement("div", {style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}},
          React.createElement("span", {style:{fontSize:10,color:ACCENT,letterSpacing:4}}, "P&L PERFORMANCE"),
          React.createElement("div", {style:{display:"flex",gap:6}},
            RANGES.map(function(r) {
              return React.createElement(Btn, {key:r, small:true, onClick:function(){setChartRange(r);}, variant:chartRange===r?"primary":"default"}, r.toUpperCase());
            })
          )
        ),
        React.createElement("div", {style:{display:"flex",gap:6,marginBottom:16}},
          ["combined","sim-a","sim-b"].map(function(v) {
            const label = v==="combined"?"COMBINED":v==="sim-a"?"SIM A":"SIM B";
            return React.createElement(Btn, {key:v, small:true, onClick:function(){setChartView(v);}, variant:chartView===v?"primary":"default"}, label);
          })
        ),
        chartView==="combined" ? React.createElement("div", {style:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}},
          [{label:"SIM A",hist:state&&state.histA,accent:ACCENT},{label:"SIM B",hist:state&&state.histB,accent:PURPLE}].map(function(item) {
            const d = chartData(item.hist, chartRange);
            const wins = (item.hist||[]).filter(function(h){return h.totalPnl>0;}).length;
            const net = (item.hist||[]).reduce(function(s,h){return s+h.totalPnl;},0);
            return React.createElement("div", {key:item.label, style:{background:CARD,border:border(BDR),borderRadius:8,padding:18}},
              React.createElement("div", {style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}},
                React.createElement("span", {style:{fontSize:8,color:item.accent,letterSpacing:3}}, item.label+" DAILY P&L"),
                React.createElement("div", {style:{display:"flex",gap:6,alignItems:"center"}},
                  React.createElement(Dot, {c:item.accent}),
                  React.createElement("span", {style:{fontSize:8,color:MUTED}}, ((item.hist&&item.hist.length)||0)+" sessions")
                )
              ),
              React.createElement(PnLChart, {data:d, accent:item.accent}),
              (item.hist&&item.hist.length) ? React.createElement("div", {style:{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:5,marginTop:12}},
                [
                  {l:"BEST", v:(item.hist.length?"+"+ usd(Math.max.apply(null,item.hist.map(function(h){return h.totalPnl;}))):"—")},
                  {l:"WORST", v:(item.hist.length?usd(Math.min.apply(null,item.hist.map(function(h){return h.totalPnl;}))):"—")},
                  {l:"NET", v:(net>=0?"+":"")+usd(net)},
                  {l:"SESSIONS", v:(item.hist&&item.hist.length)||0},
                  {l:"WINS", v:wins},
                  {l:"LOSSES", v:((item.hist&&item.hist.length)||0)-wins},
                ].map(function(it) {
                  return React.createElement("div", {key:it.l, style:{background:BG,border:border(BDR),borderRadius:3,padding:"5px 8px"}},
                    React.createElement("div", {style:{fontSize:7,color:MUTED,letterSpacing:1.5,marginBottom:2}}, it.l),
                    React.createElement("div", {style:{fontSize:11,color:TXT}}, ""+it.v)
                  );
                })
              ) : null
            );
          })
        ) : (function() {
          const isSA = chartView === "sim-a";
          const hist = isSA ? (state&&state.histA) : (state&&state.histB);
          const accent = isSA ? ACCENT : PURPLE;
          const label = isSA ? "SIM A" : "SIM B";
          const d = chartData(hist, chartRange);
          const wins = (hist||[]).filter(function(h){return h.totalPnl>0;}).length;
          const total = (hist||[]).length;
          const net = (hist||[]).reduce(function(s,h){return s+h.totalPnl;},0);
          const wr = total ? (wins/total*100).toFixed(0) : 0;
          return React.createElement("div", null,
            React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:8,padding:20,marginBottom:14}},
              React.createElement("div", {style:{fontSize:8,color:accent,letterSpacing:3,marginBottom:14}}, label+" — DAILY P&L"),
              React.createElement(PnLChart, {data:d, accent})
            ),
            React.createElement("div", {style:{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}},
              [
                {l:"SESSIONS",v:total},
                {l:"WINS",v:wins,c:GREEN},
                {l:"LOSSES",v:total-wins,c:RED},
                {l:"WIN RATE",v:wr+"%",c:wins>=total-wins?GREEN:RED},
                {l:"NET P&L",v:(net>=0?"+":"")+usd(net),c:net>=0?GREEN:RED},
              ].map(function(it) {
                return React.createElement(StatCard, {key:it.l, label:it.l, value:""+it.v, valueColor:it.c});
              })
            )
          );
        })()
      ) : null,

      // ── History ──
      tab==="history" ? React.createElement("div", null,
        React.createElement("div", {style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}},
          React.createElement("span", {style:{fontSize:10,color:ACCENT,letterSpacing:4}}, "SESSION HISTORY"),
          state && state.history && state.history.length ? React.createElement(Btn, {onClick:function() {
            const rows = (state.history||[]).map(function(d){
              const r = d.capitalStart>0?((d.totalPnl/d.capitalStart)*100).toFixed(3):"0";
              return [d.date,(d.capitalStart||0).toFixed(2),(d.capitalEnd||0).toFixed(2),(d.totalPnl||0).toFixed(2),(d.totalPnl/((d.rate||rt)||1)).toFixed(2),r,(d.rate||rt).toFixed(4),d.totalPnl>0?"Yes":"No"];
            });
            exportCSV("alphasim_history_"+new Date().toISOString().split("T")[0]+".csv",rows,["Date","Cap Start","Cap End","P&L $","P&L £","Return %","GBP/USD","Win"]);
          }}, "↓ EXPORT CSV") : null
        ),
        !state || !state.history || !state.history.length
          ? React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:8,padding:"50px 0",textAlign:"center",color:MUTED,fontSize:10,letterSpacing:2}}, "NO SESSIONS CLOSED YET")
          : React.createElement("div", null,
              React.createElement("div", {style:{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}},
                React.createElement(StatCard, {label:"SESSIONS", value:state.history.length}),
                React.createElement(StatCard, {label:"WINNING", value:state.history.filter(function(d){return d.totalPnl>0;}).length, valueColor:GREEN}),
                React.createElement(StatCard, {label:"LOSING", value:state.history.filter(function(d){return d.totalPnl<0;}).length, valueColor:RED}),
                React.createElement(StatCard, {label:"NET P&L", value:(cumPnl>=0?"+":"")+usd(cumPnl), valueColor:cumPnl>=0?GREEN:RED})
              ),
              React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:8,overflow:"hidden"}},
                React.createElement("div", {style:{display:"grid",gridTemplateColumns:"1.5fr 1fr 1fr 1fr 1fr 1fr",padding:"8px 14px",borderBottom:border(BDR),fontSize:7,color:MUTED,letterSpacing:2}},
                  ["DATE","START","END","P&L","RETURN","STATUS"].map(function(h){return React.createElement("span",{key:h},h);})
                ),
                [].concat(state.history).reverse().map(function(d,i) {
                  const ret = (d.totalPnl/(d.capitalStart||1))*100;
                  return React.createElement("div", {key:i, style:{display:"grid",gridTemplateColumns:"1.5fr 1fr 1fr 1fr 1fr 1fr",padding:"10px 14px",borderBottom:border(DIM),fontSize:10}},
                    React.createElement("span", {style:{color:TXT}}, d.date),
                    React.createElement("span", {style:{color:MUTED}}, "$"+(d.capitalStart||0).toFixed(0)),
                    React.createElement("span", {style:{color:TXT,fontWeight:600}}, "$"+(d.capitalEnd||0).toFixed(0)),
                    React.createElement("span", {style:{color:d.totalPnl>=0?GREEN:RED}}, signed(d.totalPnl)),
                    React.createElement("span", {style:{color:ret>=0?GREEN:RED}}, pct(ret)),
                    React.createElement(Tag, {c:d.totalPnl>=0?GREEN:RED, size:7}, d.totalPnl>=0?"PROFIT":"LOSS")
                  );
                })
              )
            )
      ) : null,

      // ── Trades ──
      tab==="trades" ? React.createElement("div", null,
        React.createElement("div", {style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}},
          React.createElement("span", {style:{fontSize:10,color:ACCENT,letterSpacing:4}}, "TRADE LOG"),
          React.createElement("div", {style:{display:"flex",gap:8}},
            tlog.length ? React.createElement(Btn, {onClick:function(){
              const rows=tlog.map(function(t){return[t.date,t.time,t.sim,t.symbol,t.sector||"",t.event,t.entryPrice?t.entryPrice.toFixed(2):"",t.exitPrice?parseFloat(t.exitPrice).toFixed(2):"",t.allocation?t.allocation.toFixed(2):"",t.pnlUsd!=null?t.pnlUsd.toFixed(2):"",t.pnlPct!=null?t.pnlPct.toFixed(3):"",t.score||"",t.notes||""];});
              exportCSV("alphasim_trades_"+new Date().toISOString().split("T")[0]+".csv",rows,["Date","Time","Sim","Symbol","Sector","Event","Entry","Exit","Alloc","P&L $","P&L %","Score","Notes"]);
            }}, "↓ EXPORT CSV") : null,
            tlog.length ? React.createElement(Btn, {variant:"danger", onClick:function(){setTlog([]);localStorage.removeItem(SK+"_t");}}, "CLEAR") : null
          )
        ),
        tlog.length ? (function(){
          const exits=tlog.filter(function(t){return t.event!=="ENTRY";});
          const wins=exits.filter(function(t){return (t.pnlUsd||0)>0;});
          const net=exits.reduce(function(s,t){return s+(t.pnlUsd||0);},0);
          const wr=exits.length?(wins.length/exits.length*100).toFixed(0):0;
          return React.createElement("div", {style:{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:14}},
            React.createElement(StatCard, {label:"ENTRIES", value:tlog.filter(function(t){return t.event==="ENTRY";}).length, accent:ACCENT}),
            React.createElement(StatCard, {label:"EXITS", value:exits.length}),
            React.createElement(StatCard, {label:"WIN RATE", value:wr+"%", valueColor:parseInt(wr)>=50?GREEN:RED}),
            React.createElement(StatCard, {label:"W / L", value:wins.length+" / "+(exits.length-wins.length)}),
            React.createElement(StatCard, {label:"NET P&L", value:(net>=0?"+":"")+usd(net), valueColor:net>=0?GREEN:RED})
          );
        })() : null,
        !tlog.length
          ? React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:8,padding:"50px 0",textAlign:"center",color:MUTED,fontSize:10,letterSpacing:2}}, "NO TRADES YET")
          : React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:8,overflowX:"auto"}},
              React.createElement("div", {style:{minWidth:820}},
                React.createElement("div", {style:{display:"grid",gridTemplateColumns:"82px 60px 48px 58px 95px 78px 70px 68px 70px 70px 1fr",padding:"8px 13px",borderBottom:border(BDR),fontSize:7,color:MUTED,letterSpacing:1.5,gap:4}},
                  ["DATE","TIME","SIM","SYM","EVENT","ENTRY","EXIT","ALLOC","P&L $","P&L %","NOTES"].map(function(h){return React.createElement("span",{key:h},h);})
                ),
                tlog.map(function(t,i){
                  const ec=t.event==="PROFIT-TARGET"?GREEN:t.event==="STOP-LOSS"?RED:ACCENT;
                  return React.createElement("div", {key:i, style:{display:"grid",gridTemplateColumns:"82px 60px 48px 58px 95px 78px 70px 68px 70px 70px 1fr",padding:"7px 13px",borderBottom:border(DIM),fontSize:9,gap:4}},
                    React.createElement("span",{style:{color:"#334155"}},t.date),
                    React.createElement("span",{style:{color:DIM}},t.time),
                    React.createElement("span",{style:{color:MUTED}},t.sim?(t.sim.replace("Sim ","")):"-"),
                    React.createElement("span",{style:{color:"#475569",letterSpacing:1}},t.symbol),
                    React.createElement(Tag,{c:ec,size:7},t.event),
                    React.createElement("span",{style:{color:MUTED}},t.entryPrice?"$"+t.entryPrice:"—"),
                    React.createElement("span",{style:{color:MUTED}},t.exitPrice?"$"+parseFloat(t.exitPrice).toFixed(2):"—"),
                    React.createElement("span",{style:{color:DIM}},t.allocation?"$"+parseFloat(t.allocation).toFixed(0):"—"),
                    React.createElement("span",{style:{color:(t.pnlUsd||0)>=0?GREEN:RED}},t.pnlUsd!=null?signed(t.pnlUsd):"—"),
                    React.createElement("span",{style:{color:(t.pnlPct||0)>=0?GREEN:RED}},t.pnlPct!=null?pct(t.pnlPct):"—"),
                    React.createElement("span",{style:{color:DIM,fontSize:8,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},t.notes)
                  );
                })
              )
            )
      ) : null,

      // ── Log ──
      tab==="log" ? React.createElement("div", null,
        React.createElement("div", {style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}},
          React.createElement("span", {style:{fontSize:10,color:ACCENT,letterSpacing:4}}, "ACTIVITY LOG"),
          log.length ? React.createElement(Btn, {onClick:function(){exportCSV("alphasim_log_"+new Date().toISOString().split("T")[0]+".csv",log.map(function(e){return[e.ts,e.t,e.m];}),["Time","Type","Message"]);}}, "↓ EXPORT CSV") : null
        ),
        React.createElement("div", {style:{background:CARD,border:border(BDR),borderRadius:8,overflow:"hidden"}},
          !log.length
            ? React.createElement("div", {style:{padding:"50px",textAlign:"center",color:MUTED,fontSize:9,letterSpacing:2}}, "NO ACTIVITY")
            : log.map(function(e,i){
                const c = e.t==="error"?RED:e.t==="success"?GREEN:e.t==="warn"?AMBER:MUTED;
                return React.createElement("div", {key:e.id, style:{display:"flex",gap:12,padding:"7px 14px",borderBottom:border(DIM)}},
                  React.createElement("span",{style:{fontSize:8,color:DIM,flexShrink:0}},e.ts),
                  React.createElement(Tag,{c,size:7},e.t),
                  React.createElement("span",{style:{fontSize:10,color:c==="info"?MUTED:c,lineHeight:1.6}},e.m)
                );
              })
        )
      ) : null
    )
  );
}
