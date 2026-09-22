# -*- coding: utf-8 -*-
"""把四源原始数据合并成前端消费的统一结构 data/app.json。

设计原则（来自需求盘问的裁决）
------------------------------
1. **绝不合成总分**：每个格只放某个源自己的原始分与该源自己的名次。
2. **源内各自比**：跨源分歧度用「源内百分位」，不做量纲换算。
3. **主指标按大类定义**，其余源作为交叉校验列并列展示。
4. **单源子类显式标注**，分歧度留 null。
5. 名次是唯一跨量纲可比的量，矩阵用名次；原始分放进 tooltip 与详情表。

用法：python tools/build_app.py [--top 30]
"""
import json, io, os, sys, re, argparse, datetime
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from normalize import canonical, normalize_name

DATA = os.path.join(HERE, '..', 'data')

# 「新发布」标识的时间窗口（天）。这是**默认值**，前端可以用 ?new=NN 覆盖它。
# 依据：日经 2026-09-21 实测，中美 9 家头部厂商「高性能模型」的平均更新间隔
# 已从 2023-01~2026-03 的 125 天缩短到 2026-04~09 的 44 天。窗口取 45 天
# ≈ 一个「发布代际」。取 30 天会系统性漏掉迭代慢的厂商 —— 本库实测各家自己的
# 相邻发布间隔中位：Alibaba 19 / Meta 21 / Google 30 / OpenAI 34 / Anthropic 42 /
# Zhipu 50 / Mistral 52 / DeepSeek 63 / xAI 71 天，>30 的那几家旗舰永远压不进窗口。
NEW_WINDOW_DAYS = 45


