/* 页面自检（DOM 桩冒烟测试）—— 常驻回归守卫，不是一次性脚本。
   在桩环境里跑 radar.js，并通过「捕获事件监听 → 派发合成事件」真正驱动交互：
     · 矩阵首屏
     · 6 个大类详情视图逐个切换
     · 3 种排序 × 3 种开源筛选 × 搜索 × 覆盖过滤
     · 展开每个模型卡片 + 悬停 tooltip
   断言无运行时错误、输出无 NaN/undefined/null、行列数与数据吻合。
   失败时 exit 1，可被 run_all.py / 计划任务当作闸门。
   用法： node tools/selftest.js   （不需要起本地服务器） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(DIR, 'data/app.json.js'), 'utf8');
const radarSrc = fs.readFileSync(path.join(DIR, 'scripts/radar.js'), 'utf8');
const histPath = path.join(DIR, 'data/history.json.js');
const histSrc = fs.existsSync(histPath) ? fs.readFileSync(histPath, 'utf8') : null;

/* ───────── DOM 桩 ─────────
   做成工厂是为了能开第二套环境：真实快照只有 1 天，走的是「积累中」降级路径；
   要验证折线本身，必须另起一套、喂一份合成的多天 HISTORY 进去。
   两套环境互不干扰（各自的 els / listeners / window）。 */
