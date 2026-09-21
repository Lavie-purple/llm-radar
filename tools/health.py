# -*- coding: utf-8 -*-
"""抓取量体检 —— 挡住「抓取器返回 0，但只抓到 3 行」这种静默退化。

为什么需要
----------
run_all.py 原来只看 returncode。可源站改版最典型的症状恰恰是
「HTTP 200 + 解析没报错 + 结果是空的」：榜单从服务端渲染改成客户端渲染、
字段改名、分页参数失效……这时抓取器会「成功」返回，页面却悄悄少一整列。
四个源全是第三方页面，没有任何契约，这种退化迟早会发生，而且不会自己报错 ——
它只会让页面越来越空，而没人知道是哪一天开始空的。

口径
----
每个源记两个数：
  groups —— 榜单 / 维度数（lmarena 的 boards、llm-stats 的 indexes、LiveBench 的 categoryMap）
  rows   —— 条目数（各榜行数之和 / 模型数）
两个都记，是因为两种退化都要挡：整块榜消失（groups 掉）和榜在但被截断（rows 掉）。

判据
----
与「最近 WINDOW 次记录的中位数」比，偏离超过 THRESH 就报警。
  · 用中位数不用上次值 —— 单次抖动不该触发，趋势性塌缩才该。
  · 记录不足 MIN_HIST 次时只记录、不判断 —— 没有基线，任何比较都是瞎猜。
  · 缩水 = 失败（退出非零，run_all 据此不覆盖上一版 app.json，保留可用的旧数据）；
    变大 = 只警告。这不是放宽标准：源站新增一个大类会让行数合法暴涨，
    拿它挡住当天的更新纯属误报；而「少了一整块」永远不是正常现象。

用法
----
    python tools/health.py              # 体检 + 记录本次
    python tools/health.py --no-record  # 只体检
    python tools/health.py --show       # 只打印历史台账
"""

import argparse
import datetime as dt
import io
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.abspath(os.path.join(HERE, '..', 'data'))
LOGS = os.path.abspath(os.path.join(HERE, '..', 'logs'))
LOG = os.path.join(LOGS, 'health.json')

SOURCES = ['lmarena', 'aa', 'llmstats', 'livebench']

WINDOW = 7        # 取最近多少次记录算中位数
MIN_HIST = 3      # 至少攒到几次才开始判断（现在只有 1 次）
THRESH = 0.30     # 偏离阈值
KEEP = 60         # 台账最多留多少条


# --------------------------------------------------------------------------
def measure(src, payload):
    """-> (groups, rows)。口径固定，改这里等于改历史基线，需同步清空台账。"""
    if src == 'lmarena':
        boards = payload.get('boards') or {}
        return len(boards), sum(len(b.get('rows') or []) for b in boards.values())
    if src == 'llmstats':
        idx = payload.get('indexes') or {}
        return len(idx), sum(len(b.get('rows') or []) for b in idx.values())
    if src == 'aa':
        return len(payload.get('coverage') or {}), len(payload.get('models') or [])
    if src == 'livebench':
        return len(payload.get('categoryMap') or {}), len(payload.get('models') or [])
    return 0, 0


def collect(data_dir=DATA):
    out = {}
    for s in SOURCES:
        path = os.path.join(data_dir, s + '.json')
        try:
            payload = json.load(io.open(path, encoding='utf-8'))
        except Exception as e:
            out[s] = {'error': str(e), 'groups': 0, 'rows': 0}
            continue
        g, r = measure(s, payload)
        out[s] = {'groups': g, 'rows': r}
    return out


def load_log():
    try:
        d = json.load(io.open(LOG, encoding='utf-8'))
    except Exception:
        return []
    return d.get('runs') or []


def save_log(runs):
    if not os.path.isdir(LOGS):
        os.makedirs(LOGS)
    payload = {'updatedAt': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
               'runs': runs[-KEEP:]}
    io.open(LOG, 'w', encoding='utf-8').write(
        json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True))


