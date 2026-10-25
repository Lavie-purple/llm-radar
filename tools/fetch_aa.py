#!/usr/bin/env python3
"""抓取 Artificial Analysis 模型数据（免 API key）。

数据来源
--------
`artificialanalysis.ai/leaderboards/models` 页面内嵌的 RSC payload。
官方 API（`api/v2/data/llms/models`）需要 key，但页面内嵌数据同样完整：
272 个模型 × 38 字段，含 Intelligence Index、GDPval-AA、Terminal-Bench、
价格、输出速度、TTFT、端到端耗时与幻觉率。

2026-10 改版记录（本次踩过）
--------------------------
AA 把指标数组从 `"models"` 改名成 `"initialModels"`，`"models"` 退化成
709 条只有 slug/name/releaseSlug 的**名录**。按 key 名找数组会静默抓到名录
（HTTP 200、解析无异常、指标全空）。现在改成按「含 intelligenceIndex 字段」
找数组（rsc.best_metrics_array），并对指标覆盖率设闸门。
同时 `releaseDate` 不在指标数组里，在 `"releases"` 数组里（slug → releaseDate），
按 slug 关联；`effort` 字段整个从页面消失了，相关展示降级为无。

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
    # 按「含指标字段」找数组，不按 key 名 —— AA 2026-10 把指标数组从 models
    # 改名成 initialModels，models 沦为 709 条名录。见模块 docstring。
    raw = rsc.best_metrics_array(chunks, "intelligenceIndex", min_items=50)
    if not raw:
        print("未找到含指标的模型数组（AA 页面结构可能已改版）", file=sys.stderr)
        return 1

    print(f"  解析到 {len(raw)} 个模型条目（含 intelligenceIndex）")

    # releaseDate 在 releases 数组里（slug -> releaseDate），按 slug 关联。
    # 2026-10 起指标数组自身不再带这个字段。
    rel_map = {}
    for arr, _ in rsc.find_arrays(chunks, "releases", min_items=50):
        for r in arr:
            if r.get("slug") and r.get("releaseDate"):
                rel_map[r["slug"]] = r["releaseDate"]
    if rel_map:
        print(f"  releaseDate 映射收集到 {len(rel_map)} 条")

    # effort 字段只出现在另一个视图（字段较少的那份数组）里，单独收集后合并
    # 2026-10 改版后 effort 已从页面消失，这里保留兼容：找得到就合并，找不到就算了。
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
        rd = rel_map.get(m.get("slug"))
        if rd:
            row["releaseDate"] = rd
        for k in FIELDS:
            if k in ("deprecated", "releaseDate"):
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

    # 字段级闸门：条目数正常但指标全空，正是 2026-10 改版那次的形态
    #（抓到 709 条名录、intelligenceIndex 0 条）。health.py 只数条目数，
    # 这种「条目暴涨但字段全空」它只会 WARN 不会 FAIL —— 闸门必须设在抓取器里。
    if has_idx == 0:
        print(f"抓到 {len(rows)} 个条目但 intelligenceIndex 全为空"
              " —— 指标数组可能又改名了，拒绝写出", file=sys.stderr)
        return 1

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
