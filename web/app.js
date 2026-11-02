'use strict';
// A股板块分析 · 静态版（GitHub Pages）。数据：data/*.json（GitHub Actions 每 5 分钟导出）+ 手机端直连腾讯行情。
const $ = s => document.querySelector(s);
const V = $('#view');
const cls = p => p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
const pctS = p => p == null ? '--' : (p > 0 ? '+' : '') + (+p).toFixed(2) + '%';
const wan = w => w == null ? '--' : Math.abs(w) >= 1e4 ? (w / 1e4).toFixed(Math.abs(w) >= 1e6 ? 0 : 1) + '亿' : Math.round(w) + '万';
const yi = a => a == null ? '--' : wan(a / 1e4);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tags = t => (t || []).map(x => `<span class="tag ${x}">${x}</span>`).join('');
const MKT = { main: '主板', cyb: '创业板', kcb: '科创板', bj: '北交所' };
const state = { type: 'sw1', mode: 'map', showAll: false, kw: '', boardSort: {}, scroll: {} };
let timer = null;

// ---------- 北京时间 / 交易时段 ----------
function bjNow() { const d = new Date(); return new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000); }
function isTrading() { const d = bjNow(), w = d.getDay(), hm = d.getHours() * 100 + d.getMinutes(); return w > 0 && w < 6 && ((hm >= 925 && hm <= 1131) || (hm >= 1300 && hm <= 1501)); }
const hms = d => d.toTimeString().slice(0, 8);

// ---------- 数据：静态 JSON ----------
const cache = {};
async function getJSON(path, ttlMs = 0) {
  const c = cache[path]; if (c && (Date.now() - c.t < ttlMs)) return c.v;
  const pre = window.__pre && window.__pre[path]; if (pre) delete window.__pre[path]; // index.html 已预加载：同一 URL、默认缓存模式才能复用预加载响应
  const r = await fetch(path + '?t=' + (pre || Math.floor(Date.now() / 60000)), pre ? {} : { cache: 'no-store' }); // 每分钟一个缓存键，绕过 CDN 旧缓存
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const v = await r.json(); cache[path] = { t: Date.now(), v }; return v;
}
const objRows = d => d.rows.map(r => Object.fromEntries(d.cols.map((k, i) => [k, r[i]])));

// ---------- 腾讯实时行情：<script charset=gbk> 注入，读取全局变量 v_xxx ----------
function qtScript(codes) {
  return new Promise(res => {
    const s = document.createElement('script'); let done = false;
    const fin = ok => { if (done) return; done = true; clearTimeout(to); s.remove();
      const out = {}; if (ok) for (const c of codes) { const v = window['v_' + c]; if (v) { out[c] = parseQt(v); try { delete window['v_' + c]; } catch (e) { window['v_' + c] = undefined; } } }
      res(out); };
    const to = setTimeout(() => fin(false), 8000);
    s.charset = 'gbk'; s.src = 'https://qt.gtimg.cn/q=' + codes.join(',') + '&r=' + Math.random();
    s.onload = () => fin(true); s.onerror = () => fin(false); document.head.appendChild(s);
  });
}
function parseQt(v) {
  const f = v.split('~'); const n = i => { const x = parseFloat(f[i]); return isNaN(x) ? null : x; };
  return { name: (f[1] || '').replace(/\s/g, ''), price: n(3), prev: n(4), open: n(5), vol: n(6), time: f[30], chg: n(31), pct: n(32), high: n(33), low: n(34),
    amount: (n(37) || 0) * 1e4, turnover: n(38), pe: n(39), fmv: n(44), mv: n(45), limit_up: n(47), limit_down: n(48) };
}
const QT_STAT = { req: 0, ms: 0 };
async function liveQuotes(codes, batch = 60) {
  const t0 = performance.now(); const bs = []; for (let i = 0; i < codes.length; i += batch) bs.push(codes.slice(i, i + batch));
  const rs = await Promise.all(bs.map(qtScript)); const out = Object.assign({}, ...rs);
  QT_STAT.req = bs.length; QT_STAT.ms = Math.round(performance.now() - t0); QT_STAT.n = Object.keys(out).length; window.__qt = QT_STAT;
  return out;
}
// 腾讯日K/分时：ifzq.gtimg.cn 返回 Access-Control-Allow-Origin:*，直接 fetch；失败时用 _var= 脚本注入兜底
async function ifzq(path, varName) {
  for (const h of ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn']) {
    try { const r = await fetch(h + path); if (r.ok) { const t = await r.text(); return JSON.parse(t.slice(t.indexOf('{'))); } } catch (e) { }
  }
  return new Promise((res, rej) => { const s = document.createElement('script'); const vn = varName + Math.floor(Math.random() * 1e6);
    s.src = 'https://ifzq.gtimg.cn' + path + '&_var=' + vn; s.onload = () => { const v = window[vn]; s.remove(); v ? res(v) : rej(new Error('无数据')); };
    s.onerror = () => { s.remove(); rej(new Error('网络错误')); }; document.head.appendChild(s); });
}

