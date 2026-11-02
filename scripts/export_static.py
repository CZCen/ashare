#!/usr/bin/env python3
"""A股板块分析 · 静态站导出脚本（只用 Python 标准库）。

数据源：腾讯（行情快照、日K、涨跌停价）、新浪（股票列表、申万一级/热门概念成分、主力净流入）。
状态目录 state/：stocks.json、boards.json、history.json.gz、meta.json（由 data 分支持久化）。
输出目录 site_build/：web/ 下的前端 + data/ 下的 JSON。

用法：
  python scripts/export_static.py --mode auto    # 按北京时间自动判断：盘中=snapshot，15:30 后=eod
  python scripts/export_static.py --mode snapshot
  python scripts/export_static.py --mode eod      # 收盘后：落库当日日线、更新列表/板块、重算选股
  python scripts/export_static.py --mode bootstrap  # 无状态时全量回填（约 5–8 分钟）
退出时在 $GITHUB_OUTPUT 写 deploy=true/false 与 save_state=true/false。
"""
import argparse, datetime as dt, gzip, json, os, re, shutil, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, ROUND_HALF_UP, ROUND_FLOOR, ROUND_CEILING

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.environ.get("ASHARE_STATE", os.path.join(ROOT, "state"))
OUT = os.environ.get("ASHARE_OUT", os.path.join(ROOT, "site_build"))
WEB = os.path.join(ROOT, "web")
TZ = dt.timezone(dt.timedelta(hours=8))
SINA = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php"
HDR = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
       "Referer": "https://finance.sina.com.cn"}
HIST_KEEP = 70  # 每只股票保留的日线根数
STAT_PAT = re.compile(r"昨日|涨停|连板|融资融券|MSCI|沪股通|深股通|陆股通|富时|标普|QFII|社保|基金重仓|证金|汇金|"
                      r"破净|次新|预盈|预增|预亏|预减|高送转|送转|举牌|龙虎榜|百元股|低价|低市盈率|微盘|超大盘|"
                      r"年度强势|历史新高|小盘|中盘|大盘|高派息|增持回购|参股|退市|ST|价值成长|AH股|AB股|GDR|养老金|转融|"
                      r"风险警示|央视50|中证|沪深300|创业板综|科创50|权重|绩优|蓝筹|新股")

def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
def now(): return dt.datetime.now(TZ)

def get(url, params=None, enc="utf-8", tries=3, timeout=15):
    if params: url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    err = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HDR), timeout=timeout) as r:
                return r.read().decode(enc, "ignore")
        except Exception as e:
            err = e; time.sleep(0.5 * (i + 1))
    raise err

def get_json(url, params=None):
    t = get(url, params)
    return json.loads(t) if t.strip() else None

def _f(x):
    try: return float(x)
    except Exception: return None

def mkt_of(code):
    p, n = code[:2], code[2:]
    if p == "bj": return "bj"
    if n.startswith(("688", "689")): return "kcb"
    if n.startswith(("300", "301", "302")): return "cyb"
    return "main"

def calc_limits(prev, mkt, name=""):
    """历史日线的涨跌停价（接口不提供历史值时使用）。规则已用 2026-11-02 腾讯接口全市场涨跌停价逐只校验一致：
    主板 10%（含 ST）、未股改 S 股 5%、创业板/科创板 20%、北交所 30%（涨停向下取整、跌停向上取整）。当日一律以接口值为准。"""
    if mkt == "bj": p = Decimal("0.30")
    elif mkt in ("cyb", "kcb"): p = Decimal("0.20")
    elif name.startswith("S") and not name.upper().startswith("ST"): p = Decimal("0.05")
    else: p = Decimal("0.10")
    P = Decimal(str(prev)); q = Decimal("0.01")
    if mkt == "bj":
        return float((P * (1 + p)).quantize(q, ROUND_FLOOR)), float((P * (1 - p)).quantize(q, ROUND_CEILING))
    return float((P * (1 + p)).quantize(q, ROUND_HALF_UP)), float((P * (1 - p)).quantize(q, ROUND_HALF_UP))

# ---------------- 状态读写 ----------------
def sp(n): return os.path.join(STATE, n)
def load_json(n, default):
    p = sp(n)
    if not os.path.exists(p): return default
    if n.endswith(".gz"):
        with gzip.open(p, "rt", encoding="utf-8") as f: return json.load(f)
    with open(p, encoding="utf-8") as f: return json.load(f)
