/* A股技术指标（纯函数，无依赖）。浏览器里挂到 window.IND，Node 里 module.exports。
 * 输入 bars: [{t:'YYYY-MM-DD', o, h, l, c, v}]，按时间升序，前复权。
 * 约定（与 tools/indicators_ref.py 完全一致）：
 *  - MA(N)：前 N-1 根为 null。
 *  - EMA(N)：α=2/(N+1)，以第 1 根收盘价为初值，从第 1 根开始递推。
 *  - MACD(12,26,9)：DIF=EMA12-EMA26，DEA=EMA9(DIF)（初值=第 1 根 DIF），MACD 柱=2*(DIF-DEA)。
 *  - KDJ(9,3,3)：RSV=(C-LLV(L,9))/(HHV(H,9)-LLV(L,9))*100，不足 9 根时用已有的根；HHV==LLV 时 RSV=50；
 *                K=2/3*K'+1/3*RSV，D=2/3*D'+1/3*K，K、D 初值 50；J=3K-2D。
 *  - RSI(6,12,24)：通达信/同花顺 SMA(X,N,1) 平滑：Y=(X+(N-1)*Y')/N；X 从第 2 根开始（需要前收），
 *                以第 2 根的 X 为初值；RSI=SMA(MAX(C-C',0))/SMA(|C-C'|)*100，分母为 0 时 RSI=50；第 1 根为 null。
 *  - BOLL(20,2)：MID=MA20，STD 为总体标准差（除以 N），UP/LOW=MID±2*STD。
 *  - 超买：RSI6>=80 且 J>=100；超卖：RSI6<=20 且 J<=0；连续满足只标第一天。
 *    一字涨停日（最高==最低 且 收盘==由前收按板块规则算出的涨停价，容差 0.005）不标超买；一字跌停日不标超卖；
 *    若连续区间首日被抑制，则区间内下一个非一字的满足日成为标记日。被抑制的日子记在 supp 里。
 *    涨跌停价：主板 10%（名称以 S 开头且非 ST 的未股改股 5%）、创业板/科创板 20%（四舍五入到分）、北交所 30%（涨停向下取整、跌停向上取整）。
 *    注意用的是前复权价，除权前的老 K 线可能因复权取整与真实涨停价有微小偏差。
 *  - 转折点（5,5）：高点 = 最高价严格高于左侧 5 根、且不低于右侧 5 根（平顶取最左一根）；低点对称。
 *    第 i 根需要 i+5 根存在才确认，即信号滞后 5 根，一旦确认不再变化。
 *  - 背离（基于 DIF）：相邻两个高点（间隔≤60 根）：后高价>前高价 且 后 DIF<前 DIF 且两者 DIF>0 → 顶背离；
 *    相邻两个低点：后低价<前低价 且 后 DIF>前 DIF 且两者 DIF<0 → 底背离。
 */
