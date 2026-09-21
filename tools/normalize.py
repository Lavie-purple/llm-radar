# -*- coding: utf-8 -*-
"""模型名归一化：把四源各异的模型名收敛到同一个 canonical family id。

设计要点
--------
1. 归一化的目标是「模型家族」，不区分推理强度（Max / High / thinking-64k / effort）。
   推理强度另存为 variant 字段，详情里单独展示 —— 因为对齐不同强度会让价格差数倍。
2. 同一个 board 内若出现多个强度变体，保留名次最好的那个，并记录 variant。
3. 归一化只做确定性规则，不做模糊匹配；无法归一的模型保持独立 id，
   由 tools/check_merge.py 输出未匹配清单，人工确认。
"""
import re

# —— 需要剥离的「变体」标记（推理强度 / 思考预算 / 采样参数）——
VARIANT_PATTERNS = [
    r'x-?high', r'very-?high', r'high', r'medium', r'med', r'low', r'minimal', r'none',
    r'thinking', r'non-?thinking', r'no-?thinking', r'reasoning', r'instant', r'chat',
    r'flash', r'pro', r'ultra', r'max', r'plus', r'air', r'mini', r'nano', r'tiny', r'lite',
    r'preview', r'exp(?:erimental)?', r'beta', r'alpha', r'rc\d*', r'dev',
    r'effort', r'budget', r'default',
]
# flash / pro / max / mini 等其实常常是产品线而非强度，但各源用法不一致：
# 这里采取保守策略 —— 先尝试「剥变体」版本，若产生碰撞再退回原样（见 canonical 的 group 逻辑）。

_EFFORT_TOKENS = {
    'max', 'xhigh', 'x-high', 'very-high', 'high', 'medium', 'med', 'low', 'minimal',
    'none', 'thinking', 'non-thinking', 'nothinking', 'no-thinking', 'reasoning',
    'instant', 'effort', 'budget', 'default', 'high-effort', 'low-effort',
}

# 日期 / 快照后缀：-0902 / -20251101 / -2026-06-25 / -v1
_DATE_RE = re.compile(r'(?:^|[-_.])(?:20\d{2}[-_.]?\d{2}[-_.]?\d{2}|20\d{2}[-_.]?\d{2}|\d{4})(?=$|[-_.])')
_VER_RE = re.compile(r'(?:^|[-_.])v\d+(?:\.\d+)*$')

# 括号内内容（如 "(Max)"、"(xHigh)"、"(medium)"）先提取再判断
_PAREN_RE = re.compile(r'[（(]\s*([^）)]*?)\s*[）)]')


def split_variant(name):
    """把名字拆成 (主干, 变体列表)。变体来自括号与尾部 token。"""
    s = str(name or '').strip()
    variants = []
    for m in _PAREN_RE.finditer(s):
        inner = m.group(1).strip()
        if inner and inner.lower() in _EFFORT_TOKENS:
            variants.append(inner.lower())
    s = _PAREN_RE.sub(' ', s)
    s = s.replace('_', '-').replace(' ', '-')
    s = re.sub(r'-{2,}', '-', s).strip('-')
    parts = s.split('-')
    keep = []
    for i, p in enumerate(parts):
        p = p.strip()
        if not p:
            continue
        # flash / pro / max 等出现在末尾时算变体；出现在中段时保留（常是产品线）
        if i >= len(parts) - 3 and p.lower() in _EFFORT_TOKENS:
            variants.append(p.lower())
            continue
        keep.append(p)
    return '-'.join(keep), variants


def canonical(name):
    """返回 (family_id, variant_label)。

    family_id 小写、去点号，作为跨源主键。
    """
    s, variants = split_variant(name)
    if not s:
        s = str(name or '').strip().lower().replace(' ', '-')
    s = _VER_RE.sub('', s)
    s = _DATE_RE.sub('-', s)
    s = s.lower()
    s = re.sub(r'[^a-z0-9.\-]', '', s)
    s = re.sub(r'-{2,}', '-', s).strip('-')
    # 统一常见别名写法：5.1 vs 5-1
    s = re.sub(r'(?<=\d)-(?=\d)', '.', s)
    fam = s or 'unknown'
    label = '+'.join(dict.fromkeys(variants)) if variants else None
    return fam, label


def normalize_name(name):
    """用于展示的规范名：保留可读形态，去掉变体与日期。"""
    s = str(name or '').strip()
    s = _PAREN_RE.sub(' ', s)
    s = _DATE_RE.sub('', s)
    s = re.sub(r'\s+', ' ', s).strip(' -_.')
    return s or str(name or '')


# —— 人工确认过的别名表：把无法用规则归一的 id 映射到统一 family ——
# 键为规则归一化后的 id，值为目标 family id。
ALIAS = {
    # 空
}