function tagList(q, isNew) {
  const t = []; const nolimit = q && /^[NC]/.test(q.name || '');
  if (q && q.vol && q.limit_up && !nolimit) {
    if (q.price >= q.limit_up - 1e-6) t.push('涨停'); else if (q.high >= q.limit_up - 1e-6) t.push('炸板');
    if (q.limit_down && q.price <= q.limit_down + 1e-6) t.push('跌停');
  }
  if (q && !q.vol) t.push('停牌');
  if (isNew || nolimit) t.push('新股');
  if (q && /ST/i.test(q.name || '')) t.push('ST');
  return t;
}

function header(title, back, right) { $('#title').textContent = title; $('#back').style.display = back ? 'block' : 'none'; $('#hdrR').innerHTML = right || ''; }
function setTab(t) { document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.t === t)); }
function bg(p) {
  if (p == null || Math.abs(p) < 0.005) return '#8a8a8a';
  const a = Math.min(Math.abs(p) / 4, 1); const mix = (c1, c2) => c1.map((v, i) => Math.round(v + (c2[i] - v) * a));
  return `rgb(${(p > 0 ? mix([214, 120, 120], [190, 10, 20]) : mix([110, 190, 140], [0, 120, 50])).join(',')})`;
}
function treemap(items, W, H) {
  const total = items.reduce((s, x) => s + x.w, 0); const scale = W * H / total;
  const nodes = items.map(x => ({ ...x, a: x.w * scale })).sort((a, b) => b.a - a.a);
  const out = []; let x = 0, y = 0, w = W, h = H, row = [];
  const worst = (r, side) => { const s = r.reduce((t, n) => t + n.a, 0); let m = 0; for (const n of r) m = Math.max(m, side * side * n.a / (s * s), s * s / (side * side * n.a)); return m; };
  const lay = r => { const s = r.reduce((t, n) => t + n.a, 0);
    if (w >= h) { const cw = s / h; let cy = y; for (const n of r) { const nh = n.a / cw; out.push({ ...n, x, y: cy, w: cw, h: nh }); cy += nh; } x += cw; w -= cw; }
    else { const ch = s / w; let cx = x; for (const n of r) { const nw = n.a / ch; out.push({ ...n, x: cx, y, w: nw, h: ch }); cx += nw; } y += ch; h -= ch; } };
  for (const n of nodes) { const side = Math.min(w, h); if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n); else { lay(row); row = [n]; } }
  if (row.length) lay(row); return out;
}

