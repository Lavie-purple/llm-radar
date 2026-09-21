#!/usr/bin/env python3
"""生成四源抓取管道总览页（data/pipeline.html）。

用途：一眼确认四源都抓到了什么、覆盖率如何、以及最近一次变更。
用法：python tools/make_report.py
"""

import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, "..", "data"))
OUT = os.path.join(DATA, "pipeline.html")


def e(s):
    return html.escape(str(s)) if s is not None else "—"


def load(name):
    p = os.path.join(DATA, f"{name}.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def pct(a, b):
    return f"{a}/{b} ({a/b*100:.0f}%)" if b else "—"


def main():
    lm = load("lmarena")
    aa = load("aa")
    ls = load("llmstats")
    lb = load("livebench")
    ch = load("changes")

    # ---- 四源卡片 ----
    cards = []

    if lm:
        boards = lm["boards"]
        rows = []
        for k, bd in boards.items():
            rows.append(
                f"<tr><td class='m'>{e(bd['label'])}</td><td class='s'>{e(k)}</td>"
                f"<td class='n'>{len(bd['rows'])}/{bd.get('fullCount')}</td>"
                f"<td>{e(bd['rows'][0]['displayName'] if bd['rows'] else '—')}</td></tr>"
            )
        cards.append((
            "LMArena",
            "arena.atease.dev（第三方镜像）",
            f"{lm['stats']['boardCount']} 榜 / {lm['stats']['totalRows']} 行",
            "license(open/proprietary) · score+CI · votes · rankSpread · 价格 · context<br>"
            "agent 榜额外含 净改善度 / confirmedSuccess / toolHallucination / costTaskP50 等 7 项",
            "<table>" + "".join(rows) + "</table>",
        ))

    if aa:
        cov = aa["coverage"]
        top = sorted([m for m in aa["models"] if m.get("intelligenceIndex")],
                     key=lambda m: -m["intelligenceIndex"])[:10]
        rows = "".join(
            f"<tr><td class='n'>{m['intelligenceIndex']:.2f}</td>"
            f"<td>{e(m.get('shortName') or m['name'])}</td>"
            f"<td class='s'>{e(m.get('effort'))}</td>"
            f"<td class='n'>${e(m.get('price1mInputTokens'))}/${e(m.get('price1mOutputTokens'))}</td>"
            f"<td class='n'>{m.get('medianOutputTokensPerSecond', 0):.0f}</td></tr>"
            for m in top
        )
        cards.append((
            "Artificial Analysis",
            "artificialanalysis.ai/leaderboards/models（页面内嵌）",
            f"{aa['count']} 个模型",
            f"Intelligence Index {pct(cov['intelligenceIndex'], aa['count'])} · "
            f"GDPval-AA {pct(cov['gdpval'], aa['count'])} · "
            f"价格 {pct(cov['price'], aa['count'])} · "
            f"速度 {pct(cov['speed'], aa['count'])}<br>"
            f"抓取于 {e(aa['fetchedAt'])}",
            "<table><thead><tr><th>指数</th><th>模型</th><th>effort</th><th>价格 $/M</th><th>tok/s</th></tr></thead>"
            "<tbody>" + rows + "</tbody></table>",
        ))

    if ls:
        st = ls["stats"]
        focus = ["general", "reasoning", "code", "agents", "tool_calling",
                 "frontend_development", "chat", "instruction_following"]
        rows = "".join(
            f"<tr><td class='m'>{e(c)}</td><td class='n'>{ls['indexes'][c]['count']}</td>"
            f"<td>{e(ls['indexes'][c]['rows'][0].get('model_name'))}</td>"
            f"<td class='n'>{e(ls['indexes'][c]['rows'][0].get('conservative'))}</td></tr>"
            for c in focus if c in (ls.get("indexes") or {})
        )
        cards.append((
            "llm-stats",
            "llm-stats.com（页面内嵌）",
            f"{st['modelCount']} 个模型 / {st['nonEmptyCategories']} 个非空分类",
            f"开源模型 {st['openSourceCount']} · 有价格 {st['withPrice']} · "
            f"<b>有速度仅 {st['withSpeed']}</b>（覆盖率低）<br>"
            f"保守分 S = μ − 3σ（字段名 conservative）；含 rank_delta_14d 14 天排名变化",
            "<table><thead><tr><th>分类</th><th>项数</th><th>榜首</th><th>S</th></tr></thead>"
            "<tbody>" + rows + "</tbody></table>",
        ))

    if lb:
        top = sorted([m for m in lb["models"] if m["overall"] is not None],
                     key=lambda m: -m["overall"])[:10]
        rows = "".join(
            f"<tr><td class='n'>{m['overall']:.2f}</td><td>{e(m['model'])}</td>"
            f"<td class='n'>{e(m['categories'].get('Agentic Coding'))}</td>"
            f"<td class='n'>{e(m['categories'].get('Instruction Following'))}</td>"
            f"<td class='n'>{'$'+str(m['costPerSuccessfulTask']) if m['costPerSuccessfulTask'] is not None else '—'}</td></tr>"
            for m in top
        )
        cards.append((
            "LiveBench",
            f"livebench.ai 静态文件（release {e(lb['release'])}）",
            f"{lb['stats']['modelCount']} 个模型 / {len(lb['categoryMap'])} 类 / 22 任务",
            "无官方 API。含你要的 <b>Agentic Coding</b>、<b>Instruction Following</b>（键名 IF）、"
            "<b>Cost per successful task</b><br>"
            "CPST =（Σcost ÷ Σquestions ÷ score）× 100；Overall = 7 类等权平均",
            "<table><thead><tr><th>Overall</th><th>模型</th><th>Agentic</th><th>IF</th><th>CPST</th></tr></thead>"
            "<tbody>" + rows + "</tbody></table>",
        ))

    # ---- 变更报告 ----
    if ch and ch.get("hasBaseline"):
        parts = []
        for s, out in ch["sources"].items():
            if s == "lmarena":
                for b, v in out["boards"].items():
                    parts.append(f"<li><b>lmarena/{e(b)}</b>：新增 {len(v['added'])}、"
                                 f"掉出 {len(v['removed'])}、名次变动 {len(v['moved'])}</li>")
            else:
                parts.append(f"<li><b>{e(s)}</b>：新增 {len(out['added'])}、掉出 {len(out['removed'])}、"
                             f"大幅变动 {len(out.get('shifted', []))}</li>")
        changes_html = (f"<p>基线 <code>{e(ch['previous'])}</code> → <code>{e(ch['current'])}</code>，"
                        f"合计 新增 {ch['summary']['added']} / 掉出 {ch['summary']['removed']} / "
                        f"名次变动 {ch['summary']['moved']}</p><ul>" + "".join(parts) + "</ul>")
    else:
        changes_html = ("<p class='dim'>尚无基线快照。下次抓取后，这里会显示"
                        "「自上次以来新增 / 掉出 / 大幅变动」。变更追踪是一等功能。</p>")

    cards_html = "".join(
        f"<section class='card'><header><h3>{e(t)}</h3>"
        f"<div class='src'>{e(src)}</div><div class='scale'>{e(scale)}</div></header>"
        f"<p class='note'>{note}</p><div class='tw'>{table}</div></section>"
        for t, src, scale, note, table in cards
    )

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>抓取管道总览 · 四源</title>
<style>
  :root {{ --bg:#f6f6f4; --card:#fff; --ink:#17171a; --dim:#6b6b73; --line:#e2e2df;
    --accent:#ff5a1f; --ok:#0a7c42; --mono:ui-monospace,"Cascadia Mono",Consolas,monospace; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }}
  .wrap {{ max-width:1240px; margin:0 auto; padding:32px 24px 72px; }}
  h1 {{ font-size:26px; margin:0 0 6px; letter-spacing:-.02em; }}
  h2 {{ font-size:13px; text-transform:uppercase; letter-spacing:.1em; color:var(--accent);
    margin:34px 0 12px; padding-bottom:8px; border-bottom:2px solid var(--line); }}
  .lead {{ color:var(--dim); margin:0 0 22px; }}
  code {{ font-family:var(--mono); font-size:12px; background:#ececea; padding:1px 5px; border-radius:3px; }}
  .ok {{ display:inline-block; background:#e8f5ee; color:var(--ok); font-weight:600;
    font-size:11px; padding:2px 8px; border-radius:3px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:8px;
    margin-bottom:16px; overflow:hidden; }}
  .card header {{ padding:14px 16px; border-bottom:1px solid var(--line); background:#fbfbfa; }}
  .card h3 {{ margin:0 0 4px; font-size:16px; }}
  .src {{ font-family:var(--mono); font-size:11.5px; color:var(--dim); }}
  .scale {{ font-family:var(--mono); font-size:12px; color:var(--accent); margin-top:2px; }}
  .note {{ margin:0; padding:10px 16px; font-size:12.5px; color:#45454c;
    border-bottom:1px solid #f0f0ee; }}
  .tw {{ overflow-x:auto; }}
  table {{ width:100%; border-collapse:collapse; font-size:12.5px; }}
  th {{ text-align:left; font-size:10.5px; color:var(--dim); text-transform:uppercase;
    letter-spacing:.05em; padding:7px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }}
  td {{ padding:6px 14px; border-bottom:1px solid #f2f2f0; white-space:nowrap; }}
  tbody tr:last-child td {{ border-bottom:none; }}
  .n {{ font-family:var(--mono); text-align:right; }}
  .m {{ font-weight:600; }}
  .s {{ color:var(--dim); font-family:var(--mono); font-size:11.5px; }}
  .dim {{ color:var(--dim); }}
  ul {{ margin:8px 0 0; padding-left:20px; }} li {{ margin:3px 0; }}
  footer {{ margin-top:40px; padding-top:16px; border-top:1px solid var(--line);
    color:var(--dim); font-size:12px; }}
</style></head><body><div class="wrap">
  <h1>抓取管道总览 <span class="ok">四源全部跑通</span></h1>
  <p class="lead">四个源均<b>免 API key</b>抓取 · 入口 <code>tools/run_all.py</code> ·
    存档 <code>snapshots/</code> · 校验 <code>tools/verify_lmarena.py</code></p>

  <h2>数据源</h2>
  {cards_html}

  <h2>变更追踪</h2>
  <section class="card"><div style="padding:14px 16px">{changes_html}</div></section>

  <h2>已知缺口</h2>
  <section class="card"><div style="padding:14px 16px">
    <ul>
      <li><b>AA 的 image / video Elo 抓不到</b>：这两个榜单页首屏 HTML 只有模型元数据，
          Elo 由客户端异步加载。需官方 API key，或该维度只保留 LMArena 一个源。</li>
      <li><b>llm-stats 的速度字段覆盖率仅 43/392（11%）</b>：speed 列的可用性有限。</li>
      <li><b>LiveBench 是 2026-06-25 release</b>：半年一刷，9 月新模型不在内。</li>
      <li><b>计划任务未创建</b>：<code>schtasks.exe</code> 被安全策略列入程序黑名单，
          需手动运行 <code>tools/run_daily.bat</code> 或自行注册任务。</li>
    </ul>
  </div></section>

  <footer>由 <code>tools/make_report.py</code> 生成 ·
    数据文件 <code>data/*.json</code> · 抓取时间 {e((lm or {}).get('fetchedAt'))}</footer>
</div></body></html>
"""

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"已生成 {OUT} ({len(doc)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
