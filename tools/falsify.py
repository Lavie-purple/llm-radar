"""守卫证伪器 —— 「没见过它变红的守卫不算守卫」。

本项目有两条测试层（selftest.js 的 DOM 桩、visual_check.js 的真浏览器）。
新写一条断言之后，必须把**它守护的那段代码拆掉**，确认断言真的变红。
这件事以前每轮手工做，这里把它机械化了。

用法：
    python tools/falsify.py

退出码：
    0  每条用例都被证实「拆掉守护对象就会变红」
    1  有任一情况不成立 —— 具体是下面两种，都会让退出码非零，绝不静默通过：
         · 跳过：锚点字符串在新代码里找不到了（用例腐烂了，必须更新）
         · 仍然全绿：拆了代码测试还是过 → 这条断言是假的，等于没写

⚠️ CASES 是**逐轮维护**的：锚点直接绑在源码字符串上，改了实现就得同步改这里。
   故意让它「找不到锚点就报错」而不是「跳过算过」，就是为了逼人更新，
   而不是让一份过期用例长期假装通过。
"""
import io
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
JS = os.path.join(ROOT, 'scripts', 'radar.js')
CSS = os.path.join(ROOT, 'styles', 'radar.css')
NODE = os.environ.get('NODE_BIN') or 'node'

# (用例名, 目标文件, 原文, 替换成, 跑哪个测试)
CASES = [
    ('悬停提亮改回 1.5（会破坏行内色阶序）',
     CSS, 'tr:hover td.cell { filter: brightness(1.14); }',
     'tr:hover td.cell { filter: brightness(1.5); }', 'visual_check.js'),
    ('不给格子加 flash 类（拆掉被守护的渲染）',
     JS, "+ (isFlash ? ' flash' : '') + '\"'", "+ '\"'", 'visual_check.js'),
    ('给 @keyframes 加显式 to:透明（破坏「to 取自身值」）',
     CSS, '  from { background-color: rgba(56, 189, 248, 0.92); }\n}',
     '  from { background-color: rgba(56, 189, 248, 0.92); }\n'
     '  to { background-color: rgba(0, 0, 0, 0); }\n}', 'visual_check.js'),
    ('去掉「闪过的表作废」（重渲染会重放动画）',
     JS, '    state.flash = {};   // 闪过的这一轮就作废，后续重渲染不再重放\n', '',
     'selftest.js'),
    ('数据重抓判断改回 ===（闪与不闪整体反转）',
     JS, 'prev.gen !== gen', 'prev.gen === gen', 'selftest.js'),
    ('脚注计数被后续渲染抹掉',
     JS, '    if (flashN > 0) state.lastFlash = flashN;',
     '    state.lastFlash = flashN;', 'selftest.js'),
    ('脚注不说明原因',
     JS, '那是相对你上次打开时<b>档位变了</b>的格子', '那是随机高亮', 'selftest.js'),
]


def read(p):
    return io.open(p, encoding='utf-8').read()


def write(p, s):
    io.open(p, 'w', encoding='utf-8').write(s)


def run(tool):
    r = subprocess.run([NODE, 'tools/' + tool], cwd=ROOT, capture_output=True, text=True)
    bad = [l.strip() for l in r.stdout.splitlines()
           if l.startswith('  FAIL ') or l.startswith('  x ')]
    return bad


def main():
    orig = {JS: read(JS), CSS: read(CSS)}
    problems = []
    try:
        for name, path, old, new, tool in CASES:
            src = read(path)
            if old not in src:
                problems.append('%s —— 锚点失效（源码里找不到要改的那段，用例需要更新）' % name)
                print('%-42s  跳过：锚点失效' % name)
                continue
            write(path, src.replace(old, new, 1))
            bad = run(tool)
            if bad:
                print('%-42s  变红 %d 条' % (name, len(bad)))
                for l in bad[:3]:
                    print('        ' + l)
            else:
                problems.append('%s —— 拆掉守护对象后测试仍然全绿，这条断言是假的' % name)
                print('%-42s  ★ 仍然全绿，守卫失效' % name)
            write(JS, orig[JS])
            write(CSS, orig[CSS])
    finally:
        write(JS, orig[JS])
        write(CSS, orig[CSS])

    print()
    print('还原后复跑：')
    ok_all = True
    for t in ['selftest.js', 'visual_check.js']:
        bad = run(t)
        if bad:
            ok_all = False
        print('  %-18s %s' % (t, 'PASS' if not bad else 'FAIL %d 条' % len(bad)))

    print()
    if problems or not ok_all:
        for p in problems:
            print('!! ' + p)
        print('结论：证伪未通过（%d 个问题）' % (len(problems) + (0 if ok_all else 1)))
        return 1
    print('结论：%d 条用例全部被证实「拆掉守护对象就会变红」。' % len(CASES))
    return 0


if __name__ == '__main__':
    sys.exit(main())
