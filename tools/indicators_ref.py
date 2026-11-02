"""技术指标 Python 参考实现（与 web/indicators.js 同一套约定，供测试交叉核对）。
用法：
  python3 tools/indicators_ref.py                     # 打印 5 只样例股最后一根的指标值
  python3 tools/indicators_ref.py sh600519 sz000001   # 指定股票
  python3 tools/indicators_ref.py --dump /tmp/ind.json sh600519 ...  # 同时导出全量 K 线与指标，供 JS 对拍
数据：腾讯 ifzq 前复权日K（640 根），EMA 从第一根开始递推。
"""
import json, math, sys, urllib.request

SAMPLES = ["sh600519", "sz000001", "sz300750", "sh688981", "sh601318"]

def fetch(code, n=640):
    u = f"https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,{n},qfq"
    d = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=20).read())["data"][code]
    k = d.get("qfqday") or d.get("day") or []
    return [dict(t=b[0], o=float(b[1]), c=float(b[2]), h=float(b[3]), l=float(b[4]), v=float(b[5])) for b in k]

def ma(x, n): return [None if i < n - 1 else sum(x[i - n + 1:i + 1]) / n for i in range(len(x))]
def ema(x, n):
    a, out, e = 2 / (n + 1), [], None
    for i, v in enumerate(x): e = v if i == 0 else a * v + (1 - a) * e; out.append(e)
    return out
def sma_tdx(x, n, start):
    out, y = [None] * len(x), None
    for i in range(start, len(x)): y = x[i] if y is None else (x[i] + (n - 1) * y) / n; out[i] = y
    return out
def macd(c):
    e1, e2 = ema(c, 12), ema(c, 26); dif = [a - b for a, b in zip(e1, e2)]; dea = ema(dif, 9)
    return dif, dea, [2 * (a - b) for a, b in zip(dif, dea)]
def kdj(h, l, c, n=9):
    K, D, J, k, d = [], [], [], 50.0, 50.0
    for i in range(len(c)):
        hh, ll = max(h[max(0, i - n + 1):i + 1]), min(l[max(0, i - n + 1):i + 1])
        rsv = 50.0 if hh == ll else (c[i] - ll) / (hh - ll) * 100
        k = (2 * k + rsv) / 3; d = (2 * d + k) / 3; K.append(k); D.append(d); J.append(3 * k - 2 * d)
    return K, D, J
def rsi(c, n):
    up = [0.0] + [max(c[i] - c[i - 1], 0) for i in range(1, len(c))]; ab = [0.0] + [abs(c[i] - c[i - 1]) for i in range(1, len(c))]
    su, sa = sma_tdx(up, n, 1), sma_tdx(ab, n, 1)
    return [None if i == 0 else (50.0 if sa[i] == 0 else su[i] / sa[i] * 100) for i in range(len(c))]
def boll(c, n=20, k=2):
    mid = ma(c, n); up, low = [], []
    for i in range(len(c)):
        if mid[i] is None: up.append(None); low.append(None); continue
        sd = math.sqrt(sum((c[j] - mid[i]) ** 2 for j in range(i - n + 1, i + 1)) / n); up.append(mid[i] + k * sd); low.append(mid[i] - k * sd)
    return up, mid, low
def pivots(h, l, w=5):
    hi, lo = [], []
    for i in range(w, len(h) - w):
        if all(h[i] > h[j] for j in range(i - w, i)) and all(h[i] >= h[j] for j in range(i + 1, i + w + 1)): hi.append(i)
        if all(l[i] < l[j] for j in range(i - w, i)) and all(l[i] <= l[j] for j in range(i + 1, i + w + 1)): lo.append(i)
    return hi, lo
def divergences(h, l, dif, w=5, gap=60):
    hi, lo = pivots(h, l, w); out = []
    for a, b in zip(hi, hi[1:]):
        if b - a <= gap and h[b] > h[a] and dif[b] < dif[a] and dif[a] > 0 and dif[b] > 0: out.append(dict(type="top", a=a, b=b, confirm=b + w))
    for a, b in zip(lo, lo[1:]):
        if b - a <= gap and l[b] < l[a] and dif[b] > dif[a] and dif[a] < 0 and dif[b] < 0: out.append(dict(type="bottom", a=a, b=b, confirm=b + w))
    return sorted(out, key=lambda x: (x["b"], x["type"]))
