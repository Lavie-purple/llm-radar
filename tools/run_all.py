#!/usr/bin/env python3
"""统一入口：跑全部抓取器，然后存档快照并生成变更报告。

每日计划任务调用这一个脚本即可。

用法
----
    python tools/run_all.py
    python tools/run_all.py --only lmarena,aa    # 只跑指定源
    python tools/run_all.py --no-snapshot        # 不存档
"""

import argparse
import datetime as dt
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

# 页面自检（tools/selftest.js）是 Node 脚本，与抓取器用的解释器不同
NODE_CANDIDATES = [
    os.environ.get("NODE_EXE"),
    r"C:\Users\lavie\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
]


def find_node():
    for c in NODE_CANDIDATES:
        if c and os.path.isfile(c):
            return c
    return shutil.which("node")

FETCHERS = [
    ("lmarena", "fetch_lmarena.py", []),
    ("aa", "fetch_aa.py", []),
    ("llmstats", "fetch_llmstats.py", []),
    ("livebench", "fetch_livebench.py", []),
]


def run(script, extra):
    path = os.path.join(HERE, script)
    proc = subprocess.run(
        [PY, path] + extra,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.returncode, (proc.stdout or ""), (proc.stderr or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="逗号分隔，只跑指定源")
    ap.add_argument("--no-snapshot", action="store_true")
    ap.add_argument("--no-selftest", action="store_true", help="跳过页面自检")
    ap.add_argument("--no-health", action="store_true", help="跳过抓取量体检")
    args = ap.parse_args()

    only = set(x.strip() for x in args.only.split(",")) if args.only else None

    started = dt.datetime.now()
    print(f"===== 抓取开始 {started.astimezone().isoformat(timespec='seconds')} =====")

    results = {}
    for name, script, extra in FETCHERS:
        if only and name not in only:
            continue
        t0 = dt.datetime.now()
        code, out, err = run(script, extra)
        dt_s = (dt.datetime.now() - t0).total_seconds()
        results[name] = code
        flag = "✓" if code == 0 else "✗"
        print(f"\n{flag} {name}  ({dt_s:.1f}s)")
        # 只打印抓取器输出的末尾几行，避免刷屏
        for line in (out or "").rstrip().splitlines()[-6:]:
            print("   " + line)
        if code != 0 and err:
            for line in err.rstrip().splitlines()[:6]:
                print("   ! " + line, file=sys.stderr)

    ok = sum(1 for c in results.values() if c == 0)
    print(f"\n----- 抓取完成：{ok}/{len(results)} 成功 -----")

    # 抓取量体检：抓取器全绿也不代表抓全了。源站改版最常见的形态恰恰是
    # 「HTTP 200 + 解析无异常 + 结果为空」。这一关不过就按抓取失败处理 ——
    # 保留上一版 app.json，而不是拿半份数据覆盖出一个看着正常的空页面。
    health_ok = True
    if ok == len(results) and results and not args.no_health:
        code, out, err = run("health.py", [])
        print("\n" + (out or "").rstrip())
        if err:
            print(err.rstrip(), file=sys.stderr)
        health_ok = (code == 0)

    # 合成前端数据：把四个源合并成 data/app.json（+ app.json.js）
    # 只有四源全部成功且体检通过才重建，避免用半份数据覆盖出错的页面。
    if ok == len(results) and results and health_ok:
        code, out, err = run("build_app.py", [])
        print("\n" + (out or "").rstrip())
        if err:
            print(err.rstrip(), file=sys.stderr)
        if code != 0:
            print("数据合成步骤失败", file=sys.stderr)
            return 1

        # 页面自检：数据合成后跑一遍 DOM 桩冒烟。
        # 防的是「数据对了但页面崩了」——抓取器全绿也挡不住渲染层出 NaN。
        if not args.no_selftest:
            node = find_node()
            if not node:
                print("\n未找到 node，跳过页面自检", file=sys.stderr)
            else:
                proc = subprocess.run(
                    [node, os.path.join(HERE, "selftest.js")],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                )
                lines = (proc.stdout or "").rstrip().splitlines()
                print("\n" + "\n".join(lines[-4:]))
                if proc.returncode != 0:
                    print(proc.stdout or "", file=sys.stderr)
                    print("页面自检失败（数据已更新，但页面渲染有问题）", file=sys.stderr)
                    return 1
    else:
        why = "抓取失败" if ok != len(results) else ("抓取量体检异常" if not health_ok else "无可用结果")
        print(f"\n{why}，跳过数据合成（保留上一版 app.json）", file=sys.stderr)

    if not args.no_snapshot:
        code, out, err = run("snapshot.py", [])
        print("\n" + (out or "").rstrip())
        if err:
            print(err.rstrip(), file=sys.stderr)
        if code != 0:
            print("快照步骤失败", file=sys.stderr)
            return 1

    # 名次走势数据：扫描 snapshots/ 全量重算，输出 data/history.json(.js)。
    # 必须排在 snapshot.py 之后 —— 它读的就是刚存下的那一份。
    # 即使 --no-snapshot 也照跑：快照没变时它只是把同样的结果重写一遍，无副作用。
    code, out, err = run("build_history.py", [])
    print("\n" + (out or "").rstrip())
    if err:
        print(err.rstrip(), file=sys.stderr)
    if code != 0:
        print("走势数据生成失败", file=sys.stderr)
        return 1

    elapsed = (dt.datetime.now() - started).total_seconds()
    print(f"\n总耗时 {elapsed:.1f}s")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
