#!/usr/bin/env python3
"""抓取 LMArena 榜单数据（经 arena.atease.dev 中文镜像）。

数据来源
--------
镜像页是 Next.js 服务端渲染，榜单数据以 RSC payload 内嵌在 HTML 里
（`self.__next_f.push([1, "...JSON..."])`）。解析该 JSON 比解析 HTML 表格更可靠：

  * 字段是结构化的（数值字段直接给 `*_val`，不用自己正则拆 "1506±5"）
  * 带 `license` 字段（open / proprietary）—— 开源筛选的依据
  * 是全量数据（text 榜 402 个模型），不限于页面首屏的 15 行

⚠️ 该镜像为第三方（非 LMArena 官方）。数据口径：镜像同步官方默认视图，
而官方自 2025-05-16 起 text / vision arena 默认即 style-controlled。

用法
----
    python tools/fetch_lmarena.py              # 每榜 Top 30（默认）
    python tools/fetch_lmarena.py --top 15     # 每榜 Top 15
    python tools/fetch_lmarena.py --all        # 全量
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request

BASE = "https://arena.atease.dev"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "..", "data", "lmarena.json")

# (路由, 所属大类, 中文名, 主指标量纲)
BOARDS = [
    ("agent", "agent", "Agent（净改善度）", "pct"),
    ("text", "chat", "文本对话", "elo"),
    ("vision", "chat", "视觉多模态", "elo"),
    ("search", "chat", "搜索增强", "elo"),
    ("document", "chat", "文档理解", "elo"),
    ("code", "code", "前端开发", "elo"),
    ("image-to-webdev", "code", "图生网页", "elo"),
    ("text-to-image", "image", "文生图", "elo"),
    ("image-edit", "image", "图像编辑", "elo"),
    ("text-to-video", "video", "文生视频", "elo"),
    ("image-to-video", "video", "图生视频", "elo"),
    ("video-edit", "video", "视频编辑", "elo"),
]

# agent 榜专属指标
AGENT_METRICS = [
    "confirmedSuccess",
    "praiseVsComplaint",
    "steerability",
    "bashRecovery",
    "toolHallucination",
    "costTaskP50",
    "outputTokensTaskP50",
]

DEC = json.JSONDecoder()
PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)')


def fetch(url, retries=3, timeout=45):
    """带重试的 GET。"""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"抓取失败 {url}: {last}")


def extract_initial_data(html):
    """从 RSC payload 中提取 initialData 对象。"""
    best = None
    for chunk in PUSH_RE.findall(html):
        if "initialData" in chunk and (best is None or len(chunk) > len(best)):
            best = chunk
    if best is None:
        return None
    # JS 字符串反转义
    raw = best.replace('\\"', '"').replace("\\\\", "\\")
    key = '"initialData":'
    i = raw.find(key)
    if i < 0:
        return None
    j = raw.index("{", i + len(key))
    obj, _ = DEC.raw_decode(raw, j)
    return obj


def parse_price(text):
    """'$$10 / $50' -> (10.0, 50.0)。N/A 或残缺时返回 (None, None)。"""
    if not text or text.strip() in ("N/A", ""):
        return None, None
    t = text.strip()
    if t.startswith("$"):
        t = t[1:]
    parts = [p.strip().lstrip("$").strip() for p in t.split("/")]
    vals = []
    for p in parts[:2]:
        try:
            vals.append(float(p))
        except ValueError:
            vals.append(None)
    while len(vals) < 2:
        vals.append(None)
    if vals[0] is None and vals[1] is None:
        return None, None
    return vals[0], vals[1]


def build_row(m):
    """把镜像的原始记录规整成统一行结构。"""
    row = {
        "rank": m.get("rank"),
        "rankSpread": m.get("rankSpread"),
        "model": m.get("model"),
        "displayName": m.get("display_name") or m.get("model"),
        "vendor": m.get("vendor_override") or m.get("vendor"),
        "license": m.get("license"),
        "score": m.get("score_val"),
        "votes": m.get("votes_val"),
        "country": m.get("country"),
        "openrouterId": m.get("openrouter_id"),
        "huggingfaceId": m.get("huggingface_id"),
        "detailSlug": m.get("detail_slug"),
    }

    if m.get("score_ci") is not None:
        row["scoreCi"] = m.get("score_ci")

    price_in, price_out = parse_price(m.get("price"))
    if price_in is not None:
        row["priceIn"] = price_in
        row["priceOut"] = price_out

    ctx = m.get("context")
    if ctx and ctx != "N/A":
        row["context"] = ctx

    extra = {}
    for key in AGENT_METRICS:
        val = m.get(key + "_val")
        if val is None:
            continue
        extra[key] = val
        ci = m.get(key + "_ci")
        if ci is not None:
            extra[key + "Ci"] = ci
    if extra:
        row["extra"] = extra

    return row


def scrape_board(route, top):
    url = f"{BASE}/{route}/"
    html = fetch(url)
    data = extract_initial_data(html)
    if not data:
        raise RuntimeError("页面中未找到 initialData（镜像可能已改版）")
    models = data.get("models") or []
    rows = [build_row(m) for m in models]
    if top and top > 0:
        rows = rows[:top]
    return data.get("meta") or {}, rows, len(models)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=30, help="每榜保留前 N 名（默认 30）")
    ap.add_argument("--all", action="store_true", help="抓全量，忽略 --top")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    top = 0 if args.all else args.top

    boards = {}
    total = 0
    errors = []

    for route, group, label, unit in BOARDS:
        try:
            meta, rows, full_count = scrape_board(route, top)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{route}: {e}")
            print(f"  ✗ {route:<18} {e}", file=sys.stderr)
            continue

        boards[route] = {
            "group": group,
            "label": label,
            "unit": unit,
            "route": f"/{route}/",
            "sourceUrl": meta.get("source_url"),
            "sourceUpdated": meta.get("last_updated"),
            "sourceFetchedAt": meta.get("fetched_at"),
            "fullCount": full_count,
            "rows": rows,
        }
        total += len(rows)
        print(f"  ✓ {route:<18} {len(rows):>3}/{full_count:<4} 榜首={rows[0]['displayName'] if rows else '-'}")

    if not boards:
        print("全部失败，未写出文件。", file=sys.stderr)
        return 1

    payload = {
        "source": {
            "name": "arena.atease.dev",
            "note": "LMArena 官方榜单的第三方中文镜像。官方自 2025-05-16 起 text/vision 默认即 style-controlled。",
            "officialUrl": "https://lmarena.ai/",
            "licenseNote": "license 字段区分 open / proprietary，可直接用于开源筛选。",
        },
        "fetchedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "top": top,
        "boards": boards,
        "stats": {
            "boardCount": len(boards),
            "totalRows": total,
        },
    }

    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    size = os.path.getsize(out_path)
    print(f"\n{len(boards)}/{len(BOARDS)} 榜，{total} 行 -> {out_path} ({size/1024:.0f} KB)")
    if errors:
        print(f"失败 {len(errors)} 个：", file=sys.stderr)
        for e in errors:
            print("  - " + e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