def median_of(runs, src, field):
    vals = [r['sources'][src][field] for r in runs
            if isinstance(r.get('sources', {}).get(src), dict)
            and r['sources'][src].get(field) is not None]
    return statistics.median(vals) if vals else None


def audit(cur, hist):
    """-> [(level, text)]，level ∈ {'FAIL','WARN'}。hist 是本次之前的记录。"""
    issues = []
    ready = len(hist) >= MIN_HIST
    for src in SOURCES:
        c = cur.get(src) or {}
        if c.get('error'):
            issues.append(('FAIL', '%s：数据读取失败（%s）' % (src, c['error'])))
            continue
        for field, label in (('groups', '榜单数'), ('rows', '条目数')):
            now = c.get(field) or 0
            if now == 0:
                issues.append(('FAIL', '%s %s = 0 —— 解析成功但一条都没抓到，源站大概率改版了'
                               % (src, label)))
                continue
            med = median_of(hist, src, field) if ready else None
            if not med:
                continue
            dev = (now - med) / float(med)
            if dev < -THRESH:
                issues.append(('FAIL', '%s %s 从常年的 %s 掉到 %s（%.0f%%，阈值 %.0f%%）'
                               % (src, label, _n(med), now, dev * 100, THRESH * 100)))
            elif dev > THRESH:
                issues.append(('WARN', '%s %s 从常年的 %s 涨到 %s（+%.0f%%）'
                               % (src, label, _n(med), now, dev * 100)))
    return issues


def _n(x):
    return str(int(x)) if float(x).is_integer() else '%.1f' % x


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-record', action='store_true', help='只体检，不写台账')
    ap.add_argument('--show', action='store_true', help='只打印历史台账')
    ap.add_argument('--data', default=DATA, help='数据目录（默认 ../data，供测试指向别处）')
    args = ap.parse_args()

    runs = load_log()

    if args.show:
        if not runs:
            print('台账是空的：%s' % LOG)
            return 0
        print('台账 %s　共 %d 次' % (LOG, len(runs)))
        for r in runs:
            cells = []
            for s in SOURCES:
                v = r.get('sources', {}).get(s) or {}
                cells.append('%s=%s/%s' % (s, v.get('groups', '?'), v.get('rows', '?')))
            print('  %s  %s' % (r.get('at', '?')[:16], '  '.join(cells)))
        return 0

    cur = collect(args.data)

    print('抓取量体检（groups/rows）')
    for s in SOURCES:
        c = cur[s]
        med_g = median_of(runs, s, 'groups') if len(runs) >= MIN_HIST else None
        med_r = median_of(runs, s, 'rows') if len(runs) >= MIN_HIST else None
        base = ''
        if med_g is not None:
            base = '　基线 %s/%s（近 %d 次中位数）' % (_n(med_g), _n(med_r),
                                                      min(len(runs), WINDOW))
        print('  %-10s %5s / %6s%s' % (s, c.get('groups'), c.get('rows'), base))

    issues = audit(cur, runs)
    fails = [t for lv, t in issues if lv == 'FAIL']
    warns = [t for lv, t in issues if lv == 'WARN']

    if len(runs) < MIN_HIST:
        print('\n基线不足（已有 %d 次，需 %d 次），本次只记录不判断。' % (len(runs), MIN_HIST))

    for t in warns:
        print('\n  ! 注意　' + t, file=sys.stderr)
    for t in fails:
        print('\n  ✗ 异常　' + t, file=sys.stderr)

    if not args.no_record:
        runs.append({
            'at': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
            'sources': {s: {'groups': cur[s].get('groups', 0), 'rows': cur[s].get('rows', 0)}
                        for s in SOURCES},
        })
        save_log(runs)
        print('\n已记入台账 %s（共 %d 次）' % (LOG, len(runs[-KEEP:])))

    if fails:
        print('\n抓取量体检不通过：%d 项异常。' % len(fails), file=sys.stderr)
        return 1
    print('\n抓取量体检通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
