#!/usr/bin/env python3
"""抓取 llm-stats.com 数据（免 API key）。

数据来源
--------
`llm-stats.com` 首页内嵌的 RSC payload，含两块：

  1. `initialHomepageLLMModels` —— 392 个模型的基础档案
     （组织、上下文、输入/输出价格、吞吐 throughput、is_open_source、arena_scores）
  2. `initialAllIndexes` —— 55 个分类的 TrueSkill 榜
     每项含 mu / sigma / conservative（= μ−3σ，即 LLM Stats Score）/ rank /
     rank_delta_14d（14 天排名变化）/ games_played

官方 API（api.llm-stats.com）需要 key，但页面内嵌数据同样完整且免 key。

用法
----
    python tools/fetch_llmstats.py
    python tools/fetch_llmstats.py --index-top 100
"""

import argparse
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rsc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "..", "data", "llmstats.json")
URL = "https://llm-stats.com/"

# 与用户关心的维度相关的分类（其余仍保留在文件里）
FOCUS = ["general", "reasoning", "code", "coding", "agents", "chat",
         "instruction_following", "tool_calling", "frontend_development",
         "math", "vision", "multimodal", "search", "text-to-image"]

MODEL_FIELDS = [
    "model_id", "name", "organization", "organization_id",
    "context", "param_count",
    "input_price", "output_price", "throughput",
    "is_open_source", "release_date", "announcement_date",
    "gpqa_score", "swe_bench_verified_score", "hle_score",
    "arena_scores",
]

INDEX_FIELDS = [
    "rank", "model_id", "model_name", "organization_id", "organization_name",
    "mu", "sigma", "conservative", "ci_lower", "ci_upper",
    "rank_delta_14d", "games_played",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index-top", type=int, default=50, help="每个分类保留前 N 名（默认 50）")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    print(f"抓取 {URL} ...")
    html = rsc.http_get(URL)
    print(f"  HTML {len(html)/1024/1024:.2f} MB")

    chunks = rsc.rsc_chunks(html)

    raw_models = rsc.best_array(chunks, "initialHomepageLLMModels", min_items=10)
    if not raw_models:
        print("未找到 initialHomepageLLMModels（页面结构可能已改版）", file=sys.stderr)
        return 1

    models = []
    for m in raw_models:
        row = {}
        for k in MODEL_FIELDS:
            v = m.get(k)
            if v is not None:
                row[k] = v
        models.append(row)
    print(f"  模型档案 {len(models)} 条")

    all_index = rsc.find_object(chunks, "initialAllIndexes")
    if not all_index:
        print("未找到 initialAllIndexes", file=sys.stderr)
        return 1

    indexes = {}
    empty = []
    for cat, obj in all_index.items():
        rows_raw = obj.get("models") or []
        if not rows_raw:
            empty.append(cat)
            continue
        rows = []
        for r in rows_raw[: args.index_top]:
            rows.append({k: r.get(k) for k in INDEX_FIELDS if k in r})
        indexes[cat] = {
            "count": len(rows_raw),
            "rows": rows,
        }
    print(f"  分类 {len(all_index)} 个（非空 {len(indexes)}，空 {len(empty)}）")

    has_open = sum(1 for m in models if m.get("is_open_source"))
    has_speed = sum(1 for m in models if m.get("throughput") is not None)
    has_price = sum(1 for m in models if m.get("input_price") is not None)

    payload = {
        "source": {
            "name": "llm-stats.com",
            "url": URL,
            "note": "解析自页面内嵌 RSC payload，未使用官方 API（免 key）。"
                    "TrueSkill 发布分 S = μ − 3σ，字段名 conservative。",
            "licenseNote": "is_open_source 为布尔字段，可直接用于开源筛选。",
        },
        "fetchedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "indexTop": args.index_top,
        "models": models,
        "indexes": indexes,
        "stats": {
            "modelCount": len(models),
            "categoryCount": len(all_index),
            "nonEmptyCategories": len(indexes),
            "emptyCategories": empty,
            "openSourceCount": has_open,
            "withSpeed": has_speed,
            "withPrice": has_price,
        },
    }

    path, size = rsc.write_json(payload, args.out)
    print(f"\n-> {path} ({size/1024:.0f} KB)")
    print(f"  开源模型 {has_open} / 有速度 {has_speed} / 有价格 {has_price}")

    print("\n用户关心的分类：")
    for cat in FOCUS:
        if cat in indexes:
            top = indexes[cat]["rows"][0]
            print(f"  {cat:<22} {indexes[cat]['count']:>4} 项  榜首={top.get('model_name')} "
                  f"(S={top.get('conservative')})")
        else:
            print(f"  {cat:<22} —— 不存在或为空")

    print("\n各分类榜首（按分类名排序，前 12）：")
    for cat in sorted(indexes)[:12]:
        top = indexes[cat]["rows"][0]
        print(f"  {cat:<22} {top.get('model_name'):<28} S={top.get('conservative')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