(function (root) {
  'use strict';
  function ma(x, n) { const out = new Array(x.length).fill(null); let s = 0;
    for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) out[i] = s / n; } return out; }
  // 均值用逐窗求和（避免累加误差与 Python 不一致）
  function maExact(x, n) { const out = new Array(x.length).fill(null);
    for (let i = n - 1; i < x.length; i++) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += x[j]; out[i] = s / n; } return out; }
  function ema(x, n) { const a = 2 / (n + 1), out = new Array(x.length); let e = x[0];
    for (let i = 0; i < x.length; i++) { e = i === 0 ? x[0] : a * x[i] + (1 - a) * e; out[i] = e; } return out; }
  function smaTdx(x, n, start) { // x[start..] 有效
    const out = new Array(x.length).fill(null); let y = null;
    for (let i = start; i < x.length; i++) { y = y === null ? x[i] : (x[i] + (n - 1) * y) / n; out[i] = y; } return out; }
  function macd(c, f = 12, s = 26, m = 9) {
    const e1 = ema(c, f), e2 = ema(c, s), dif = c.map((_, i) => e1[i] - e2[i]), dea = ema(dif, m);
    return { dif, dea, bar: dif.map((d, i) => 2 * (d - dea[i])) };
  }
  function kdj(h, l, c, n = 9, m1 = 3, m2 = 3) {
    const K = [], D = [], J = []; let k = 50, d = 50;
    for (let i = 0; i < c.length; i++) {
      let hh = -Infinity, ll = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; }
      const rsv = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
      k = ((m1 - 1) * k + rsv) / m1; d = ((m2 - 1) * d + k) / m2; K.push(k); D.push(d); J.push(3 * k - 2 * d);
    }
    return { k: K, d: D, j: J };
  }
  function rsi(c, n) {
    const up = c.map((v, i) => i ? Math.max(v - c[i - 1], 0) : 0), ab = c.map((v, i) => i ? Math.abs(v - c[i - 1]) : 0);
    const su = smaTdx(up, n, 1), sa = smaTdx(ab, n, 1);
    return c.map((_, i) => i === 0 ? null : (sa[i] === 0 ? 50 : su[i] / sa[i] * 100));
  }
  function boll(c, n = 20, k = 2) {
    const mid = maExact(c, n), up = [], low = [];
    for (let i = 0; i < c.length; i++) {
      if (mid[i] === null) { up.push(null); low.push(null); continue; }
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2; const sd = Math.sqrt(s / n);
      up.push(mid[i] + k * sd); low.push(mid[i] - k * sd);
    }
    return { mid, up, low };
  }
  function pivots(h, l, w = 5) {
    const hi = [], lo = [];
    for (let i = w; i + w < h.length; i++) {
      let ph = true, pl = true;
      for (let j = i - w; j < i; j++) { if (!(h[i] > h[j])) ph = false; if (!(l[i] < l[j])) pl = false; }
      for (let j = i + 1; j <= i + w; j++) { if (!(h[i] >= h[j])) ph = false; if (!(l[i] <= l[j])) pl = false; }
      if (ph) hi.push(i); if (pl) lo.push(i);
    }
    return { hi, lo };
  }
  function divergences(h, l, dif, w = 5, maxGap = 60) {
    const p = pivots(h, l, w), out = [];
    for (let k = 1; k < p.hi.length; k++) { const a = p.hi[k - 1], b = p.hi[k];
      if (b - a <= maxGap && h[b] > h[a] && dif[b] < dif[a] && dif[a] > 0 && dif[b] > 0) out.push({ type: 'top', a, b, confirm: b + w }); }
    for (let k = 1; k < p.lo.length; k++) { const a = p.lo[k - 1], b = p.lo[k];
      if (b - a <= maxGap && l[b] < l[a] && dif[b] > dif[a] && dif[a] < 0 && dif[b] < 0) out.push({ type: 'bottom', a, b, confirm: b + w }); }
    return out.sort((x, y) => x.b - y.b || (x.type < y.type ? -1 : 1));
  }
  function limitPct(code, name) {
    code = code || ''; name = name || '';
    if (code.startsWith('bj')) return 0.30;
    if (/^sz30|^sh68/.test(code)) return 0.20;
    if (name.startsWith('S') && !name.toUpperCase().startsWith('ST')) return 0.05;
    return 0.10;
  }
  function limits(prev, code, name) {
    const p = limitPct(code, name), u = prev * (1 + p) * 100, d = prev * (1 - p) * 100;
    if ((code || '').startsWith('bj')) return [Math.floor(u + 1e-7) / 100, Math.ceil(d - 1e-7) / 100];
    return [Math.floor(u + 0.5 + 1e-7) / 100, Math.floor(d + 0.5 + 1e-7) / 100];
  }
  function yizi(h, l, c, code, name) { // 返回 [一字涨停[], 一字跌停[]]
    const up = [], dn = [];
    for (let i = 0; i < c.length; i++) {
      if (i === 0 || h[i] !== l[i]) { up.push(false); dn.push(false); continue; }
      const [lu, ld] = limits(c[i - 1], code, name);
      up.push(Math.abs(c[i] - lu) <= 0.005); dn.push(Math.abs(c[i] - ld) <= 0.005);
    }
    return [up, dn];
  }
  function extremes(r6, j, yzUp, yzDn) {
    const out = [], supp = []; let pob = false, pos = false, mob = false, mos = false;
    for (let i = 0; i < j.length; i++) {
      const ob = r6[i] !== null && r6[i] >= 80 && j[i] >= 100, os = r6[i] !== null && r6[i] <= 20 && j[i] <= 0;
      if (ob && !pob) mob = false; if (os && !pos) mos = false;
      if (ob && !mob) { if (yzUp && yzUp[i]) supp.push({ type: 'overbought', i }); else { out.push({ type: 'overbought', i }); mob = true; } }
      if (os && !mos) { if (yzDn && yzDn[i]) supp.push({ type: 'oversold', i }); else { out.push({ type: 'oversold', i }); mos = true; } }
      pob = ob; pos = os;
    }
    out.supp = supp; return out;
  }
  function all(bars, opt) {
    opt = opt || {};
    const h = bars.map(b => b.h), l = bars.map(b => b.l), c = bars.map(b => b.c), v = bars.map(b => b.v);
    const M = macd(c), K = kdj(h, l, c), B = boll(c), r6 = rsi(c, 6); const [yu, yd] = yizi(h, l, c, opt.code, opt.name); const E = extremes(r6, K.j, yu, yd);
    return { ma5: maExact(c, 5), ma10: maExact(c, 10), ma20: maExact(c, 20), ma60: maExact(c, 60), vma5: maExact(v, 5), vma10: maExact(v, 10),
      dif: M.dif, dea: M.dea, macd: M.bar, k: K.k, d: K.d, j: K.j, rsi6: r6, rsi12: rsi(c, 12), rsi24: rsi(c, 24),
      boll_up: B.up, boll_mid: B.mid, boll_low: B.low, div: divergences(h, l, M.dif), ext: E, supp: E.supp };
  }
  const IND = { limits, yizi, ma: maExact, ema, smaTdx, macd, kdj, rsi, boll, pivots, divergences, extremes, all };
  if (typeof module !== 'undefined' && module.exports) module.exports = IND; else root.IND = IND;
})(typeof window !== 'undefined' ? window : this);
