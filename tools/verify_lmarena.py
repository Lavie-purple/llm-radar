#!/usr/bin/env python3
"""校验 data/lmarena.json 的结构与数值一致性，并打印统计报告。

断言分 6 类：
  1. 榜单完整性与行数
  2. 名次从 1 连续递增
  3. 分数降序
  4. 同榜内模型不重复
  5. license 值域合法
  6. 必填字段非空、数值字段类型正确

用法：python tools/verify_lmarena.py
"""

import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data", "lmarena.json")

EXPECTED_BOARDS = [
    "agent", "text", "vision", "search", "document",
    "code", "image-to-webdev", "text-to-image", "image-edit",
    "text-to-video", "image-to-video", "video-edit",
]

VALID_LICENSE = {"open", "proprietary"}

failures = []
warnings = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def warn(cond, msg):
    if not cond:
        warnings.append(msg)


def main():
    if not os.path.exists(DATA):
        print(f"数据文件不存在：{DATA}")
        return 1

    with open(DATA, encoding="utf-8") as f:
        d = json.load(f)

    boards = d.get("boards", {})
    print(f"抓取时间：{d.get('fetchedAt')}")
    print(f"数据源  ：{(d.get('source') or {}).get('name')}")
    print(f"榜单数  ：{len(boards)}")
    print()

    # ---- 1. 完整性 ----
    for b in EXPECTED_BOARDS:
        check(b in boards, f"缺少榜单 {b}")
    check(len(boards) == len(EXPECTED_BOARDS),
          f"榜单数为 {len(boards)}，期望 {len(EXPECTED_BOARDS)}")

    lic_counter = Counter()
    total_rows = 0

    print(f"{'榜':<18}{'行数':>5}{'全量':>6}  榜首")
    print("-" * 68)

    for key in EXPECTED_BOARDS:
        if key not in boards:
            continue
        bd = boards[key]
        rows = bd.get("rows", [])
        total_rows += len(rows)

        check(len(rows) > 0, f"{key}: 无数据行")
        if not rows:
            continue

        # 必填字段
        for r in rows:
            check(r.get("rank") is not None, f"{key}: rank 为空 ({r.get('model')})")
            check(bool(r.get("model")), f"{key}: model 为空")
            check(bool(r.get("displayName")), f"{key}: displayName 为空 ({r.get('model')})")
            check(isinstance(r.get("rank"), int), f"{key}: rank 非整数 ({r.get('model')})")
            check(r.get("score") is not None, f"{key}: score 为空 ({r.get('model')})")
            check(isinstance(r.get("score"), (int, float)),
                  f"{key}: score 非数值 ({r.get('model')})")
            lic = r.get("license")
            check(lic in VALID_LICENSE, f"{key}: license 非法值 {lic!r} ({r.get('model')})")
            if lic:
                lic_counter[lic] += 1

        # 2. 名次连续
        ranks = [r["rank"] for r in rows]
        check(ranks == list(range(1, len(rows) + 1)),
              f"{key}: 名次不连续 {ranks[:5]}...{ranks[-3:]}")

        # 3. 分数降序
        scores = [r["score"] for r in rows]
        check(all(scores[i] >= scores[i + 1] for i in range(len(scores) - 1)),
              f"{key}: 分数非降序（{scores[0]} ... {scores[-1]}）")

        # 4. 不重复
        names = [r["model"] for r in rows]
        dup = [n for n, c in Counter(names).items() if c > 1]
        check(not dup, f"{key}: 模型重复 {dup[:3]}")

        print(f"{key:<18}{len(rows):>5}{bd.get('fullCount', 0):>6}  {rows[0]['displayName']}")

    print("-" * 68)
    print(f"{'合计':<18}{total_rows:>5}")
    print()

    # ---- license 分布 ----
    print("license 分布：", dict(lic_counter))
    check(lic_counter.get("open", 0) > 0, "没有任何 open 模型，license 字段可能失效")
    check(lic_counter.get("proprietary", 0) > 0, "没有任何 proprietary 模型")

    # ---- 价格解析抽查 ----
    print()
    print("价格解析抽查（text 榜前 5）：")
    for r in boards.get("text", {}).get("rows", [])[:5]:
        pi, po = r.get("priceIn"), r.get("priceOut")
        print(f"  {r['displayName']:<28} in=${pi} out=${po}")

    priced = [r for r in boards.get("text", {}).get("rows", []) if r.get("priceIn") is not None]
    check(len(priced) > 0, "text 榜价格全部解析失败")
    if priced:
        bad = [r["displayName"] for r in priced if (r.get("priceOut") or 0) < (r.get("priceIn") or 0)]
        warn(not bad, f"输出价低于输入价的模型（可能解析错）：{bad[:5]}")

    # ---- agent 榜专属指标 ----
    print()
    agent_rows = boards.get("agent", {}).get("rows", [])
    if agent_rows:
        k0 = set(agent_rows[0].get("extra", {}))
        print(f"agent 榜 extra 字段（共 {len(k0)}）：{sorted(k0)}")
        print("agent 榜前 3：")
        for r in agent_rows[:3]:
            ex = r.get("extra", {})
            print(f"  #{r['rank']} {r['displayName']:<26} 净改善={r['score']} "
                  f"每任务成本=${ex.get('costTaskP50')} 确认成功率={ex.get('confirmedSuccess')}")
        check(len(k0) >= 5, f"agent 榜 extra 字段偏少（{len(k0)}），解析可能不全")

    # ---- 开源模型头部 ----
    print()
    print("各榜排名最高的 open 模型：")
    for key in EXPECTED_BOARDS:
        rows = boards.get(key, {}).get("rows", [])
        op = next((r for r in rows if r.get("license") == "open"), None)
        if op:
            print(f"  {key:<18} #{op['rank']:<3} {op['displayName']}")

    # ---- 结果 ----
    print()
    if warnings:
        print(f"⚠️  {len(warnings)} 条警告：")
        for w in warnings:
            print("   - " + w)
    if failures:
        print(f"❌ {len(failures)} 条失败：")
        for m in failures[:30]:
            print("   - " + m)
        return 1
    print("✅ 全部校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
