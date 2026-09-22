"""守卫证伪器 —— 「没见过它变红的守卫不算守卫」。

本项目有多条测试层（selftest.js 的 DOM 桩、visual_check.js 的真浏览器、
check_deploy.js 的线上部署核验）。新写一条断言之后，必须把**它守护的那段代码拆掉**，
确认断言真的变红。这件事以前每轮手工做，这里把它机械化了。

用法：
    python tools/falsify.py                # 默认只跑不需要联网的用例
    FALSIFY_NET=1 python tools/falsify.py  # 连联网用例一起跑（真浏览器 + 打线上）

退出码：
    0  每条用例都被证实「拆掉守护对象就会变红」
    1  有任一情况不成立 —— 具体是下面三种，都会让退出码非零，绝不静默通过：
         · 跳过：锚点字符串在新代码里找不到了（用例腐烂了，必须更新）
         · 仍然全绿：拆了代码测试还是过 → 这条断言是假的，等于没写
         · 没跑完：被测工具没打出收尾汇总（崩了 / 没起来）→ 这一次不作数。
           必须与上一条**分开报**，否则偶发崩溃会被误读成「守卫是假的」，
           让人去改一条本来没问题的断言。
    2  开跑前体检发现锚点缺失 —— 多半是上一次被强行打断、替换没还原留下的残留。
       这时**不跑**：硬跑只会得到一份「锚点失效」的假报告，掩盖真正的死因。
       130 同 2 的成因，来自信号处理器（收到 Ctrl-C / SIGTERM 时先还原再退出）。

⚠️ CASES 是**逐轮维护**的：锚点直接绑在源码字符串上，改了实现就得同步改这里。
   故意让它「找不到锚点就报错」而不是「跳过算过」，就是为了逼人更新，
   而不是让一份过期用例长期假装通过。
"""
import io
import os
import signal
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
JS = os.path.join(ROOT, 'scripts', 'radar.js')
CSS = os.path.join(ROOT, 'styles', 'radar.css')
# 守卫自己也会写出没信息量的产物（比如把特写截成整屏），所以它也要能被证伪。
VC = os.path.join(ROOT, 'tools', 'visual_check.js')
# 部署守卫（需要联网 + 真浏览器），同样要能被证伪。
CD = os.path.join(ROOT, 'tools', 'check_deploy.js')
NODE = os.environ.get('NODE_BIN') or 'node'
NET = os.environ.get('FALSIFY_NET') == '1'

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

    # ── 「新发布」标识 ────────────────────────────────────────────────
    ('窗口边界含等号（<= 写成 < 会漏掉正第 N 天）',
     JS, 'return d != null && d <= newWindowDays();',
     'return d != null && d < newWindowDays();', 'selftest.js'),
    ('无发布日期当成 0 天（把「不可判」伪装成「今天发布」）',
     JS, 'if (!rd) return null;                        // 源里没有 → 不猜，直接「不可判」',
     'if (!rd) return 0;', 'selftest.js'),
    ('矩阵里不渲染徽章（拆掉被守护的渲染）',
     JS, '+ newBadge(id)', "+ ''", 'selftest.js'),
    ('tooltip 对「源里没日期」沉默（最危险的失败模式）',
     JS, ": 'llm-stats 无此模型') + '</dd>'", ": '—') + '</dd>'", 'selftest.js'),
    ('URL 覆盖窗口失效（?new=NN 全部回落到默认）',
     JS, 'var m = /[?&]new=(\\d{1,4})\\b/.exec(s);', 'var m = null;', 'selftest.js'),
    ('脚注计数写死（筛选后不跟着变）',
     JS, 'var newN = ids.filter(isNewRelease).length;', 'var newN = 8;', 'selftest.js'),
    ('脚注不再声明「没有标记 ≠ 不新」',
     JS, "'<b>没有这个标记不等于模型不新</b> —— llm-stats 里查不到的名字就没有日期，'",
     "''", 'selftest.js'),
    ('徽章宽度撑爆首列（会挤掉模型名）',
     CSS, '  flex: none; font-family: var(--font-body); font-size: 9px; line-height: 1.45;',
     '  flex: none; font-family: var(--font-body); font-size: 9px; line-height: 1.45;\n'
     '  min-width: 60px;', 'visual_check.js'),
    ('徽章不再用 llm-stats 源色（丢掉「颜色即来源」）',
     CSS, '  color: var(--src-ls); border: 1px solid rgba(224, 163, 62, 0.45);',
     '  color: var(--src-lb); border: 1px solid rgba(224, 163, 62, 0.45);',
     'visual_check.js'),
    ('徽章特写不裁剪（退化成与别的截图 md5 相同的整屏图）',
     VC, '        width: b.width + pad * 2,', '        width: 1680,', 'visual_check.js'),
]

# 需要联网 + 真浏览器的用例，默认不跑（每次推完手动开一次就够）。
# 单列一张表而不是加一个第 6 元组字段：默认路径上完全不需要知道它存在。
# 启用：FALSIFY_NET=1 python tools/falsify.py
CASES_NET = [
    ('丢掉 CRLF 归一化（线上比本地每行少 1 字节，会被判成内容不一致）',
     CD, 'const EOL = /\\r\\n/g;', 'const EOL = /ZZZ_NEVER_MATCHES/g;', 'check_deploy.js'),
]


