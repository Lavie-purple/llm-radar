#!/usr/bin/env python3
"""抓取 LiveBench 数据（无官方 API，直接用其静态数据文件）。

数据来源
--------
livebench.ai 是 React SPA，榜单数据来自三个静态文件：

  * `table_<release>.csv`      —— 模型 × 22 个任务的得分
  * `categories_<release>.json` —— 7 个大类 → 任务的映射
  * `cost_<release>.csv`       —— 每任务成本 + 每任务题目数（nq_*）

发布版日期通过 GitHub API 枚举 `LiveBench/livebench.github.io` 的 public/ 目录自动发现，
数据文件优先从 livebench.ai 下载（它比 GitHub 仓库更新：同名文件 58 行 vs 29 行）。

指标定义（取自页面 JS bundle 的 tooltip 与实现）
-----------------------------------------------
  每任务成本        cost_per_task = Σ cost[task] / Σ nq_[task]
  每成功任务成本     cpst = cost_per_task / score × 100
  类别分            该类下各任务分的算术平均
  Overall           7 个类别分的等权平均（按类别平均，不按题目）

用法
----
    python tools/fetch_livebench.py
    python tools/fetch_livebench.py --release 2026_06_25
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

# categories json 里的键名 → 展示名
CATEGORY_LABEL = {
    "Reasoning": "Reasoning",
    "Coding": "Coding",
    "Agentic Coding": "Agentic Coding",
    "Mathematics": "Mathematics",
    "Data Analysis": "Data Analysis",
    "Language": "Language",
    "IF": "Instruction Following",
}


def discover_releases():
    """从 GitHub 仓库文件树里枚举所有 release 日期，降序返回。"""
    data = json.loads(rsc.http_get(TREE_API, timeout=45))
    dates = sorted({m.group(1) for m in
                    (re.search(r"public/categories_(\d{4}_\d{2}_\d{2})\.json", it.get("path", ""))
                     for it in data.get("tree", [])) if m},
                   reverse=True)
    return dates


def grab(name, release):
    """优先从 livebench.ai 取，失败回退 GitHub raw。返回文本或 None。"""
    for base in (SITE, RAW):
        try:
            txt = rsc.http_get(f"{base}/{name}", retries=2, timeout=45)
            if txt and not txt.lstrip().startswith("<!"):
                return txt
        except Exception:  # noqa: BLE001
            continue
    return None


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", help="指定 release（如 2026_06_25），默认取最新")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    releases = discover_releases()
    if not releases:
        print("未发现任何 release", file=sys.stderr)
        return 1
    release = args.release or releases[0]
    print(f"可用 release（新→旧）：{releases[:5]}")
    print(f"使用 release：{release}")

    table_txt = grab(f"table_{release}.csv", release)
    cats_txt = grab(f"categories_{release}.json", release)
    cost_txt = grab(f"cost_{release}.csv", release)

    if not table_txt or not cats_txt:
        print("关键文件缺失（table 或 categories）", file=sys.stderr)
        return 1

    rows = parse_csv(table_txt)
    categories = json.loads(cats_txt)
    cost_rows = {r["model"]: r for r in parse_csv(cost_txt)} if cost_txt else {}

    print(f"  模型 {len(rows)} 个 / 类别 {len(categories)} 个 / cost 表 {len(cost_rows)} 行")

    models = []
    for r in rows:
        name = (r.get("model") or "").strip()
        if not name:
            continue

        # 每任务分
        task_scores = {}
        for cat, tasks in categories.items():
            for t in tasks:
                v = to_num(r.get(t))
                if v is not None:
                    task_scores[t] = v

        # 各类别分（类内任务算术平均）
        cat_scores = {}
        for cat, tasks in categories.items():
            vals = [task_scores[t] for t in tasks if t in task_scores]
            if vals:
                cat_scores[CATEGORY_LABEL.get(cat, cat)] = round(sum(vals) / len(vals), 3)

        # overall = 各类别分的等权平均
        overall = round(sum(cat_scores.values()) / len(cat_scores), 3) if cat_scores else None

        # 成本
        cp = cost_rows.get(name)
        cost_per_task = None
        cpst = None
        if cp:
            total_cost = 0.0
            total_q = 0.0
            for cat, tasks in categories.items():
                for t in tasks:
                    c = to_num(cp.get(t))
                    nq = to_num(cp.get("nq_" + t))
                    if c is not None and nq is not None and nq > 0:
                        total_cost += c
                        total_q += nq
            if total_q > 0:
                cost_per_task = total_cost / total_q
                if overall:
                    cpst = cost_per_task / overall * 100

        models.append({
            "model": name,
            "overall": overall,
            "categories": cat_scores,
            "tasks": task_scores,
            "costPerTask": round(cost_per_task, 6) if cost_per_task is not None else None,
            "costPerSuccessfulTask": round(cpst, 4) if cpst is not None else None,
        })

    payload = {
        "source": {
            "name": "livebench.ai",
            "url": SITE,
            "note": "无官方 API。数据取自站点静态文件 table_*.csv / categories_*.json / cost_*.csv，"
                    "release 日期经 GitHub 仓库自动发现。",
            "metricNote": "Cost per successful task = (Σcost ÷ Σquestions ÷ score) × 100；"
                          "Overall = 7 个类别分的等权平均（按类别平均，不按题目）。",
        },
        "fetchedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "release": release,
        "availableReleases": releases,
        "categoryMap": {CATEGORY_LABEL.get(k, k): v for k, v in categories.items()},
        "models": models,
        "stats": {
            "modelCount": len(models),
            "withCost": sum(1 for m in models if m["costPerSuccessfulTask"] is not None),
        },
    }

    path, size = rsc.write_json(payload, args.out)
    print(f"\n{len(models)} 个模型 -> {path} ({size/1024:.0f} KB)")

    print("\nOverall 前 8：")
    for m in sorted([x for x in models if x["overall"] is not None],
                    key=lambda x: -x["overall"])[:8]:
        cpst = m["costPerSuccessfulTask"]
        print(f"  {m['overall']:>6.2f}  {m['model'][:46]:<48} "
              f"Agentic={m['categories'].get('Agentic Coding')}  "
              f"IF={m['categories'].get('Instruction Following')}  "
              f"CPST=${cpst if cpst is not None else '—'}")

    print("\nCost per successful task 最低的 5 个：")
    withcost = [x for x in models if x["costPerSuccessfulTask"] is not None]
    for m in sorted(withcost, key=lambda x: x["costPerSuccessfulTask"])[:5]:
        print(f"  ${m['costPerSuccessfulTask']:<8} {m['model'][:46]:<48} Overall={m['overall']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
