// 对拍：node tools/check_indicators.js /tmp/ind.json —— 用 Python 导出的同一份 K 线跑 JS 指标，逐根比较（容差 1e-6），并检查信号不回改
const IND = require('../web/indicators.js'); const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/ind.json', 'utf8')); let bad = 0, cmp = 0;
const sig = r => JSON.stringify([r.div.map(x => [x.type, x.a, x.b]), r.ext.map(x => [x.type, x.i])]);
for (const [code, { bars, ind }] of Object.entries(data)) {
  const js = IND.all(bars); let maxd = 0;
  for (const k of Object.keys(ind)) { if (k === 'div' || k === 'ext') continue;
    ind[k].forEach((v, i) => { const w = js[k][i]; cmp++;
      if ((v === null) !== (w === null)) { bad++; if (bad < 10) console.log('null 不一致', code, k, i, v, w); return; }
      if (v !== null) { const d = Math.abs(v - w); maxd = Math.max(maxd, d); if (d > 1e-6) { bad++; if (bad < 10) console.log('差异', code, k, i, v, w); } } }); }
  const same = sig(js) === sig(ind); if (!same) { bad++; console.log('信号不一致', code, sig(js), sig(ind)); }
  // 不回改：用前 n-k 根计算的已确认信号，必须原样出现在全量结果里
  let stable = true;
  for (let cut = 1; cut <= 60; cut++) { const sub = IND.all(bars.slice(0, bars.length - cut)); const n = bars.length - cut;
    const full = new Set(js.div.map(x => [x.type, x.a, x.b].join())); const fe = new Set(js.ext.map(x => [x.type, x.i].join()));
    for (const x of sub.div) if (!full.has([x.type, x.a, x.b].join())) stable = false;
    for (const x of sub.ext) if (!fe.has([x.type, x.i].join())) stable = false;
    // 反向：全量里在第 n-1 根前已确认的信号，截断版也必须有
    for (const x of js.div) if (x.confirm <= n - 1 && !sub.div.some(y => y.type === x.type && y.a === x.a && y.b === x.b)) stable = false; }
  console.log(code, bars.length + '根', '最大差', maxd.toExponential(2), '信号一致', same, '背离', js.div.length, '超买超卖', js.ext.length, '追加K线不回改', stable);
  if (!stable) bad++;
}
console.log(bad ? `失败 ${bad}` : `全部通过（${cmp} 个数值）`); process.exit(bad ? 1 : 0);