// ---------- 首页：用导出的 5 分钟快照（不在手机上拉全市场） ----------
async function home() {
  setTab('home'); header('板块总览', false, '');
  let d; try { d = await getJSON('data/overview.json', 50000); } catch (e) { V.innerHTML = '<div class="empty">数据加载失败，请检查网络后下拉刷新</div>'; return; }
  if (!['#/', ''].includes(location.hash)) return;
  const tr = isTrading();
  // 数据延迟：工作日 09:30–11:30 / 13:00–15:00（北京时间），快照超过 15 分钟未更新
  const bn = bjNow(), hm = bn.getHours() * 100 + bn.getMinutes(), wd = bn.getDay();
  const today = `${bn.getFullYear()}-${String(bn.getMonth() + 1).padStart(2, '0')}-${String(bn.getDate()).padStart(2, '0')}`;
  const inSess = wd > 0 && wd < 6 && ((hm >= 930 && hm < 1130) || (hm >= 1300 && hm < 1500));
  const tsMs = Date.parse(d.ts.replace(' ', 'T') + '+08:00'); const ageMin = (Date.now() - tsMs) / 60000;
  const stale = inSess && ageMin > 15;
  const staleTip = stale ? (d.trade_date === today ? `快照已 ${Math.round(ageMin)} 分钟未更新` : '今日快照尚未生成（或今日休市）') : '';
  header('板块总览', false, `<span class="live ${tr ? '' : 'stale'}"></span>${tr ? '盘中' : '收盘'}`);
  const [up, flat, down, zt, dt] = d.breadth, tot = up + down + flat || 1;
  const boards = objRows({ cols: d.cols, rows: d.boards[state.type] }); const isGn = state.type === 'gn'; const kw = state.kw.trim();
  let shown = kw ? boards.filter(x => x.name.includes(kw)) : boards;
  if (isGn && !kw && !state.showAll) shown = [...boards.slice(0, 20), ...boards.slice(Math.max(20, boards.length - 10))];
  const idx = d.idx.filter(i => ['sh000001', 'sz399001', 'sz399006'].includes(i[0]));
  V.innerHTML = `<div class="upd">数据更新：${d.ts}（交易日 ${d.trade_date}）${stale ? ` <span class="badge-stale" title="${staleTip}">数据延迟</span>` : (tr ? ' · 每 5 分钟更新' : '')}${stale ? `<br><small>${staleTip}；板块页/个股页的价格为实时行情</small>` : ''}</div>
  <div class="card"><div class="idx">${idx.map(i => `<div><small>${esc(i[1])}</small><b class="${cls(i[3])}">${i[2]?.toFixed(2)}</b><small class="${cls(i[3])}">${pctS(i[3])}</small></div>`).join('')}</div>
   <div class="breadth"><span class="up">上涨 ${up}</span><span>平 ${flat}</span><span class="down">下跌 ${down}</span><span class="up">涨停 ${zt}</span><span class="down">跌停 ${dt}</span></div>
   <div class="bar"><i style="width:${up / tot * 100}%;background:var(--up)"></i><i style="width:${flat / tot * 100}%;background:var(--flat)"></i><i style="width:${down / tot * 100}%;background:var(--down)"></i></div></div>
  <div class="seg"><button data-ty="sw1" class="${!isGn ? 'on' : ''}">申万一级行业</button><button data-ty="gn" class="${isGn ? 'on' : ''}">概念板块</button></div>
  <div class="seg small"><button data-m="map" class="${state.mode === 'map' ? 'on' : ''}">热力图</button><button data-m="list" class="${state.mode === 'list' ? 'on' : ''}">排行榜</button></div>
  ${isGn ? `<div style="margin-bottom:8px"><input type="search" id="kw" placeholder="搜索概念板块（共 ${boards.length} 个）" value="${esc(state.kw)}"></div>` : ''}
  ${isGn && !kw ? `<div class="sec">${state.showAll ? `全部 ${boards.length} 个概念，按涨跌幅排序` : '涨幅前 20 + 跌幅前 10'} · <a href="javascript:void 0" id="tgl" style="color:var(--acc)">${state.showAll ? '收起' : '全部'}</a></div>` : ''}
  <div id="bv"></div>
  <p class="muted">板块涨跌幅＝成分股按流通市值加权的当日涨跌幅（成分来自新浪${isGn ? '热门概念' : '申万一级行业'}，行情来自腾讯）。方块大小＝板块成交额。</p>`;
  V.querySelectorAll('[data-ty]').forEach(x => x.onclick = () => { state.type = x.dataset.ty; state.kw = ''; state.showAll = false; home(); });
  V.querySelectorAll('[data-m]').forEach(x => x.onclick = () => { state.mode = x.dataset.m; home(); });
  const k = $('#kw'); if (k) k.oninput = () => { state.kw = k.value; const v = k.value.trim(); renderBoards(v ? boards.filter(x => x.name.includes(v)) : shown); };
  const t = $('#tgl'); if (t) t.onclick = () => { state.showAll = !state.showAll; home(); };
  renderBoards(shown);
  if (state.scroll.home) { window.scrollTo(0, state.scroll.home); state.scroll.home = 0; }
  clearInterval(timer); if (tr) timer = setInterval(() => { if (['#/', ''].includes(location.hash)) home(); }, 60000);
}
function renderBoards(list) {
  const el = $('#bv'); if (!list.length) { el.innerHTML = '<div class="empty">没有匹配的板块</div>'; return; }
  if (state.mode === 'map') {
    el.innerHTML = '<div class="tm" id="tm"></div>'; const tm = $('#tm');
    const rs = treemap(list.map(x => ({ ...x, w: Math.max(x.amount_yi, 0.01) })), tm.clientWidth, tm.clientHeight);
    tm.innerHTML = rs.map(r => { const fs = Math.max(9, Math.min(16, Math.sqrt(r.w * r.h) / 5.5)); const tiny = r.w < 34 || r.h < 26;
      return `<a href="#/board/${r.id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${bg(r.pct)};font-size:${fs}px">${tiny ? '' : `<b>${esc(r.name)}</b><span>${pctS(r.pct)}</span>`}</a>`; }).join('');
  } else {
    el.innerHTML = `<div class="card list">${list.map((x, i) => `<a class="row" href="#/board/${x.id}"><span style="width:26px;color:var(--sub);font-size:12px">${i + 1}</span><div class="nm">${esc(x.name)}<small>领涨 ${esc(x.lead)} <span class="${cls(x.lead_pct)}">${pctS(x.lead_pct)}</span> · ${x.n}只 · 涨${x.up}/跌${x.down}${x.zt ? ' · 涨停' + x.zt : ''}</small></div><div class="v ${cls(x.pct)}"><b>${pctS(x.pct)}</b><small>${x.amount_yi >= 1 ? x.amount_yi.toFixed(0) + '亿' : (x.amount_yi * 1e4).toFixed(0) + '万'}</small></div></a>`).join('')}</div>`;
  }
}

