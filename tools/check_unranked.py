"""无名次记录守卫 —— 数据层「每个名次都要能追溯来源」的守门员。

背景（2026-11-14）：LMArena code 榜新进一条「预览版」记录，源站算了 Elo
（1668）却把 rank 置为 null、票数 N/A，而且官方名次序列是 1..17, 18..29
—— 它不占名次。旧代码拿 None 和 int 一起 sort，直接 TypeError 崩掉整条管道。
本站不能按位置补一个假名次（那会把后面 12 个名次全挤错位），所以合成层
必须把「源站没给名次」的行挡在源索引之外。

这里用**注入夹具**直接调 build_lmarena()，不依赖重跑管道、也不依赖当天
源站是否恰好又出现无名次行 —— 活跃路径在「没有无名次行」时根本不执行，
那种守卫全绿也是假的。同时扫一遍 app.json，守住产物里每一个 rank 都是整数。

后来又加了一项产物一致性：页面内嵌的 APP.changes 必须与当天 changes.json
同一基线。管道顺序是 build_app → snapshot，前者读到的永远是上一轮变更报告
（2026-11-14 实测页面显示「基线 10-27→11-02」而数据已是 11-14），
靠 snapshot.py 的 sync_changes_to_app() 回写修正。

收尾汇总「无名次核验：」是 falsify.py 判定「跑完了没」用的，别删。
"""
import copy
import importlib.util
import io
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TOOLS = os.path.join(ROOT, 'tools')
sys.path.insert(0, TOOLS)

fails = 0
total = 0


def check(cond, name, detail=''):
    global fails, total
    total += 1
    print(('  ok   ' if cond else '  FAIL ') + name + ((' — ' + detail) if detail else ''))
    if not cond:
        fails += 1


def load(path):
    return json.load(io.open(path, encoding='utf-8'))


def main():
    spec = importlib.util.spec_from_file_location(
        'build_app_probe', os.path.join(TOOLS, 'build_app.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)          # main() 在 __main__ 保护里，不会跑管道

    # ① 注入夹具：真实源数据 + 一条源站没给名次的记录
    raw = load(os.path.join(ROOT, 'data', 'lmarena.json'))
    probe = copy.deepcopy(raw)
    board = 'code'
    fixture = copy.deepcopy(probe['boards'][board]['rows'][0])
    fixture['rank'] = None
    fixture['model'] = '____UNRANKED_FIXTURE____'
    fixture['displayName'] = fixture['model']
    fixture['votes'] = 'N/A'
    probe['boards'][board]['rows'].insert(5, fixture)

    expected = sum(1 for r in probe['boards'][board]['rows']
                   if isinstance(r.get('rank'), int))
    out = m.build_lmarena(probe)
    got = out[board]['rows']
    check(all(isinstance(r['rank'], int) for r in got),
          '源索引里每一条名次都是整数（无名次行不进索引）',
          '共 %d 行' % len(got))
    check(len(got) == expected,
          '注入的无名次行被过滤，且没误删有名次行',
          '得到 %d / 应有 %d' % (len(got), expected))
    check(expected < len(probe['boards'][board]['rows']),
          '夹具确实制造了无名次行（否则这条守卫是空跑）',
          '%d / %d' % (expected, len(probe['boards'][board]['rows'])))

    # ② 产物不变量：app.json 里每个 rank 都必须是整数
    app = load(os.path.join(ROOT, 'data', 'app.json'))
    n = 0
    bad = []
    for sk, sc in (app.get('subcats') or {}).items():
        for row in sc.get('rows', []):
            for src, v in (row.get('values') or {}).items():
                for rec in [v] + (v.get('sub') or []):
                    n += 1
                    if not isinstance(rec.get('rank'), int):
                        bad.append('%s/%s/%s=%r' % (sk, row.get('id'), src, rec.get('rank')))
    check(n > 0, 'app.json 里扫到了名次字段（不是空扫）', '%d 处' % n)
    check(not bad, '产物里没有非整数名次', ', '.join(bad[:4]))

    # ③ 抓取层可见性：源数据自己要记录有几条无名次行，不做静默改版
    lm = load(os.path.join(ROOT, 'data', 'lmarena.json'))
    check('unrankedRows' in (lm.get('stats') or {}),
          '抓取器把无名次行数写进 stats（不静默）',
          str((lm.get('stats') or {}).get('unrankedRows')))

    # ④ 报警器别被静默掉（10-27 那次 KeyError 的教训）
    src = io.open(os.path.join(TOOLS, 'build_app.py'), encoding='utf-8').read()
    check('数据层错误：子类' in src,
          '合成层保留了无名次的显式报错（不是只靠 TypeError）')

    # ⑤ 变更报告不能慢一轮：APP.changes 必须与当天 changes.json 同一基线、同一计数
    ch = load(os.path.join(ROOT, 'data', 'changes.json'))
    ach = app.get('changes') or {}
    check(ach.get('current') == ch.get('current') and ach.get('previous') == ch.get('previous'),
          '页面内嵌变更报告与 changes.json 同一基线（不是上一轮）',
          'APP=%s→%s / 文件=%s→%s' % (ach.get('previous'), ach.get('current'),
                                     ch.get('previous'), ch.get('current')))
    check(ach.get('summary') == ch.get('summary'),
          '页面内嵌的变更计数也同步',
          '%s / %s' % (ach.get('summary'), ch.get('summary')))
    snap_src = io.open(os.path.join(TOOLS, 'snapshot.py'), encoding='utf-8').read()
    calls = len(re.findall(r'^\s+sync_changes_to_app\(payload\)$', snap_src, re.M))
    check(calls >= 2,
          'snapshot.py 两个分支都保留了变更回写调用（别静默掉）',
          '%d 处' % calls)

    print()
    print('无名次核验：%d 项 ／ FAIL %d' % (total, fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
