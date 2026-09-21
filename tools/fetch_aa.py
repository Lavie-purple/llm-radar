#!/usr/bin/env python3
"""抓取 Artificial Analysis 模型数据（免 API key）。

数据来源
--------
`artificialanalysis.ai/leaderboards/models` 页面内嵌的 RSC payload。
官方 API（`api/v2/data/llms/models`）需要 key，但页面内嵌数据同样完整：
653 个模型 × 50 字段，含 Intelligence Index、GDPval-AA、Terminal-Bench、
价格、输出速度、TTFT、端到端耗时与幻觉率。

用法
----
    python tools/fetch_aa.py
    python tools/fetch_aa.py --all        # 不过滤 deprecated
"""

import argparse
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rsc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "..", "data", "aa.json")
URL = "https://artificialanalysis.ai/leaderboards/models"

# 保留的字段（覆盖用户点名的 AA 指标）
FIELDS = [
    "slug", "name", "shortName", "modelCreatorName", "releaseDate",
    "isReasoning", "isOpenWeights", "deprecated", "contextWindowTokens",
    # 智能体 / 编码
    "gdpvalNormalized", "analystAgent", "apexAgents", "itbenchSre",
    "terminalBench21", "terminalBench40", "terminalbenchHard",
    "tau2", "tauBanking",
    # 通用能力 / 科学推理
    "intelligenceIndex", "intelligenceIndexIsEstimated",
    "lcr", "hle", "gpqa", "scicode", "ifbench", "critpt", "mmmuPro",
    # 事实性 / 幻觉
    "omniscience", "omniscienceAccuracy", "omniscienceNonHallucination",
    # 价格
    "price1mInputTokens", "price1mOutputTokens", "cacheHitPrice", "cacheWritePrice",
    # 速度 / 延迟
    "medianOutputTokensPerSecond",
    "medianTimeToFirstTokenSeconds", "medianTimeToFirstAnswerTokenSeconds",
    "medianEndToEndResponseTimeSeconds", "medianReasoningTimeSeconds",
]


def effort_label(m):
    """effort 在不同视图里可能是 dict({'label':...}) 也可能是纯字符串。"""
    e = m.get("effort")
    if isinstance(e, dict):
        return e.get("label")
    if isinstance(e, str):
        return e
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="保留 deprecated 模型")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    print(f"抓取 {URL} ...")
    html = rsc.http_get(URL)
    print(f"  HTML {len(html)/1024/1024:.2f} MB")

    chunks = rsc.rsc_chunks(html)
    raw = rsc.best_array(chunks, "models", min_items=50)
    if not raw:
        print("未找到 models 数组（AA 页面结构可能已改版）", file=sys.stderr)
        return 1

    print(f"  解析到 {len(raw)} 个模型条目")

    # effort 字段只出现在另一个视图（字段较少的那份数组）里，单独收集后合并
    effort_map = {}
    for arr, _ in rsc.find_arrays(chunks, "models", min_items=50):
        for m in arr:
            label = effort_label(m)
            if m.get("slug") and label:
                effort_map[m["slug"]] = label
    if effort_map:
        print(f"  effort 映射收集到 {len(effort_map)} 条")

    rows = []
    skipped_dep = 0
    for m in raw:
        if not args.all and m.get("deprecated"):
            skipped_dep += 1
            continue
        row = {}
        label = effort_label(m) or effort_map.get(m.get("slug"))
        if label:
            row["effort"] = label
        for k in FIELDS:
            if k in ("deprecated",):
                continue
            v = m.get(k)
            if v is not None:
                row[k] = v
        rows.append(row)

    # 统计
    has_idx = sum(1 for r in rows if r.get("intelligenceIndex") is not None)
    has_gdp = sum(1 for r in rows if r.get("gdpvalNormalized") is not None)
    has_price = sum(1 for r in rows if r.get("price1mInputTokens") is not None)
    has_speed = sum(1 for r in rows if r.get("medianOutputTokensPerSecond") is not None)

    payload = {
        "source": {
            "name": "artificialanalysis.ai",
            "url": URL,
            "note": "解析自页面内嵌 RSC payload，未使用官方 API（免 key）。"
                    "Intelligence Index 版本请以站方标注为准。",
            "licenseNote": "isOpenWeights 字段区分开放权重与闭源；官方另有 Openness Index。",
        },
        "fetchedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "count": len(rows),
        "coverage": {
            "intelligenceIndex": has_idx,
            "gdpval": has_gdp,
            "price": has_price,
            "speed": has_speed,
        },
        "models": rows,
    }

    path, size = rsc.write_json(payload, args.out)
    print(f"\n{len(rows)} 个模型（跳过 deprecated {skipped_dep}）-> {path} ({size/1024:.0f} KB)")
    print(f"  有 Intelligence Index : {has_idx}")
    print(f"  有 GDPval-AA          : {has_gdp}")
    print(f"  有价格                : {has_price}")
    print(f"  有输出速度            : {has_speed}")

    # 抽查
    print("\nIntelligence Index 前 8：")
    top = sorted([r for r in rows if r.get("intelligenceIndex") is not None],
                 key=lambda r: -r["intelligenceIndex"])[:8]
    for r in top:
        print(f"  {r['intelligenceIndex']:>6.2f}  {r.get('shortName') or r['name']:<44} "
              f"effort={str(r.get('effort')):<8} "
              f"${r.get('price1mInputTokens')}/${r.get('price1mOutputTokens')}  "
              f"{r.get('medianOutputTokensPerSecond', 0):.0f} tok/s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
