# -*- coding: utf-8 -*-
"""扫描 snapshots/ 生成名次走势数据 data/history.json。

为什么要有这个
--------------
四个源站全都只给「当下快照」，没有一个给你「跨源 + 时间」的趋势。
而选模型真正难的不是「现在谁第一」，是「这个第一是不是刚爬上来的、下周会不会掉」。
这份走势是自建站唯一能压倒四站的独占信息 —— 而 snapshots/ 里的数据本来就在攒，
之前只被用来算「自上次以来」的 diff，剩下的全浪费了。

口径
----
只取**每个子类的主指标来源**（和矩阵列头一致），只记**前 TOP 名**（够覆盖页面展示的 30 名）。
名次一律按 build_app.py 的同一套逻辑重算，保证历史与当前页面的名次是同一个口径。

用法
----
    python tools/build_history.py
    python tools/build_history.py --max 90     # 只看最近 90 天
"""

import argparse
import datetime as dt
import io
import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from normalize import canonical
from build_app import (CATEGORIES, build_aa, build_livebench, build_llmstats,
                       build_lmarena, lb_value, num)

DATA = os.path.abspath(os.path.join(HERE, '..', 'data'))
SNAP = os.path.abspath(os.path.join(HERE, '..', 'snapshots'))
OUT = os.path.join(DATA, 'history.json')
OUT_JS = os.path.join(DATA, 'history.json.js')

TOP = 40          # 每个子类只记前 40 名
DEFAULT_MAX = 90  # 最多回溯多少天（防止快照攒多了以后每天解析过慢）


def write_payload(payload):
    """同时写 .json 与 .json.js。

    为什么要 .js 包装：页面是从 file:// 直接打开的单文件站，
    fetch/XHR 读本地 .json 会被 CORS 挡掉（app.json 也是同样的处理）。
    """
    txt = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    io.open(OUT, 'w', encoding='utf-8').write(txt)
    io.open(OUT_JS, 'w', encoding='utf-8').write('window.HISTORY=' + txt + ';\n')
    return len(txt.encode('utf-8'))


# --------------------------------------------------------------------------
def snapshot_days(max_n):
    """返回 [(date_tag, dirpath)]，按日期升序，同一天只保留最后一份。

    历史遗留的 tag 是 '%Y-%m-%dT%H%M'（精确到分钟），新的只到日期。
    统一按前 10 位归并；同一天取「最后写入的那份」，用目录 mtime 判定。

    ⚠️ 不能按 tag 字典序取最大：'2026-09-21T1100' 和 '2026-09-21' 是同一天，
    但前者字典序更大（后者是它的前缀），于是新写的日期目录永远选不中。
    实测踩过这个坑，改成看 mtime 才是「最后写的那份」。
    """
    if not os.path.isdir(SNAP):
        return []
    by_day = {}
    for d in os.listdir(SNAP):
        full = os.path.join(SNAP, d)
        if not os.path.isdir(full) or not d[:1].isdigit():
            continue
        day = d[:10]
        try:
            mt = os.path.getmtime(full)
        except OSError:
            continue
        if day not in by_day or mt > by_day[day][0]:
            by_day[day] = (mt, full)
    days = sorted((k, v[1]) for k, v in by_day.items())
    return days[-max_n:] if max_n else days


def ranks_lmarena(raw, key):
    b = (raw.get('boards') or {}).get(key)
    if not b:
        return {}
    out = {}
    for row in b.get('rows', []):
        m = row.get('model')
        rk = row.get('rank')
        if not m or rk is None or rk > TOP:
            continue
        fid, _ = canonical(m)
        if fid not in out or rk < out[fid]:
            out[fid] = rk
    return out


def ranks_llmstats(raw, key):
    b = (raw.get('indexes') or {}).get(key)
    if not b:
        return {}
    out = {}
    for row in b.get('rows', []):
        nm = row.get('model_name')
        rk = row.get('rank')
        if not nm or rk is None or rk > TOP:
            continue
        fid, _ = canonical(nm)
        if fid not in out or rk < out[fid]:
            out[fid] = rk
    return out


def ranks_aa(raw, key):
    by_fam, _ = build_aa(raw)
    ranked = sorted([(f, num(m.get(key))) for f, m in by_fam.items()
                     if num(m.get(key)) is not None], key=lambda t: -t[1])
    return {f: i for i, (f, _) in enumerate(ranked, 1) if i <= TOP}