def compact_bar(b):
    r = lambda x, k=2: None if x is None else round(x, k)
    return [b[0], r(b[1]), r(b[2]), r(b[3]), r(b[4]), r(b[5]), r(b[6], 0), r(b[7]), r(b[8]), r(b[9], 0)]

def save_json(n, obj):
    if n.startswith("history"): obj = {c: [compact_bar(b) for b in bars] for c, bars in obj.items()}
    os.makedirs(STATE, exist_ok=True); p = sp(n)
    if n.endswith(".gz"):
        with gzip.open(p, "wt", encoding="utf-8", compresslevel=9) as f: json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    else:
        with open(p, "w", encoding="utf-8") as f: json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))

# ---------------- 新浪：股票列表、板块 ----------------
def sina_node(node):
    out, page = [], 1
    while True:
        d = get_json(f"{SINA}/Market_Center.getHQNodeData", dict(page=page, num=100, sort="symbol", asc=1, node=node, symbol="", _s_r_a="page")) or []
        out += d
        if len(d) < 100: break
        page += 1; time.sleep(0.1)
    return out

def update_universe(stocks):
    rows = sina_node("hs_a")
    if len(rows) < 4000: raise RuntimeError(f"股票列表异常：{len(rows)}")
    seen = set()
    for x in rows:
        c = x["symbol"]; seen.add(c)
        old = stocks.get(c)
        stocks[c] = [x["name"].replace(" ", ""), mkt_of(c), old[2] if old else None]
    for c in list(stocks):
        if c not in seen: del stocks[c]  # 退市/摘牌
    log("universe", len(stocks))

def update_boards(boards):
    d = get_json(f"{SINA}/Market_Center.getHQNodes")
    tree = {n[0]: [(k[0], k[2]) for k in n[1]] for n in d[1][0][1] if n[0] in ("申万一级", "热门概念")}
    jobs = [(nm, cd, "sw1") for nm, cd in tree.get("申万一级", [])]
    jobs += [(nm, cd, "gn") for nm, cd in tree.get("热门概念", []) if not STAT_PAT.search(nm)]
    def one(j):
        try: return j, [x["symbol"] for x in sina_node(j[1])]
        except Exception: return j, None
    with ThreadPoolExecutor(4) as ex: res = list(ex.map(one, jobs))
    new, fail = {}, 0
    for (nm, cd, ty), mem in res:
        if mem is None:
            fail += 1
            if cd in boards: new[cd] = boards[cd]  # 抓取失败沿用旧成分
            continue
        if ty == "gn" and len(mem) < 10: continue
        new[cd] = [nm, ty, mem]
    if sum(1 for b in new.values() if b[1] == "sw1") < 31 or len(new) < 300:
        log("板块成分异常，保留旧数据", len(new), "失败", fail); return boards
    log("boards", len(new), "失败", fail); return new

# ---------------- 腾讯：快照 ----------------
def parse_qt(text):
    out = {}
    for line in text.split(";"):
        line = line.strip()
        if not line.startswith("v_") or '="' not in line: continue
        key, body = line[2:].split('="', 1)
        f = body.rstrip('"').split("~")
        if len(f) < 50: continue
        out[key] = dict(name=f[1].replace(" ", ""), price=_f(f[3]), prev=_f(f[4]), open=_f(f[5]), vol=_f(f[6]), time=f[30],
                        chg=_f(f[31]), pct=_f(f[32]), high=_f(f[33]), low=_f(f[34]), amount=(_f(f[37]) or 0) * 1e4,
                        turnover=_f(f[38]), pe=_f(f[39]), fmv=_f(f[44]), mv=_f(f[45]), limit_up=_f(f[47]), limit_down=_f(f[48]))
    return out

def qt_batch(codes):
    try: return parse_qt(get("https://qt.gtimg.cn/q=" + ",".join(codes), enc="gbk"))
    except Exception: return {}

def snapshot(codes):
    q = {}
    with ThreadPoolExecutor(6) as ex:
        for d in ex.map(qt_batch, [codes[i:i + 80] for i in range(0, len(codes), 80)]): q.update(d)
    idx = qt_batch(["sh000001", "sz399001", "sz399006"])
    t = idx.get("sh000001", {}).get("time", "")
    td = f"{t[:4]}-{t[4:6]}-{t[6:8]}" if len(t) >= 8 else None
    log("snapshot", len(q), "trade_date", td)
    return q, idx, td

