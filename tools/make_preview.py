#!/usr/bin/env python3
"""把 data/lmarena.json 渲染成一份可直接打开核对的 HTML 预览页。

用法：python tools/make_preview.py
输出：data/preview.html
"""

import html
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data", "lmarena.json")
OUT = os.path.join(HERE, "..", "data", "preview.html")

GROUP_LABEL = {
    "chat": "Chat 对话",
    "code": "Code / Vibe coding",
    "image": "图像生成",
    "video": "视频生成",
    "agent": "Agent",
}
GROUP_ORDER = ["chat", "code", "image", "video", "agent"]


def e(s):
    return html.escape(str(s)) if s is not None else ""


def main():
    with open(DATA, encoding="utf-8") as f:
        d = json.load(f)

    boards = d["boards"]
    stats = d.get("stats", {})

    # 按大类分组
    grouped = {g: [] for g in GROUP_ORDER}
    for key, bd in boards.items():
        grouped.setdefault(bd.get("group", "other"), []).append((key, bd))

    nav = []
    sections = []

    for g in GROUP_ORDER:
        items = grouped.get(g) or []
        if not items:
            continue
        nav.append(
            f'<a class="nav-g" href="#g-{g}">{e(GROUP_LABEL.get(g, g))}'
            f'<span class="nav-n">{len(items)}</span></a>'
        )
        cards = []
        for key, bd in items:
            rows = bd.get("rows", [])
            is_agent = key == "agent"
            unit = bd.get("unit")

            head = ["#", "模型", "厂牌", "许可"]
            if is_agent:
                head += ["净改善 %", "每任务成本", "确认成功率", "工具幻觉", "票数"]
            else:
                head += ["分数", "±CI", "票数", "价格 $/M (入/出)", "上下文"]

            trs = []
            for r in rows:
                lic = r.get("license")
                lic_cls = "lic-open" if lic == "open" else "lic-prop"
                lic_txt = "开源" if lic == "open" else "闭源"

                if is_agent:
                    ex = r.get("extra", {})
                    cost = ex.get("costTaskP50")
                    trs.append(
                        "<tr>"
                        f'<td class="c-rank">{r["rank"]}</td>'
                        f'<td class="c-model">{e(r["displayName"])}</td>'
                        f'<td class="c-vendor">{e(r.get("vendor"))}</td>'
                        f'<td><span class="lic {lic_cls}">{lic_txt}</span></td>'
                        f'<td class="c-num c-main">{e(r["score"])}</td>'
                        f'<td class="c-num">{f"${cost}" if cost is not None else "—"}</td>'
                        f'<td class="c-num">{e(ex.get("confirmedSuccess", "—"))}</td>'
                        f'<td class="c-num">{e(ex.get("toolHallucination", "—"))}</td>'
                        f'<td class="c-num c-dim">{e(r.get("votes"))}</td>'
                        "</tr>"
                    )
                else:
                    pi, po = r.get("priceIn"), r.get("priceOut")
                    if pi is None:
                        price_txt = "—"
                    elif po is None:
                        price_txt = f"${pi}"
                    else:
                        price_txt = f"${pi} / ${po}"
                    trs.append(
                        "<tr>"
                        f'<td class="c-rank">{r["rank"]}</td>'
                        f'<td class="c-model">{e(r["displayName"])}</td>'
                        f'<td class="c-vendor">{e(r.get("vendor"))}</td>'
                        f'<td><span class="lic {lic_cls}">{lic_txt}</span></td>'
                        f'<td class="c-num c-main">{e(r["score"])}</td>'
                        f'<td class="c-num c-dim">{("±" + str(r["scoreCi"])) if r.get("scoreCi") is not None else "—"}</td>'
                        f'<td class="c-num c-dim">{e(r.get("votes"))}</td>'
                        f'<td class="c-num">{price_txt}</td>'
                        f'<td class="c-num c-dim">{e(r.get("context", "—"))}</td>'
                        "</tr>"
                    )

            cards.append(
                f'<section class="card" id="b-{key}">'
                f'<header class="card-h">'
                f'<h3>{e(bd.get("label"))}<span class="slug">/{key}/</span></h3>'
                f'<div class="card-meta">'
                f'<span>{len(rows)} / {bd.get("fullCount", "?")} 条</span>'
                f'<span>源更新 {e(bd.get("sourceUpdated"))}</span>'
                f'<span class="unit">{e(unit)}</span>'
                f'</div></header>'
                f'<div class="tw"><table><thead><tr>'
                + "".join(f"<th>{h}</th>" for h in head)
                + "</tr></thead><tbody>"
                + "".join(trs)
                + "</tbody></table></div>"
                "</section>"
            )

        sections.append(
            f'<div class="group" id="g-{g}"><h2>{e(GROUP_LABEL.get(g, g))}</h2>'
            + "".join(cards)
            + "</div>"
        )

    lic_note = stats.get("totalRows", 0)
    src = d.get("source", {})

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LMArena 数据核对 · {len(boards)} 榜 {lic_note} 行</title>
<style>
  :root {{
    --bg:#f6f6f4; --card:#fff; --ink:#17171a; --dim:#6b6b73; --line:#e2e2df;
    --accent:#ff5a1f; --open:#0a7c42; --open-bg:#e8f5ee;
    --mono: ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }}
  .wrap {{ max-width:1400px; margin:0 auto; padding:32px 24px 80px; }}
  h1 {{ font-size:26px; margin:0 0 6px; letter-spacing:-.02em; }}
  .lead {{ color:var(--dim); margin:0 0 20px; }}
  .lead code {{ font-family:var(--mono); font-size:12px; background:#ececea;
    padding:1px 5px; border-radius:3px; }}
  .stats {{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px; }}
  .stat {{ background:var(--card); border:1px solid var(--line); border-radius:6px;
    padding:8px 14px; }}
  .stat b {{ font-family:var(--mono); font-size:16px; }}
  .stat span {{ display:block; color:var(--dim); font-size:11px;
    text-transform:uppercase; letter-spacing:.06em; }}
  .warn {{ margin:16px 0 24px; padding:10px 14px; background:#fff4ec;
    border-left:3px solid var(--accent); border-radius:0 5px 5px 0;
    font-size:12.5px; color:#7a3a12; }}
  nav {{ position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:6px;
    padding:12px 0; background:linear-gradient(var(--bg) 75%, transparent);
    margin-bottom:12px; }}
  .nav-g {{ display:inline-flex; align-items:center; gap:6px; background:var(--card);
    border:1px solid var(--line); border-radius:999px; padding:5px 12px;
    text-decoration:none; color:var(--ink); font-size:12.5px; }}
  .nav-g:hover {{ border-color:var(--accent); color:var(--accent); }}
  .nav-n {{ font-family:var(--mono); color:var(--dim); font-size:11px; }}
  .group {{ margin:32px 0 0; }}
  .group h2 {{ font-size:13px; text-transform:uppercase; letter-spacing:.1em;
    color:var(--accent); margin:0 0 12px; padding-bottom:8px;
    border-bottom:2px solid var(--line); }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:8px;
    margin-bottom:16px; overflow:hidden; }}
  .card-h {{ display:flex; justify-content:space-between; align-items:baseline;
    gap:12px; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid var(--line);
    background:#fbfbfa; }}
  .card-h h3 {{ margin:0; font-size:15px; }}
  .slug {{ font-family:var(--mono); font-size:11px; color:var(--dim);
    margin-left:8px; font-weight:400; }}
  .card-meta {{ display:flex; gap:14px; font-size:11.5px; color:var(--dim);
    font-family:var(--mono); }}
  .unit {{ color:var(--accent); }}
  .tw {{ overflow-x:auto; }}
  table {{ width:100%; border-collapse:collapse; font-size:12.5px; }}
  th {{ text-align:left; font-weight:600; font-size:11px; color:var(--dim);
    text-transform:uppercase; letter-spacing:.05em; padding:8px 12px;
    border-bottom:1px solid var(--line); white-space:nowrap; }}
  td {{ padding:6px 12px; border-bottom:1px solid #f0f0ee; white-space:nowrap; }}
  tbody tr:last-child td {{ border-bottom:none; }}
  tbody tr:hover {{ background:#fafafa; }}
  .c-rank {{ font-family:var(--mono); color:var(--dim); width:38px; }}
  .c-model {{ font-weight:500; }}
  .c-vendor {{ color:var(--dim); font-size:12px; }}
  .c-num {{ font-family:var(--mono); text-align:right; }}
  .c-main {{ font-weight:600; font-size:13px; }}
  .c-dim {{ color:var(--dim); }}
  .lic {{ font-size:10.5px; padding:1px 7px; border-radius:3px; font-weight:600; }}
  .lic-open {{ background:var(--open-bg); color:var(--open); }}
  .lic-prop {{ background:#f0f0ee; color:#8a8a90; }}
  footer {{ margin-top:40px; padding-top:16px; border-top:1px solid var(--line);
    color:var(--dim); font-size:12px; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>LMArena 数据核对</h1>
  <p class="lead">第三方镜像 <code>{e(src.get("name"))}</code> ·
    抓取于 <code>{e(d.get("fetchedAt"))}</code> ·
    解析自页面内嵌 JSON（非 HTML 表格，故字段为结构化原值）</p>

  <div class="stats">
    <div class="stat"><span>榜单</span><b>{len(boards)}</b></div>
    <div class="stat"><span>数据行</span><b>{stats.get("totalRows", 0)}</b></div>
    <div class="stat"><span>全量行</span><b>{sum(b.get("fullCount", 0) for b in boards.values())}</b></div>
    <div class="stat"><span>本页每榜</span><b>Top {d.get("top") or "全量"}</b></div>
  </div>

  <div class="warn">
    ⚠️ <b>数据源为第三方镜像</b>（非 LMArena 官方）。其同步自官方默认视图，
    而官方自 2025-05-16 起 text / vision arena 默认即为 style-controlled。
    分数绝对值只在<b>同一榜内</b>可比，跨榜（如 Elo 与净改善度）不可比。
  </div>

  <nav>{"".join(nav)}</nav>
  {"".join(sections)}

  <footer>
    由 <code>tools/make_preview.py</code> 生成 · 数据 <code>data/lmarena.json</code> ·
    校验 <code>python tools/verify_lmarena.py</code>
  </footer>
</div>
</body>
</html>
"""

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"已生成 {os.path.abspath(OUT)} ({len(doc)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