function makeEl(id, elListeners) {
  return {
    id, _html: '', textContent: '', hidden: false, dataset: {}, value: '', checked: false, clientWidth: 1440,
    style: { setProperty() {}, removeProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener(type, fn) { (elListeners[id + ':' + type] = elListeners[id + ':' + type] || []).push(fn); },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    getBoundingClientRect() { return { width: 220, height: 120 }; },
    closest() { return null; },
    querySelectorAll() { return []; },
  };
}

function newHarness(historySource, opts) {
  const o = opts || {};
  const els = {};
  const listeners = {};      // 事件类型 -> 处理函数数组
  const elListeners = {};    // 'id:type' -> 处理函数数组
  const document = {
    getElementById(id) { if (!els[id]) els[id] = makeEl(id, elListeners); return els[id]; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    body: makeEl('body', elListeners),
  };
  /* matchMedia 默认缺席（=> 窄屏，内联展开）；给 opts.rail 时只让 2560 那条命中，
     这样「CSS 断点」与「JS 分支」在测试里也是同一个真值来源。 */
  const mqLog = [];
  /* localStorage 桩：数据变化闪烁要跨「两次打开页面」比对，
     所以这个 store 必须能被测试读出来、改一改、再喂给下一套环境。 */
  const store = {};
  if (o.seed !== undefined) store['llmradar.bands.v1'] = o.seed;
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const window = {
    innerWidth: o.rail ? 3840 : 1600, innerHeight: 900, addEventListener() {}, localStorage,
    /* location 只在「?new=NN 覆盖窗口」那条路径上被读到。
       默认给空串 = 没有 URL 参数，走 APP.newWindowDays 默认值。 */
    location: { search: o.search || '' },
    matchMedia(query) {
      mqLog.push(query);
      return {
        media: query,
        matches: !!o.rail && /min-width:\s*2560px/.test(query),
        addEventListener() {}, removeEventListener() {}, addListener() {},
      };
    },
  };
  const ctx = { window, document, console, Date, Math, JSON, Object, Array, String, Number, isNaN, parseInt, parseFloat };
  vm.createContext(ctx);
  vm.runInContext(appSrc, ctx, { filename: 'app.json.js' });
  if (historySource) vm.runInContext(historySource, ctx, { filename: 'history.json.js' });
  /* 允许在 radar.js 跑起来之前改 APP。「新发布」标识要测窗口边界
     （第 45 天亮 / 第 46 天不亮），必须在渲染前就把 generatedAt、
     各模型的 releasedAt、newWindowDays 摆好，事后再改已经渲染完了。 */
  if (o.patch) o.patch(ctx.window.APP);
  vm.runInContext(radarSrc, ctx, { filename: 'radar.js' });
  return { els, listeners, elListeners, document, window, ctx, mqLog, store, APP: ctx.window.APP };
}

const H = newHarness(histSrc);
const { els, listeners, elListeners, document, window, ctx } = H;
const APP = H.APP;

/* ───────── 断言 ───────── */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++;
  else { fail++; console.log('  x ' + label + (extra ? '  ->  ' + extra : '')); }
}
function scan(label, html) {
  ok(html.indexOf('NaN') < 0, label + ' 无 NaN');
  ok(html.indexOf('undefined') < 0, label + ' 无 undefined');
  ok(!/>null</.test(html), label + ' 无 >null<');
}
const panel = id => els[id]._html || '';

/* ───────── 事件派发 ───────── */
function fire(type, selector, dataset, extra) {
  const target = {
    dataset: dataset || {}, value: extra && extra.value, checked: extra && extra.checked,
    closest(sel) { return sel === selector ? this : null; },
    classList: { toggle() {}, add() {}, remove() {} },
  };
  (listeners[type] || []).forEach(fn => fn(Object.assign({
    target, clientX: 400, clientY: 300, preventDefault() {},
  }, extra || {})));
}
const click = (sel, ds) => fire('click', sel, ds);
function setInput(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  (elListeners[id + ':input'] || []).forEach(fn => fn({ target: el }));
}
function setCheck(id, checked) {
  const el = document.getElementById(id);
  el.checked = checked;
  (elListeners[id + ':change'] || []).forEach(fn => fn({ target: el }));
}

function matrixStats() {
  const h = panel('matrix');
  const rows = h.split('data-row="').slice(1);
  const ids = rows.map(x => x.split('"')[0]);
  const cells = (h.match(/class="cell(?:\s[^"]*)?"/g) || []).length;
  return { rows: rows.length, cells, ids, html: h };
}
function dtableStats() {
  const h = panel('dtable');
  const cells = (h.match(/class="dval/g) || []).length;
  const models = (h.match(/data-toggle="/g) || []).length;
  return { cells, models, html: h };
}

/* ══════════ 1. 首屏矩阵 ══════════ */
let st = matrixStats();
ok(st.rows === APP.matrixIds.length, '首屏矩阵行数', st.rows + ' vs ' + APP.matrixIds.length);
ok(st.cells === st.rows * 17, '首屏矩阵格子 = 行 × 17', st.cells + ' vs ' + st.rows * 17);
scan('首屏矩阵', st.html);
scan('时效条', panel('freshness'));
scan('数据基准条', panel('srcline'));
scan('变更条', panel('changes'));
scan('视图切换', panel('viewtabs'));
scan('页脚', panel('footer-method') + panel('footer-gaps'));
ok((panel('viewtabs').match(/data-view="cat"/g) || []).length === 6, '6 个大类按钮');

/* ══════════ 2. 6 个大类详情 ══════════ */
APP.categories.forEach(c => {
  click('[data-view]', { view: 'cat', cat: c.key });
  ok(els['view-cat'].hidden === false && els['view-matrix'].hidden === true,
     '切到 ' + c.key + ' 视图可见性正确');
  const d = dtableStats();
  ok(d.models > 0, c.label + ' 有模型行', String(d.models));
  scan(c.label + ' 详情', d.html);
  let expCols = 0;
  c.subcats.forEach(k => {
    const s = APP.subcats[k];
    expCols += s.distinctSources.length + (s.singleSource ? 0 : 1);
  });
  ok(d.cells === d.models * expCols, c.label + ' 列数 = 模型数 × ' + expCols,
     d.cells + ' vs ' + (d.models * expCols));
  scan(c.label + ' 脚注', panel('cat-note'));
});

/* ══════════ 3. 排序 ══════════ */
click('[data-view]', { view: 'matrix' });
['coverage', 'best', 'name'].forEach(s => {
  click('#matrixsort button', { sort: s });
  const a = matrixStats();
  ok(a.rows === APP.matrixIds.length, '排序 ' + s + ' 行数不变', String(a.rows));
  scan('排序 ' + s, a.html);
  let sorted = true;
  for (let i = 1; i < a.ids.length; i++) {
    const A = APP.models[a.ids[i - 1]], B = APP.models[a.ids[i]];
    if (s === 'coverage' && !(A.coverage > B.coverage ||
      (A.coverage === B.coverage && A.bestRank <= B.bestRank))) sorted = false;
    if (s === 'best' && !(A.bestRank < B.bestRank ||
      (A.bestRank === B.bestRank && A.coverage >= B.coverage))) sorted = false;
  }
  ok(sorted, '排序 ' + s + ' 顺序正确');
});

/* ══════════ 4. 开源筛选 ══════════ */
click('#matrixsort button', { sort: 'coverage' });
const expOpen = APP.matrixIds.filter(i => APP.models[i].open).length;
[['all', APP.matrixIds.length], ['open', expOpen],
 ['closed', APP.matrixIds.length - expOpen]].forEach(p => {
  click('#openfilter button', { open: p[0] });
  const a = matrixStats();
  ok(a.rows === p[1], '开源筛选 ' + p[0] + ' 行数 = ' + p[1], String(a.rows));
  if (p[0] === 'open') ok(a.ids.every(i => APP.models[i].open), '开源筛选结果全为开源');
  if (p[0] === 'closed') ok(a.ids.every(i => !APP.models[i].open), '闭源筛选结果全为闭源');
  scan('筛选 ' + p[0], a.html);
});

/* ══════════ 5. 覆盖过滤 ══════════ */
click('#openfilter button', { open: 'all' });
setCheck('covfilter', true);
const expCov = APP.matrixIds.filter(i => (APP.models[i].coverage || 0) >= 3).length;
ok(matrixStats().rows === expCov, '覆盖>=3 过滤行数 = ' + expCov, String(matrixStats().rows));
scan('覆盖过滤', panel('matrix'));
setCheck('covfilter', false);

/* ══════════ 6. 搜索 ══════════ */
['claude', 'kimi', 'qwen', 'glm', 'zzzzz'].forEach(q => {
  setInput('q', q);
  const a = matrixStats();
  const exp = APP.matrixIds.filter(i => {
    const m = APP.models[i];
    return ((m.name || '') + ' ' + (m.vendor || '') + ' ' + i).toLowerCase().indexOf(q.toLowerCase()) >= 0;
  }).length;
  ok(a.rows === exp, '搜索 ' + q + ' 行数 = ' + exp, String(a.rows));
  scan('搜索 ' + q, a.html);
});
setInput('q', '');

/* ══════════ 7. 展开模型卡片 ══════════ */
let cardErr = 0, cardBad = 0;
APP.matrixIds.forEach(id => {
  try {
    click('[data-toggle]', { toggle: id });
    const h = panel('matrix');
    if (h.indexOf('mcard-grid') < 0) cardBad++;
    if (/NaN|undefined|>null</.test(h)) cardErr++;
    click('[data-toggle]', { toggle: id });
  } catch (e) { cardErr++; }
});
ok(cardBad === 0, '每个矩阵模型都能展开卡片', cardBad + ' 个失败');
ok(cardErr === 0, '展开渲染无 NaN/undefined', cardErr + ' 处');

click('[data-toggle]', { toggle: 'claude-fable-5.1' });
const fh = panel('matrix');
ok(fh.indexOf('全部落点') > 0, '卡片含「全部落点」');
ok(fh.indexOf('OpenRouter') > 0, '卡片含「去试」链接');
ok(fh.indexOf('$/任务（Agent）') > 0, '卡片含 Agent 每任务成本');
// 速度项必须「标签说的是秒、值也得是秒」。
// 曾经错成 <dt>首答 token</dt><dd>1.23 s</dd> —— 标签写 token 值却是秒。
ok(fh.indexOf('首答 token 时延') > 0 || fh.indexOf('首 token 时延') > 0, '卡片含首答时延（秒）');
ok(fh.indexOf('首答 token</dt>') < 0, '速度项标签与单位一致（无「首答 token」配秒值）');
// 缺数据也要占位成「—」，不能让整行消失 —— 否则用户分不清"没有这项指标"和"这个模型没数"
ok(/首 (token|答 token) 时延<\/dt><dd>(—|[\d.]+ s)<\/dd>/.test(fh), '速度缺数据时仍占一行（缺失≠无此指标）');
scan('Fable 5.1 卡片', fh);
click('[data-toggle]', { toggle: 'claude-fable-5.1' });

/* ══════════ 8. tooltip ══════════ */
let tipErr = 0;
['claude-fable-5.1|chat.text', 'gpt-6-astra|chat.text',
 'kimi-k3|agent.work', 'minimax-h3|video.i2v', 'gpt-image-2.5-sunburst|image.t2i']
  .forEach(cell => {
    try { fire('mouseover', '[data-cell]', { cell }); } catch (e) { tipErr++; }
    if (/NaN|undefined/.test(panel('tip'))) tipErr++;
  });
ok(tipErr === 0, 'tooltip 渲染无异常', tipErr + ' 处');
ok(panel('tip').indexOf('跨源分歧') > 0 || panel('tip').indexOf('单源') > 0, 'tooltip 含分歧度说明');

/* ══════════ 9. 数据层一致性 ══════════ */
let cellBad = 0, singleDv = 0, dvBad = 0, monoBad = 0, covBad = 0, rankBad = 0, pBad = 0;
APP.categories.forEach(c => {
  c.subcats.forEach(k => {
    const s = APP.subcats[k];
    if (s.distinctSources.indexOf(s.primary) < 0) pBad++;
    for (let i = 0; i < s.rows.length; i++) {
      const r = s.rows[i];
      const cc = APP.models[r.id].cells[k];
      const n = Object.keys(cc.values).length;
      if (n === 0) cellBad++;
      if (s.singleSource && cc.diverge != null) singleDv++;
      if (!s.singleSource && n >= 2 && cc.diverge == null) dvBad++;
      if (i && s.rows[i].primaryRank < s.rows[i - 1].primaryRank) monoBad++;
      if (cc.values[s.primary].rank !== r.primaryRank) rankBad++;
    }
  });
});
APP.matrixIds.forEach(id => {
  if (APP.models[id].coverage !== APP.models[id].seenIn.length) covBad++;
});
ok(cellBad === 0, '无空值行', String(cellBad));
ok(singleDv === 0, '单源子类分歧度为 null', String(singleDv));
ok(dvBad === 0, '多源行分歧度已计算', String(dvBad));
ok(monoBad === 0, '子类名次单调非降', String(monoBad));
ok(rankBad === 0, 'primaryRank 与源内名次一致', String(rankBad));
ok(covBad === 0, '覆盖广度自洽', String(covBad));
ok(pBad === 0, '主源在自己源列表内', String(pBad));

/* ══════════ 10. 单位口径 ══════════ */
// 百分数不应超过 100（净改善度允许为负）；指数 0~100；Elo 1000~2000
let unitBad = [], fmtBad = [];
APP.categories.forEach(c => c.subcats.forEach(k => {
  APP.subcats[k].rows.forEach(r => {
    Object.keys(r.values).forEach(sk => {
      const v = r.values[sk];
      const u = v.unit;
      if (['pct', 'pct100'].indexOf(u) < 0 && ['elo', 'index', 'score'].indexOf(u) < 0) unitBad.push(k + '/' + u);
      if (u === 'pct100' && (v.value > 100 || v.value < -50)) fmtBad.push(k + ' ' + v.value);
      if (u === 'pct' && (v.value > 1.0001 || v.value < -0.0001)) fmtBad.push(k + ' ' + v.value);
      if (u === 'elo' && (v.value < 900 || v.value > 2200)) fmtBad.push(k + ' elo=' + v.value);
    });
  });
}));
ok(unitBad.length === 0, '所有值使用已知单位', unitBad.slice(0, 5).join(','));
ok(fmtBad.length === 0, '所有值的量纲在合理区间', fmtBad.slice(0, 5).join(','));

/* 抽查渲染出的文本，不应出现 >200% 这种被重复放大的百分数 */
click('[data-view]', { view: 'cat', cat: 'general' });
const gh = panel('dtable');
ok(!/\d{3,}\.\d%/.test(gh), '通用能力表无三位数百分数', (gh.match(/\d{3,}\.\d%/g) || []).slice(0, 4).join(','));
click('[data-view]', { view: 'cat', cat: 'agent' });
const ah = panel('dtable');
ok(ah.indexOf('13.7%') > 0, 'agent 详情表显示 13.7%', ah.indexOf('13.7%'));
ok(panel('cathead').indexOf('13.71%') > 0, 'agent 主指标条显示 13.71%', panel('cathead').indexOf('13.71%'));
ok(!/\d{3,}\.\d%/.test(ah), 'agent 表无三位数百分数', (ah.match(/\d{3,}\.\d%/g) || []).slice(0, 4).join(','));
click('[data-view]', { view: 'matrix' });

/* ══════════ 11. 名次走势：多天夹具 ══════════
   真实 snapshots/ 目前只有 1 天，上面全套跑到的都是「积累中」降级路径。
   折线那条路径不测，等数据攒够了才发现画歪就晚了 —— 所以这里另起一套环境
   （独立的 els / listeners / window），喂一份合成的 6 天 HISTORY，专门盯：
   折线是否渲染、缺快照是否断线、三种方向是否都出得来、坐标有没有 NaN。 */
const DAYS = 6;
const FIX_TAGS = ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21'];

const FIX_SERIES = {};
APP.matrixIds.slice(0, 30).forEach((id, mi) => {
  const subs = {};
  APP.categories.forEach(c => c.subcats.forEach(k => {
    const cell = (APP.models[id].cells || {})[k];
    const v = cell && cell.values[APP.subcats[k].primary];
    if (!v) return;
    const base = v.rank;
    const arr = [];
    // mi%3 造出 上升 / 下降 / 持平 三种形态
    for (let d = 0; d < DAYS; d++) {
      const drift = mi % 3 === 0 ? -d : (mi % 3 === 1 ? d : 0);
      arr.push(Math.max(1, base + drift));
    }
    // 每第 4 条序列挖一个空档：验证「缺快照就断线」，而不是拿直线连过去
    if (mi % 4 === 0) arr[2] = null;
    subs[k] = arr;
  }));
  if (Object.keys(subs).length) FIX_SERIES[id] = subs;
});
const FIX = { builtAt: '2026-09-21T09:00:00+08:00', n: DAYS, tags: FIX_TAGS, series: FIX_SERIES };

const H2 = newHarness('window.HISTORY=' + JSON.stringify(FIX) + ';');
const els2 = H2.els;
const panel2 = id => (els2[id] ? els2[id]._html : '') || '';
function fire2(type, selector, dataset) {
  const target = {
    dataset: dataset || {},
    closest(sel) { return sel === selector ? this : null; },
    classList: { toggle() {}, add() {}, remove() {} },
  };
  (H2.listeners[type] || []).forEach(fn => fn({ target, clientX: 400, clientY: 300, preventDefault() {} }));
}

const mh = panel2('matrix');
const sparks = (mh.match(/class="cspk /g) || []).length;
const paths = mh.match(/<path d="[^"]*"/g) || [];
ok(sparks > 0, '夹具：矩阵格内出现微走势线', String(sparks));
ok(paths.length === sparks, '每条走势恰好一条折线', paths.length + ' vs ' + sparks);
ok(/class="cspk d-up"/.test(mh), '夹具：出现「名次上升」走势');
ok(/class="cspk d-down"/.test(mh), '夹具：出现「名次下降」走势');
// 全程持平的序列不画线（水平虚线在小尺寸下读起来像文字下划线，是噪声）
ok(!/class="cspk d-flat"/.test(mh), '夹具：全程持平的序列在矩阵里不画线');
ok((mh.match(/class="cspk /g) || []).length < (mh.match(/class="cell/g) || []).length,
  '夹具：并非每个格子都画线（留空携带「没动过」的语义）');
ok(!/NaN|undefined/.test(mh), '夹具：矩阵无 NaN/undefined');
ok(!/d="[^"]*(NaN|undefined)/.test(mh), '夹具：折线路径里没有非法坐标');
// 断线：缺快照处路径必须重开一段（一条路径里出现 2 个以上的 M）
const broken = paths.filter(p => (p.match(/M/g) || []).length >= 2).length;
ok(broken > 0, '夹具：缺快照处折线断开而非拉直', String(broken));
// 坐标必须落在 viewBox 内（18×8），否则线会画出格子外面
const oob = paths.filter(p => (p.match(/-?\d+\.\d/g) || []).some(n => {
  const v = parseFloat(n);
  return v < -0.01 || v > 18.01;
})).length;
ok(oob === 0, '夹具：微走势坐标在 18×8 视口内', String(oob));
console.log('  · 夹具走势：' + sparks + ' 条微折线 / ' + broken + ' 条断线 / 共 ' + paths.length + ' 条路径');

/* 展开卡片：走势列。
   故意挑 matrixIds[1]（夹具里 mi=1，drift=+d → 名次严格递增），
   保证这条序列一定不是「持平」，能稳定验到真实折线而不是「＝」占位。 */
fire2('click', '[data-toggle]', { toggle: APP.matrixIds[1] });
const ch = panel2('matrix');
ok(ch.indexOf('mcard-grid') > 0, '夹具：卡片已展开');
ok(ch.indexOf('走势（近 ' + DAYS + ' 天）') > 0, '卡片走势列标题带天数',
  ch.slice(ch.indexOf('走势'), ch.indexOf('走势') + 24));
ok(/class="tnum">\d+→\d+<\/b>/.test(ch), '卡片走势列给出「首次→最新」名次');
ok(/class="tspark d-down"/.test(ch), '卡片走势列画出下降折线');
ok(ch.indexOf('tpend') < 0, '该模型每条落点都有走势，无「积累中」残留');
// 平线不该以折线形态出现：持平一律走「＝」占位，矩阵里更是直接留空
ok(!/class="tspark d-flat"/.test(ch), '卡片里持平序列也不画平线，改用「＝」');
ok(ch.indexOf('走势（积累中') < 0, '数据够时不再显示「积累中」');
ok(!/NaN|undefined/.test(ch), '夹具：展开卡片无 NaN/undefined');

/* tooltip 里的走势 */
const fid = Object.keys(FIX_SERIES)[0];
const fsub = Object.keys(FIX_SERIES[fid])[0];
fire2('mouseover', '[data-cell]', { cell: fid + '|' + fsub });
const th = panel2('tip');
ok(th.indexOf('名次走势 · 近 ' + DAYS + ' 天') > 0, '夹具：tooltip 带走势标题');
ok(th.indexOf('tspark big') > 0, '夹具：tooltip 内折线已渲染');
ok(th.indexOf('09-16 #') > 0, '夹具：tooltip 列出逐日名次');
ok(!/NaN|undefined/.test(th), '夹具：tooltip 无 NaN/undefined');

/* 回落：把 HISTORY 抽掉不该崩，只该退化成「—」 */
const H3 = newHarness(null);
const mh3 = H3.els['matrix']._html || '';
ok(mh3.indexOf('class="cspk') < 0, '无 history.json.js 时不画走势');
ok(!/NaN|undefined/.test(mh3), '无 history.json.js 时矩阵仍无 NaN');

/* ══════════ 超宽屏详情栏（≥2560）══════════
   同一份 APP，只把 matchMedia 的 2560 查询打开，验证 JS 换轨：
   卡片进右侧栏、不再内联进表；选中项默认落在列表第一行。 */
const HR = newHarness(histSrc, { rail: true });
const rail = id => (HR.els[id] ? HR.els[id]._html || '' : '');
const mhR = rail('matrix');

ok(HR.mqLog.some(q => /min-width:\s*2560px/.test(q)), '超宽屏：探询了 2560 断点');
ok(mhR.indexOf('class="mcard"') < 0, '超宽屏：表内不再出现内联展开行');
ok(rail('detailrail').indexOf('railhead') > 0, '超宽屏：详情栏有标题条');
ok(rail('detailrail').indexOf('mcard-grid') > 0, '超宽屏：详情栏渲染了模型卡片');
ok(/<span class="railname">/.test(rail('detailrail')), '超宽屏：栏头带当前模型名');
ok(rail('matrix-note').indexOf('点行在右侧详情栏查看') > 0, '超宽屏：脚注改成「右侧详情栏」');
ok(rail('matrix-note').indexOf('点行展开') < 0, '超宽屏：脚注不再说「展开」');
scan('超宽屏 详情栏', rail('detailrail'));

// 默认选中 = 过滤后第一行
const HR_first = HR.APP.models[HR.APP.matrixIds[0]];
ok(rail('detailrail').indexOf(HR_first.name) > 0, '超宽屏：默认选中列表第一行',
  HR_first.name);
// 表里恰好一行带 .open 高亮
ok((mhR.match(/<tr class="open"/g) || []).length === 1, '超宽屏：矩阵恰好高亮一行');
ok((mhR.match(/<tr class="open"/g) || [])[0] !== undefined
  && mhR.indexOf('<tr class="open" data-row="' + HR.APP.matrixIds[0] + '"') > 0,
  '超宽屏：高亮的正是默认选中那行');

// 点另一行 → 栏内换成它
HR.fire = (type, selector, dataset) => {
  const target = { dataset: dataset || {}, closest(sel) { return sel === selector ? this : null; },
    classList: { toggle() {}, add() {}, remove() {} } };
  (HR.listeners[type] || []).forEach(fn => fn({ target, clientX: 400, clientY: 300, preventDefault() {} }));
};
const second = HR.APP.matrixIds[1];
HR.fire('click', '[data-toggle]', { toggle: second });
ok(rail('detailrail').indexOf(HR.APP.models[second].name) > 0, '超宽屏：点第二行后栏内换成它',
  HR.APP.models[second].name);
ok((rail('matrix').match(/<tr class="open"/g) || []).length === 1, '超宽屏：切换后仍只高亮一行');
ok(rail('matrix').indexOf('<tr class="open" data-row="' + second + '"') > 0,
  '超宽屏：高亮跟着切到第二行');
scan('超宽屏 切换后', rail('detailrail'));

// 筛到空集时栏不能空着崩掉
HR.fire('click', '#openfilter button', { open: 'closed' });
HR.els['q'].value = 'zzz-不存在的模型-zzz';
(HR.elListeners['q:input'] || []).forEach(fn => fn({ target: HR.els['q'] }));
ok(rail('matrix').indexOf('class="empty"') > 0, '超宽屏：筛到空集时矩阵给出空态');
ok(rail('detailrail').indexOf('detailempty') > 0, '超宽屏：筛到空集时详情栏给出空态');
scan('超宽屏 空集', rail('detailrail'));

/* ══════════ 数据变化闪烁（animation，不是 transition）══════════
   这个功能真实的失败方式不是「不闪」，而是「乱闪」——
   排序、筛选、搜索、刷新页面都会重渲染，而 animation 在新建节点上一定会跑。
   所以四个场景里有两个守的是「不许闪」。 */
{
  const mkFire = (Fx) => (type, selector, dataset, extra) => {
    const target = {
      dataset: dataset || {}, value: extra && extra.value,
      closest(sel) { return sel === selector ? this : null; },
      classList: { toggle() {}, add() {}, remove() {} },
    };
    (Fx.listeners[type] || []).forEach(fn => fn(Object.assign(
      { target, clientX: 400, clientY: 300, preventDefault() {} }, extra || {})));
  };
  const nFlash = (html) => (html.match(/class="cellbtn[^"]*\bflash\b/g) || []).length;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* 场景 1 —— 第一次访问：一格都不许闪，但要顺手把基线留下 */
  const F1 = newHarness(histSrc);
  const m1 = F1.els['matrix']._html;
  ok((m1.match(/class="cellbtn q\d/g) || []).length > 100, '闪烁·1：矩阵有热力格',
    String((m1.match(/class="cellbtn q\d/g) || []).length));
  ok(nFlash(m1) === 0, '闪烁·1：首次访问（无历史基线）不闪任何格子', String(nFlash(m1)));

  const saved = F1.store['llmradar.bands.v1'];
  ok(!!saved, '闪烁·1：渲染后已把档位基线写入 localStorage');
  let rec = null;
  try { rec = JSON.parse(saved); } catch (e) {}
  ok(!!rec && rec.gen === APP.generatedAt, '闪烁·1：基线记住本次数据的时间戳', rec && rec.gen);
  ok(!!rec && Object.keys(rec.bands).length > 100,
    '闪烁·1：基线存的是全量档位，不是当前筛选子集',
    rec && String(Object.keys(rec.bands).length));

  /* 场景 2 —— 数据没重抓（时间戳相同）：再打开一次也不许闪 */
  const F2 = newHarness(histSrc, { seed: saved });
  ok(nFlash(F2.els['matrix']._html) === 0,
    '闪烁·2：generatedAt 未变 → 刷新页面不闪（否则每次打开都满屏乱闪）',
    String(nFlash(F2.els['matrix']._html)));

  /* 场景 3 —— 数据重抓 + 只改一个格子的档位：只闪那一个 */
  const firstCell = (m1.match(/data-cell="([^"]+)"/) || [])[1];
  ok(!!firstCell, '闪烁·3：能从渲染结果里取到一个样本格子', firstCell);
  const mut = JSON.parse(saved);
  mut.gen = '2000-01-01T00:00:00+08:00';            // 假装数据重抓过
  mut.bands[firstCell] = (mut.bands[firstCell] % 6) + 1;   // 改成一个不同的档
  const F3 = newHarness(histSrc, { seed: JSON.stringify(mut) });
  const m3 = F3.els['matrix']._html;
  ok(nFlash(m3) === 1, '闪烁·3：只有那个变档的格子闪', String(nFlash(m3)));
  ok(new RegExp('class="cellbtn[^"]*\\bflash\\b" data-cell="' + escRe(firstCell) + '"').test(m3),
    '闪烁·3：闪的正是被改动的那一格（不是随便一个）', firstCell);

  /* 场景 4 —— 之后的重渲染不许重放动画（否则第一次点排序就变成频闪灯） */
  const before4 = nFlash(F3.els['matrix']._html);
  mkFire(F3)('click', '#matrixsort button', { sort: 'coverage' });
  const after4 = nFlash(F3.els['matrix']._html);
  ok(before4 === 1 && after4 === 0, '闪烁·4：重渲染不重放（闪过的表已作废）',
    before4 + ' -> ' + after4);

  /* 场景 5 —— 新增落点也要闪：基线里「没有这个格子」时，这次有值 = 新增，该闪。
     ⚠️ 样本必须取渲染得到的格子：模型的默认排序会筛掉低覆盖的，
     随便挑一个 bands 里的键很可能根本不在表上（上一版就踩了这个坑）。 */
  const mut2 = JSON.parse(saved);
  mut2.gen = '2000-01-01T00:00:00+08:00';
  delete mut2.bands[firstCell];
  const F4 = newHarness(histSrc, { seed: JSON.stringify(mut2) });
  const m4 = F4.els['matrix']._html;
  ok(nFlash(m4) === 1, '闪烁·5：基线里缺的落点算作「新增」，只闪它一个',
    firstCell + ' flash=' + nFlash(m4));

  /* 场景 6 —— 脚注必须解释「为什么会闪」，否则用户会当成 bug。
     计数口径是「实际渲染出来的格子」，不是 computeFlash 的全量结果 ——
     两者在默认筛选下并不相等。 */
  const noteOf = (Fx) => (Fx.els['matrix-note'] ? Fx.els['matrix-note']._html : '') || '';
  const n3 = noteOf(F3);
  ok(/1 格闪过/.test(n3), '闪烁·6：脚注给出闪过的格子数（实际渲染出来的那些）',
    n3.slice(Math.max(0, n3.indexOf('格闪过') - 14), n3.indexOf('格闪过') + 34));
  ok(/档位变了/.test(n3), '闪烁·6：脚注说明原因是「档位变了」');
  ok(!/格闪过/.test(noteOf(F1)), '闪烁·6：没有闪过时脚注不提这件事');
}

/* ══════════ 「新发布」标识 ══════════
   这个功能最会骗人的地方不是「标错」，而是「沉默」—— 源里查不到发布日期的模型
   不带标识，看上去和「不新」一模一样。所以这里一半断言守的是
   「无日期 / 出窗口 / 在窗口内 三种状态必须能区分开」；
   另一半守窗口边界：差一天就不该亮（`<=` 写成 `<` 会漏掉整条边界）。 */
{
  const REF = '2026-09-22T09:00:00+08:00';
  const W = 45;
  const nBadge = (h) => (h.match(/class="newbadge"/g) || []).length;
  const rowHTML = (h, id) => {
    const i = h.indexOf('data-row="' + id + '"');
    if (i < 0) return '';
    const j = h.indexOf('data-row="', i + 5);
    return h.slice(i, j < 0 ? h.length : j);
  };
  let IN_ID = null, OUT_ID = null, NONE_ID = null, BAD_ID = null;

  /* 夹具：把真实数据里的发布日期全部清掉，只给三个模型摆上受控的值。
     2026-09-22 往回数：45 天 = 08-08（边界内），46 天 = 08-07（刚出窗口）。 */
  const patch = (a) => {
    a.generatedAt = REF;
    a.newWindowDays = W;
    Object.keys(a.models).forEach(k => { delete a.models[k].releasedAt; });
    if (!IN_ID) {
      IN_ID = a.matrixIds[0]; OUT_ID = a.matrixIds[1];
      NONE_ID = a.matrixIds[2]; BAD_ID = a.matrixIds[3];
    }
    a.models[IN_ID].releasedAt = '2026-08-08';      // 恰好 45 天
    a.models[OUT_ID].releasedAt = '2026-08-07';     // 46 天
    a.models[BAD_ID].releasedAt = '不是日期';        // 有字段但解析不了
  };

  const B1 = newHarness(histSrc, { patch });
  const mB = B1.els['matrix']._html || '';
  ok(nBadge(mB) === 1, '新发布·1：整表只亮一个标识（夹具里只有一条在窗口内）',
    '窗口 ' + W + ' -> ' + nBadge(mB) + ' 个');
  ok(rowHTML(mB, IN_ID).indexOf('newbadge') > 0,
    '新发布·1：距今恰好 ' + W + ' 天算「新」（边界含在内）', IN_ID);
  ok(rowHTML(mB, OUT_ID).indexOf('newbadge') < 0,
    '新发布·1：距今 ' + (W + 1) + ' 天不算（差一天就不亮）', OUT_ID);
  ok(rowHTML(mB, NONE_ID).indexOf('newbadge') < 0,
    '新发布·1：源里没有发布日期的模型不给标识', NONE_ID);
  ok(rowHTML(mB, BAD_ID).indexOf('newbadge') < 0,
    '新发布·1：日期解析不了的模型不给标识（也不许算成今天）', BAD_ID);
  ok(/caret">▶<\/span><span class="newbadge">新<\/span><span class="mname">/.test(rowHTML(mB, IN_ID)),
    '新发布·1：徽章插在 caret 与名字之间，且是单字「新」');

  /* URL 覆盖：窗口必须能在运行时改，否则「换多少天」就得重新构建数据 */
  const B2 = newHarness(histSrc, { patch, search: '?new=0' });
  ok(nBadge(B2.els['matrix']._html) === 0, '新发布·2：?new=0 关掉这个标识',
    String(nBadge(B2.els['matrix']._html)));
  const B3 = newHarness(histSrc, { patch, search: '?new=90' });
  ok(nBadge(B3.els['matrix']._html) === 2, '新发布·2：?new=90 把 46 天那条也收进来',
    String(nBadge(B3.els['matrix']._html)));
  const B4 = newHarness(histSrc, { patch, search: '?new=abc&x=1' });
  ok(nBadge(B4.els['matrix']._html) === 1,
    '新发布·2：URL 参数不合法时回落到 APP.newWindowDays，不崩',
    String(nBadge(B4.els['matrix']._html)));

  /* Tooltip —— 三种状态必须说三种话 */
  const tipOf = (Fx, sel, dataset) => {
    const target = { dataset, closest(s) { return s === sel ? this : null; } };
    (Fx.listeners['mouseover'] || []).forEach(fn => fn({ target, clientX: 400, clientY: 300 }));
    return Fx.els['tip']._html || '';
  };
  const tIn = tipOf(B1, '[data-model]', { model: IN_ID });
  ok(/2026-08-08/.test(tIn) && new RegExp('距今 ' + W + ' 天').test(tIn),
    '新发布·3：带标识的模型 tooltip 写明发布日期与天数', tIn.slice(0, 80));
  ok(/<b>有<\/b>/.test(tIn), '新发布·3：tooltip 明确说「有」标识');
  const tOut = tipOf(B1, '[data-model]', { model: OUT_ID });
  ok(/距今 46 天/.test(tOut) && /超出窗口/.test(tOut),
    '新发布·4：出窗口的模型 tooltip 说的是「已超出窗口」，不是「源里没有」', tOut.slice(0, 80));
  const tNone = tipOf(B1, '[data-model]', { model: NONE_ID });
  ok(/llm-stats 无此模型/.test(tNone),
    '新发布·5：没日期的模型 tooltip 必须写明「llm-stats 无此模型」', tNone.slice(0, 80));
  ok(/不等于它不新/.test(tNone), '新发布·5：tooltip 把「无日期」和「不新」区分开');
  const tBad = tipOf(B1, '[data-model]', { model: BAD_ID });
  ok(/格式无法解析/.test(tBad) && !/无此模型/.test(tBad),
    '新发布·5：字段存在但解析不了时，tooltip 说的是解析失败，不冒充「源里没有」');

  /* 脚注：窗口天数 + 计数都要跟着实际渲染走 */
  const note1 = B1.els['matrix-note']._html || '';
  ok(new RegExp('最近 ' + W + ' 天内发布').test(note1), '新发布·6：脚注写明窗口天数');
  ok(/上面 114 个里有 <b>1<\/b> 个/.test(note1), '新发布·6：脚注给出亮标数',
    (note1.match(/上面 \d+ 个里有 <b>\d+<\/b> 个/) || ['(没找到)'])[0]);
  ok(/不等于模型不新/.test(note1), '新发布·6：脚注点明「没有标记 ≠ 不新」');
  const qEl = B1.document.getElementById('q');
  qEl.value = 'zzz-不存在的模型-zzz';
  (B1.elListeners['q:input'] || []).forEach(fn => fn({ target: qEl }));
  const note2 = B1.els['matrix-note']._html || '';
  ok(/上面 0 个里有 <b>0<\/b> 个/.test(note2),
    '新发布·6：筛选后脚注计数跟着变（不是写死的）',
    (note2.match(/上面 \d+ 个里有 <b>\d+<\/b> 个/) || ['(没找到)'])[0]);
  ok(nBadge(B1.els['matrix']._html) === 0, '新发布·6：筛到空集时标识也归零');
}

/* ══════════ 汇总 ══════════ */
console.log('');
const nsub = APP.categories.reduce((a, c) => a + c.subcats.length, 0);
console.log('矩阵：' + APP.matrixIds.length + ' 行 × ' + nsub + ' 列');
console.log('模型库：' + Object.keys(APP.models).length + ' 个｜开源 '
  + Object.keys(APP.models).filter(i => APP.models[i].open).length + ' 个');
console.log('单源子类：' + Object.keys(APP.subcats).filter(k => APP.subcats[k].singleSource).length + ' / ' + nsub);
console.log('大类：' + APP.categories.map(c => c.key + '(' + c.subcats.length + ')').join(' '));
console.log('');
console.log('PASS ' + pass + ' ／ FAIL ' + fail);
process.exit(fail ? 1 : 0);