// ---------- 板块详情：先显示导出快照，再用腾讯实时行情覆盖 ----------
const COLS = [['name', '名称'], ['price', '现价'], ['pct', '涨跌幅'], ['amount', '成交额'], ['turnover', '换手'], ['mf', '主力净流入']];
async function boardView(id) {
  setTab('home'); header('板块', true, ''); V.innerHTML = '<div class="empty">加载中…</div>';
  const d = await getJSON('data/b/' + id + '.json', 50000);
  const rows = objRows(d).map(r => ({ code: r.code, name: r.name, price: r.price, pct: r.pct, amount: r.amount_wan == null ? null : r.amount_wan * 1e4, turnover: r.turnover,
    mf: r.mf_wan, fmv: r.fmv_yi, isNew: r.new, q: { name: r.name, price: r.price, vol: r.trading, limit_up: r.limit_up, limit_down: r.limit_down, high: r.high } }));
  rows.forEach(r => r.tags = tagList(r.q, r.isNew));
  const st = state.boardSort[id] || (state.boardSort[id] = { k: 'pct', asc: false });
  let src = `快照 ${d.ts.slice(5, 16)}`, live = false, bpct = null;
  const render = () => {
    header(d.name, true, `${rows.length} 只`);
    const rs = [...rows].sort((a, b) => { const x = a[st.k], y = b[st.k];
      if (st.k === 'name') return st.asc ? String(x).localeCompare(y, 'zh') : String(y).localeCompare(x, 'zh');
      if (x == null) return 1; if (y == null) return -1; return st.asc ? x - y : y - x; });
    V.innerHTML = `<div class="upd"><span class="live ${live ? '' : 'stale'}"></span>${src}${bpct != null ? ` · 板块 <b class="${cls(bpct)}">${pctS(bpct)}</b>` : ''}</div>
    <div class="card" style="padding:4px 6px"><table class="tbl"><thead><tr>${COLS.map(([k, n]) => `<th data-k="${k}" class="${st.k === k ? 's' : ''}">${n}${st.k === k ? (st.asc ? '↑' : '↓') : ''}</th>`).join('')}</tr></thead><tbody>
    ${rs.map(r => `<tr onclick="location.hash='#/stock/${r.code}'"><td>${esc(r.name)}${tags(r.tags)}<br><small>${r.code.slice(2)}</small></td><td class="${cls(r.pct)}">${r.price?.toFixed(2) ?? '--'}</td><td class="${cls(r.pct)}">${pctS(r.pct)}</td><td>${yi(r.amount)}</td><td>${r.turnover != null ? r.turnover.toFixed(2) + '%' : '--'}</td><td class="${cls(r.mf)}">${r.mf == null ? '暂无' : wan(r.mf)}</td></tr>`).join('')}
    </tbody></table></div><p class="muted">主力净流入为新浪口径（新浪资金流向“主力”净额，每 5 分钟随快照更新），取不到时显示「暂无」。现价/涨跌幅/成交额/换手为腾讯行情。</p>`;
    V.querySelectorAll('th').forEach(th => th.onclick = () => { const k = th.dataset.k; if (st.k === k) st.asc = !st.asc; else { st.k = k; st.asc = k === 'name'; } render(); window.__keepScroll = true; });
  };
  render();
  const key = 'board:' + id; if (state.scroll[key]) window.scrollTo(0, state.scroll[key]);
  const refresh = async () => {
    const q = await liveQuotes(rows.map(r => r.code));
    if (!Object.keys(q).length) { src = `实时行情获取失败，显示快照 ${d.ts.slice(5, 16)}`; live = false; render(); return; }
    let ws = 0, ps = 0;
    for (const r of rows) { const x = q[r.code]; if (!x) continue;
      Object.assign(r, { name: x.name, price: x.price, pct: x.vol ? x.pct : null, amount: x.amount, turnover: x.turnover, fmv: x.fmv, q: x }); r.tags = tagList(x, r.isNew);
      if (x.vol && x.pct != null && x.fmv) { ws += x.fmv; ps += x.fmv * x.pct; } }
    bpct = ws ? ps / ws : null; live = true;
    src = `腾讯实时 ${hms(new Date())}（${QT_STAT.n} 只，${QT_STAT.req} 次请求 ${QT_STAT.ms}ms）`;
    const y = window.scrollY; render(); window.scrollTo(0, y);
  };
  await refresh();
  clearInterval(timer); if (isTrading()) timer = setInterval(() => { if (location.hash === '#/board/' + id) refresh(); }, 60000);
}