def ranks_livebench(raw, key):
    by_fam = build_livebench(raw)
    ranked = sorted([(f, num(lb_value(m, key))) for f, m in by_fam.items()
                     if num(lb_value(m, key)) is not None], key=lambda t: -t[1])
    return {f: i for i, (f, _) in enumerate(ranked, 1) if i <= TOP}


RANKERS = {'lmarena': ranks_lmarena, 'llmstats': ranks_llmstats,
           'aa': ranks_aa, 'livebench': ranks_livebench}


def per_snapshot(dirpath):
    """-> {(subcat_key, src_key): {family_id: rank}}，只取各子类的主指标来源。"""
    cache = {}

    def get(src):
        if src not in cache:
            p = os.path.join(dirpath, src + '.json')
            try:
                cache[src] = json.load(io.open(p, encoding='utf-8'))
            except Exception:
                cache[src] = None
        return cache[src]

    out = {}
    for cat in CATEGORIES:
        for sc in cat['subcats']:
            prim = sc['primary']
            col = next((c for c in sc['cols'] if c[0] == prim), None)
            if not col:
                continue
            board_key = col[1]
            raw = get(prim)
            if raw is None:
                continue
            fn = RANKERS.get(prim)
            if not fn:
                continue
            try:
                r = fn(raw, board_key)
            except Exception as e:                       # 单个快照坏掉不该拖垮全部
                print('  ! %s / %s 解析失败：%s' % (os.path.basename(dirpath), sc['key'], e),
                      file=sys.stderr)
                continue
            if r:
                out[(sc['key'], prim)] = r
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max', type=int, default=DEFAULT_MAX, help='最多回溯多少天')
    args = ap.parse_args()

    days = snapshot_days(args.max)
    print('可用快照 %d 天' % len(days))
    if not days:
        payload = {"builtAt": dt.datetime.now().astimezone().isoformat(timespec='seconds'),
                   "n": 0, "tags": [], "series": {},
                   "note": "还没有快照。跑一次 tools/run_all.py 之后再回来看。"}
        write_payload(payload)
        print('-> %s（空）' % OUT)
        return 0

    tags = [d for d, _ in days]
    # fid -> subcat -> {下标: rank}
    raw = defaultdict(lambda: defaultdict(dict))
    for i, (tag, path) in enumerate(days):
        per = per_snapshot(path)
        total = 0
        for (subcat, _src), ranks in per.items():
            for fid, rk in ranks.items():
                raw[fid][subcat][i] = rk
                total += 1
        print('  %s  子类 %2d 个，落点 %4d 条' % (tag, len(per), total))

    series = {}
    for fid, subs in raw.items():
        series[fid] = {sk: [idx.get(i) for i in range(len(tags))]
                       for sk, idx in subs.items()}

    payload = {
        "builtAt": dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        "n": len(tags),
        "tags": tags,
        "series": series,
    }
    write_payload(payload)

    print()
    print('已写出 %s  (%.0f KB)' % (OUT, os.path.getsize(OUT) / 1024))
    print('          %s  (%.0f KB)' % (OUT_JS, os.path.getsize(OUT_JS) / 1024))
    print('时间点 %d 个（%s ~ %s）｜模型 %d 个' % (len(tags), tags[0], tags[-1], len(series)))
    sub_n = defaultdict(int)
    for subs in series.values():
        for sk in subs:
            sub_n[sk] += 1
    print('各子类有走势的模型数：')
    for cat in CATEGORIES:
        for sc in cat['subcats']:
            print('   %-18s %3d' % (sc['key'], sub_n.get(sc['key'], 0)))
    # 自检：每个序列长度必须等于时间点数（否则前端按索引取点会串位）
    bad = [(f, sk, len(a)) for f, subs in series.items()
           for sk, a in subs.items() if len(a) != len(tags)]
    print('序列长度异常：%s' % (bad[:5] if bad else '无（全部对齐 %d）' % len(tags)))
    # 前端画线的最低要求是「同一序列里至少 2 个有名次的点」。
    # 这一行是给「攒够没有」一个当场可读的答案，免得靠翻页面猜。
    drawable = sum(1 for subs in series.values() for a in subs.values()
                   if sum(1 for x in a if x is not None) >= 2)
    total_seq = sum(len(subs) for subs in series.values())
    print('可画走势的序列：%d / %d%s' % (
        drawable, total_seq, '' if drawable else '　← 只有 1 天快照，前端会显示「积累中」'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