def moneyflow():
    m, page = {}, 1
    try:
        while page < 20:
            d = get_json(f"{SINA}/MoneyFlow.ssl_bkzj_ssggzj", dict(page=page, num=1000, sort="symbol", asc=1, bankuai="", shichang="")) or []
            for x in d: m[x["symbol"]] = _f(x.get("r0_net"))
            if len(d) < 1000: break
            page += 1; time.sleep(0.2)
    except Exception as e:
        log("主力净流入抓取失败", e)
    log("moneyflow", len(m)); return m if len(m) > 1000 else {}

# ---------------- 日线 ----------------
def tx_kline(code, n):
    for h in ("https://ifzq.gtimg.cn", "https://web.ifzq.gtimg.cn"):
        try:
            d = get_json(f"{h}/appstock/app/fqkline/get", dict(param=f"{code},day,,,{n},"))["data"][code]
            return d.get("day") or []
        except Exception: pass
    return None

def sina_kline(code, n):
    d = get_json("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData", dict(symbol=code, scale=240, ma="no", datalen=n)) or []
    return [[x["day"], x["open"], x["close"], x["high"], x["low"], str(float(x["volume"]) / 100)] for x in d]

def backfill(stocks, hist, n, codes=None):
    """日线 bar: [date, open, close, high, low, prev_close, vol(手), limit_up, limit_down, mf]"""
    codes = codes or list(stocks)
    def one(c):
        try: return c, (sina_kline(c, n) if stocks[c][1] == "bj" else tx_kline(c, n))
        except Exception: return c, None
    done = 0
    with ThreadPoolExecutor(10) as ex:
        for c, bars in ex.map(one, codes):
            done += 1
            if done % 1000 == 0: log("backfill", done, len(codes))
            if not bars: continue
            name, mkt, ld = stocks[c]
            have = {b[0]: b for b in hist.get(c, [])}
            prev = None
            for b in bars:
                d, o, cl, h, l, v = b[0], _f(b[1]), _f(b[2]), _f(b[3]), _f(b[4]), _f(b[5])
                if d not in have:
                    lu, ldn = calc_limits(prev, mkt, name) if prev else (None, None)
                    have[d] = [d, o, cl, h, l, prev, v, lu, ldn, None]
                prev = cl
            hist[c] = sorted(have.values())[-HIST_KEEP:]
            if len(bars) < n and not ld: stocks[c][2] = bars[0][0]  # 上市不足 n 日：首根 K 线视为上市日

def write_today(hist, q, td, mf):
    n = 0
    for c, x in q.items():
        if not x.get("vol") or not x.get("price"): continue
        bars = [b for b in hist.get(c, []) if b[0] != td]
        bars.append([td, x["open"], x["price"], x["high"], x["low"], x["prev"], x["vol"], x["limit_up"], x["limit_down"], mf.get(c)])
        hist[c] = bars[-HIST_KEEP:]; n += 1
    log("today rows", n)

# ---------------- 选股特征 ----------------
def features(stocks, hist):
    dates = sorted({b[0] for bars in hist.values() for b in bars[-60:]})[-60:]
    if not dates: return None
    last = dates[-1]; di = {d: i for i, d in enumerate(dates)}
    rows = []
    for c, bars in hist.items():
        s = stocks.get(c)
        if not s or not bars: continue
        name, mkt, ld = s
        nolim = 5 if mkt in ("cyb", "kcb") else 1
        # 上市日在保留的日线里时，按 K 线计数（停牌日不计）判断无涨跌幅限制日与次新股
        ipo_i = next((i for i, b in enumerate(bars) if b[0] == ld), None) if ld else None
        zt, zb = [], []
        for i, b in enumerate(bars):
            d, o, cl, h, l, pc, v, lu, ldn, mf = b
            if d not in di or not lu: continue
            if ipo_i is not None and i - ipo_i < nolim: continue  # 新股无涨跌幅限制日、主板新股首日不算涨停
            if cl >= lu - 1e-6: zt.append(di[d])
            elif h >= lu - 1e-6: zb.append(di[d])
        lb = 0
        ztset = set(zt)
        for b in reversed(bars):
            if b[0] in di and di[b[0]] in ztset: lb += 1
            else: break
        closes = [b[2] for b in bars]; vols = [b[6] or 0 for b in bars]; highs = [b[3] for b in bars]
        ma = lambda n: round(sum(closes[-n:]) / n, 3) if len(closes) >= n else None
        vr = round(vols[-1] / (sum(vols[-6:-1]) / 5), 2) if len(vols) >= 6 and sum(vols[-6:-1]) > 0 else None
        hi20 = 1 if len(highs) >= 21 and closes[-1] > max(highs[-21:-1]) else 0
        mfs = []
        for b in bars[-10:]: mfs.append(None if b[9] is None else round(b[9] / 1e4))  # 万元
        susp = 1 if bars[-1][0] != last else 0
        pct = round((closes[-1] / bars[-1][5] - 1) * 100, 2) if bars[-1][5] else None
        new = 1 if (ipo_i is not None and len(bars) - ipo_i < 20) else 0
        rows.append([c, name, mkt, 1 if "ST" in name.upper() else 0, new, susp, closes[-1], pct,
                     ma(5), ma(10), ma(20), lb, zt, zb, vr, hi20, mfs])
    return dict(date=last, dates=dates, cols=["code", "name", "mkt", "st", "new", "susp", "close", "pct", "ma5", "ma10", "ma20",
                                               "lb", "zt", "zb", "vr", "hi20", "mf"], rows=rows)