def limit_pct(code, name=""):
    if code.startswith("bj"): return 0.30
    if code.startswith(("sz30", "sh68")): return 0.20
    if name.startswith("S") and not name.upper().startswith("ST"): return 0.05
    return 0.10
def limits(prev, code, name=""):
    p = limit_pct(code, name); u = prev * (1 + p) * 100; d = prev * (1 - p) * 100
    if code.startswith("bj"): return math.floor(u + 1e-7) / 100, math.ceil(d - 1e-7) / 100
    return math.floor(u + 0.5 + 1e-7) / 100, math.floor(d + 0.5 + 1e-7) / 100
def yizi(h, l, c, code, name=""):
    up, dn = [], []
    for i in range(len(c)):
        if i == 0 or h[i] != l[i]: up.append(False); dn.append(False); continue
        lu, ld = limits(c[i - 1], code, name); up.append(abs(c[i] - lu) <= 0.005); dn.append(abs(c[i] - ld) <= 0.005)
    return up, dn
def extremes(r6, j, yu=None, yd=None):
    """连续满足只标首个非一字日；一字涨停不标超买、一字跌停不标超卖。返回 (标记, 被抑制)"""
    out, supp, pob, pos, mob, mos = [], [], False, False, False, False
    for i in range(len(j)):
        ob = r6[i] is not None and r6[i] >= 80 and j[i] >= 100; os_ = r6[i] is not None and r6[i] <= 20 and j[i] <= 0
        if ob and not pob: mob = False
        if os_ and not pos: mos = False
        if ob and not mob:
            if yu and yu[i]: supp.append(dict(type="overbought", i=i))
            else: out.append(dict(type="overbought", i=i)); mob = True
        if os_ and not mos:
            if yd and yd[i]: supp.append(dict(type="oversold", i=i))
            else: out.append(dict(type="oversold", i=i)); mos = True
        pob, pos = ob, os_
    return out, supp
def compute(bars, code="", name=""):
    h = [b["h"] for b in bars]; l = [b["l"] for b in bars]; c = [b["c"] for b in bars]; v = [b["v"] for b in bars]
    dif, dea, bar = macd(c); K, D, J = kdj(h, l, c); up, mid, low = boll(c); r6 = rsi(c, 6)
    yu, yd = yizi(h, l, c, code, name); ext, supp = extremes(r6, J, yu, yd)
    return dict(ma5=ma(c, 5), ma10=ma(c, 10), ma20=ma(c, 20), ma60=ma(c, 60), vma5=ma(v, 5), vma10=ma(v, 10), dif=dif, dea=dea, macd=bar,
                k=K, d=D, j=J, rsi6=r6, rsi12=rsi(c, 12), rsi24=rsi(c, 24), boll_up=up, boll_mid=mid, boll_low=low,
                div=divergences(h, l, dif), ext=ext, supp=supp)

if __name__ == "__main__":
    args = sys.argv[1:]; dump = None
    if args[:1] == ["--dump"]: dump, args = args[1], args[2:]
    codes = args or SAMPLES; res = {}
    print("代码      日期        DIF      DEA      MACD     K       D       J       RSI6    RSI12   RSI24   BOLL上   BOLL中   BOLL下")
    for code in codes:
        bars = fetch(code); r = compute(bars, code); res[code] = dict(bars=bars, ind=r); i = len(bars) - 1
        f = lambda k, p=3: f"{r[k][i]:.{p}f}"
        print(f"{code} {bars[i]['t']} {f('dif')} {f('dea')} {f('macd')} {f('k',2)} {f('d',2)} {f('j',2)} {f('rsi6',2)} {f('rsi12',2)} {f('rsi24',2)} {f('boll_up',2)} {f('boll_mid',2)} {f('boll_low',2)}"
              f"  (共{len(bars)}根, 背离{len(r['div'])}个, 超买超卖{len(r['ext'])}个, 一字抑制{len(r['supp'])}个)")
    if dump:
        json.dump(res, open(dump, "w"), ensure_ascii=False); print("已导出", dump)
