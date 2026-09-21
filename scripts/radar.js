/* ============================================================
   LLM Radar — 决策台
   数据来自 data/app.json.js（由 tools/build_app.py 生成）
   核心约束：不合成总分；跨源只用名次；分歧度用源内名次百分位。
   ============================================================ */
(function () {
  'use strict';

  var APP = window.APP;
  if (!APP) {
    document.body.innerHTML = '<p style="padding:40px;font-family:monospace">'
      + '未找到 data/app.json.js —— 请先运行 <b>python tools/build_app.py</b> 生成数据。</p>';
    return;
  }

  var SRC = {};
  APP.sources.forEach(function (s) { SRC[s.key] = s; });

  /* 各源的预期更新周期（天）。超过 max(3, 周期×2) 就标黄，超过周期×4 标红。
     LiveBench 半年一刷，不能用日更的标准去判它「陈旧」。 */
  var CADENCE = { lmarena: 1, aa: 1, llmstats: 1, livebench: 180 };

  var state = {
    view: 'matrix',
    openOnly: 'all',
    q: '',
    cov: false,
    sort: 'coverage',
    sortCol: null,       // 点列头排序：该子类的 key，null = 用上面的默认排序
    sortDir: 'asc',      // 'asc' = 名次好的在前；'desc' = 名次差的在前
    valueMode: false,    // 性价比：名次 × $/1k 对话（越低越划算）
    cat: APP.categories[0].key,
    expanded: {},
    sel: null,           // 超宽屏详情栏里显示的模型（窄屏不用，走 expanded 内联展开）
    selCat: null,        // 大类详情视图的详情栏选中项，与矩阵各记各的
    flash: null,         // 本次打开要闪的格子（null = 还没算）；算过一轮后置 {}，不重放
    lastFlash: 0         // 本次打开实际闪出来的格子数（脚注用；0 = 没闪过）
  };

  /* ── 超宽屏详情栏 ───────────────────────────────────────
     断点必须与 CSS @media (min-width: 2560px) 完全一致，
     否则会出现「CSS 把栏显示出来了、JS 却还在往表里塞内联卡片」这种半截状态。
     用 matchMedia 而不是比较 innerWidth，就是为了让两者共用同一个真值来源。 */
  var RAIL_MQ = (window.matchMedia ? window.matchMedia('(min-width: 2560px)') : null);
  function railOn() { return !!(RAIL_MQ && RAIL_MQ.matches); }

  /* ── 工具 ───────────────────────────────────────────── */
  var $ = function (id) { return document.getElementById(id); };

  /* 表格是 width:max-content，colspan 单元格会被列宽挤扁。
     给表格写入 --cardw（= 可视容器宽度），卡片内容据此定宽并 sticky 钉在左侧。 */
  function setCardWidth(tableId, wrapId) {
    var t = $(tableId), w = $(wrapId);
    if (!t || !w) return;
    var width = w.clientWidth || w.getBoundingClientRect().width;
    if (width > 0) t.style.setProperty('--cardw', Math.round(width) + 'px');
  }
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  /* ── 数据变化提示（只用 animation，不用 transition）──────────
     ⚠️ 这里不能用 CSS transition。renderMatrix() 是 t.innerHTML = h 整块替换，
     每次渲染 1938 个格子节点全部销毁重建 —— transition 要求「同一个元素」保存
     前一个值，新元素只有终值，所以永远不会触发（实测：打身份标记后重渲染，
     存活的 = 0；对照组原地改 class 则正常触发）。
     animation 不同：它在新插入的元素上照样会跑（实测 1938/1938 running）。
     所以做成「一次性 class + @keyframes」，详见 styles/radar.css 的 .cellbtn.flash。

     两个闸门，缺一个都会变成噪音：
     1) generatedAt 没变就一个都不闪 —— 否则每次刷新页面都满屏乱闪；
     2) 只闪「档位真的换了」的格子 —— 排序/筛选/搜索都会重渲染，不该闪。 */
  var FLASHKEY = 'llmradar.bands.v1';

  function loadBands() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(FLASHKEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }   // 隐私模式 / 数据被改坏：当作没有历史
  }
  function saveBands(o) {
    try { if (window.localStorage) window.localStorage.setItem(FLASHKEY, JSON.stringify(o)); }
    catch (e) { /* 配额满或被禁：静默放弃，不影响页面 */ }
  }

  /* 全量档位表（不只是当前筛选出来的那些）—— 否则用搜索筛过一次之后
     再清空搜索，没被记录的格子会被误判成「新增」而乱闪。 */
  function allBands() {
    var out = {};
    Object.keys(APP.models).forEach(function (id) {
      var cells = APP.models[id].cells || {};
      Object.keys(APP.subcats).forEach(function (k) {
        var cell = cells[k];
        var v = cell && cell.values ? cell.values[APP.subcats[k].primary] : null;
        if (v && v.colPct != null) out[id + '|' + k] = qBand(v.colPct);
      });
    });
    return out;
  }

  function computeFlash() {
    var prev = loadBands();
    var cur = allBands();
    var gen = APP.generatedAt || '';
    var hits = {};
    /* 只有「这次打开时的 generatedAt ≠ 上次记录的」才说明数据被重抓过，才去比对档位。
       相等 = 数据没变，一个都不闪（否则每次刷新页面都满屏乱闪）。
       prev.bands[k] !== cur[k] 一并覆盖「本来没有落点、这次有了」（undefined → 档位），
       新增落点恰恰是最该被看见的一种变化。 */
    if (prev && prev.bands && prev.gen !== gen) {
      Object.keys(cur).forEach(function (k) {
        if (prev.bands[k] !== cur[k]) hits[k] = true;
      });
    }
    saveBands({ gen: gen, bands: cur });
    return hits;
  }

  function daysAgo(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  /* 单位口径：
       pct    —— 0~1 的小数（AA 的各评测），展示时 ×100
       pct100 —— 已经是 0~100 的百分数（LiveBench 各类别、LMArena agent 净改善度）
       elo / index / score —— 原样
     fmtVal / fmtValRaw 已把 % 并入返回值，所以 unitLabel 恒为空，
     保留这个函数只是为了让调用处读起来一致。 */
  function unitLabel() { return ''; }

  function fmtVal(v, unit) {
    if (v == null) return '—';
    if (unit === 'pct') return (v * 100).toFixed(1) + '%';
    if (unit === 'pct100') return v.toFixed(1) + '%';
    if (unit === 'score' || unit === 'index') return v.toFixed(1);
    if (unit === 'elo') return Math.round(v);
    return String(v);
  }

  function fmtValRaw(v, unit) {
    if (v == null) return '—';
    if (unit === 'pct') return (v * 100).toFixed(2) + '%';
    if (unit === 'pct100') return v.toFixed(2) + '%';
    if (unit === 'score' || unit === 'index') return v.toFixed(2);
    if (unit === 'elo') return Math.round(v) + '';
    return String(v);
  }

  function srcTag(k) {
    var s = SRC[k];
    return '<span class="srctag ' + k + '">' + esc(s ? s.short : k) + '</span>';
  }

  function dvBar(d) {
    if (d == null) return '<span style="color:var(--color-faint);opacity:.4">—</span>';
    return '<span class="dvbar' + (d >= 55 ? ' hot' : '') + '">'
      + '<i style="--w:' + Math.min(100, d) + '%"></i>'
      + '<span style="font-family:var(--font-mono);font-size:10px">' + d.toFixed(0) + '</span></span>';
  }

  /* 色阶：按「本列排名深度百分位」上色（colPct：100 = 本列第一，0 = 本列最深）。
     为什么不用绝对名次：各列深度不同 —— video.edit 只排到第 10 名，chat.search 排到第 30 名。
     绝对名次下 rank 10 在浅列是末位、在深列是中游，同一个颜色含义不同。
     为什么不用榜总数：LMArena 文本榜 402 个模型、本页只取前 30，这 30 名的真·源内
     百分位全落在 92.8~100 之间，整列会塌成一个颜色（实测）。
     所以色阶用「本列内相对位置」，而「对全榜的位置」另以 srcPct 作为数字展示。 */
  function qBand(p) {
    if (p == null) return 0;
    if (p >= 93) return 1;
    if (p >= 78) return 2;
    if (p >= 60) return 3;
    if (p >= 40) return 4;
    if (p >= 18) return 5;
    return 6;
  }
  function qClass(p) { var b = qBand(p); return b ? ' q' + b : ''; }
  /* 详情表用的是左边缘色条（不铺底色，避免压住密集文字），故另起一套 dqN */
  function dqClass(p) { var b = qBand(p); return b ? ' dq' + b : ''; }
  /* 把「百分位」说成人话：94.3 -> 前 5.7% */
  function fmtPct(p) {
    if (p == null) return '—';
    var top = 100 - p;
    if (top <= 0.05) return '第 1';
    return '前 ' + (top < 10 ? top.toFixed(1) : Math.round(top)) + '%';
  }

  function sortArrow() {
    return '<i class="sarrow">' + (state.sortDir === 'asc' ? '▲' : '▼') + '</i>';
  }

  function fmtMoney(n) {
    if (n == null) return '—';
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return String(Math.round(n * 10) / 10);
    return String(Math.round(n * 100) / 100);
  }

  /* 价格列：只显示每 100 万 token 的输入 / 输出单价，这是最通用、最好比较的口径。
     其余成本口径（$/任务、$/成功任务）在展开卡片的「成本」栏里，单位各不相同、不能混排。 */
  function priceCell(m) {
    var p = m.price || {};
    if (p.in == null && p.out == null) return '<span class="pmiss">—</span>';
    return '<span class="pin">$' + fmtMoney(p.in) + '</span>'
      + '<span class="psep">/</span>'
      + '<span class="pout">$' + fmtMoney(p.out == null ? p.in : p.out) + '</span>';
  }

  /* ── 名次走势（sparkline）────────────────────────────────
     数据来自 data/history.json.js（tools/build_history.py 扫描 snapshots/ 生成）。

     这一块是本站唯一压得过四个源站的东西：四站都只给「当下快照」，
     没有一个能回答「这个第一是刚爬上来的，还是已经稳了半年」。
     而 snapshots/ 本来每次抓取都在存，之前只被用来算「自上次以来」的 diff。

     ⚠️ 「积累中」是常态而不是异常 —— 快照得攒够 2 天才画得出斜率。
     所以这里必须有一条诚实的降级路径，而不是画一条假的平线。 */
  var HIST_MIN_PTS = 2;    // 少于 2 个有名次的时间点，连斜率都谈不上
  var SPARK_MINSPAN = 5;   // 纵轴强制最小跨度，防 ±1 名的抖动被拉成悬崖

  /* 读 window.HISTORY 而不是在加载时缓存成局部变量：
     一是这个脚本可能先于 history.json.js 执行，
     二是视觉核对需要在运行时替换成多日夹具来验证折线路径。 */
  function history() { return window.HISTORY || null; }
  function histDays() { var h = history(); return (h && h.n) || 0; }

  /* -> {all:[rank|null,...], pts:[{i,r},...], n:快照天数} 或 null */
  function histOf(id, subcat) {
    var h = history();
    var a = (h && h.series && h.series[id]) ? h.series[id][subcat] : null;
    if (!a || !a.length) return null;
    var pts = [];
    for (var i = 0; i < a.length; i++) if (a[i] != null) pts.push({ i: i, r: a[i] });
    return { all: a, pts: pts, n: a.length };
  }

  function trendDir(t) {
    var f = t.pts[0], l = t.pts[t.pts.length - 1];
    return l.r < f.r ? 'up' : (l.r > f.r ? 'down' : 'flat');
  }

  /* 全程没动过（所有点相等，而不是首尾相等 —— 5→9→5 中间动过，不算平）。
     平线在小尺寸下只会读成一串圆点，所以在矩阵里留空、
     在详情栏里只给一个「＝」加首末名次，都不画线。 */
  function isFlat(t) {
    var rs = t.pts.map(function (p) { return p.r; });
    return Math.min.apply(null, rs) === Math.max.apply(null, rs);
  }

  /* 名次折线：名次越小越靠上（名次变好 = 线往上走）。
     纵轴按序列自身范围自适应 + 强制最小跨度；x 轴按快照下标定位，
     中间缺快照的位置断线 —— 掉出前 N 名再回来，本来就该断，不该假装连续。

     ⚠️ 只在首末两点画圆点，不是每点都画。每个点都画圆，在 18×8 这种尺寸下
     会连成一串等距圆点，水平序列更是直接变成一条虚线，读起来像文字下划线。 */
  function sparkSVG(pts, n, w, h) {
    if (!pts || pts.length < HIST_MIN_PTS || n < HIST_MIN_PTS) return '';
    var rs = pts.map(function (p) { return p.r; });
    var lo = Math.min.apply(null, rs), hi = Math.max.apply(null, rs);
    if (hi - lo < SPARK_MINSPAN) {
      var mid = (lo + hi) / 2;
      lo = mid - SPARK_MINSPAN / 2;
      hi = mid + SPARK_MINSPAN / 2;
    }
    var padY = 2.5, ih = h - padY * 2, padX = 1.5, iw = w - padX * 2;
    var X = function (i) { return padX + iw * i / (n - 1); };
    var Y = function (r) { return padY + ih * (r - lo) / (hi - lo); };

    var d = '', dots = '';
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k];
      var x = X(p.i).toFixed(1), y = Y(p.r).toFixed(1);
      d += (k === 0 || pts[k - 1].i !== p.i - 1 ? 'M' : 'L') + x + ' ' + y;
      if (k === 0 || k === pts.length - 1) {
        dots += '<circle cx="' + x + '" cy="' + y + '" r="' + (k === 0 ? 1 : 1.6) + '"/>';
      }
    }
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h
      + '" fill="currentColor" aria-hidden="true">'
      + '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.2"'
      + ' stroke-linejoin="round" stroke-linecap="round"/>' + dots + '</svg>';
  }

  /* 把整条序列摊成人话：09-21 #5 · 09-22 #7 · … */
  function trendTip(t) {
    var h = history(), tags = (h && h.tags) || [];
    var out = [];
    for (var i = 0; i < t.all.length; i++) {
      var r = t.all[i];
      out.push(String(tags[i] || ('第' + (i + 1) + '次')).slice(5) + ' #' + (r == null ? '—' : r));
    }
    return out.join('　·　');
  }

  var DIR_WORD = { up: '名次上升', down: '名次下降', flat: '名次持平' };

  /* 矩阵格里的微走势：钉在右下角，不占名次数字的位置。
     只画线不给数字 —— 精确名次看悬停，这里只回答「在往上还是往下」。 */
  function cellSpark(id, subcat) {
    var t = histOf(id, subcat);
    if (!t || t.pts.length < HIST_MIN_PTS) return '';
    /* 全程没动过就不画：留空反而携带语义「这条榜上它没动过」，
       画一条 18px 的水平线只会被当成装饰。 */
    if (isFlat(t)) return '';
    var dir = trendDir(t);
    var ttl = '近 ' + t.n + ' 天走势（' + DIR_WORD[dir] + '）　' + trendTip(t)
      + '\n纵轴自适应、最小跨度 ' + SPARK_MINSPAN + ' 名，所以线陡 ≠ 掉得狠，'
      + '具体名次看格子里的数字。想看清整条走势请把鼠标移到格子上。';
    return '<span class="cspk d-' + dir + '" title="' + esc(ttl) + '">'
      + sparkSVG(t.pts, t.n, 18, 8) + '</span>';
  }

  /* 展开卡片「全部落点」表里的走势列。 */
  function trendCell(id, subcat) {
    var t = histOf(id, subcat);
    var h = history();
    var days = histDays();
    if (!h) {
      return '<span class="tpend" title="还没有走势数据文件（data/history.json.js）—— '
        + '跑一次 tools/run_all.py 就会生成。">—</span>';
    }
    if (!t || !t.pts.length) {
      return '<span class="tpend" title="该模型在这条榜上还没有历史名次。'
        + '历史只记各榜前 40 名，更深的名次不记；快照攒够 ' + HIST_MIN_PTS
        + ' 天后会自动出现走势。">'
        + (days < HIST_MIN_PTS ? '积累中 ' + days + '/' + HIST_MIN_PTS : '—') + '</span>';
    }
    if (t.pts.length < HIST_MIN_PTS) {
      return '<span class="tpend" title="这条序列暂时只有 ' + t.pts.length + ' 个时间点有名次，'
        + '至少 ' + HIST_MIN_PTS + ' 个才画得出斜率。">'
        + '积累中 ' + t.pts.length + '/' + HIST_MIN_PTS + '</span>';
    }
    var f = t.pts[0], l = t.pts[t.pts.length - 1];
    var dir = trendDir(t);
    if (isFlat(t)) {
      return '<span class="tflat" title="' + esc('近 ' + t.n + ' 天全程停在第 ' + f.r + ' 名，'
        + '名次没动过。\n' + trendTip(t)) + '">＝'
        + '<b class="tnum">' + f.r + '→' + l.r + '</b></span>';
    }
    return '<span class="tspark d-' + dir + '" title="'
      + esc('近 ' + t.n + ' 天走势（' + DIR_WORD[dir] + '）\n' + trendTip(t)
        + '\n纵轴按该序列自身范围自适应、最小跨度 ' + SPARK_MINSPAN + ' 名 —— 线陡 ≠ 掉得狠。')
      + '">' + sparkSVG(t.pts, t.n, 46, 16)
      + '<b class="tnum">' + f.r + '→' + l.r + '</b></span>';
  }

  /* ── 过滤 ───────────────────────────────────────────── */
  function passModel(id) {
    var m = APP.models[id];
    if (!m) return false;
    if (state.openOnly === 'open' && !m.open) return false;
    if (state.openOnly === 'closed' && m.open) return false;
    if (state.cov && (m.coverage || 0) < 3) return false;
    if (state.q) {
      var hay = ((m.name || '') + ' ' + (m.vendor || '') + ' ' + id).toLowerCase();
      if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
    }
    return true;
  }

  /* 取某模型在某列的排序键（该列主指标来源的名次记录） */
  function sortKeyOf(id, colKey) {
    var m = APP.models[id];
    var cell = (m.cells || {})[colKey];
    if (!cell || !cell.values) return null;
    var sc = APP.subcats[colKey];
    var v = sc ? cell.values[sc.primary] : null;
    if (!v) {
      // 主源缺数据时退用该列任意一个源，避免整列排不动
      var ks = Object.keys(cell.values);
      v = ks.length ? cell.values[ks[0]] : null;
    }
    return v || null;
  }

  /* $/1k 对话 = (输入 + 输出) / 1000。是目前唯一可跨模型比较的对话成本口径。 */
  function priceOf(m) {
    var p = (m && m.price) || {};
    return (p.in != null && p.out != null) ? (p.in + p.out) / 1000 : null;
  }

  function filteredMatrix() {
    var ids = APP.matrixIds.filter(passModel);
    var fallback = function (a, b) {
      return (APP.models[b].coverage - APP.models[a].coverage)
        || (APP.models[a].bestRank - APP.models[b].bestRank);
    };

    // ── 点列头排序 ──
    if (state.sortCol) {
      var col = state.sortCol;
      var isPrice = (col === '__price');
      var dir = state.sortDir === 'asc' ? 1 : -1;
      ids.sort(function (a, b) {
        var A = APP.models[a], B = APP.models[b];
        var ka, kb;
        if (isPrice) {
          ka = priceOf(A); kb = priceOf(B);
        } else if (state.valueMode) {
          // 性价比：名次 × $/1k 对话，越低越划算
          var va = sortKeyOf(a, col), vb = sortKeyOf(b, col);
          var pa = priceOf(A), pb = priceOf(B);
          ka = (va && pa != null) ? va.rank * pa : null;
          kb = (vb && pb != null) ? vb.rank * pb : null;
        } else {
          var ra = sortKeyOf(a, col), rb = sortKeyOf(b, col);
          ka = ra ? ra.rank : null;
          kb = rb ? rb.rank : null;
        }
        // 缺值一律沉底，不跟着升/降序翻转
        if (ka == null && kb == null) return fallback(a, b);
        if (ka == null) return 1;
        if (kb == null) return -1;
        return ka !== kb ? (ka - kb) * dir : fallback(a, b);
      });
      return ids;
    }

    // 开了性价比但没点列头：用「最好名次 × $/1k」兜底
    if (state.valueMode) {
      ids.sort(function (a, b) {
        var A = APP.models[a], B = APP.models[b];
        var pa = priceOf(A), pb = priceOf(B);
        var ka = pa != null ? A.bestRank * pa : null;
        var kb = pb != null ? B.bestRank * pb : null;
        if (ka == null && kb == null) return fallback(a, b);
        if (ka == null) return 1;
        if (kb == null) return -1;
        return ka !== kb ? ka - kb : fallback(a, b);
      });
      return ids;
    }

    if (state.sort === 'coverage') {
      ids.sort(fallback);
    } else if (state.sort === 'best') {
      ids.sort(function (a, b) {
        var A = APP.models[a], B = APP.models[b];
        return (A.bestRank - B.bestRank) || (B.coverage - A.coverage);
      });
    } else {
      ids.sort(function (a, b) {
        return (APP.models[a].name || a).localeCompare(APP.models[b].name || b, 'zh');
      });
    }
    return ids;
  }

  /* ── 顶栏：时效 ─────────────────────────────────────── */
  function renderFreshness() {
    var html = APP.sources.map(function (s) {
      var d = daysAgo(s.fetchedAt);
      var cad = CADENCE[s.key] || 1;
      var cls = 'fresh';
      var label;
      if (d == null) { label = '—'; }
      else if (d >= cad * 4) { cls += ' stale'; label = d + ' 天前'; }
      else if (d >= Math.max(3, cad * 2)) { cls += ' warn'; label = d + ' 天前'; }
      else { label = d <= 0 ? '今天' : d + ' 天前'; }
      return '<span class="' + cls + '" title="' + esc(s.label + ' · ' + (s.fetchedAt || '')) + '">'
        + '<i></i>' + esc(s.short) + ' <b>' + label + '</b></span>';
    }).join('');
    $('freshness').innerHTML = html;
    $('genstamp').textContent = '数据合成于 ' + (APP.generatedAt || '').replace('T', ' ').slice(0, 16);
  }

  /* ── 数据基准条 ─────────────────────────────────────── */
  function renderSrcline() {
    $('srcline').innerHTML = APP.sources.map(function (s) {
      return '<div class="srccard">'
        + '<div class="srccard-h"><i style="background:' + s.color + '"></i>'
        + '<b>' + esc(s.label) + '</b><em>' + esc(s.scale || '') + '</em></div>'
        + '<p>' + esc(s.note || '') + '</p></div>';
    }).join('');
  }

  /* ── 变更条 ─────────────────────────────────────────── */
  function renderChanges() {
    var c = APP.changes || {};
    var el = $('changes');
    if (!c.hasBaseline) {
      el.innerHTML = '<div class="chbar"><h3>变更追踪</h3>'
        + '<div class="chlist"><span class="chip">尚无基线</span></div>'
        + '<p class="chnote">这是本管道的首次快照。下一次抓取后，这里会显示「自上次以来新增 / 掉出 / 名次大幅变动」的模型。</p></div>';
      return;
    }
    var added = [], moved = [], removed = [];
    var src = c.sources || {};
    Object.keys(src).forEach(function (k) {
      var o = src[k];
      if (!o) return;
      if (o.boards) {
        Object.keys(o.boards).forEach(function (b) {
          var bb = o.boards[b];
          (bb.added || []).forEach(function (x) { added.push(x); });
          (bb.removed || []).forEach(function (x) { removed.push(x); });
          (bb.moved || []).forEach(function (x) { moved.push(x); });
        });
      } else {
        (o.added || []).forEach(function (x) { added.push(x); });
        (o.removed || []).forEach(function (x) { removed.push(x); });
      }
    });
    var chips = [];
    added.slice(0, 10).forEach(function (x) {
      chips.push('<span class="chip add">+ ' + esc(typeof x === 'string' ? x : (x.model || x.id)) + '</span>');
    });
    moved.slice(0, 8).forEach(function (x) {
      chips.push('<span class="chip mov">' + esc(x.model || x.id) + ' ' + x.from + '→' + x.to + '</span>');
    });
    removed.slice(0, 8).forEach(function (x) {
      chips.push('<span class="chip del">− ' + esc(typeof x === 'string' ? x : (x.model || x.id)) + '</span>');
    });
    var hot = chips.length > 0;
    el.innerHTML = '<div class="chbar' + (hot ? ' hot' : '') + '">'
      + '<h3>自上次抓取</h3><div class="chlist">'
      + (chips.length ? chips.join('') : '<span class="chip">无变化</span>')
      + '</div>'
      + '<p class="chnote">基线 ' + esc((c.previous || '').slice(0, 16)) + ' → ' + esc((c.current || '').slice(0, 16))
      + '　·　新增 ' + added.length + ' 项、名次变动 ' + moved.length + ' 项、掉出 ' + removed.length + ' 项</p></div>';
  }

  /* ── 视图切换 ───────────────────────────────────────── */
  function renderTabs() {
    var html = '<button data-view="matrix" class="' + (state.view === 'matrix' ? 'on' : '') + '">'
      + '名次矩阵 <span class="n">' + APP.matrixIds.length + '</span></button>';
    APP.categories.forEach(function (c) {
      var n = c.subcats.length;
      html += '<button data-view="cat" data-cat="' + c.key + '" class="'
        + (state.view === 'cat' && state.cat === c.key ? 'on' : '') + '">'
        + (c.newly ? '<span class="nb"></span>' : '')
        + esc(c.label) + ' <span class="n">' + n + '</span></button>';
    });
    $('viewtabs').innerHTML = html;
  }

  /* ── 矩阵 ───────────────────────────────────────────── */
  function columns() {
    var cols = [];
    APP.categories.forEach(function (c) {
      c.subcats.forEach(function (k) {
        var sc = APP.subcats[k];
        cols.push({ key: k, cat: c.key, label: sc.label, primary: sc.primary, single: sc.singleSource });
      });
    });
    return cols;
  }

  /* ── 超宽屏详情栏 ───────────────────────────────────── */
  function renderRail(id, elId) {
    var rail = $(elId);
    if (!rail) return;
    if (!id) {
      rail.innerHTML = '<div class="railhead"><b>详情</b>'
        + '<span class="railhint">超宽屏 · 常驻栏</span></div>'
        + '<div class="detailempty">没有符合条件的模型。<br>放宽筛选后这里会显示选中模型的全貌。</div>';
      return;
    }
    var m = APP.models[id] || {};
    rail.innerHTML = '<div class="railhead"><b>详情</b>'
      + '<span class="railname">' + esc(m.name || id) + '</span>'
      + '<span class="railhint">点左侧任意一行切换</span></div>'
      + '<div class="railbody">' + modelCard(id) + '</div>';
  }

  /* 两个视图（矩阵 / 大类详情）共用同一套「选中项」规则，
     只是各记各的 state 和一个各自的栏元素 id。 */
  function railSel(ids, key) {
    var sel = (state[key] && ids.indexOf(state[key]) >= 0) ? state[key] : (ids[0] || null);
    state[key] = sel;
    return sel;
  }

  function renderMatrix() {
    var cols = columns();
    var ids = filteredMatrix();
    var t = $('matrix');
    var h = '';

    /* 超宽屏：详情栏必须始终有内容，否则右侧是一大块空的。
       选中项优先用用户点过的 state.sel；它可能被筛选/搜索筛掉，
       所以每次都要回头核对一遍，不在了就退回列表第一行。 */
    var rail = railOn();
    var selId = rail ? railSel(ids, 'sel') : null;

    /* 只有本次打开的第一轮渲染才闪。之后的排序/筛选重渲染如果还带着这个表，
       animation 会在新建节点上反复重放，整表变成频闪灯。 */
    if (state.flash === null) state.flash = computeFlash();
    var flash = state.flash;

    // 表头
    var priceActive = state.sortCol === '__price';
    h += '<thead><tr class="grp"><th class="corner" rowspan="2">模型</th>'
      + '<th class="pricehead' + (priceActive ? ' sorted' : '') + '" rowspan="2"'
      + ' data-sortcol="__price" role="button" tabindex="0"'
      + ' title="价格：每 100 万 token 的输入 / 输出单价（USD）。点此按价格排序，再点切换升/降序。'
      + '标 $0 的是源站就记为 0 的自托管 / 免费额度模型，按价格升序时会排在最前。'
      + '图像 / 视频等没有 token 单价的模型显示为「—」并沉底。">'
      + '<span class="sbl">价格' + (priceActive ? sortArrow() : '') + '</span>'
      + '<span class="srcline2">$/1M 入·出</span></th>';
    APP.categories.forEach(function (c) {
      h += '<th class="grp" colspan="' + c.subcats.length + '">' + esc(c.label)
        + ' <span class="ct">' + c.subcats.length + '</span></th>';
    });
    h += '</tr><tr class="sub">';
    cols.forEach(function (c) {
      var active = state.sortCol === c.key;
      var cls = 'sub s-' + c.primary + (active ? ' sorted' : '');
      var srcName = SRC[c.primary] ? SRC[c.primary].short : c.primary;
      var hint = c.label + '：本列名次来自 '
        + (SRC[c.primary] ? SRC[c.primary].label : c.primary)
        + (c.single ? '（该子类仅此一个源）' : '（该子类的主指标来源，其余源见详情页）')
        + '。点此按本列名次排序，再点切换升/降序，第三次恢复默认。';
      h += '<th class="' + cls + '" data-sortcol="' + esc(c.key) + '" role="button" tabindex="0"'
        + ' title="' + esc(hint) + '">'
        + '<span class="sbl">' + esc(c.label) + (active ? sortArrow() : '') + '</span>'
        + '<span class="srcline2">' + esc(srcName) + (c.single ? ' *' : '') + '</span></th>';
    });
    h += '</tr></thead><tbody>';

    if (!ids.length) {
      h += '<tr><td colspan="' + (cols.length + 2) + '"><div class="empty">没有符合条件的模型。试试放宽「开源筛选」或清空搜索。</div></td></tr>';
    }

    /* 实际闪出来的格子数（不是 computeFlash 的全量结果）——
       只有渲染出来的格子才会带 .flash，脚注得说用户真正看得到的那个数。 */
    var flashN = 0;
    ids.forEach(function (id) {
      var m = APP.models[id];
      // 超宽屏：高亮交给详情栏的选中项；窄屏：还是各自独立的内联展开
      var isOpen = rail ? (id === selId) : !!state.expanded[id];
      h += '<tr class="' + (isOpen ? 'open' : '') + '" data-row="' + esc(id) + '">';
      h += '<td class="modelcell"><button class="mbtn" data-toggle="' + esc(id) + '">'
        + '<span class="caret">▶</span>'
        + '<span class="mname">' + esc(m.name || id) + '</span>'
        + (m.open ? '<span class="badge-open">开源</span>' : '')
        + '<span class="cov">' + (m.coverage || 0) + '</span>'
        + '</button></td>';

      var bl = priceOf(m);
      h += '<td class="pricecell" title="'
        + esc((m.name || id) + '　每 100 万 token 输入 / 输出'
          + (bl != null ? '\n$/1k 对话（1k 入 + 1k 出）= $' + bl.toFixed(4) : '\n该源未提供 token 单价'))
        + '">' + priceCell(m) + '</td>';

      cols.forEach(function (c) {
        var cell = (m.cells || {})[c.key];
        var v = cell && cell.values ? cell.values[c.primary] : null;
        var dv = cell ? cell.diverge : null;
        var isFlash = !!flash[id + '|' + c.key];
        if (isFlash) flashN++;
        if (!v) {
          h += '<td class="cell' + (c.single ? ' single' : '') + '">'
            + '<div class="cellbtn"><span class="miss">·</span></div></td>';
          return;
        }
        var cls = 'cell' + (c.single ? ' single' : '') + (dv != null && dv >= 55 ? ' dv-high' : '');
        var multi = v.alts && v.alts.length ? '<span class="sm">×' + (v.alts.length + 1) + '</span>' : '';
        h += '<td class="' + cls + '"><button class="cellbtn' + qClass(v.colPct)
          + (isFlash ? ' flash' : '') + '"'
          + ' data-cell="' + esc(id) + '|' + esc(c.key) + '">' + v.rank + multi
          + cellSpark(id, c.key) + '</button></td>';
      });
      h += '</tr>';

      if (isOpen && !rail) {
        h += '<tr class="mcard"><td colspan="' + (cols.length + 2) + '">'
          + '<div class="mcard-in">' + modelCard(id) + '</div></td></tr>';
      }
    });

    h += '</tbody>';
    t.innerHTML = h;
    /* 先记下闪了几个，再作废这张表 —— 脚注要在这之后才拼，
       直接读 state.flash 会读到刚刚清空的 {}，提示永远不出现。
       ⚠️ 只在真的闪了的时候写：初始化阶段 renderMatrix 会被调不止一次，
       第二次的 flashN 是 0，无条件赋值会把刚记下的数字抹掉。 */
    if (flashN > 0) state.lastFlash = flashN;
    state.flash = {};   // 闪过的这一轮就作废，后续重渲染不再重放
    setCardWidth('matrix', 'wrap-matrix');
    if (rail) renderRail(selId, 'detailrail');

    // 图例（与 CSS 的 .q1~.q6 一一对应）
    var hDays = histDays();
    var trendLegend = hDays >= HIST_MIN_PTS
      ? '<span title="格子右下角那道微折线：该模型在本列最近 ' + hDays + ' 次抓取里的名次变化，'
        + '线往上走 = 名次在变好"><i style="background:#38bdf8"></i>走势↑</span>'
        + '<span title="同上，线往下走 = 名次在变差"><i style="background:var(--color-accent)"></i>走势↓</span>'
      : '';
    $('matrix-legend').innerHTML =
      '<span class="qscale">色阶 = 本列位置</span>'
      + '<span title="本列百分位 ≥93"><i class="qi q1"></i>前 7%</span>'
      + '<span title="本列百分位 78–93"><i class="qi q2"></i>22%</span>'
      + '<span title="本列百分位 60–78"><i class="qi q3"></i>40%</span>'
      + '<span title="本列百分位 40–60"><i class="qi q4"></i>60%</span>'
      + '<span title="本列百分位 18–40"><i class="qi q5"></i>82%</span>'
      + '<span title="本列百分位 &lt;18"><i class="qi q6"></i>后段</span>'
      + '<span><i style="background:var(--color-surface);border:1px dashed var(--color-border-2)"></i>单源</span>'
      + '<span><i style="background:var(--color-accent)"></i>分歧 ≥55</span>'
      + trendLegend;

    /* 走势状态说明：快照天数是每天在长的，所以这句话必须由数据算出来，不能写死。 */
    var trendNote = hDays >= HIST_MIN_PTS
      ? '格子<b>右下角那道微折线</b>是该模型在本列最近 <b>' + hDays + '</b> 次抓取的名次变化'
        + '（线往上 = 名次变好；<span style="color:#38bdf8">蓝</span>＝上升、'
        + '<span style="color:var(--color-accent)">橙</span>＝下降）。'
        + '它纵轴按各自的序列自适应，所以<b>线陡不等于掉得狠</b>，具体名次仍看格子里的数字。'
        + '只有名次真的动过才画线 —— <b>留空的格子表示它在这条榜上没动过</b>。'
      : '<b>名次走势还在积累</b>：目前只有 <b>' + hDays + '</b> 天快照，'
        + '攒到 ' + HIST_MIN_PTS + ' 天起，格子右下角会出现微折线，悬停可见整条走势。';

    var shown = ids.length;
    $('matrix-note').innerHTML = '共 <b>' + shown + '</b> 个模型（候选池 ' + APP.matrixIds.length
      + ' 个：出现在 ≥2 个子类，或在任一子类进前 10）。每格显示<b>主指标来源</b>的名次；'
      + '<b>颜色表示它在本列中的相对位置</b>——列内第一最深、本列最深名次最浅。'
      + '不用绝对名次上色是因为各列深度不同（<b>视频编辑只排到第 10 名，搜索增强排到第 30 名</b>），'
      + '同一个名次在不同列含义不同。悬停可看它在该榜<b>全榜</b>里的真实位置。'
      + '带 <span class="tag-single">单源</span> 的列只有一个数据源，其分歧度无法计算。'
      + '格内 <span class="dot-miss"></span> 表示该模型未进本页收录范围或未参评。'
      + (flashHint()
          ? ' <b>' + flashCount() + ' 格闪过</b> —— 那是相对你上次打开时<b>档位变了</b>的格子'
            + '（只闪数据重抓过且真换了档的，普通排序筛选不会闪）。'
          : '')
      + '<b>' + (rail ? '点行在右侧详情栏查看' : '点行展开') + '</b>该模型的全部落点。'
      + ' ' + trendNote;
  }

  /* 闪过的格子数 —— 脚注与图例共用，避免两处各说各话。
     注意读的是 lastFlash 而不是 flash：闪烁表在渲染末尾就被清空了。 */
  function flashCount() { return state.lastFlash || 0; }
  function flashHint() { return flashCount() > 0; }

  /* ── 模型卡片 ───────────────────────────────────────── */
  function modelCard(id) {
    var m = APP.models[id];
    var v = m.vendor || '未知';
    var ctx = m.context;
    var ctxTxt = (typeof ctx === 'number') ? (ctx >= 1000000 ? (ctx / 1000000) + 'M' : Math.round(ctx / 1000) + 'K') : (ctx || '—');

    /* 列 1 —— 身份与可得性 */
    var c1 = '<div class="mcard"><div class="mcard-title"><strong>' + esc(m.name || id) + '</strong>'
      + (m.open ? '<span class="badge-open">开源</span>' : '<span class="cov" style="border-color:var(--color-border-2)">闭源</span>')
      + '</div>'
      + '<div class="mcard-sub">' + esc(v) + (m.country ? ' · ' + esc(m.country) : '')
      + ' · 出现在 ' + (m.coverage || 0) + ' 个子类的榜单里，最好名次第 ' + (m.bestRank || '—') + '</div>'
      + '<h4>身份</h4><dl class="kv">'
      + '<dt>开源判定</dt><dd class="dim">' + (m.open
        ? '是（来源：' + (m.openBy || []).map(function (k) { return SRC[k] ? SRC[k].short : k; }).join('、') + '）'
        : '否（四个源均标为闭源）') + '</dd>'
      + '<dt>上下文</dt><dd>' + esc(ctxTxt) + '</dd>'
      + '<dt>覆盖子类</dt><dd>' + (m.seenIn || []).length + ' 个</dd>'
      + '</dl>';

    var links = [];
    if (m.links && m.links.openrouter) links.push('<a href="' + esc(m.links.openrouter) + '" target="_blank" rel="noopener">去试 · OpenRouter ↗</a>');
    if (m.links && m.links.detail) links.push('<a href="' + esc(m.links.detail) + '" target="_blank" rel="noopener">榜单详情 ↗</a>');
    if (links.length) c1 += '<div class="links">' + links.join('') + '</div>';
    c1 += '</div>';

    /* 列 2 —— 成本与速度 */
    var p = m.price || {};
    var sp = m.speed || {};
    var lbT = m.extra && m.extra.lbCostTask, lbS = m.extra && m.extra.lbCostSucc;
    var agentCell = (m.cells['agent.work'] || {}).values;
    var agentCost = agentCell && agentCell.lmarena && agentCell.lmarena.extra
      ? agentCell.lmarena.extra.costTaskP50 : null;
    var agentEx = agentCell && agentCell.lmarena ? agentCell.lmarena.extra : null;

    var c2 = '<div class="mcard"><h4>成本（按维度各自的单位，不做换算）</h4><dl class="kv">';
    if (p.in != null) {
      c2 += '<dt>$/1M 输入</dt><dd>$' + p.in + '</dd><dt>$/1M 输出</dt><dd>$' + (p.out != null ? p.out : '—') + '</dd>';
      c2 += '<dt>$/1k 对话</dt><dd>$' + (p.blended1k != null ? p.blended1k.toFixed(4) : '—') + '</dd>';
    } else {
      c2 += '<dt>API 价格</dt><dd class="dim">该源未提供</dd>';
    }
    c2 += '<dt>$/任务（Agent）</dt><dd>' + (agentCost != null ? '$' + agentCost : '—') + '</dd>';
    c2 += '<dt>$/任务（LiveBench）</dt><dd>' + (lbT != null ? '$' + lbT : '—') + '</dd>';
    c2 += '<dt>$/成功任务</dt><dd>' + (lbS != null ? '$' + lbS : '—') + '</dd>';
    c2 += '</dl>';
    if (p.blended1k != null) {
      c2 += '<p style="font-size:10.5px;color:var(--color-faint);margin-top:8px;line-height:1.6">'
        + '$/1k 对话 = 1k 输入 + 1k 输出的合计（(输入+输出）/1000），是目前唯一可跨模型比较的对话成本口径。</p>';
    }

    c2 += '<h4 style="margin-top:18px">速度</h4><dl class="kv">';
    c2 += '<dt>输出速度</dt><dd>' + (sp.tps != null ? sp.tps + ' tok/s' : '—') + '</dd>';
    // 注意单位：ttft / ttfa 都是「秒」，不是 token 数。
    // AA 的原始字段名是 medianTimeToFirstTokenSeconds / medianTimeToFirstAnswerTokenSeconds。
    // 缺数据时也占一行写「—」，与上面几项保持同一透出口径（缺失 ≠ 没有这项指标）。
    var latRows = [];
    if (sp.ttft != null) latRows.push(['首 token 时延', sp.ttft + ' s']);
    if (sp.ttfa != null) latRows.push(['首答 token 时延', sp.ttfa + ' s']);
    if (!latRows.length) latRows.push(['首 token 时延', '—']);
    latRows.forEach(function (r) { c2 += '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; });
    c2 += '<dt>端到端</dt><dd>' + (sp.e2e != null ? sp.e2e + ' s' : '—') + '</dd>';
    c2 += '</dl><p style="font-size:10.5px;color:var(--color-faint);margin-top:8px;line-height:1.6">'
      + '速度只在 Artificial Analysis 一个源内部可比——它与 llm-stats 的计数口径不同，两站数字不能并排。</p>';

    if (agentEx && Object.keys(agentEx).length) {
      c2 += '<h4 style="margin-top:18px">Agent 榜附加指标（LMArena）</h4><dl class="kv">';
      var EXTRA_LABEL = {
        confirmedSuccess: '确认成功率', toolHallucination: '工具幻觉率',
        steerability: '可操控性', bashRecovery: 'Bash 恢复力',
        praiseVsComplaint: '好评/差评比', outputTokensTaskP50: '每任务输出 token'
      };
      Object.keys(EXTRA_LABEL).forEach(function (k) {
        if (agentEx[k] != null) c2 += '<dt>' + EXTRA_LABEL[k] + '</dt><dd>' + agentEx[k] + '</dd>';
      });
      c2 += '</dl>';
    }
    c2 += '</div>';

    /* 列 3 —— 全部落点 */
    var c3 = '<div class="mcard"><h4>全部落点（跨 6 大类）</h4>';
    var any = false;
    var rowsHtml = '';
    APP.categories.forEach(function (cat) {
      cat.subcats.forEach(function (sk) {
        var cell = (m.cells || {})[sk];
        if (!cell) return;
        any = true;
        var sc = APP.subcats[sk];
        var vals = Object.keys(cell.values).map(function (k) {
          var vv = cell.values[k];
          var sub = (vv.sub && vv.sub.length)
            ? '　<em style="font-style:normal;color:var(--color-faint)">+ '
              + vv.sub.map(function (x) { return esc(x.label) + ' ' + fmtValRaw(x.value, x.unit); }).join('、')
              + '</em>' : '';
          return srcTag(k) + '<span title="' + esc((vv.label || '') + ' | ' + (vv.raw || '')) + '">#'
            + vv.rank + '　' + fmtVal(vv.value, vv.unit) + unitLabel(vv.unit) + '</span>' + sub;
        }).join('');
        rowsHtml += '<tr><td class="scname">' + esc(cat.label) + ' · ' + esc(sc.label)
          + (sc.singleSource ? ' <span class="tag-single">单源</span>' : '') + '</td>'
          + '<td class="vals">' + vals + '</td>'
          + '<td>' + dvBar(cell.diverge) + '</td>'
          + '<td class="tcol">' + trendCell(id, sk) + '</td></tr>';
      });
    });
    if (any) {
      var hDays = histDays();
      var trendHead = '走势' + (hDays >= HIST_MIN_PTS
        ? '（近 ' + hDays + ' 天）'
        : '（积累中 ' + hDays + '/' + HIST_MIN_PTS + '）');
      c3 += '<table class="celltable"><thead><tr><th>子类</th><th>各源名次 / 原始分</th><th>分歧</th>'
        + '<th class="tcol" title="该模型在这条子类榜上最近几次抓取的名次变化。'
        + '越往上名次越好；蓝＝上升、橙＝下降。纵轴按各自序列自适应，'
        + '所以线陡不代表掉得狠，精确名次看左边的数字。">' + esc(trendHead) + '</th>'
        + '</tr></thead><tbody>'
        + rowsHtml + '</tbody></table>';
    } else {
      c3 += '<div class="empty">该模型没有进入本页任何子类的收录范围。</div>';
    }
    c3 += '</div>';

    return '<div class="mcard-grid">' + c1 + c2 + c3 + '</div>';
  }

  /* ── 大类详情 ───────────────────────────────────────── */
  function renderCat() {
    var cat = APP.categories.filter(function (c) { return c.key === state.cat; })[0];
    if (!cat) return;
    var subs = cat.subcats.map(function (k) { return APP.subcats[k]; });

    /* 头部 */
    var head = '<div class="chead-row"><div>'
      + '<h2>' + esc(cat.label) + '</h2>'
      + '<p class="csub">' + esc(cat.sub) + '　·　' + subs.length + ' 个子类</p>'
      + '</div><div class="tol' + (cat.tolerance === '零容忍' ? ' zero' : '') + '">'
      + '<i></i>容忍度：' + esc(cat.tolerance) + '</div></div>';
    if (cat.toleranceNote) {
      head += '<p class="csub" style="margin-top:8px">' + esc(cat.toleranceNote) + '</p>';
    }

    /* agent 的主指标条 */
    if (cat.headline) {
      var hl = cat.headline;
      var board = APP.subcats['agent.work'];
      var top = (board ? board.rows : []).slice(0, 6);
      head += '<div class="headline-metric"><div class="hm-h">'
        + '<span style="color:' + (SRC[hl.source] ? SRC[hl.source].color : '#fff') + '">■</span>'
        + '大类主指标：' + esc(hl.label) + '</div><div class="hm-list">'
        + top.map(function (r) {
          var vv = r.values[hl.source];
          return vv ? '<span><b>' + esc(r.name) + '</b> ' + (vv.value > 0 ? '+' : '') + vv.value + '% <em>#' + vv.rank + '</em></span>' : '';
        }).join('')
        + '</div><p class="hm-note">' + esc(hl.note) + '</p></div>';
    }

    /* 读法提示：每个子类一句话 */
    head += '<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">'
      + subs.map(function (s) {
        return '<span class="tol" title="' + esc(s.question) + '">'
          + esc(s.label) + '：' + esc((SRC[s.primary] ? SRC[s.primary].short : s.primary))
          + (s.singleSource ? ' <span class="tag-single">单源</span>' : '') + '</span>';
      }).join('') + '</div>';

    $('cathead').innerHTML = head;

    /* 表 */
    var models = {};
    subs.forEach(function (s) {
      s.rows.forEach(function (r) { if (passModel(r.id)) models[r.id] = 1; });
    });
    var ids = Object.keys(models);
    ids.sort(function (a, b) {
      var A = APP.models[a], B = APP.models[b];
      return (B.coverage - A.coverage) || (A.bestRank - B.bestRank);
    });

    var rail = railOn();
    var selId = rail ? railSel(ids, 'selCat') : null;

    var h = '<thead><tr><th class="corner" rowspan="2" style="position:sticky;left:0;z-index:4;background:var(--color-surface-2);text-align:left;padding:5px 12px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--color-muted);border-right:1px solid var(--color-border-2)">模型</th>';
    subs.forEach(function (s) {
      var srcs = s.distinctSources;
      var span = srcs.length + (s.singleSource ? 0 : 1);
      h += '<th class="grp" colspan="' + span + '">' + esc(s.label)
        + '<small>' + esc((SRC[s.primary] ? SRC[s.primary].short : '') + ' 主指标'
          + (s.singleSource ? ' · 单源' : ' · ' + srcs.length + ' 源')) + '</small></th>';
    });
    h += '</tr><tr>';
    subs.forEach(function (s) {
      s.distinctSources.forEach(function (k) {
        h += '<th class="subcol s-' + k + '">' + esc(SRC[k] ? SRC[k].short : k) + '</th>';
      });
      if (!s.singleSource) h += '<th class="subcol">分歧</th>';
    });
    h += '</tr></thead><tbody>';

    if (!ids.length) {
      h += '<tr><td colspan="40"><div class="empty">没有符合条件的模型。</div></td></tr>';
    }

    ids.forEach(function (id) {
      var m = APP.models[id];
      var isOpen = rail ? (id === selId) : !!state.expanded[id];
      h += '<tr class="' + (isOpen ? 'open' : '') + '"><td class="modelcell"><button class="mbtn" data-toggle="' + esc(id) + '">'
        + '<span class="caret">▶</span><span class="mname">' + esc(m.name || id) + '</span>'
        + (m.open ? '<span class="badge-open">开源</span>' : '')
        + '<span class="cov">' + (m.coverage || 0) + '</span></button></td>';
      subs.forEach(function (s) {
        var cell = (m.cells || {})[s.key];
        s.distinctSources.forEach(function (k) {
          var vv = cell && cell.values ? cell.values[k] : null;
          if (!vv) { h += '<td class="dval empty">—</td>'; return; }
          // 同矩阵一致的色条：反映该值在本列中的相对位置（colPct）
          var dash = (k === s.primary) ? '' : ' style="color:var(--color-muted)"';
          var ttl = '#' + vv.rank + ' / ' + vv.total
            + (vv.srcPct != null ? '　全榜 ' + fmtPct(vv.srcPct) : '');
          h += '<td class="dval' + dqClass(vv.colPct) + '"' + dash + ' title="' + esc(ttl) + '">'
            + '<span class="a">' + fmtVal(vv.value, vv.unit) + unitLabel(vv.unit) + '</span>'
            + '<span class="b">#' + vv.rank + ' / ' + vv.total + '</span></td>';
        });
        if (!s.singleSource) h += '<td class="dval" style="text-align:center">' + dvBar(cell ? cell.diverge : null) + '</td>';
      });
      h += '</tr>';
      if (isOpen && !rail) {
        h += '<tr class="mcard"><td colspan="40"><div class="mcard-in">' + modelCard(id) + '</div></td></tr>';
      }
    });
    h += '</tbody>';
    $('dtable').innerHTML = h;
    setCardWidth('dtable', 'wrap-cat');
    if (rail) renderRail(selId, 'detailrail-cat');

    /* 脚注：逐个子类的口径 */
    $('cat-note').innerHTML = subs.map(function (s) {
      return '<div style="margin-bottom:6px"><b>' + esc(s.label) + '</b>　' + esc(s.question)
        + '<br>　主指标：' + esc((SRC[s.primary] ? SRC[s.primary].label : s.primary))
        + (s.singleSource ? '　<span class="tag-single">单源，分歧度不可算</span>' : '')
        + s.sources.map(function (x) {
          return x.note ? '<br>　· ' + esc((SRC[x.key] ? SRC[x.key].short : x.key) + '：' + x.note) : '';
        }).join('')
        + '</div>';
    }).join('');
  }

  /* ── 悬浮提示 ───────────────────────────────────────── */
  var tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    var r = tip.getBoundingClientRect();
    var nx = x + 16, ny = y + 16;
    if (nx + r.width > window.innerWidth - 12) nx = x - r.width - 16;
    if (ny + r.height > window.innerHeight - 12) ny = y - r.height - 16;
    tip.style.left = Math.max(8, nx) + 'px';
    tip.style.top = Math.max(8, ny) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  function cellTip(id, key) {
    var m = APP.models[id];
    var cell = (m.cells || {})[key];
    var sc = APP.subcats[key];
    if (!cell || !sc) return '';
    var rows = Object.keys(cell.values).map(function (k) {
      var v = cell.values[k];
      var alt = (v.alts && v.alts.length)
        ? '<div class="t-note">同榜同族变体：' + v.alts.map(function (a) {
          return esc(a.raw + ' #' + a.rank);
        }).join('、') + '</div>' : '';
      var sub = (v.sub && v.sub.length)
        ? v.sub.map(function (x) {
          return '<div class="t-note">同源另一指标 · ' + esc(x.label) + '：'
            + fmtValRaw(x.value, x.unit) + unitLabel(x.unit) + '（#' + x.rank + ' / ' + x.total + '）</div>';
        }).join('') : '';
      return '<div style="margin-bottom:6px">'
        + '<div class="t-h">' + srcTag(k) + esc(v.label) + '</div>'
        + '<dl><dt>名次</dt><dd>#' + v.rank + ' / ' + v.total + '</dd>'
        + (v.srcPct != null ? '<dt>全榜位置</dt><dd>' + fmtPct(v.srcPct) + '</dd>' : '')
        + '<dt>原始分</dt><dd>' + fmtValRaw(v.value, v.unit) + '</dd>'
        + (v.votes ? '<dt>票数</dt><dd>' + v.votes.toLocaleString() + '</dd>' : '')
        + (v.spread ? '<dt>名次区间</dt><dd>' + esc(v.spread) + '</dd>' : '')
        + (v.variant ? '<dt>参评变体</dt><dd>' + esc(v.variant) + '</dd>' : '')
        + (v.sigma != null ? '<dt>σ</dt><dd>' + v.sigma + '</dd>' : '')
        + (v.games != null ? '<dt>证据局数</dt><dd>' + v.games + '</dd>' : '')
        + '</dl>' + sub + alt + '</div>';
    }).join('');
    var dv = (cell.diverge == null)
      ? '<div class="t-note">' + (sc.singleSource ? '该子类仅单源，分歧度不可计算。' : '该模型在部分源缺数据，不足以计算分歧。') + '</div>'
      : '<div class="t-note">跨源分歧 <b>' + cell.diverge + '</b>'
        + (cell.diverge >= 55 ? ' —— 各源对它评价差距很大，属于口径依赖型，看它的分时要留意是哪个榜在说话。' : ' —— 各源口径基本一致。') + '</div>';

    /* 名次走势：数据够就画线，不够就说清楚还差几天 —— 不画假的平线 */
    var t = histOf(id, key);
    var trend;
    if (t && t.pts.length >= HIST_MIN_PTS) {
      trend = '<div class="t-trend"><div class="t-note">名次走势 · 近 ' + t.n + ' 天</div>'
        + '<span class="tspark big d-' + trendDir(t) + '">' + sparkSVG(t.pts, t.n, 150, 30) + '</span>'
        + '<div class="t-note">' + esc(trendTip(t)) + '</div></div>';
    } else {
      var days = histDays();
      trend = '<div class="t-note">名次走势：'
        + (days ? '快照积累中（' + (t ? t.pts.length : 0) + '/' + HIST_MIN_PTS + '）'
                : '尚无历史数据')
        + '，攒够 ' + HIST_MIN_PTS + ' 天后这里会画出折线。</div>';
    }

    return '<div class="t-h">' + esc(m.name) + '　<span style="color:var(--color-faint);font-weight:400">'
      + esc(sc.label) + '</span></div>' + rows + dv + trend;
  }

  /* ── 事件 ───────────────────────────────────────────── */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-view]');
    if (tab) {
      state.view = tab.dataset.view;
      if (tab.dataset.cat) state.cat = tab.dataset.cat;
      renderTabs(); renderAll();
      return;
    }
    var tg = e.target.closest('[data-toggle]');
    if (tg) {
      var id = tg.dataset.toggle;
      if (railOn()) {
        // 详情栏没有「收起」的概念，点已选中的行保持不动，避免右侧闪成空白
        if (state.view === 'cat') state.selCat = id; else state.sel = id;
        renderAll();
        return;
      }
      if (state.expanded[id]) delete state.expanded[id]; else state.expanded[id] = true;
      renderAll();
      return;
    }
    var of = e.target.closest('#openfilter button');
    if (of) {
      state.openOnly = of.dataset.open;
      Array.prototype.forEach.call(document.querySelectorAll('#openfilter button'), function (b) {
        b.classList.toggle('on', b === of);
      });
      renderAll();
      return;
    }
    // 点列头排序：升 → 降 → 取消（三次循环）
    var sc = e.target.closest('[data-sortcol]');
    if (sc) {
      var ck = sc.dataset.sortcol;
      if (state.sortCol === ck) {
        if (state.sortDir === 'asc') {
          state.sortDir = 'desc';
        } else {
          state.sortCol = null;
          state.sortDir = 'asc';
        }
      } else {
        state.sortCol = ck;
        state.sortDir = 'asc';
      }
      renderAll();
      return;
    }
    var ms = e.target.closest('#matrixsort button');
    if (ms) {
      state.sort = ms.dataset.sort;
      state.sortCol = null;          // 选了默认排序就等于取消列排序
      state.sortDir = 'asc';
      Array.prototype.forEach.call(document.querySelectorAll('#matrixsort button'), function (b) {
        b.classList.toggle('on', b === ms);
      });
      renderAll();
      return;
    }
  });

  $('q').addEventListener('input', function (e) { state.q = e.target.value.trim(); renderAll(); });
  $('covfilter').addEventListener('change', function (e) { state.cov = e.target.checked; renderAll(); });
  $('valuemode').addEventListener('change', function (e) { state.valueMode = e.target.checked; renderAll(); });

  document.addEventListener('mouseover', function (e) {
    var c = e.target.closest('[data-cell]');
    if (!c) return;
    var parts = c.dataset.cell.split('|');
    showTip(cellTip(parts[0], parts[1]), e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', function (e) {
    if (tip.hidden) return;
    var c = e.target.closest('[data-cell]');
    if (!c) { hideTip(); return; }
    var r = tip.getBoundingClientRect();
    var nx = e.clientX + 16, ny = e.clientY + 16;
    if (nx + r.width > window.innerWidth - 12) nx = e.clientX - r.width - 16;
    if (ny + r.height > window.innerHeight - 12) ny = e.clientY - r.height - 16;
    tip.style.left = Math.max(8, nx) + 'px';
    tip.style.top = Math.max(8, ny) + 'px';
  });
  document.addEventListener('mouseout', function (e) {
    if (!e.target.closest('[data-cell]')) hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });

  /* ── 页脚 ───────────────────────────────────────────── */
  function renderFooter() {
    $('footer-method').innerHTML = APP.sources.map(function (s) {
      return '<li><b>' + esc(s.label) + '</b>　' + esc(s.note || '') + '</li>';
    }).join('');
    var single = Object.keys(APP.subcats).filter(function (k) { return APP.subcats[k].singleSource; });
    $('footer-gaps').innerHTML =
      '<li>图像 / 视频两个大类<b>只有 LMArena 一个源</b>——AA 的 image / video Elo 是异步加载的，抓不到；llm-stats 的图像/视频榜也是客户端渲染。这两个维度的分歧度全部为空。</li>'
      + '<li>以上单源子类：<b>' + single.map(function (k) { return APP.subcats[k].label; }).join('、') + '</b>。</li>'
      + '<li>LMArena 数据取自<b>第三方中文镜像</b>（arena.atease.dev），不是官方站。官方无公开 API，这是目前唯一的自动通道。</li>'
      + '<li>LiveBench 的 release 是<b>半年一刷</b>，最新版里没有当季新模型，缺值是正常的。</li>'
      + '<li><b>名次走势是本站自建的。</b>四个源全都只给「当下快照」，没有一个提供跨时间的名次变化；'
      + '页面上的走势线来自对 snapshots/ 的逐日重算。所以它只能从本站开始抓取的那天算起 ——'
      + '<b>再往前的走势补不回来</b>。历史只记各榜前 40 名，名次更深的不记。</li>'
      + '<li>同名模型跨源靠规则归一化，推理强度变体（High/Max）已合并为同一条，保留最优名次。</li>';
    $('footer-fine').textContent = '生成时间 ' + APP.generatedAt
      + '　·　每个子类收录前 ' + APP.topN + ' 名　·　模型库 ' + Object.keys(APP.models).length
      + ' 个　·　仅供个人使用，引用请注明原始来源。';
  }

  /* ── 渲染调度 ───────────────────────────────────────── */
  function renderAll() {
    $('view-matrix').hidden = state.view !== 'matrix';
    $('view-cat').hidden = state.view !== 'cat';
    if (state.view === 'matrix') renderMatrix(); else renderCat();
  }

  /* 跨过 2560 断点时两种展开方式（内联卡片 ⇄ 右侧详情栏）要换轨，
     必须重渲染；否则会同时出现「表里展开着卡片」和「栏里也有卡片」。 */
  if (RAIL_MQ) {
    var onRailChange = function () { renderAll(); };
    if (RAIL_MQ.addEventListener) RAIL_MQ.addEventListener('change', onRailChange);
    else if (RAIL_MQ.addListener) RAIL_MQ.addListener(onRailChange);
  }

  renderFreshness();
  renderSrcline();
  renderChanges();
  renderTabs();
  renderFooter();
  renderAll();
})();