# ---------------- 导出 ----------------
def wjson(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))

def board_stats(boards, q):
    out = {"sw1": [], "gn": []}
    for bid, (nm, ty, mem) in boards.items():
        wsum = psum = amt = 0; up = down = zt = 0; eq = []; lead = None
        for c in mem:
            x = q.get(c)
            if not x or x["pct"] is None or not x["vol"]: continue
            w = x["fmv"] or 0; wsum += w; psum += w * x["pct"]; amt += x["amount"] or 0; eq.append(x["pct"])
            if x["pct"] > 0: up += 1
            elif x["pct"] < 0: down += 1
            if x["limit_up"] and x["price"] >= x["limit_up"] - 1e-6: zt += 1
            if lead is None or x["pct"] > lead[2]: lead = (c, x["name"], x["pct"])
        if not eq: continue
        pct = round(psum / wsum, 2) if wsum else round(sum(eq) / len(eq), 2)
        out[ty].append([bid, nm, pct, round(amt / 1e8, 2), len(mem), up, down, zt, lead[1] if lead else "", lead[2] if lead else None])
    for k in out: out[k].sort(key=lambda r: -r[2])
    return out

def export(stocks, boards, q, idx, td, mf, feat, meta):
    ts = now().strftime("%Y-%m-%d %H:%M:%S")
    if os.path.exists(OUT): shutil.rmtree(OUT)
    shutil.copytree(WEB, OUT)
    D = os.path.join(OUT, "data")
    feat_new = {r[0]: r[4] for r in (feat or {}).get("rows", [])}
    up = down = flat = zt = dtn = 0
    for x in q.values():
        if not x.get("vol") or x["pct"] is None: continue
        if x["pct"] > 0: up += 1
        elif x["pct"] < 0: down += 1
        else: flat += 1
        if x["limit_up"] and x["price"] >= x["limit_up"] - 1e-6: zt += 1
        if x["limit_down"] and x["price"] <= x["limit_down"] + 1e-6: dtn += 1
    ov = dict(ts=ts, trade_date=td, idx=[[k, v["name"], v["price"], v["pct"]] for k, v in idx.items()],
              breadth=[up, flat, down, zt, dtn], boards=board_stats(boards, q),
              cols=["id", "name", "pct", "amount_yi", "n", "up", "down", "zt", "lead", "lead_pct"],
              mf_date=meta.get("mf_date"), feat_date=(feat or {}).get("date"))
    wjson(os.path.join(D, "overview.json"), ov)
    # 每个板块一个文件：成分股快照（行情、主力净流入、新股标记）
    bl = []
    for bid, (nm, ty, mem) in boards.items():
        rows = []
        for c in mem:
            x = q.get(c) or {}
            rows.append([c, x.get("name") or (stocks.get(c) or [c])[0], x.get("price"), x.get("pct") if x.get("vol") else None,
                         round((x.get("amount") or 0) / 1e4) if x.get("amount") else None, x.get("turnover"),
                         None if mf.get(c) is None else round(mf[c] / 1e4), x.get("fmv"), x.get("limit_up"), x.get("limit_down"),
                         x.get("high"), 1 if x.get("vol") else 0, feat_new.get(c, 0)])
        wjson(os.path.join(D, "b", bid + ".json"), dict(id=bid, name=nm, type=ty, ts=ts,
              cols=["code", "name", "price", "pct", "amount_wan", "turnover", "mf_wan", "fmv_yi", "limit_up", "limit_down", "high", "trading", "new"], rows=rows))
        bl.append([bid, nm, ty, len(mem)])
    # 股票索引：名称、市场、所属板块序号、主力净流入（万元）
    bidx = {b[0]: i for i, b in enumerate(bl)}
    mem_of = {}
    for bid, (nm, ty, mem) in boards.items():
        for c in mem: mem_of.setdefault(c, []).append(bidx[bid])
    st = [[c, s[0], s[1], mem_of.get(c, []), None if mf.get(c) is None else round(mf[c] / 1e4), feat_new.get(c, 0)] for c, s in stocks.items()]
    wjson(os.path.join(D, "stocks.json"), dict(ts=ts, boards=bl, cols=["code", "name", "mkt", "boards", "mf_wan", "new"], rows=st))
    if feat: wjson(os.path.join(D, "features.json"), feat)
    wjson(os.path.join(D, "meta.json"), dict(ts=ts, trade_date=td, feat_date=(feat or {}).get("date"), mf_date=meta.get("mf_date"),
                                             boards_updated=meta.get("boards_updated"), mode=meta.get("mode")))
    with open(os.path.join(OUT, ".nojekyll"), "w") as f: f.write("")
    log("exported", OUT)