# --------------------------------------------------------------------------
# 分类规格：6 大类 / 12 子类 + 通用能力
# 每个子类的 cols = [(源, 该源内的键, 显示标签, 单位)]
#   源 lmarena  -> 键为榜路由名
#   源 llmstats -> 键为分类名
#   源 aa       -> 键为字段名
#   源 livebench-> 键为 'overall' 或类别名
# --------------------------------------------------------------------------
CATEGORIES = [
    {
        "key": "chat", "label": "Chat 对话", "sub": "你会拿到一段回答",
        "tolerance": "宽容", "toleranceNote": "答得不好顶多换个模型重问，不会造成损失",
        "subcats": [
            {"key": "chat.text", "label": "文本对话", "primary": "lmarena", "tolerance": "宽容",
             "question": "纯文本一问一答，谁最让人愿意继续用",
             "cols": [("lmarena", "text", "Arena Elo", "elo", "官方默认视图，自 2025-05-16 起即 style-controlled"),
                      ("llmstats", "chat", "LLM Stats Score", "score", "TrueSkill μ−3σ"),
                      ("aa", "intelligenceIndex", "Intelligence Index", "index", "")]},
            {"key": "chat.search", "label": "搜索增强", "primary": "lmarena", "tolerance": "零容忍",
             "question": "带联网检索的问答，答案是否可靠",
             "cols": [("lmarena", "search", "Arena Elo", "elo", ""),
                      ("llmstats", "search", "LLM Stats Score", "score", "")]},
            {"key": "chat.vision", "label": "视觉多模态", "primary": "lmarena", "tolerance": "宽容",
             "question": "看懂你贴的截图、照片、界面",
             "cols": [("lmarena", "vision", "Arena Elo", "elo", ""),
                      ("llmstats", "vision", "LLM Stats Score", "score", ""),
                      ("aa", "mmmuPro", "MMMU-Pro", "pct", "")]},
            {"key": "chat.document", "label": "文档理解", "primary": "lmarena", "tolerance": "零容忍",
             "question": "长 PDF、长文档的信息提取",
             "cols": [("lmarena", "document", "Arena Elo", "elo", ""),
                      ("llmstats", "long_context", "LLM Stats Score", "score", "llm-stats 以长上下文类目代理"),
                      ("aa", "lcr", "AA-LCR", "pct", "")]},
        ],
    },
    {
        "key": "general", "label": "通用能力", "sub": "一份基准分", "newly": True,
        "tolerance": "零容忍",
        "toleranceNote": "基准分低意味着能力上限低，会直接影响其他所有维度",
        "subcats": [
            {"key": "general.overall", "label": "综合", "primary": "livebench", "tolerance": "零容忍",
             "question": "三个「最重要指标」并排：客观题总分 / 独立指数 / 聚合分",
             "cols": [("livebench", "overall", "LiveBench Overall", "pct", "7 类等权平均，全客观判分"),
                      ("aa", "intelligenceIndex", "AA Intelligence Index", "index", ""),
                      ("llmstats", "general", "LLM Stats Score", "score", "聚合层，反映公开 benchmark 覆盖密度")]},
            {"key": "general.if", "label": "指令遵循", "primary": "livebench", "tolerance": "零容忍",
             "question": "严格按要求格式、字数、条件输出",
             "cols": [("livebench", "Instruction Following", "LiveBench IF", "pct", ""),
                      ("llmstats", "instruction_following", "LLM Stats Score", "score", ""),
                      ("aa", "ifbench", "IFBench", "pct", "")]},
            {"key": "general.reasoning", "label": "推理", "primary": "llmstats", "tolerance": "零容忍",
             "question": "复杂多步推理",
             "cols": [("llmstats", "reasoning", "LLM Stats Score", "score", ""),
                      ("aa", "hle", "HLE", "pct", "Humanity's Last Exam"),
                      ("aa", "gpqa", "GPQA Diamond", "pct", "")]},
            {"key": "general.math", "label": "数学", "primary": "livebench", "tolerance": "零容忍",
             "question": "数学与竞赛题",
             "cols": [("livebench", "Mathematics", "LiveBench Math", "pct", "注意：该列已接近饱和，区分度低"),
                      ("llmstats", "math", "LLM Stats Score", "score", ""),
                      ("aa", "critpt", "CritPt", "pct", "")]},
            {"key": "general.hallucination", "label": "幻觉控制", "primary": "aa", "tolerance": "零容忍",
             "question": "不知道时是否老实说不知道",
             "cols": [("aa", "omniscienceNonHallucination", "非幻觉率", "pct", "越高越好"),
                      ("aa", "omniscienceAccuracy", "AA-Omniscience 准确率", "pct", "")]},
        ],
    },
    {
        "key": "code", "label": "Code 代码", "sub": "一个网页 / 一段代码",
        "tolerance": "零容忍", "toleranceNote": "代码错就是错，无法用风格弥补",
        "subcats": [
            {"key": "code.webdev", "label": "前端开发（vibe coding）", "primary": "lmarena", "tolerance": "零容忍",
             "question": "直接产出能跑的页面——这是 vibe coding 唯一对口的信号",
             "cols": [("lmarena", "code", "WebDev Arena Elo", "elo", ""),
                      ("llmstats", "frontend_development", "LLM Stats Score", "score", "llm-stats 自建的前端开发类目"),
                      ("aa", "terminalBench21", "Terminal-Bench", "pct", "终端任务，不等于页面产出，仅作交叉校验")]},
            {"key": "code.img2web", "label": "图生网页", "primary": "lmarena", "tolerance": "零容忍",
             "question": "给一张设计图，直接还原成网页",
             "cols": [("lmarena", "image-to-webdev", "Arena Elo", "elo", "")]},
        ],
    },
    {
        "key": "agent", "label": "Agent 智能体", "sub": "一个完成的任务",
        "tolerance": "零容忍", "toleranceNote": "自主执行出错代价最高",
        "headline": {"source": "lmarena", "board": "agent", "label": "净改善度 Net Improvement",
                     "unit": "pct",
                     "note": "相比基线模型在复杂多步规划 / 工具调用 / 浏览器自动化上的解决成功率提升幅度，可为负。"},
        "subcats": [
            {"key": "agent.work", "label": "真实工作任务", "primary": "lmarena", "tolerance": "零容忍",
             "question": "交给它一个完整任务，能否自主跑完",
             "cols": [("lmarena", "agent", "净改善度", "pct", ""),
                      ("aa", "gdpvalNormalized", "GDPval-AA", "pct", "归一化到人类专家水平，100% = 人类专家同等产出"),
                      ("llmstats", "agents", "LLM Stats Score", "score", ""),
                      ("aa", "terminalBench40", "Terminal-Bench 4.0", "pct", "")]},
        ],
    },
    {
        "key": "image", "label": "Image 图像", "sub": "一张图",
        "tolerance": "宽容", "toleranceNote": "不满意重出一张即可",
        "subcats": [
            {"key": "image.t2i", "label": "文生图", "primary": "lmarena", "tolerance": "宽容",
             "question": "用文字描述生成图片",
             "cols": [("lmarena", "text-to-image", "Arena Elo", "elo", "")]},
            {"key": "image.edit", "label": "图像编辑", "primary": "lmarena", "tolerance": "宽容",
             "question": "对已有图片做局部修改",
             "cols": [("lmarena", "image-edit", "Arena Elo", "elo", "")]},
        ],
    },
    {
        "key": "video", "label": "Video 视频", "sub": "一段视频",
        "tolerance": "宽容", "toleranceNote": "生成成本高但错了只是重来",
        "subcats": [
            {"key": "video.t2v", "label": "文生视频", "primary": "lmarena", "tolerance": "宽容",
             "question": "用文字描述生成视频",
             "cols": [("lmarena", "text-to-video", "Arena Elo", "elo", "")]},
            {"key": "video.i2v", "label": "图生视频", "primary": "lmarena", "tolerance": "宽容",
             "question": "让一张静态图动起来",
             "cols": [("lmarena", "image-to-video", "Arena Elo", "elo", "")]},
            {"key": "video.edit", "label": "视频编辑", "primary": "lmarena", "tolerance": "宽容",
             "question": "对已有视频做修改",
             "cols": [("lmarena", "video-edit", "Arena Elo", "elo", "")]},
        ],
    },
]

