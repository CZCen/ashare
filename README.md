# A股板块分析 · 静态版（GitHub Pages）

手机（iPhone Safari → 分享 → 添加到主屏幕）使用的 A 股板块分析网页。纯静态，无后端、无登录、无任何密钥。

## 结构
- `web/`：前端（index.html / app.js / style.css / lwc.js / 图标 / manifest / sw.js），全部相对路径，可部署在 `/仓库名/` 子路径下。
- `scripts/export_static.py`：数据导出脚本（仅 Python 标准库），从腾讯、新浪行情接口抓数据，生成 `site_build/`。
- `state/`：数据状态种子（股票列表、板块成分、近 70 个交易日日线+涨跌停价+新浪主力净流入）。之后由 Actions 自动维护在 `data` 分支，main 不再变动。
- `.github/workflows/update.yml`：定时任务 + 发布到 Pages。

## 部署（只需一次）
1. 把本目录推到公开仓库（例如 `CZCen/ashare-board`）的 `main` 分支。
2. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
3. Settings → Actions → General → Workflow permissions 选 **Read and write permissions**（工作流需要把数据推到 `data` 分支）。
4. Actions → “更新行情并发布” → Run workflow（默认 mode=auto、force=true）跑一次，完成后访问 `https://czcen.github.io/<仓库名>/`。

不需要任何 Secrets / Token：工作流只用内置的 `GITHUB_TOKEN`。

## 定时
- 交易日北京时间 09:25–15:05 每 5 分钟导出快照（GitHub 定时任务是“尽力而为”，高峰期可能延迟或跳过几次）。
- 15:30 后 / 16:20 / 18:00：收盘入库（当日日线、涨跌停价、主力净流入）、重算选股特征；当天已处理则跳过。
- 非交易时段、节假日脚本自动跳过，不发布。
- 公开仓库 60 天无活动会被 GitHub 暂停定时任务（社区观察只有默认分支提交算活动），所以工作流每周在 main 更新一次 `heartbeat.txt`；`data` 分支每个交易日另有数据提交。

## 本地预览
```
python3 scripts/export_static.py --mode snapshot --force
cd site_build && python3 -m http.server 8000
```

## v1.1 技术指标
- `web/indicators.js`：纯函数指标模块（MA/EMA/MACD/KDJ/RSI/BOLL/转折点/背离/超买超卖），浏览器与 Node 通用。
- `tools/indicators_ref.py`：Python 参考实现；`python3 tools/indicators_ref.py` 打印 5 只样例股最后一根指标值。
- `tools/check_indicators.js`：`python3 tools/indicators_ref.py --dump /tmp/ind.json && node tools/check_indicators.js /tmp/ind.json` 逐根对拍（容差 1e-6）并检查追加 K 线后已确认信号不变。