def gh_out(**kw):
    p = os.environ.get("GITHUB_OUTPUT")
    if p:
        with open(p, "a") as f:
            for k, v in kw.items(): f.write(f"{k}={'true' if v else 'false'}\n")
    log("outputs", kw)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--mode", default="auto"); ap.add_argument("--force", action="store_true")
    a = ap.parse_args(); t0 = time.time()
    stocks = load_json("stocks.json", {}); boards = load_json("boards.json", {}); hist = load_json("history.json.gz", {})
    meta = load_json("meta.json", {})
    mode = a.mode
    t = now(); hm = t.hour * 100 + t.minute; today = t.strftime("%Y-%m-%d")
    if not stocks or not hist: mode = "bootstrap"
    elif mode == "auto": mode = "eod" if hm >= 1530 else "snapshot"
    meta["mode"] = mode; log("mode", mode)
    save_state = False
    if mode == "snapshot" and not a.force and (t.weekday() >= 5 or hm < 920 or 1135 < hm < 1255 or hm > 1510):
        log("非交易时段，跳过"); gh_out(deploy=False, save_state=False); return
    if mode == "eod" and not a.force and meta.get("eod_date") == today:
        log("今日收盘数据已处理，跳过"); gh_out(deploy=False, save_state=False); return
    if mode == "bootstrap":
        update_universe(stocks); boards = update_boards(boards)
        backfill(stocks, hist, HIST_KEEP); meta["boards_updated"] = today; save_state = True
    codes = list(stocks)
    q, idx, td = snapshot(codes)
    if not q or not td: log("快照失败"); gh_out(deploy=False, save_state=save_state); sys.exit(0 if save_state else 1)
    if mode == "snapshot" and td != today and not a.force:
        log("今天不是交易日（最新交易日 %s），跳过" % td); gh_out(deploy=False, save_state=False); return
    mf = moneyflow()
    if mf: meta["mf_date"] = td
    if mode in ("eod", "bootstrap"):
        if mode == "eod" and meta.get("eod_date") == td and not a.force:
            log("最新交易日 %s 已落库（今天非交易日）" % td); gh_out(deploy=False, save_state=False); return
        else:
            if mode == "eod":
                try: update_universe(stocks)
                except Exception as e: log("列表更新失败，沿用旧列表", e)
                if meta.get("boards_updated") != today:
                    boards = update_boards(boards); meta["boards_updated"] = today
                # 缺口检查：最近交易日缺失则补 15 根
                idxk = tx_kline("sh000001", 15) or []
                need = [b[0] for b in idxk[:-1]]
                cover = {}
                for bars in hist.values():
                    for b in bars[-20:]: cover[b[0]] = cover.get(b[0], 0) + 1
                missing = [c for c in stocks if c not in hist]
                if any(cover.get(d, 0) < 1000 for d in need): log("发现缺失交易日，补齐"); backfill(stocks, hist, 15)
                elif missing: backfill(stocks, hist, HIST_KEEP, missing)
            write_today(hist, q, td, mf)
            for c in list(hist):
                if c not in stocks: del hist[c]
            meta["eod_date"] = td
        save_state = True
    feat = features(stocks, hist)
    export(stocks, boards, q, idx, td, mf, feat, meta)
    if save_state:
        meta["saved"] = now().isoformat()
        save_json("stocks.json", stocks); save_json("boards.json", boards); save_json("history.json.gz", hist); save_json("meta.json", meta)
    log("done in %.0fs" % (time.time() - t0))
    gh_out(deploy=True, save_state=save_state)

if __name__ == "__main__":
    main()