// ---------- 个股 ----------
const WL = { get: () => JSON.parse(localStorage.getItem('wl') || '[]'), set: v => localStorage.setItem('wl', JSON.stringify(v)) };
async function stockView(code) {
  loadLwc().catch(() => {}); // 与行情并行预取图表库，不阻塞页面
  setTab(''); header('个股', true, ''); V.innerHTML = '<div class="empty">加载中…</div>';
  const [qm, sx, fx] = await Promise.all([liveQuotes([code]), getJSON('data/stocks.json', 300000).catch(() => null), getJSON('data/features.json', 300000).catch(() => null)]);
  const x = qm[code]; const si = sx ? sx.rows.find(r => r[0] === code) : null; const fr = fx ? fx.rows.find(r => r[0] === code) : null;
  if (!x && !si) { V.innerHTML = '<div class="empty">行情获取失败</div>'; return; }
  const q = x || { name: si[1] }; const mf = si ? si[4] : null; const isNew = (si && si[5]) || (fr && fr[4]);
  const lb = fr ? fr[11] : 0; const ztd = fr ? fr[12].map(i => fx.dates[i]) : []; const zbd = fr ? fr[13].map(i => fx.dates[i]) : [];
  const inWl = WL.get().includes(code);
  header(`${q.name} ${code.slice(2)}`, true, MKT[si ? si[2] : ''] || '');
  const bds = si ? si[3].map(i => sx.boards[i]) : [];
  V.innerHTML = `<div class="upd"><span class="live ${x ? '' : 'stale'}"></span>${x ? '腾讯实时 ' + hms(new Date()) : '实时行情获取失败'}</div>
  <div class="card"><div style="display:flex;align-items:center;justify-content:space-between"><div><span class="big ${cls(q.pct)}">${q.price?.toFixed(2) ?? '--'}</span> <span class="${cls(q.pct)}">${q.chg > 0 ? '+' : ''}${q.chg?.toFixed(2) ?? ''} ${pctS(q.pct)}</span><div>${tags(tagList(x, isNew))}</div></div>
    <button class="btn ${inWl ? '' : 'fill'}" id="wlb">${inWl ? '已自选' : '+ 自选'}</button></div>
    <div class="kv" style="margin-top:10px"><div><small>今开</small>${q.open ?? '--'}</div><div><small>最高</small>${q.high ?? '--'}</div><div><small>最低</small>${q.low ?? '--'}</div>
    <div><small>涨停价</small>${q.limit_up ?? '--'}</div><div><small>跌停价</small>${q.limit_down ?? '--'}</div><div><small>换手率</small>${q.turnover ?? '--'}%</div>
    <div><small>成交额</small>${yi(q.amount)}</div><div><small>总市值</small>${q.mv ? q.mv.toFixed(0) + '亿' : '--'}</div><div><small>市盈率(TTM)</small>${q.pe ?? '--'}</div>
    <div><small>流通市值</small>${q.fmv ? q.fmv.toFixed(0) + '亿' : '--'}</div><div><small>主力净流入</small>${mf == null ? '暂无' : wan(mf)}</div><div><small>连板</small>${lb}</div></div>
    ${ztd.length ? `<div class="muted" style="margin-top:6px">近期涨停：${ztd.slice(-10).join('、')}</div>` : ''}${zbd.length ? `<div class="muted">近期炸板：${zbd.slice(-10).join('、')}</div>` : ''}</div>
  <div class="seg small"><button data-c="min" class="on">分时</button><button data-c="day">日K</button></div>
  <div class="card" style="padding:4px"><div id="leg" class="muted" style="padding:2px 6px;min-height:16px"></div><div class="chart" id="ch"></div></div>
  <div class="card"><div class="sec" style="margin-top:0">所属板块</div>${bds.map(b => `<a class="btn" style="display:inline-block;margin:3px" href="#/board/${b[0]}">${esc(b[1])}</a>`).join('') || '<span class="muted">无</span>'}</div>
  <p class="muted">主力净流入为新浪口径（${sx ? sx.ts.slice(5, 16) : '--'}）。行情、分时、日K（前复权）来自腾讯。</p>`;
  $('#wlb').onclick = () => { let w = WL.get(); const on = w.includes(code); w = on ? w.filter(c => c !== code) : [...w, code]; WL.set(w); $('#wlb').textContent = on ? '+ 自选' : '已自选'; $('#wlb').classList.toggle('fill', on); };
  V.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { V.querySelectorAll('[data-c]').forEach(z => z.classList.toggle('on', z === b)); drawChart(code, b.dataset.c, q.prev); });
  drawChart(code, 'min', q.prev);
}

