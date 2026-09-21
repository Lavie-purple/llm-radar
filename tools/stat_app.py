#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统计 data/app.json 的实际规模，并打印一份可复核的报告。

用途
----
README 与文档里出现的所有"当前快照规模"数字都应当出自这个脚本，
而不是手写 —— 手写的数字会随数据更新悄悄变成假话。

它同时给出两个不同口径，别混用：
  · **模型库**        —— 出现在任一子类行里的全部模型
  · **矩阵视图**      —— 页面上真正渲染成表格行的那部分，
                        入选条件是「覆盖 >=2 个榜，或在单榜排进前 10」

用法
----
    python tools/stat_app.py
"""

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_PATH = os.path.join(HERE, "..", "data", "app.json")


def main():
    if not os.path.isfile(APP_PATH):
        print("找不到 %s —— 请先跑 tools/build_app.py" % APP_PATH, file=sys.stderr)
        return 1

    app = json.load(io.open(APP_PATH, encoding="utf-8"))
    cats = app["categories"]
    subs = app["subcats"]
    models = app["models"]
    mids = app.get("matrixIds") or []

    n_cat, n_sub, n_mod = len(cats), len(subs), len(models)

    def has_value(mid, sc):
        cell = (models.get(mid, {}).get("cells") or {}).get(sc["key"]) or {}
        return (cell.get("values") or {}).get(sc["primary"]) is not None

    def count(ids):
        f = sum(1 for mid in ids for sc in subs.values() if has_value(mid, sc))
        t = len(ids) * n_sub
        return f, t - f, t

    full_f, full_e, full_t = count(list(models))
    mx_f, mx_e, mx_t = count(mids)

    single = [k for k, v in subs.items() if v.get("singleSource")]
    open_n = sum(1 for m in models.values() if m.get("open"))
    cov3 = sum(1 for m in models.values() if len(m.get("seenIn") or []) >= 3)

    print("数据生成时间 : %s" % app.get("generatedAt"))
    print("每子类收录   : 前 %s 名" % app.get("topN"))
    print("源           : %s" % "、".join(
        (v.get("label") or k) if isinstance(v, dict) else str(v)
        for k, v in (app["sources"].items() if isinstance(app["sources"], dict)
                     else [(s.get("key"), s) for s in app["sources"]])))
    print()
    print("大类 / 子类  : %d / %d" % (n_cat, n_sub))
    for c in cats:
        print("   %-8s %d 个 : %s" % (
            c["key"], len(c["subcats"]),
            "、".join(subs[k]["label"] for k in c["subcats"])))
    print()
    print("── 模型库 ──")
    print("模型数       : %d" % n_mod)
    print("其中开源     : %d" % open_n)
    print("覆盖 >=3 榜  : %d" % cov3)
    print("全库格子     : %d 有值 / %d 空位 / 共 %d  (%.1f%% 填充)"
          % (full_f, full_e, full_t, full_f * 100.0 / full_t if full_t else 0))
    print()
    print("── 矩阵视图（页面真正渲染的行）──")
    print("行数         : %d（入选条件：覆盖 >=2 个榜 或 单榜前 10）" % len(mids))
    print("未进矩阵     : %d（只在「大类详情」视图里按子类出现）" % (n_mod - len(mids)))
    print("格子总数     : %d (%d 行 x %d 列)" % (mx_t, len(mids), n_sub))
    print("有值 / 空位  : %d / %d" % (mx_f, mx_e))
    print("填充率       : %.1f%%" % (mx_f * 100.0 / mx_t if mx_t else 0))
    print()
    print("── 单源子类 %d / %d（分歧度必然为空）──" % (len(single), n_sub))
    for k in single:
        print("   %-22s %s" % (k, subs[k]["label"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
