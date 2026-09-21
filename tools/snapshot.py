#!/usr/bin/env python3
"""快照存档与变更检测。

每次抓取后调用：
  1. 把 data/*.json 存档到 snapshots/<tag>/
  2. 与上一份快照比对，产出 data/changes.json
     （页面据此显示「自上次以来：新增 / 掉出 / 大幅变动」）

页面定位是「判断辅助器」，而用户的头号痛点是「跟不上变化」——
变更追踪因此是一等功能，不是附属产物。

用法
----
    python tools/snapshot.py            # 存档 + diff
    python tools/snapshot.py --no-save  # 只 diff 现有快照
"""

import argparse
import datetime as dt
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, "..", "data"))
SNAP = os.path.abspath(os.path.join(HERE, "..", "snapshots"))
CHANGES = os.path.join(DATA, "changes.json")

SOURCES = ["lmarena", "aa", "llmstats", "livebench"]
# 保留的「天数」。快照 tag 只到日期，同一天内重复运行会覆盖当天那一份，
# 所以 180 = 约半年历史。之前 tag 精确到分钟、只留 30 份 —— 那样同一天手动
# 多跑几次就把历史挤掉了，走势图根本攒不起来。
KEEP_SNAPSHOTS = 180
MAX_LIST = 40  # 每个 added/removed 列表最多保留多少条


def load(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def snapshot(tag=None):
    """把当前 data/*.json 存档到 snapshots/<tag>/。

    tag 默认只到日期（同一天重复运行 = 覆盖当天，而不是新开一份）。
    """
    tag = tag or dt.datetime.now().strftime("%Y-%m-%d")
    dest = os.path.join(SNAP, tag)
    os.makedirs(dest, exist_ok=True)

    saved = {}
    for s in SOURCES:
        src = os.path.join(DATA, f"{s}.json")
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(dest, f"{s}.json"))
            saved[s] = os.path.getsize(src)

    meta = {
        "tag": tag,
        "savedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "files": saved,
    }
    with open(os.path.join(dest, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    return tag


def all_snapshots():
    if not os.path.isdir(SNAP):
        return []
    return sorted(d for d in os.listdir(SNAP)
                  if os.path.isdir(os.path.join(SNAP, d)) and d[0].isdigit())


def prune():
    dirs = all_snapshots()
    for d in dirs[:-KEEP_SNAPSHOTS]:
        shutil.rmtree(os.path.join(SNAP, d), ignore_errors=True)
    return max(0, len(dirs) - KEEP_SNAPSHOTS)


# ---------- 各源的标识抽取 ----------

def ids_lmarena(doc):
    """{board: {model: rank}}"""
    out = {}
    for board, bd in (doc.get("boards") or {}).items():
        out[board] = {r["model"]: r.get("rank") for r in bd.get("rows", []) if r.get("model")}
    return out


def ids_aa(doc):
    return {m["slug"]: m.get("intelligenceIndex")
            for m in (doc.get("models") or []) if m.get("slug")}


def ids_llmstats(doc):
    out = {m["model_id"]: None for m in (doc.get("models") or []) if m.get("model_id")}
    return out


def ids_livebench(doc):
    return {m["model"]: m.get("overall")
            for m in (doc.get("models") or []) if m.get("model")}


ID_FUNCS = {
    "lmarena": ids_lmarena,
    "aa": ids_aa,
    "llmstats": ids_llmstats,
    "livebench": ids_livebench,
}


def diff_lmarena(prev, cur):
    """按榜比对模型集合与名次。"""
    p_all = ids_lmarena(prev)
    c_all = ids_lmarena(cur)
    boards = {}
    for board in sorted(set(p_all) | set(c_all)):
        p = p_all.get(board) or {}
        c = c_all.get(board) or {}
        added = sorted(set(c) - set(p))
        removed = sorted(set(p) - set(c))
        moved = []
        for m in set(p) & set(c):
            if p[m] != c[m]:
                moved.append({"model": m, "from": p[m], "to": c[m], "delta": c[m] - p[m]})
        moved.sort(key=lambda x: -abs(x["delta"]))
        if added or removed or moved:
            boards[board] = {
                "added": added[:MAX_LIST],
                "removed": removed[:MAX_LIST],
                "moved": moved[:15],
            }
    return {"boards": boards}


def diff_flat(prev, cur, fn):
    p = fn(prev)
    c = fn(cur)
    added = sorted(set(c) - set(p))
    removed = sorted(set(p) - set(c))
    # 分值大幅变动（相对变化 > 10%）
    shifted = []
    for m in set(p) & set(c):
        if p[m] is None or c[m] is None:
            continue
        if p[m] == 0:
            continue
        pct = (c[m] - p[m]) / abs(p[m]) * 100
        if abs(pct) >= 10:
            shifted.append({"model": m, "from": round(p[m], 3),
                            "to": round(c[m], 3), "pct": round(pct, 1)})
    shifted.sort(key=lambda x: -abs(x["pct"]))
    return {"added": added[:MAX_LIST], "removed": removed[:MAX_LIST], "shifted": shifted[:20]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-save", action="store_true", help="只做 diff，不新建快照")
    ap.add_argument("--tag", help="指定快照 tag（默认用当前时间）")
    args = ap.parse_args()

    if not args.no_save:
        tag = snapshot(args.tag)
        pruned = prune()
        print(f"已存档快照：{tag}" + (f"（清理旧快照 {pruned} 份）" if pruned else ""))
    else:
        dirs = all_snapshots()
        tag = dirs[-1] if dirs else None
        if not tag:
            print("没有可用快照", file=sys.stderr)
            return 1
        print(f"使用现有快照：{tag}")

    dirs = all_snapshots()
    if len(dirs) < 2:
        payload = {
            "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "current": tag,
            "previous": None,
            "hasBaseline": False,
            "note": "只有一份快照，尚无基线可比较。下次抓取后再看变更。",
            "sources": {},
        }
        with open(CHANGES, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        print("只有一份快照，写空变更报告。")
        return 0

    prev_tag, cur_tag = dirs[-2], dirs[-1]
    payload = {
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "current": cur_tag,
        "previous": prev_tag,
        "hasBaseline": True,
        "sources": {},
    }

    total = {"added": 0, "removed": 0, "moved": 0}
    for s in SOURCES:
        p = load(os.path.join(SNAP, prev_tag, f"{s}.json"))
        c = load(os.path.join(SNAP, cur_tag, f"{s}.json"))
        if p is None or c is None:
            continue
        if s == "lmarena":
            out = diff_lmarena(p, c)
            for bd in out["boards"].values():
                total["added"] += len(bd["added"])
                total["removed"] += len(bd["removed"])
                total["moved"] += len(bd["moved"])
        else:
            out = diff_flat(p, c, ID_FUNCS[s])
            total["added"] += len(out["added"])
            total["removed"] += len(out["removed"])
        payload["sources"][s] = out

    payload["summary"] = total

    with open(CHANGES, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print(f"\n变更报告 {prev_tag} -> {cur_tag}")
    print(f"  新增 {total['added']} / 掉出 {total['removed']} / 名次变动 {total['moved']}")
    for s, out in payload["sources"].items():
        if s == "lmarena":
            n = sum(len(v["added"]) + len(v["removed"]) for v in out["boards"].values())
            print(f"  {s:<10} 有变更的榜 {len(out['boards'])} 个，条目 {n}")
        else:
            print(f"  {s:<10} 新增 {len(out['added'])} 掉出 {len(out['removed'])} "
                  f"大幅变动 {len(out.get('shifted', []))}")
    print(f"\n-> {CHANGES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