# 源元信息
SOURCE_META = {
    "lmarena":  {"label": "LMArena", "short": "LMArena", "color": "#FF5A1F",
                 "url": "https://lmarena.ai/", "scale": "12 榜 / 340 行"},
    "aa":       {"label": "Artificial Analysis", "short": "AA", "color": "#38BDF8",
                 "url": "https://artificialanalysis.ai/", "scale": "272 模型"},
    "llmstats": {"label": "llm-stats", "short": "LLM-Stats", "color": "#A78BFA",
                 "url": "https://llm-stats.com/", "scale": "392 模型 / 55 分类"},
    "livebench":{"label": "LiveBench", "short": "LiveBench", "color": "#34D399",
                 "url": "https://livebench.ai/", "scale": "58 模型 / 7 类"},
}


def load(n):
    return json.load(io.open(os.path.join(DATA, n + '.json'), encoding='utf-8'))


def num(v):
    """AA 的 RSC payload 里会出现 '$undefined' 之类字符串，统一挡掉。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


# 单位口径（前端按此决定是否 ×100）：
#   pct     —— 0~1 的小数，展示时 ×100 加 %
#   pct100  —— 已经是 0~100 的百分数，展示时直接加 %
#   elo / index / score —— 原样展示
UNIT_FIX = {
    # LMArena 的 agent 榜 score 直接就是百分数（13.71 表示 13.71%），不是 0~1
    ("lmarena", "pct"): "pct100",
    # LiveBench 的 overall 与各类别均为 0~100
    ("livebench", "pct"): "pct100",
}


# --------------------------------------------------------------------------
# 各源索引构建
# --------------------------------------------------------------------------
def build_lmarena(raw):
    """返回 boards[board] = {total, updated, rows:[{id,...}]}"""
    out = {}
    for b, v in raw['boards'].items():
        rows = []
        for r in v['rows']:
            fid, variant = canonical(r['model'])
            rows.append({
                "id": fid,
                "raw": r['model'],
                "display": normalize_name(r.get('displayName') or r['model']),
                "variant": variant,
                "vendor": r.get('vendor'),
                "license": r.get('license'),
                "country": r.get('country'),
                "rank": r.get('rank'),
                "score": r.get('score'),
                "ci": r.get('scoreCi'),
                "votes": r.get('votes'),
                "rankSpread": r.get('rankSpread'),
                "priceIn": r.get('priceIn'),
                "priceOut": r.get('priceOut'),
                "context": r.get('context'),
                "openrouterId": r.get('openrouterId'),
                "detailSlug": r.get('detailSlug'),
                "extra": r.get('extra') or {},
            })
        out[b] = {"total": v.get('fullCount') or len(rows),
                  "updated": v.get('sourceUpdated'),
                  "unit": v.get('unit'),
                  "label": v.get('label'),
                  "sourceUrl": v.get('sourceUrl'),
                  "rows": rows}
    return out


AA_EFFORT_RANK = {'max': 6, 'xhigh': 5, 'x-high': 5, 'high': 4, 'medium': 3, 'low': 2,
                  'non-reasoning': 1, '': 0}

def build_aa(raw):
    """返回 (by_family, all_variants)。family -> 代表条目（intelligenceIndex 最高）。"""
    fams = defaultdict(list)
    for m in raw['models']:
        fid, _ = canonical(m['name'])
        fams[fid].append(m)
    by_family, allv = {}, {}
    for fid, ms in fams.items():
        def keyf(m):
            ii = num(m.get('intelligenceIndex'))
            eff = (m.get('effort') or '').lower() if isinstance(m.get('effort'), str) else ''
            return ((ii if ii is not None else -1), AA_EFFORT_RANK.get(eff, 0))
        ms_sorted = sorted(ms, key=keyf, reverse=True)
        by_family[fid] = ms_sorted[0]
        allv[fid] = [{"effort": (m.get('effort') if isinstance(m.get('effort'), str) else None),
                      "intelligenceIndex": num(m.get('intelligenceIndex')),
                      "isOpenWeights": m.get('isOpenWeights'),
                      "gdpvalNormalized": num(m.get('gdpvalNormalized')),
                      "price1mInputTokens": num(m.get('price1mInputTokens')),
                      "price1mOutputTokens": num(m.get('price1mOutputTokens'))} for m in ms_sorted]
    return by_family, allv


def build_llmstats(raw):
    """返回 idx[cat] = {total, rows:[{id, rank, value, mu, sigma, games, delta}]}"""
    idx = {}
    for cat, v in raw['indexes'].items():
        rows = []
        for r in v['rows']:
            fid, _ = canonical(r['model_name'])
            rows.append({"id": fid, "name": r['model_name'], "rank": r['rank'],
                         "value": r['conservative'], "mu": r['mu'], "sigma": r['sigma'],
                         "games": r.get('games_played'), "delta14d": r.get('rank_delta_14d')})
        idx[cat] = {"total": v['count'], "rows": rows}
    return idx


def build_livebench(raw):
    """返回 {by_family, totals}"""
    fams = defaultdict(list)
    for m in raw['models']:
        fid, _ = canonical(m['model'])
        fams[fid].append(m)
    by_family = {}
    for fid, ms in fams.items():
        ms.sort(key=lambda m: (m.get('overall') or -1), reverse=True)
        by_family[fid] = ms[0]
    return by_family


def lb_value(m, key):
    if not m:
        return None
    if key == 'overall':
        return m.get('overall')
    return (m.get('categories') or {}).get(key)


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=30, help='每个子类取前 N 名参与矩阵')
    args = ap.parse_args()

    lm_raw, aa_raw, ls_raw, lb_raw = (load('lmarena'), load('aa'),
                                      load('llmstats'), load('livebench'))
    lm = build_lmarena(lm_raw)
    aa_fam, aa_all = build_aa(aa_raw)
    ls = build_llmstats(ls_raw)
    lb = build_livebench(lb_raw)

    # 注：AA 与 LiveBench 的 total 现在都在各自分支里取 len(ranked)，
    # 不再预先统计"原始条目数"（那会把同家族的多个推理变体重复计入分母）。

    # ============ 逐子类装配 ============
    subcats, models, order = {}, {}, []
    seen_order = set()

    # 命名来源优先级：LMArena（已是干净展示名）> AA > llm-stats > LiveBench
    NAME_PRIORITY = {"lmarena": 4, "aa": 3, "llmstats": 2, "livebench": 1}

    def ensure_model(fid, src=None, **kw):
        if fid not in models:
            models[fid] = {"id": fid, "name": None, "vendor": None, "open": None,
                           "openBy": [], "country": None, "context": None,
                           "price": {}, "speed": {}, "extra": {},
                           "links": {}, "cells": {}, "seenIn": [],
                           "_np": -1, "_vp": -1}
        m = models[fid]
        prio = NAME_PRIORITY.get(src, 0)
        for k, v in kw.items():
            if v is None or v == '':
                continue
            if k == 'open':
                if v and not m['open']:
                    m['open'] = True
                continue
            if k == 'openBy':
                if v and v not in m['openBy']:
                    m['openBy'].append(v)
                continue
            if k == 'name':
                if prio > m['_np']:
                    m['name'], m['_np'] = v, prio
                continue
            if k == 'vendor':
                if prio > m['_vp']:
                    m['vendor'], m['_vp'] = v, prio
                continue
            if not m.get(k):
                m[k] = v
        return m

    src_presence = defaultdict(set)   # fid -> {subcat}
    _sub_index = {}

    for cat in CATEGORIES:
        for sc in cat['subcats']:
            key = sc['key']
            srcs, values = [], {}
            src_meta = []

            # ---- 逐源取行 ----
            for (skey, sk, label, unit, note) in sc['cols']:
                unit = UNIT_FIX.get((skey, unit), unit)
                if skey == 'lmarena':
                    b = lm.get(sk)
                    if not b:
                        continue
                    total = b['total']
                    value, src_meta = {}, []
                    for r in b['rows'][:args.top]:
                        rec = {"rank": r['rank'], "value": r['score'], "ci": r['ci'],
                               "votes": r['votes'], "spread": r['rankSpread'],
                               "variant": r['variant'], "raw": r['raw'],
                               "total": total, "unit": unit,
                               "extra": r['extra'], "label": label}
                        prev = value.get(r['id'])
                        if prev is None:
                            value[r['id']] = rec
                        else:
                            # 同一榜内同家族的多个推理强度变体：保留名次更好的那个，
                            # 并把另一个记为备选，避免"较优名次被后写的差名次覆盖"。
                            alt = prev.get('alts', [])
                            alt.append({"rank": rec['rank'], "variant": rec['variant'],
                                        "raw": rec['raw'], "value": rec['value']})
                            if rec['rank'] < prev['rank']:
                                rec['alts'] = prev.get('alts', []) + [
                                    {"rank": prev['rank'], "variant": prev['variant'],
                                     "raw": prev['raw'], "value": prev['value']}]
                                value[r['id']] = rec
                            else:
                                prev['alts'] = alt
                        ensure_model(r['id'], src='lmarena', name=r['display'], vendor=r['vendor'],
                                     country=r['country'], context=r['context'],
                                     open=(r['license'] == 'open'),
                                     openBy=(['lmarena'] if r['license'] == 'open' else []))
                        mm = models[r['id']]
                        if r.get('priceIn'):
                            mm['price'].setdefault('in', r['priceIn'])
                            mm['price'].setdefault('out', r['priceOut'])
                        if r.get('openrouterId'):
                            mm['links'].setdefault('openrouter', 'https://openrouter.ai/' + r['openrouterId'])
                        if r.get('detailSlug'):
                            mm['links'].setdefault('detail', 'https://arena.atease.dev/models/%s/' % r['detailSlug'])
                    entry = {"key": skey, "label": label, "unit": unit, "note": note or "",
                             "total": total, "updated": b.get('updated'),
                             "sourceUrl": b.get('sourceUrl'),
                             "values": value}
                    srcs.append(entry)

                elif skey == 'llmstats':
                    b = ls.get(sk)
                    if not b or not b['rows']:
                        continue
                    total = b['total']
                    value = {}
                    for r in b['rows'][:max(args.top, 50)]:
                        value.setdefault(r['id'], {"rank": r['rank'], "value": r['value'],
                                                   "mu": r['mu'], "sigma": r['sigma'],
                                                   "games": r['games'], "delta14d": r['delta14d'],
                                                   "raw": r['name'], "name": r['name'],
                                                   "total": total, "unit": unit, "label": label})
                        ensure_model(r['id'], src='llmstats', name=r['name'])
                    srcs.append({"key": skey, "label": label, "unit": unit, "note": note or "",
                                 "total": total, "updated": ls_raw.get('fetchedAt'),
                                 "sourceUrl": "https://llm-stats.com/", "values": value})

                elif skey == 'aa':
                    # 在全部 AA 模型（已按家族去重）里按该字段排名
                    ranked = sorted([(fid, num(m.get(sk))) for fid, m in aa_fam.items()
                                     if num(m.get(sk)) is not None],
                                    key=lambda t: -t[1])
                    # total 用「实际参与排名的家族数」。原先用 aa_totals（原始条目数，
                    # 含同一家族的多个推理强度变体），会让 "#5 / 262" 的分母虚高、
                    # 并连带把 srcPct 算小。
                    total = len(ranked)
                    if not total:
                        continue
                    value = {}
                    for i, (fid, v) in enumerate(ranked, 1):
                        m = aa_fam[fid]
                        eff = m.get('effort') if isinstance(m.get('effort'), str) else None
                        value[fid] = {"rank": i, "value": round(v, 4), "total": total,
                                      "unit": unit, "label": label, "variant": eff,
                                      "raw": m.get('name')}
                        ensure_model(fid, src='aa', name=normalize_name(m.get('name')), vendor=m.get('modelCreatorName'),
                                     context=m.get('contextWindowTokens'),
                                     open=bool(m.get('isOpenWeights')),
                                     openBy=(['aa'] if m.get('isOpenWeights') else []))
                        mm = models[fid]
                        if num(m.get('price1mInputTokens')) is not None:
                            mm['price'].setdefault('in', num(m['price1mInputTokens']))
                            mm['price'].setdefault('out', num(m.get('price1mOutputTokens')))
                        for f, dst in (('medianOutputTokensPerSecond', 'tps'),
                                       ('medianTimeToFirstTokenSeconds', 'ttft'),
                                       ('medianTimeToFirstAnswerTokenSeconds', 'ttfa'),
                                       ('medianEndToEndResponseTimeSeconds', 'e2e')):
                            if num(m.get(f)) is not None:
                                mm['speed'][dst] = round(num(m[f]), 2)
                    srcs.append({"key": skey, "label": label, "unit": unit, "note": note or "",
                                 "total": total, "updated": aa_raw.get('fetchedAt'),
                                 "sourceUrl": "https://artificialanalysis.ai/", "values": value})

                elif skey == 'livebench':
                    ranked = sorted([(fid, num(lb_value(m, sk))) for fid, m in lb.items()
                                     if num(lb_value(m, sk)) is not None],
                                    key=lambda t: -t[1])
                    # 同 AA：用实际参与排名的家族数，不用原始条目数
                    total = len(ranked)
                    if not total:
                        continue
                    value = {}
                    for i, (fid, v) in enumerate(ranked, 1):
                        m = lb[fid]
                        value[fid] = {"rank": i, "value": round(v, 4), "total": total,
                                      "unit": unit, "label": label, "raw": m.get('model')}
                        for f, dst in (('costPerTask', 'lbCostTask'),
                                       ('costPerSuccessfulTask', 'lbCostSucc')):
                            if num(m.get(f)) is not None:
                                ensure_model(fid, src='livebench', name=normalize_name(m.get('model')))
                                models[fid]['extra'][dst] = round(num(m[f]), 4)
                    srcs.append({"key": skey, "label": label, "unit": unit, "note": note or "",
                                 "total": total, "updated": lb_raw.get('fetchedAt'),
                                 "sourceUrl": "https://livebench.ai/", "values": value})

            if not srcs:
                continue

            # ---- 合并成行 ----
            primary_entry = next((s for s in srcs if s['key'] == sc['primary']), srcs[0])
            ids = list(primary_entry['values'].keys())[:args.top]
            rows = []
            for fid in ids:
                vals = {}
                for s in srcs:
                    vv = s['values'].get(fid)
                    if not vv:
                        continue
                    k = s['key']
                    if k in vals:
                        # 同一源在同一子类有多个指标列（如 AA 的 HLE / GPQA、agent 的 GDPval / Terminal-Bench 4.0）。
                        # 第一列作为该源的代表（决定名次），其余收进 sub，避免后写的列把代表覆盖掉。
                        vals[k].setdefault('sub', []).append({
                            "label": vv["label"], "value": vv["value"], "unit": vv["unit"],
                            "rank": vv["rank"], "total": vv["total"]})
                    else:
                        vals[k] = vv
                if not vals:
                    continue
                mm = models[fid]
                mm['cells'][key] = {"values": vals, "diverge": None}
                if key not in mm['seenIn']:
                    mm['seenIn'].append(key)
                rows.append({"id": fid, "name": mm['name'] or fid, "vendor": mm['vendor'],
                             "open": bool(mm['open']), "values": vals, "diverge": None,
                             "primaryRank": primary_entry['values'][fid]['rank']})
            rows.sort(key=lambda r: r['primaryRank'])

            distinct = list(dict.fromkeys(s['key'] for s in srcs))

            # ---- 排名深度：色阶与分歧度共用的分母 ----
            # 只统计「实际展示出来的这些行」里各源最深的名次。
            #
            # 为什么不用「展示行数」：同家族多推理变体合并后行数少于名次上限
            # （实测 chat.text 展示 26 行但名次排到 30），(rank-1)/(n-1) 会 > 1，
            # 被 clamp 成 0，分歧度和色阶一起失真。
            #
            # 为什么不用「该源的完整排名集合」：AA / LiveBench / llm-stats 的完整集合
            # 是全榜规模（实测 183 / 56 / 363），但本页只展示前 30 —— 那样整列只会
            # 用到 47~100 这一小段，颜色又塌了。
            #
            # 为什么不用「榜总数」：LMArena 文本榜 402 个模型，前 30 名的真·源内
            # 百分位全落在 92.8~100，整列会是一个颜色。
            #
            # 用排名深度做分母：rank 1 → 100、本列最深名次 → 0，跨列尺度一致。
            # 「对全榜的百分位」不丢掉，另存 srcPct 供 tooltip / 详情表显示。
            src_depth = {}
            for r in rows:
                for kk, vv in r['values'].items():
                    rk = vv.get('rank')
                    if rk is not None:
                        src_depth[kk] = max(src_depth.get(kk, 0), rk)

            # ---- 分歧度 ----
            # 用「源内名次百分位」而不是「源内绝对百分位」：
            # LMArena text 榜有 402 个模型，rank 1 与 rank 30 的绝对百分位只差 7 点，
            # 那样算出来的分歧度会被大盘稀释到失去意义。
            # 这里以「本源在本子类的排名深度」为分母（见上方 src_depth 注释）：
            # pct = 100 * (1 - (rank-1)/(n-1))，rank1 -> 100，本列最深名次 -> 0。
            # 语义即用户直觉："在一个源的榜上它是头部，在另一个源上是尾部"。
            def pct_of(src_key, v):
                n = src_depth.get(src_key, 1)
                if n <= 1 or v.get('rank') is None:
                    return None
                return max(0.0, min(100.0, 100.0 * (1 - (v['rank'] - 1) / (n - 1))))

            def board_pct(v):
                """对全榜的真·源内百分位。只作展示，不参与上色。"""
                t = v.get('total') or 0
                if t <= 1 or v.get('rank') is None:
                    return None
                return max(0.0, min(100.0, 100.0 * (1 - (v['rank'] - 1) / (t - 1))))

            for r in rows:
                pcts = [pct_of(k, r['values'][k]) for k in distinct if k in r['values']]
                pcts = [p for p in pcts if p is not None]
                d = round(max(pcts) - min(pcts), 1) if len(pcts) >= 2 else None
                r['diverge'] = d
                models[r['id']]['cells'][key]['diverge'] = d
                # 给每个值补两个百分位：colPct 上色用（列内相对位置），srcPct 展示用（对全榜）
                for kk, vv in r['values'].items():
                    cp = pct_of(kk, vv)
                    vv['colPct'] = round(cp, 1) if cp is not None else None
                    bp = board_pct(vv)
                    vv['srcPct'] = round(bp, 1) if bp is not None else None
                    for sbn in (vv.get('sub') or []):
                        sp = pct_of(kk, sbn)
                        sbn['colPct'] = round(sp, 1) if sp is not None else None
                        sbp = board_pct(sbn)
                        sbn['srcPct'] = round(sbp, 1) if sbp is not None else None
            subcats[key] = {
                "key": key, "cat": cat['key'], "label": sc['label'],
                "tolerance": sc['tolerance'], "question": sc['question'],
                "primary": primary_entry['key'],
                "singleSource": len(distinct) == 1,
                "distinctSources": distinct,
                "sources": [{k: s[k] for k in ('key', 'label', 'unit', 'note', 'total',
                                               'updated', 'sourceUrl')} for s in srcs],
                "rows": rows,
            }
            for r in rows:
                if r['id'] not in seen_order:
                    seen_order.add(r['id'])
                    order.append(r['id'])

    # ============ 排序：覆盖广度优先 ============
    order.sort(key=lambda fid: (-len(models[fid]['seenIn']),
                                models[fid]['name'] or fid))
    models = {k: models[k] for k in order}

    # 矩阵候选：出现在 >=2 个子类，或在任一子类进前 10。
    # 只进单榜且排名靠后的模型留在「大类详情表」里，不污染矩阵。
    matrix_ids = []
    for fid in order:
        m = models[fid]
        cov = len(m['seenIn'])
        best = min((c['values'][sc['primary']]['rank']
                    for sc, c in ((subcats[k], m['cells'][k]) for k in m['seenIn'])),
                   default=999)
        m['coverage'] = cov
        m['bestRank'] = best
        if cov >= 2 or best <= 10:
            matrix_ids.append(fid)

    # ============ 发布日期（「新发布」标识的唯一依据）============
    # 只有 llm-stats 提供 release_date（见 fetch_llmstats.py 的 MODEL_FIELDS），
    # 所以这个标识天然继承它的局限：源里查不到的名字就没有日期，也就不给标识。
    # 键一律走项目自己的 canonical()，与上面 ensure_model 的口径同源；
    # **不做模糊匹配** —— 实测 Veo 3≈o3(0.67)、Qwen 3.8≈Qwen3.5-0.8B(0.80)、
    # Seedream 5.0 Pro≈Seed 2.0 Pro(0.73)：名字像，但根本不是一个东西，
    # 自动匹配会给模型安上别人的发布日期。宁可没有标识。
    rel_map = {}
    for r in ls_raw.get('models', []):
        rd = r.get('release_date')
        if not rd:
            continue
        for cand in (r.get('name'), r.get('model_id')):
            if not cand:
                continue
            fid, _ = canonical(cand)
            if fid and fid != 'unknown':
                rel_map.setdefault(fid, rd)
    n_released = 0
    for mm in models.values():
        rd = rel_map.get(mm['id'])
        if rd:
            mm['releasedAt'] = rd
            n_released += 1

    # 补 blended 单价（1k 输入 + 1k 输出）——chat 维的成本口径
    for m in models.values():
        p = m.get('price') or {}
        if p.get('in') is not None and p.get('out') is not None:
            p['blended1k'] = round((p['in'] + p['out']) / 1000.0, 6)

    # ============ 变更 ============
    try:
        ch = load('changes')
    except Exception:
        ch = {"hasBaseline": False}

    app = {
        "generatedAt": datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
        "topN": args.top,
        "sources": [dict(SOURCE_META[k], key=k,
                         fetchedAt={"lmarena": lm_raw.get('fetchedAt'),
                                    "aa": aa_raw.get('fetchedAt'),
                                    "llmstats": ls_raw.get('fetchedAt'),
                                    "livebench": lb_raw.get('fetchedAt')}[k],
                         note={"lmarena": lm_raw['source'].get('note'),
                               "aa": aa_raw['source'].get('note'),
                               "llmstats": ls_raw['source'].get('note'),
                               "livebench": lb_raw['source'].get('note')}[k])
                    for k in ("lmarena", "aa", "llmstats", "livebench")],
        "categories": [{"key": c['key'], "label": c['label'], "sub": c['sub'],
                        "tolerance": c['tolerance'], "toleranceNote": c.get('toleranceNote'),
                        "newly": c.get('newly', False),
                        "headline": c.get('headline'),
                        "subcats": [s['key'] for s in c['subcats']]} for c in CATEGORIES],
        "subcats": subcats,
        "models": models,
        "order": order,
        "matrixIds": matrix_ids,
        "changes": ch,
        "newWindowDays": NEW_WINDOW_DAYS,
    }

    # —— 模型库只保留出现在子类行里的（其余是仅作校验用的）——
    keep = set()
    for sc in subcats.values():
        for r in sc['rows']:
            keep.add(r['id'])
    for fid in list(app['models']):
        if fid not in keep:
            del app['models'][fid]
        else:
            mm = app['models'][fid]
            mm.pop('_np', None)
            mm.pop('_vp', None)
            if mm['open'] is None:
                mm['open'] = False
    app['order'] = [f for f in app['order'] if f in keep]
    app['matrixIds'] = [f for f in app['matrixIds'] if f in keep]

    out = os.path.join(DATA, 'app.json')
    payload = json.dumps(app, ensure_ascii=False, separators=(',', ':'))
    io.open(out, 'w', encoding='utf-8').write(payload)
    # 同时输出一份 JS 包装：本地 file:// 打开时 fetch 会被 CORS 拦掉，用 <script> 载入最稳。
    io.open(os.path.join(DATA, 'app.json.js'), 'w', encoding='utf-8').write(
        'window.APP=' + payload + ';')

    # ============ 自检 ============
    print('已写出 %s  (%.0f KB)' % (out, os.path.getsize(out) / 1024))
    print('生成时间 %s | 每子类取前 %d' % (app['generatedAt'], args.top))
    print()
    print('%-28s %-14s %5s %6s %6s' % ('子类', '主源', '行数', '源数', '单源'))
    for c in app['categories']:
        print('  [%s] %s' % (c['key'], c['label']))
        for sk in c['subcats']:
            s = subcats[sk]
            print('    %-26s %-14s %5d %6d %6s' % (
                s['label'], s['primary'], len(s['rows']), len(s['sources']),
                '是' if s['singleSource'] else ''))
    print()
    print('模型库 %d 个 | 子类 %d 个 | 矩阵候选 %d 个（覆盖>=2 或单榜前10）' % (
        len(app['models']), len(subcats), len(app['matrixIds'])))
    print('开源模型 %d 个' % sum(1 for m in app['models'].values() if m['open']))

    # 「新发布」标识体检。三类数字都要报，缺一类就会把"源里没有"误读成"不新"。
    _ref = datetime.date.fromisoformat(app['generatedAt'][:10])

    def _age(m):
        rd = m.get('releasedAt')
        if not rd:
            return None
        try:
            return (_ref - datetime.date.fromisoformat(rd[:10])).days
        except ValueError:
            return None

    _mat = app['matrixIds']
    _aged = [(f, _age(app['models'][f])) for f in _mat]
    print('发布日期：模型库 %d 个有 / 矩阵 %d 行有 | 矩阵 %d 行源里没有（不给标识，不等于不新）'
          % (n_released, sum(1 for _, a in _aged if a is not None),
             sum(1 for _, a in _aged if a is None)))
    print('「新」标识：窗口 %d 天 → 矩阵亮 %d 行 / %d（%.0f%%）%s'
          % (NEW_WINDOW_DAYS,
             sum(1 for _, a in _aged if a is not None and 0 <= a <= NEW_WINDOW_DAYS),
             len(_mat),
             100.0 * sum(1 for _, a in _aged if a is not None and 0 <= a <= NEW_WINDOW_DAYS) / max(1, len(_mat)),
             '（可用 ?new=NN 覆盖）'))

    # 自检：同一子类里同一源出现多列时，必须已在 values 里折叠为 sub
    dup_bad = []
    for k, s in subcats.items():
        seen = {}
        for src in s['sources']:
            seen[src['key']] = seen.get(src['key'], 0) + 1
        for src in s['rows']:
            cv = app['models'][src['id']]['cells'][k]['values']
            for kk, n in seen.items():
                if n > 1 and (kk not in cv or 'sub' not in cv.get(kk, {})):
                    dup_bad.append((k, kk))
                    break
            break
    if dup_bad:
        print('  ⚠ 多列同源未折叠:', dup_bad)
    else:
        print('同源多列已全部折叠为 sub（无覆盖冲突）')
    print()
    print('矩阵候选前 12（按覆盖广度）：')
    for fid in app['matrixIds'][:12]:
        m = app['models'][fid]
        print('   %-30s 覆盖 %2d 榜 最好名次 %-3s %s' % (
            (m['name'] or fid)[:30], m['coverage'], m['bestRank'],
            '开源' if m['open'] else ''))


if __name__ == '__main__':
    main()
