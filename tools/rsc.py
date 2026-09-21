#!/usr/bin/env python3
"""共享工具：从 Next.js RSC payload 中提取内嵌 JSON。

背景
----
AA、llm-stats、LMArena 镜像站都是 Next.js App Router，页面数据以 React Server
Components payload 内嵌在 HTML 中，形如：

    self.__next_f.push([1,"<转义后的 JSON 片段>"])

片段本身是 JS 字符串（双引号被转义成 \\"），反转义后即可用 json 解析。
这比解析渲染后的 HTML 更可靠，也不需要官方 API key。

注意：片段里的 JSON 常嵌在 React Flight 结构（形如 `["$","div",null,{...}]`）中，
所以要用 json.JSONDecoder.raw_decode 从目标位置起解析子结构，而不是整体 loads。
"""

import io
import json
import os
import re
import time
import urllib.request

PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)')
DEC = json.JSONDecoder()

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def http_get(url, retries=3, timeout=60):
    """带重试的 GET，返回解码后的 HTML 文本。"""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"抓取失败 {url}: {last}")


def read_html(path):
    with io.open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def rsc_chunks(html):
    """提取并反转义所有 RSC push 片段。"""
    return [c.replace('\\"', '"').replace("\\\\", "\\") for c in PUSH_RE.findall(html)]


def _decode_at(text, pos):
    try:
        return DEC.raw_decode(text, pos)[0]
    except Exception:  # noqa: BLE001
        return None


def find_object(chunks, key):
    """在所有片段中找 '"key":{...}'，返回解析出的 dict（取最大的一个）。"""
    best = None
    for c in chunks:
        needle = f'"{key}":'
        start = 0
        while True:
            i = c.find(needle, start)
            if i < 0:
                break
            start = i + 1
            j = c.find("{", i + len(needle))
            if j < 0 or j - i > 40:
                continue
            obj = _decode_at(c, j)
            if isinstance(obj, dict):
                if best is None or len(obj) > len(best):
                    best = obj
    return best


def find_arrays(chunks, key, min_items=1):
    """在所有片段中找所有 '"key":[...]'，返回 [(数组, 首项字段数), ...]。"""
    out = []
    for c in chunks:
        needle = f'"{key}":'
        start = 0
        while True:
            i = c.find(needle, start)
            if i < 0:
                break
            start = i + 1
            j = c.find("[", i + len(needle))
            if j < 0 or j - i > 40:
                continue
            arr = _decode_at(c, j)
            if isinstance(arr, list) and len(arr) >= min_items and isinstance(arr[0], dict):
                out.append((arr, len(arr[0].keys())))
    return out


def best_array(chunks, key, min_items=1):
    """返回字段最丰富的那个数组（同名字段可能有多个视图，取字段最多的）。"""
    arrays = find_arrays(chunks, key, min_items=min_items)
    if not arrays:
        return None
    return max(arrays, key=lambda t: t[1])[0]


def write_json(payload, out_path):
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    return out_path, os.path.getsize(out_path)
