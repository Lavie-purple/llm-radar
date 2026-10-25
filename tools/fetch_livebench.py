#!/usr/bin/env python3
"""抓取 LiveBench 数据（无官方 API，直接用其静态数据文件）。

2026-10-23：LiveBench 升级 2.0，站点整个重做（本次踩过，全部实测核对过）
------------------------------------------------------------------
`livebench.ai` 从「旧版静态 CSV」变成「LiveBench 2.0」SPA：

  * **旧文件全下架**：`table_<release>.csv` / `categories_<release>.json` /
    `cost_<release>.csv` 在 livebench.ai 上一律 404（原来主站比 GitHub 仓库
    更全：同名文件 58 行 vs 29 行，现在只剩 GitHub 那份残缺的）。
  * **新数据在 `./data/<release>/` 下**：`table.csv`（模型 × 7 任务列）、
    `categories.json`（类别 → 任务 + `_overall_weights` 权重）、
    `cost.csv`（每任务成本 + nq_ + 单价 + token 量）、`notes.json`（发布说明）。
    `<release>` 是 8 位日期，如 `20261023`。
  * **类别整个更换**：Long Agentic / Reasoning / Coding / Browser / Data Analysis /
    Research / Design。旧的 Reasoning / Coding / Data Analysis 名字还在，
    但 Agentic Coding / Mathematics / Language / Instruction Following 没有了。
  * **overall 从等权平均改成加权平均**：权重写在 `categories.json` 的
    `_overall_weights` 里（当前 Long Agentic ×2 / Coding ×1.5 / Design ×1.5，
    其余 ×1），公式 `Σ(类别分×权重) ÷ Σ(权重)`，只对有分的类别求和。
    已从站点 JS bundle 里逐行核对（函数 En / Cn 的 tooltip 原文：
    "weighted mean of the suites with a score (…, the rest ×1)"）。
  * **成本公式没变**（同样从 bundle 核对）：
    每任务成本 = Σcost[task] ÷ Σnq_[task]；
    CPST = 每任务成本 ÷ overall × 100。

release 发现
-----------
  * v2 列表写在**站点 JS bundle** 里（`Yt=[...]` 数组，`/new` 路径下还多一个
    晚一周的 id），bundle 地址在首页 HTML 的 `src="./static/js/main.*.js"`。
    每次抓取都重新解一遍，不硬编码 —— bundle 哈希会变，release 列表也会长。
  * v1 列表仍从 GitHub 仓库文件树枚举（livebench.ai 已经不提供旧文件，
    只能走 raw.githubusercontent.com）。
  * 默认取「能抓到数据的最新 release」；v2 发现整体失败直接报错退出，
    不静默回退旧数据（那是 2026-10-25 实际发生过的静默退化）。

指标定义
--------
  每任务成本        cost_per_task = Σ cost[task] / Σ nq_[task]
  每成功任务成本     cpst = cost_per_task / score × 100
  类别分            该类下各任务分的算术平均（2.0 起每类只有一个任务）
  Overall           各类别分的加权平均（权重见 categories.json，缺省 1）

用法
----
    python tools/fetch_livebench.py                    # 自动发现，取最新
    python tools/fetch_livebench.py --release 2026_06_25   # 强制旧版（GitHub raw）
    python tools/fetch_livebench.py --list             # 只列 release 不抓
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rsc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "..", "data", "livebench.json")

TREE_API = "https://api.github.com/repos/LiveBench/livebench.github.io/git/trees/main?recursive=1"
SITE = "https://livebench.ai"
RAW = "https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public"

WEIGHTS_KEY = "_overall_weights"

# 首页 HTML 里的 bundle 地址，如 src="./static/js/main.27333af3.js"
BUNDLE_RE = re.compile(r'src="(\./static/js/main\.[^"]+?\.js)"')
# bundle 里的 v2 release 列表：Yt=["20261014"]
V2_LIST_RE = re.compile(r'\bYt\s*=\s*\[([^\]]*)\]')
# bundle 里 /new 路径下额外多出的那个（条件编译的两支都写在同一个 bundle 里）
V2_EXTRA_RE = re.compile(r'\[\.\.\.Yt,\s*"(\d{8})"\]')
# v1 旧版文件名里的日期
V1_DATE_RE = re.compile(r"(\d{4}_\d{2}_\d{2})")


# --------------------------------------------------------------------------
# release 发现
# --------------------------------------------------------------------------
def discover_v2():
    """从站点 JS bundle 解出 v2 release id 列表（新→旧）。失败抛异常。"""
    home = rsc.http_get(SITE + "/", retries=3, timeout=45)
    m = BUNDLE_RE.search(home)
    if not m:
        raise RuntimeError("首页里找不到 JS bundle 地址（livebench.ai 结构又变了？）")
    js = rsc.http_get(SITE + "/" + m.group(1).lstrip("./"), retries=2, timeout=60)
    ids = []
    m2 = V2_LIST_RE.search(js)
    if m2:
        ids += re.findall(r'"(\d{8})"', m2.group(1))
    ids += V2_EXTRA_RE.findall(js)
    ids = sorted(set(ids), reverse=True)
    if not ids:
        raise RuntimeError("bundle 里解不出 v2 release 列表（Yt 数组没了？）")
    return ids


def discover_v1():
    """从 GitHub 仓库文件树枚举所有 v1 release 日期，降序返回。"""
    data = json.loads(rsc.http_get(TREE_API, timeout=45))
    dates = sorted({m.group(1) for m in
                    (re.search(r"public/table_(\d{4}_\d{2}_\d{2})\.csv", it.get("path", ""))
                     for it in data.get("tree", [])) if m},
                   reverse=True)
    return dates


def sort_key(release):
    """v2 的 20261023 与 v1 的 2026_06_25 统一按日期排序。"""
    d = release.replace("_", "")
    return dt.date(int(d[:4]), int(d[4:6]), int(d[6:8]))


def all_releases():
    """-> [(release, 'v2'|'v1')]，新的在前。v2 发现失败会抛异常（不静默）。"""
    out = [(r, "v2") for r in discover_v2()]
    out += [(r, "v1") for r in discover_v1()]
    out.sort(key=lambda t: sort_key(t[0]), reverse=True)
    return out


# --------------------------------------------------------------------------
# 取文件
# --------------------------------------------------------------------------
def try_get(url):
    try:
        txt = rsc.http_get(url, retries=2, timeout=45)
    except Exception:  # noqa: BLE001
        return None
    if txt and not txt.lstrip().startswith("<!"):
        return txt
    return None


def grab_v2(name, release):
    txt = try_get(f"{SITE}/data/{release}/{name}")
    return txt


def grab_v1(name, release):
    """v1 旧文件：livebench.ai 已 404，直接走 GitHub raw。"""
    return try_get(f"{RAW}/{name}_{release}.csv" if name.endswith(".csv")
                   else f"{RAW}/{name}_{release}.json")


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------
def parse_csv(text):
    return list(csv.DictReader(io.StringIO(text)))


def to_num(v):
    if v is None:
        return None
    v = str(v).strip()
    if v == "" or v.lower() in ("nan", "n/a", "-"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def split_categories(cats):
    """categories.json -> (类别 dict, 权重 dict)。权重只认 >0 的有限数。"""
    raw_w = cats.get(WEIGHTS_KEY) or {}
    clean = {k: v for k, v in cats.items() if k != WEIGHTS_KEY}
    weights = {}
    for k, v in raw_w.items():
        if k not in clean:
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:
            weights[k] = f
    return clean, weights


def weighted_overall(cat_scores, weights):
    """overall = Σ(类别分×权重) ÷ Σ(权重)，只对有分的类别求和（与站点 En 一致）。"""
    num = den = 0.0
    for cat, sc in cat_scores.items():
        if sc is None:
            continue
        w = weights.get(cat, 1.0)
        if w <= 0:
            continue
        num += sc * w
        den += w
    return round(num / den, 3) if den > 0 else None


def cost_stats(cost_row, categories):
    """-> (cost_per_task, cost_per_successful_task or None先算成本部分)。

    每任务成本 = Σ cost[task] / Σ nq_[task]（与站点 Q 函数一致）。
    CPST 需要 overall，由调用方除。
    """
    if not cost_row:
        return None
    tot_c = tot_q = 0.0
    for tasks in categories.values():
        for t in tasks:
            c = to_num(cost_row.get(t))
            nq = to_num(cost_row.get("nq_" + t))
            if c is not None and nq is not None and nq > 0:
                tot_c += c
                tot_q += nq
    return (tot_c / tot_q) if tot_q > 0 else None


def build_models_v2(rows, categories, weights, cost_rows):
    models = []
    known_tasks = {t for tasks in categories.values() for t in tasks}
    unknown = set()
    for r in rows:
        name = (r.get("model") or "").strip()
        if not name:
            continue
        unknown |= {k for k in r.keys() if k != "model" and k not in known_tasks}
        task_scores = {t: to_num(r.get(t)) for t in known_tasks if to_num(r.get(t)) is not None}
        cat_scores = {}
        for cat, tasks in categories.items():
            vals = [task_scores[t] for t in tasks if t in task_scores]
            if vals:
                cat_scores[cat] = round(sum(vals) / len(vals), 3)
        overall = weighted_overall(cat_scores, weights)
        cpt = cost_stats(cost_rows.get(name), categories)
        cpst = round(cpt / overall * 100, 4) if (cpt is not None and overall) else None
        models.append({
            "model": name,
            "overall": overall,
            "categories": cat_scores,
            "tasks": task_scores,
            "costPerTask": round(cpt, 6) if cpt is not None else None,
            "costPerSuccessfulTask": cpst,
        })
    if unknown:
        print(f"  ! 忽略不在 categories.json 里的列：{sorted(unknown)}", file=sys.stderr)
    return models


def build_models_v1(rows, categories, cost_rows):
    """旧版口径：overall = 各类别分的等权平均（2026-10-23 之前的算法）。"""
    models = []
    for r in rows:
        name = (r.get("model") or "").strip()
        if not name:
            continue
        task_scores = {}
        for cat, tasks in categories.items():
            for t in tasks:
                v = to_num(r.get(t))
                if v is not None:
                    task_scores[t] = v
        cat_scores = {}
        for cat, tasks in categories.items():
            vals = [task_scores[t] for t in tasks if t in task_scores]
            if vals:
                cat_scores[cat] = round(sum(vals) / len(vals), 3)
        overall = round(sum(cat_scores.values()) / len(cat_scores), 3) if cat_scores else None
        cpt = cost_stats(cost_rows.get(name), categories)
        cpst = round(cpt / overall * 100, 4) if (cpt is not None and overall) else None
        models.append({
            "model": name,
            "overall": overall,
            "categories": cat_scores,
            "tasks": task_scores,
            "costPerTask": round(cpt, 6) if cpt is not None else None,
            "costPerSuccessfulTask": cpst,
        })
    return models


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", help="指定 release（v2 如 20261023，v1 如 2026_06_25）")
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--list", action="store_true", help="只列 release 不抓")
    args = ap.parse_args()

    try:
        releases = all_releases()
    except Exception as e:  # noqa: BLE001
        print(f"release 发现失败：{e}", file=sys.stderr)
        return 1

    if args.list:
        for r, gen in releases:
            print(f"  {r}  ({gen})")
        return 0

    print(f"可用 release（新→旧，前 8）：{[(r, g) for r, g in releases[:8]]}")

    # 选定 release：显式指定 > 能抓到数据的最新
    if args.release:
        rel = args.release
        gen = "v2" if re.fullmatch(r"\d{8}", rel) else "v1"
        if not any(r == rel for r, _ in releases):
            print(f"指定的 release {rel} 不在可用列表里", file=sys.stderr)
            return 1
        cands = [(rel, gen)]
    else:
        cands = releases

    chosen = None
    for rel, gen in cands:
        grab = grab_v2 if gen == "v2" else grab_v1
        table_txt = grab("table.csv" if gen == "v2" else "table", rel)
        cats_txt = grab("categories.json" if gen == "v2" else "categories", rel)
        if table_txt and cats_txt:
            chosen = (rel, gen, table_txt, cats_txt, grab)
            break
        print(f"  ! {rel} ({gen}) 数据不可用，试下一个", file=sys.stderr)

    if not chosen:
        print("所有 release 都取不到数据", file=sys.stderr)
        return 1

    rel, gen, table_txt, cats_txt, grab = chosen
    cost_txt = grab("cost.csv" if gen == "v2" else "cost", rel)
    print(f"使用 release：{rel}（{gen}）")

    rows = parse_csv(table_txt)
    categories_raw = json.loads(cats_txt)
    if gen == "v2":
        categories, weights = split_categories(categories_raw)
    else:
        categories = categories_raw
        weights = {}
    cost_rows = {r["model"]: r for r in parse_csv(cost_txt)} if cost_txt else {}

    if gen == "v2":
        models = build_models_v2(rows, categories, weights, cost_rows)
    else:
        models = build_models_v1(rows, categories, cost_rows)

    print(f"  模型 {len(models)} 个 / 类别 {len(categories)} 个 / cost 表 {len(cost_rows)} 行")
    if not cost_rows:
        print("  ! 没有 cost 数据（CPST 将全部为空）", file=sys.stderr)
    if gen == "v2" and weights:
        print(f"  overall 权重：{weights}")

    if not models:
        print("解析出 0 个模型，拒绝写出", file=sys.stderr)
        return 1
    no_overall = sum(1 for m in models if m["overall"] is None)
    if no_overall == len(models):
        print("全部模型都没有 overall —— 解析口径可能对不上，拒绝写出", file=sys.stderr)
        return 1

    payload = {
        "source": {
            "name": "livebench.ai",
            "url": SITE,
            "note": "无官方 API。LiveBench 2.0 数据取自站点静态文件 data/<release>/{table.csv,"
                    "categories.json,cost.csv}，release 列表解自站点 JS bundle；"
                    "旧版（v1）release 只能从 GitHub 仓库 raw 获取（主站已下架旧文件）。",
            "metricNote": "Cost per successful task = (Σcost ÷ Σquestions ÷ score) × 100；"
                          + ("Overall = 各类别分的加权平均（权重见 categories.json 的 "
                             "_overall_weights，缺省 ×1）。"
                             if gen == "v2" else
                             "Overall = 各类别分的等权平均（v1 旧口径）。"),
        },
        "fetchedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "release": rel,
        "format": gen,
        "availableReleases": [r for r, _ in releases],
        "overallWeights": weights,
        "categoryMap": categories,
        "models": models,
        "stats": {
            "modelCount": len(models),
            "withCost": sum(1 for m in models if m["costPerSuccessfulTask"] is not None),
            "withOverall": sum(1 for m in models if m["overall"] is not None),
        },
    }

    path, size = rsc.write_json(payload, args.out)
    print(f"\n{len(models)} 个模型 -> {path} ({size/1024:.0f} KB)")

    print("\nOverall 前 8：")
    for m in sorted([x for x in models if x["overall"] is not None],
                    key=lambda x: -x["overall"])[:8]:
        cpst = m["costPerSuccessfulTask"]
        print(f"  {m['overall']:>6.2f}  {m['model'][:46]:<48} "
              f"CPST=${cpst if cpst is not None else '—'}")

    print("\nCost per successful task 最低的 5 个：")
    withcost = [x for x in models if x["costPerSuccessfulTask"] is not None]
    for m in sorted(withcost, key=lambda x: x["costPerSuccessfulTask"])[:5]:
        print(f"  ${m['costPerSuccessfulTask']:<8} {m['model'][:46]:<48} Overall={m['overall']}")
    if not withcost:
        print("  （无）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