// ---------- 图表库按需加载：首屏不加载 lwc.js，打开个股图表时才注入 ----------
const LWC_SRC = 'lwc.js';
let lwcEl = null, lwcFailed = false;
function loadLwc(ms = 15000) {
  return new Promise((res, rej) => {
    if (window.LightweightCharts) return res();
    if (!lwcEl || lwcFailed) { if (lwcEl) lwcEl.remove(); lwcFailed = false; lwcEl = document.createElement('script'); lwcEl.src = LWC_SRC; lwcEl.async = true;
      lwcEl.addEventListener('error', () => { lwcFailed = true; }); document.head.appendChild(lwcEl); }
    const to = setTimeout(() => rej(new Error('timeout')), ms);
    lwcEl.addEventListener('load', () => { clearTimeout(to); window.LightweightCharts ? res() : rej(new Error('load')); }, { once: true });
    lwcEl.addEventListener('error', () => { clearTimeout(to); rej(new Error('error')); }, { once: true });
  });
}
async function chartReady(el, my, redraw) { // 成功返回 true；超时/失败显示重试，稍后加载成功会自动重画
  if (window.LightweightCharts) return true;
  el.innerHTML = '<div class="empty">图表加载中…</div>';
  try { await loadLwc(); return my === drawSeq; }
  catch (e) {
    if (my !== drawSeq) return false;
    el.innerHTML = `<div class="empty">图表组件${e.message === 'timeout' ? '加载超时（网络较慢）' : '加载失败'}<br><button class="btn" id="lwcRetry" style="margin-top:8px">重试</button></div>`;
    const b = el.querySelector('#lwcRetry'); if (b) b.onclick = () => redraw();
    if (lwcEl && !lwcFailed) lwcEl.addEventListener('load', () => { if (my === drawSeq && window.LightweightCharts) redraw(); }, { once: true });
    return false;
  }
}
let chart = null;
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
function mkChart(el, opt) {
  if (chart) { chart.remove(); chart = null; }
  chart = LightweightCharts.createChart(el, { width: el.clientWidth, height: el.clientHeight, layout: { background: { color: 'transparent' }, textColor: dark() ? '#aaa' : '#555', fontSize: 11 },
    grid: { vertLines: { color: dark() ? '#222' : '#eee' }, horzLines: { color: dark() ? '#222' : '#eee' } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, ...(opt || {}) },
    handleScale: { axisPressedMouseMove: false }, localization: { locale: 'zh-CN' } });
  return chart;
}
let drawSeq = 0;
async function drawChart(code, kind, prev) {
  const my = ++drawSeq; const el = $('#ch'); $('#leg').textContent = '';
  if (!(await chartReady(el, my, () => drawChart(code, kind, prev)))) return;
  el.innerHTML = '';
  try {
    if (kind === 'min') {
      const j = await ifzq('/appstock/app/minute/query?code=' + code, 'mq'); if (my !== drawSeq) return; const dd = j.data[code].data;
      const ymd = dd.date; const base = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 1000;
      let pv = 0, pa = 0; const pts = dd.data.map(l => { const [hm, p, cv, ca] = l.split(' '); const o = { t: base + (+hm.slice(0, 2)) * 3600 + (+hm.slice(2)) * 60, p: +p, v: +cv - pv, a: +ca - pa }; pv = +cv; pa = +ca; return o; });
      const c = mkChart(el, { timeVisible: true, secondsVisible: false });
      const s = c.addLineSeries({ color: '#3a7bd5', lineWidth: 1.5, priceLineVisible: false }); s.setData(pts.map(p => ({ time: p.t, value: p.p })));
      let cum = 0, cv = 0; const avg = c.addLineSeries({ color: '#e0a000', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      avg.setData(pts.map(p => { cum += p.a; cv += p.v; return { time: p.t, value: cv ? cum / cv / 100 : p.p }; }));
      if (prev) s.createPriceLine({ price: prev, color: '#999', lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: '昨收' });
      const vs = c.addHistogramSeries({ priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }); c.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      vs.setData(pts.map((p, i) => ({ time: p.t, value: p.v, color: (i && p.p < pts[i - 1].p) ? 'rgba(17,160,90,.6)' : 'rgba(224,38,47,.6)' })));
      c.timeScale().fitContent();
      $('#leg').innerHTML = `分时 ${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)} · <span style="color:#3a7bd5">价格</span> <span style="color:#e0a000">均价</span>`;
    } else {
      const j = await ifzq(`/appstock/app/fqkline/get?param=${code},day,,,250,qfq`, 'kq'); const dd = j.data[code];
      const k = (dd.qfqday || dd.day || []).map(b => ({ t: b[0], o: +b[1], c: +b[2], h: +b[3], l: +b[4], v: +b[5] }));
      if (k.length < 30 && code.startsWith('bj')) $('#leg').textContent = '北交所新代码日K历史有限';
      const c = mkChart(el);
      const cs = c.addCandlestickSeries({ upColor: '#e0262f', downColor: '#11a05a', borderUpColor: '#e0262f', borderDownColor: '#11a05a', wickUpColor: '#e0262f', wickDownColor: '#11a05a' });
      cs.setData(k.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));
      const ma = (n, col) => { const s = c.addLineSeries({ color: col, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        const out = []; for (let i = n - 1; i < k.length; i++) { let t = 0; for (let j = i - n + 1; j <= i; j++) t += k[j].c; out.push({ time: k[i].t, value: +(t / n).toFixed(3) }); } s.setData(out); return out; };
      const m5 = ma(5, '#e0a000'), m10 = ma(10, '#3a7bd5'), m20 = ma(20, '#b04ad5');
      const vs = c.addHistogramSeries({ priceScaleId: 'v', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }); c.priceScale('v').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      vs.setData(k.map(b => ({ time: b.t, value: b.v, color: b.c >= b.o ? 'rgba(224,38,47,.5)' : 'rgba(17,160,90,.5)' })));
      c.timeScale().setVisibleLogicalRange({ from: Math.max(0, k.length - 80), to: k.length });
      const last = a => a.length ? a[a.length - 1].value.toFixed(2) : '--';
      const leg = (a, b, d, t) => `${t} <span style="color:#e0a000">MA5 ${a}</span> <span style="color:#3a7bd5">MA10 ${b}</span> <span style="color:#b04ad5">MA20 ${d}</span>`;
      const def = () => leg(last(m5), last(m10), last(m20), `日K(${k.length}日,前复权)`); $('#leg').innerHTML = def();
      c.subscribeCrosshairMove(p => { if (!p.time) { $('#leg').innerHTML = def(); return; }
        const g = a => (a.find(x => x.time === p.time)?.value ?? NaN).toFixed(2); const b = k.find(x => x.t === p.time);
        $('#leg').innerHTML = leg(g(m5), g(m10), g(m20), `${p.time} 收${b?.c}`); });
    }
  } catch (e) { el.innerHTML = '<div class="empty">图表加载失败（' + esc(e.message) + '）</div>'; }
}

// ---------- 智能选股（浏览器端计算，数据为收盘后导出的 features.json） ----------
const SC = Object.assign({ zt: 1, zt_n: 10, lb: 0, lb_min: 2, fl: 0, fl_k: 2, ma: 0, ma_n: 5, mf: 0, mf_m: 3, incl_st: 0, incl_new: 0, board: '' }, JSON.parse(localStorage.getItem('sc') || '{}'));
async function screenView() {
  setTab('screen'); header('智能选股', false, '');
  const sx = await getJSON('data/stocks.json', 300000);
  const cb = k => `<input type="checkbox" data-k="${k}" ${+SC[k] ? 'checked' : ''}>`;
  const num = (k, step) => `<input type="number" data-k="${k}" value="${SC[k]}" step="${step || 1}" min="1">`;
  V.innerHTML = `<div class="card">
   <div class="cond">${cb('zt')}<label>近 N 日有涨停</label>N=${num('zt_n')}</div>
   <div class="cond">${cb('lb')}<label>连板数 ≥</label>${num('lb_min')}</div>
   <div class="cond">${cb('fl')}<label>放量突破<br><small class="muted">量≥近5日均量K倍且收盘创20日新高</small></label>K=${num('fl_k', 0.1)}</div>
   <div class="cond">${cb('ma')}<label>站上均线</label><select data-k="ma_n"><option value="5" ${SC.ma_n == 5 ? 'selected' : ''}>5日线</option><option value="20" ${SC.ma_n == 20 ? 'selected' : ''}>20日线</option></select></div>
   <div class="cond">${cb('mf')}<label>主力连续净流入<br><small class="muted">新浪口径，数据不足的股票不入选</small></label>M=${num('mf_m')}</div>
   <div class="cond"><label>所属板块</label><select data-k="board" style="max-width:55%"><option value="">全部</option>${sx.boards.slice().sort((a, b) => (b[2] > a[2]) - (b[2] < a[2]) || a[1].localeCompare(b[1], 'zh')).map(b => `<option value="${b[0]}" ${SC.board === b[0] ? 'selected' : ''}>${b[2] === 'sw1' ? '[行业]' : '[概念]'}${esc(b[1])}</option>`).join('')}</select></div>
   <div class="cond">${cb('incl_st')}<label>包含 ST 股</label>${cb('incl_new')}<label>包含次新股（上市&lt;20日）</label></div>
   <div style="text-align:center;margin-top:10px"><button class="btn fill" id="go" style="padding:8px 40px">开始选股</button></div></div><div id="res"></div>`;
  V.querySelectorAll('[data-k]').forEach(el => el.onchange = () => { const k = el.dataset.k; SC[k] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value; localStorage.setItem('sc', JSON.stringify(SC)); });
  $('#go').onclick = runScreen; runScreen();
}
async function runScreen() {
  const r = $('#res'); r.innerHTML = '<div class="empty">计算中…</div>';
  const fx = await getJSON('data/features.json', 300000); const D = fx.dates; const nD = D.length;
  let bset = null; if (SC.board) { const b = await getJSON('data/b/' + SC.board + '.json', 300000); bset = new Set(b.rows.map(x => x[0])); }
  const zn = +SC.zt_n || 10, lbm = +SC.lb_min || 2, k = +SC.fl_k || 2, man = +SC.ma_n || 5, M = +SC.mf_m || 3;
  if (!(+SC.zt || +SC.lb || +SC.fl || +SC.ma || +SC.mf)) { r.innerHTML = '<div class="empty">请至少选择一个条件</div>'; return; }
  const out = [];
  for (const row of fx.rows) {
    const [code, name, mkt, st, isNew, susp, close, pct, ma5, ma10, ma20, lb, zt, zb, vr, hi20, mf] = row;
    if (susp) continue; if (!+SC.incl_st && st) continue; if (!+SC.incl_new && isNew) continue; if (bset && !bset.has(code)) continue;
    const hit = []; const zw = zt.filter(i => i >= nD - zn), bw = zb.filter(i => i >= nD - zn);
    if (+SC.zt) { if (!zw.length) continue; hit.push(`近${zn}日涨停${zw.length}次`); }
    if (+SC.lb) { if (lb < lbm) continue; hit.push(`${lb}连板`); }
    if (+SC.fl) { if (!(vr && vr >= k && hi20)) continue; hit.push(`量比5日${vr.toFixed(1)}倍·创20日新高`); }
    if (+SC.ma) { const m = man == 20 ? ma20 : ma5; if (!(m && close > m)) continue; hit.push(`站上${man}日线`); }
    if (+SC.mf) { const last = mf.slice(-M); if (last.length < M || last.some(v => v == null || v <= 0)) continue; hit.push(`主力连续${M}日净流入`); }
    out.push({ code, name, mkt, close, pct, hit, lb, st, isNew, zd: zw.map(i => D[i]), bd: bw.map(i => D[i]) });
  }
  out.sort((a, b) => (b.lb - a.lb) || ((b.pct ?? -99) - (a.pct ?? -99)));
  const show = out.slice(0, 300);
  r.innerHTML = `<div class="sec">共 ${out.length} 只（数据截止 ${fx.date}，收盘后计算；多条件取交集）${out.length > 300 ? '，显示前 300' : ''}</div>
  <div class="card list">${show.map(x => `<a class="row" href="#/stock/${x.code}"><div class="nm">${esc(x.name)} <small style="display:inline">${x.code.slice(2)} ${MKT[x.mkt]}</small>${x.st ? tags(['ST']) : ''}${x.isNew ? tags(['新股']) : ''}<small>${x.hit.join(' · ')}${x.zd.length ? ' · 涨停日 ' + x.zd.map(s => s.slice(5)).join(',') : ''}${x.bd.length ? ' · 炸板 ' + x.bd.map(s => s.slice(5)).join(',') : ''}</small></div><div class="v ${cls(x.pct)}"><b>${x.close?.toFixed(2)}</b><small class="${cls(x.pct)}">${pctS(x.pct)}</small></div></a>`).join('') || '<div class="empty">没有符合条件的股票</div>'}</div>
  <p class="muted">涨停＝收盘价等于当日涨停价（当日取行情接口的涨停价；历史日按交易所规则由前收盘价计算）。摸板未封住记为炸板，不算涨停。新股无涨跌幅限制的交易日、主板新股首日不算涨停。</p>`;
}

// ---------- 自选（localStorage） ----------
async function watchView() {
  setTab('watch'); header('自选股', false, '');
  V.innerHTML = `<div class="card"><input type="search" id="sk" placeholder="输入代码或名称添加自选"><div id="sr" class="list"></div></div><div id="wl"></div>`;
  const sxP = getJSON('data/stocks.json', 300000);
  const load = async () => { const codes = WL.get();
    if (!codes.length) { $('#wl').innerHTML = '<div class="empty">还没有自选股<br>在个股页点「+ 自选」，或在上方搜索添加</div>'; return; }
    const [q, sx] = await Promise.all([liveQuotes(codes), sxP.catch(() => null)]); const mfm = {}; if (sx) for (const r of sx.rows) if (codes.includes(r[0])) mfm[r[0]] = r;
    $('#wl').innerHTML = `<div class="upd"><span class="live ${Object.keys(q).length ? '' : 'stale'}"></span>${Object.keys(q).length ? '腾讯实时 ' + hms(new Date()) : '实时行情获取失败'}</div><div class="card list">${codes.map(c => { const x = q[c] || {}; const s = mfm[c];
      return `<div class="row"><a class="nm" href="#/stock/${c}" style="color:inherit;text-decoration:none">${esc(x.name || (s && s[1]) || c)}${tags(tagList(q[c], s && s[5]))}<small>${c.slice(2)} · 主力 ${s && s[4] != null ? wan(s[4]) : '暂无'}</small></a><div class="v ${cls(x.pct)}"><b>${x.price?.toFixed(2) ?? '--'}</b><small class="${cls(x.pct)}">${pctS(x.vol ? x.pct : null)}</small></div><button class="btn" style="margin-left:8px" data-del="${c}">删除</button></div>`; }).join('')}</div>`;
    $('#wl').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { WL.set(WL.get().filter(c => c !== b.dataset.del)); load(); }); };
  let tmo; $('#sk').oninput = e => { clearTimeout(tmo); const v = e.target.value.trim(); if (!v) { $('#sr').innerHTML = ''; return; }
    tmo = setTimeout(async () => { const sx = await sxP; const r = sx.rows.filter(x => x[0].includes(v) || x[1].includes(v)).slice(0, 20);
      $('#sr').innerHTML = r.map(x => `<div class="row"><a class="nm" href="#/stock/${x[0]}" style="color:inherit;text-decoration:none">${esc(x[1])}<small>${x[0]}</small></a><button class="btn fill" data-add="${x[0]}">${WL.get().includes(x[0]) ? '已添加' : '+ 自选'}</button></div>`).join('');
      $('#sr').querySelectorAll('[data-add]').forEach(b => b.onclick = () => { const w = WL.get(); if (!w.includes(b.dataset.add)) WL.set([...w, b.dataset.add]); b.textContent = '已添加'; load(); }); }, 250); };
  load(); clearInterval(timer); if (isTrading()) timer = setInterval(() => { if (location.hash === '#/watch') load(); }, 60000);
}

// ---------- 路由 ----------
let cur = '';
async function route() {
  if (cur) state.scroll[cur] = window.scrollY;
  const h = location.hash.replace(/^#/, '') || '/'; clearInterval(timer); if (chart) { chart.remove(); chart = null; }
  let m;
  try {
    if (h === '/') { cur = 'home'; await home(); }
    else if ((m = h.match(/^\/board\/(.+)$/))) { cur = 'board:' + m[1]; await boardView(m[1]); }
    else if ((m = h.match(/^\/stock\/(.+)$/))) { cur = 'stock'; window.scrollTo(0, 0); await stockView(m[1]); }
    else if (h === '/screen') { cur = 'screen'; await screenView(); }
    else if (h === '/watch') { cur = 'watch'; await watchView(); }
  } catch (e) { V.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; }
}
window.addEventListener('hashchange', route);
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