def read(p):
    return io.open(p, encoding='utf-8').read()


def write(p, s):
    io.open(p, 'w', encoding='utf-8').write(s)


# 每个被测工具**末尾必定打印**的收尾汇总，用来判断它到底有没有跑完。
# 没有这个判定会出大问题：「一条 FAIL 都没有」既可能是「拆了守护对象还是全绿」
# （= 这条断言是假的，必须修），也可能是「工具半途崩了/根本没跑起来」（= 结论不作数）。
# 两者混为一谈，就会把「偶发崩溃」误报成「守卫失效」，让人去改一条本来没问题的断言。
SUMMARY = {
    'selftest.js': '／ FAIL ',
    'visual_check.js': '截图目录：',
    'check_deploy.js': '线上核验：',
}


def run(tool):
    r = subprocess.run([NODE, 'tools/' + tool], cwd=ROOT,
                       capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    bad = [l.strip() for l in r.stdout.splitlines()
           if l.startswith('  FAIL ') or l.startswith('  x ')]
    done = SUMMARY[tool] in r.stdout
    return bad, done, r.returncode, r.stdout


def main():
    orig = {JS: read(JS), CSS: read(CSS), VC: read(VC), CD: read(CD)}

    # ⚠️ 这个脚本会**真的改源码**再还原。被 Ctrl-C / SIGTERM 打断时（无 TTY 环境里
    # 超时杀进程也算），`finally` 不保证执行 —— 于是替换留在源码里没人还原。
    # 后果很阴：下次跑会报一串「锚点失效」，把「上次被打断」伪装成「用例过期」。
    # 所以加两道防护：① 信号处理器里立刻还原；② 开跑前先体检锚点，缺了就拒绝开跑。
    def restore(*_a):
        for p, s in orig.items():
            try:
                if read(p) != s:
                    write(p, s)
            except Exception:
                pass
    for _sig in ('SIGINT', 'SIGTERM', 'SIGBREAK'):
        _h = getattr(signal, _sig, None)
        if _h is None:
            continue
        try:
            signal.signal(_h, lambda *_a: (restore(), sys.exit(130)))
        except Exception:
            pass

    stale = [name for name, path, old, _new, _t in (CASES + CASES_NET) if old not in orig[path]]
    if stale:
        print('!! 开跑前体检不通过：%d 条用例的锚点在源码里找不到。' % len(stale))
        for name in stale:
            print('   · ' + name)
        print('   若上一次 falsify 是被强行打断的，源码里可能残留着没还原的替换。')
        print('   先修源码再跑 —— 直接继续只会得到一份「锚点失效」的假报告。')
        return 2

    problems = []
    cases = CASES + (CASES_NET if NET else [])
    if not NET and CASES_NET:
        print('  跳过 %d 条联网用例（要联网 + 真浏览器，设 FALSIFY_NET=1 启用）：' % len(CASES_NET))
        for name in [c[0] for c in CASES_NET]:
            print('    · ' + name)
        print()
    try:
        for name, path, old, new, tool in cases:
            src = read(path)
            if old not in src:
                problems.append('%s —— 锚点失效（源码里找不到要改的那段，用例需要更新）' % name)
                print('%-42s  跳过：锚点失效' % name)
                continue
            write(path, src.replace(old, new, 1))
            bad, done, rc, out = run(tool)
            if not done:
                # 关键区分：没跑完 ≠ 守卫是假的。这一条不作数，也不算通过。
                lastline = (out.strip().splitlines() or ['(无输出)'])[-1][:130]
                problems.append('%s —— 被测工具没跑完（returncode=%s，未见收尾汇总），'
                                '这一次的结论不作数' % (name, rc))
                print('%-42s  ★ 没跑完（returncode=%s），无法判定' % (name, rc))
                print('        末行：' + lastline)
            elif bad:
                print('%-42s  变红 %d 条' % (name, len(bad)))
                for l in bad[:3]:
                    print('        ' + l)
            else:
                problems.append('%s —— 拆掉守护对象后测试仍然全绿，这条断言是假的' % name)
                print('%-42s  ★ 仍然全绿，守卫失效' % name)
            restore()
    finally:
        restore()

    print()
    print('还原后复跑：')
    ok_all = True
    for t in ['selftest.js', 'visual_check.js']:
        bad, done, rc, _out = run(t)
        if bad or not done:
            ok_all = False
        print('  %-18s %s' % (t, 'PASS' if not bad and done else
                              ('没跑完(rc=%s)' % rc if not done else 'FAIL %d 条' % len(bad))))

    print()
    if problems or not ok_all:
        for p in problems:
            print('!! ' + p)
        print('结论：证伪未通过（%d 个问题）' % (len(problems) + (0 if ok_all else 1)))
        return 1
    print('结论：%d 条用例全部被证实「拆掉守护对象就会变红」。' % len(cases))
    return 0


if __name__ == '__main__':
    sys.exit(main())
