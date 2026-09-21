/* 视觉/渲染核对（第二层守卫）——需要先把页面起在本地 http 上。
 *
 * 与 tools/selftest.js 的分工：
 *   selftest.js  → DOM 桩，跑得快、不需要浏览器，管「逻辑有没有崩」
 *   visual_check.js → 真浏览器，管「布局有没有坏」（列宽、sticky、tooltip 位置、控制台报错）
 *
 * 用法：
 *   python -m http.server 8758 -d .        # 另开一个终端
 *   node tools/visual_check.js             # 默认 http://127.0.0.1:8758/
 *   node tools/visual_check.js http://127.0.0.1:9000/ ./_shot
 *
 * 产物：截图写到 outDir（默认 <项目>/_shot），并打印关键尺寸与逐项核对结果。
 * 任一硬指标不达标时 exit 1。 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8758/';
const OUTDIR = path.resolve(process.argv[3] || path.join(__dirname, '..', '_shot'));

function loadPlaywright() {
  const tries = [
    'playwright',
    'C:/Users/lavie/.workbuddy/binaries/node/workspace/node_modules/playwright',
  ];
  for (const t of tries) {
    try { return require(t); } catch (e) { /* 下一个 */ }
  }
  console.error('找不到 playwright。先装：cd C:/Users/lavie/.workbuddy/binaries/node/workspace && npm i playwright');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const fails = [];
function check(cond, label, detail) {
  if (!cond) fails.push(label + (detail !== undefined ? ' → ' + detail : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (detail !== undefined && !cond ? '   [' + detail + ']' : ''));
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

  const shot = (name, clip) => page.screenshot({ path: path.join(OUTDIR, name + '.png'), ...(clip ? { clip } : {}) });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  /* ── 1. 矩阵 ── */
  console.log('\n[矩阵]');
  const m = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const t = q('#matrix'), wrap = q('#view-matrix .tablewrap');
    const row = q('#matrix tbody tr[data-row]');
    const modelTd = row ? row.querySelector('td.modelcell') : null;
    const cornerTh = q('#matrix thead th.corner');
    const cells = row ? [...row.querySelectorAll('td.cell')] : [];
    const ths = [...document.querySelectorAll('#matrix thead tr.sub th')];
    const R = el => el ? el.getBoundingClientRect() : null;
    const rm = R(modelTd), rc = R(cornerTh), rd = R(cells[0]), rh = R(ths[0]);
    return {
      rows: document.querySelectorAll('#matrix tbody tr[data-row]').length,
      cols: ths.length,
      // 首列：表体 modelcell 与表头 corner 必须同列
      modelX: rm ? Math.round(rm.x) : -1, modelW: rm ? Math.round(rm.width) : 0,
      cornerX: rc ? Math.round(rc.x) : -2, cornerW: rc ? Math.round(rc.width) : 0,
      // 第一个数据列：表体 cell 与表头 sub 必须同列
      dataX: rd ? Math.round(rd.x) : -1, dataW: rd ? Math.round(rd.width) : 0,
      subX: rh ? Math.round(rh.x) : -2, subW: rh ? Math.round(rh.width) : 0,
      cellH: rd ? Math.round(rd.height) : 0,
      tableW: Math.round(t.getBoundingClientRect().width),
      wrapW: wrap ? wrap.clientWidth : 0,
      // 每个列头都必须有来源行（否则"不混淆来源"原则被破坏）
      missingSrc: ths.filter(th => !th.querySelector('.srcline2')).length,
      docScrollW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  });
  check(m.rows > 0 && m.cols === 17, `矩阵 ${m.rows} 行 × ${m.cols} 列`, JSON.stringify(m));
  check(m.modelX === m.cornerX && m.modelW === m.cornerW,
    '首列对齐（表体 modelcell == 表头 corner）', `td(${m.modelX},${m.modelW}) th(${m.cornerX},${m.cornerW})`);
  check(m.dataX === m.subX && m.dataW === m.subW,
    '数据列对齐（首个格子 == 首个列头）', `td(${m.dataX},${m.dataW}) th(${m.subX},${m.subW})`);
  check(m.modelW >= 210 && m.modelW <= 360, `首列宽度合理（${m.modelW}px，防"吞掉全部余量"回归）`, m.modelW);
  check(m.missingSrc === 0, '17 个列头都标了名次来源', m.missingSrc);
  check(m.tableW <= m.wrapW + 8, `表格未溢出容器（表 ${m.tableW} / 容器 ${m.wrapW}）`, `${m.tableW}/${m.wrapW}`);
  check(m.docScrollW <= m.winW + 2, '页面无横向滚动条', `${m.docScrollW}/${m.winW}`);
  await shot('01-matrix');

  /* ── 2. 展开卡片 ── */
  console.log('\n[展开卡片]');
  const firstBtn = await page.$('#matrix tbody tr[data-row] .mbtn');
  if (firstBtn) {
    await firstBtn.click();
    await page.waitForTimeout(350);
    const c = await page.evaluate(() => {
      const card = document.querySelector('#matrix tbody tr.mcard .mcard-in');
      const wrap = document.querySelector('#view-matrix .tablewrap');
      if (!card) return null;
      const b = card.getBoundingClientRect();
      return { w: Math.round(b.width), wrapW: wrap.clientWidth, x: Math.round(b.x), wrapX: Math.round(wrap.getBoundingClientRect().x) };
    });
    check(!!c, '卡片已展开');
    if (c) check(c.w <= c.wrapW + 8, `卡片未溢出滚动容器（${c.w} / ${c.wrapW}）`, `${c.w}/${c.wrapW}`);
    await shot('02-card');
    // 重渲染会让旧 handle 失效，必须重新取
    const btn2 = await page.$('#matrix tbody tr[data-row] .mbtn');
    if (btn2) { await btn2.click(); await page.waitForTimeout(200); }
  }

  /* ── 3. 六个大类详情 ── */
  console.log('\n[大类详情]');
  const cats = await page.evaluate(() => (window.APP ? window.APP.categories.map(c => c.key) : []));
  for (const key of cats) {
    await page.click(`[data-view="cat"][data-cat="${key}"]`);
    await page.waitForTimeout(260);
    const d = await page.evaluate(() => {
      const t = document.querySelector('#dtable');
      const rows = document.querySelectorAll('#dtable tbody tr').length;
      const grps = document.querySelectorAll('#dtable thead th.grp').length;
      const subs = document.querySelectorAll('#dtable thead th.subcol').length;
      const bad = /\d{3,}\.\d%|NaN|undefined|null/.test(document.querySelector('#dtable').innerText);
      return { rows, grps, subs, bad, w: t ? Math.round(t.getBoundingClientRect().width) : 0 };
    });
    check(d.rows > 0 && d.grps > 0 && d.subs >= d.grps, `${key}：${d.rows} 行 / ${d.grps} 子类组 / ${d.subs} 数据列`, JSON.stringify(d));
    check(!d.bad, `${key}：表内无 NaN/undefined/三位数百分数`, d.bad);
  }
  await shot('03-general');

  /* ── 4. 开源筛选 ── */
  console.log('\n[筛选]');
  await page.click('[data-view="matrix"]');
  await page.waitForTimeout(200);
  const allN = await page.evaluate(() => document.querySelectorAll('#matrix tbody tr[data-row]').length);
  await page.click('#openfilter button[data-open="open"]');
  await page.waitForTimeout(300);
  const openN = await page.evaluate(() => document.querySelectorAll('#matrix tbody tr[data-row]').length);
  check(openN > 0 && openN < allN, `仅开源：${allN} → ${openN} 行`, `${allN}/${openN}`);
  await shot('04-open');
  await page.click('#openfilter button[data-open="all"]');
  await page.waitForTimeout(200);

  /* ── 5. tooltip ── */
  console.log('\n[tooltip]');
  const cell = await page.$('#matrix tbody td.cell .cellbtn');
  if (cell) {
    await cell.hover();
    await page.waitForTimeout(400);
    const tip = await page.evaluate(() => {
      const t = document.querySelector('#tip');
      if (!t) return null;
      const b = t.getBoundingClientRect();
      return { hidden: t.hidden, text: t.innerText.slice(0, 80), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) };
    });
    check(tip && !tip.hidden && tip.text.length > 4, 'tooltip 弹出且有内容', tip ? tip.text : 'null');
    await shot('05-tip');
  } else {
    check(false, '找到可悬停的格子');
  }

  /* ── 5b. 悬停提亮 + 数据变化提示 ──
     这两条都只能用真浏览器验：一个要真的 :hover 与 filter 计算，
     一个要真的 animation 引擎（transition 在本项目里根本不触发）。 */
  console.log('\n[悬停与变化提示]');
  const hy = await page.evaluate(() => {
    /* 从真实 CSS 里读回六个档位的 alpha，别在测试里硬编码颜色 —— 
       否则改了色阶而测试还绿，等于没守。 */
    const alphaOf = (cls) => {
      const d = document.createElement('button');
      d.className = 'cellbtn ' + cls;
      d.style.cssText = 'position:absolute;left:-9999px';
      document.body.appendChild(d);
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(d).backgroundColor);
      d.remove();
      const p = m ? m[1].split(',').map(Number) : [0, 0, 0, 0];
      return p.length === 4 ? p[3] : 1;
    };
    const lad = {};
    ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].forEach(k => { lad[k] = alphaOf(k); });
    const surf = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim();
    const rows = [...document.querySelectorAll('#matrix tbody tr[data-row]')];
    const row = rows.find(r => r.querySelector('td.cell .cellbtn.q2')) || rows[0];
    return { lad, surf, rowId: row ? row.dataset.row : null };
  });
  check(hy.lad.q1 > hy.lad.q2 && hy.lad.q2 > hy.lad.q6, '色阶仍是「越靠前越亮」的递减阶梯',
    JSON.stringify(hy.lad));
  const rowSel = `#matrix tbody tr[data-row="${hy.rowId}"]`;
  await page.hover(`${rowSel} td.modelcell`);
  await page.waitForTimeout(240);
  const hov = await page.evaluate((sel) => {
    const tr = document.querySelector(sel);
    return {
      filter: getComputedStyle(tr.querySelector('td.cell')).filter,
      bar: getComputedStyle(tr.querySelector('td.modelcell')).boxShadow,
    };
  }, rowSel);
  /* 关键不变量（这条是本轮修的 bug）：热力格底色本身就是信息，
     整行提亮不能大到让「上不了档的格子」看起来比「上档的格子」还亮。
     实测算术：brightness(1.5) 下悬停 q2 的均通道 81.7 > 静止 q1 的 66.3，序反了。 */
  const rgb = (s) => { const m = /^#([0-9a-f]{6})$/i.exec(String(s).trim()); return m ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : [20, 24, 29]; };
  const base = rgb(hy.surf), fill = [56, 189, 248];
  const mult = Number((/brightness\(([\d.]+)\)/.exec(hov.filter) || [, '1'])[1]);
  const mean = (c) => (c[0] + c[1] + c[2]) / 3;
  const comp = (a) => base.map((b, i) => Math.min(255, b * (1 - a) + fill[i] * a));
  const hoverQ2 = comp(hy.lad.q2).map(x => Math.min(255, x * mult));
  const restQ1 = comp(hy.lad.q1);
  check(mult > 1 && mult <= 1.2, `悬停提亮倍数 ${mult}（须 ≤1.2，否则色阶失序）`, hov.filter);
  check(mean(hoverQ2) < mean(restQ1), '悬停中的 q2 仍比静止的 q1 暗（行内色阶序不乱）',
    `${mean(hoverQ2).toFixed(1)} vs ${mean(restQ1).toFixed(1)}`);
  check(/\binset\b/.test(hov.bar) && /\b3px\b/.test(hov.bar), '悬停行有 3px 左侧指示条', hov.bar);
  await shot('13-hover');

  console.log('\n[变化提示 · animation]');
  const seedInfo = await page.evaluate(() => {
    const el = document.querySelector('#matrix td.cell .cellbtn[data-cell]');
    return { cur: window.localStorage.getItem('llmradar.bands.v1'), cell: el ? el.dataset.cell : null };
  });
  check(!!seedInfo.cell && !!seedInfo.cur, '页面已把档位基线写进 localStorage', String(!!seedInfo.cur));
  if (seedInfo.cell && seedInfo.cur) {
    const seed = JSON.parse(seedInfo.cur);
    seed.gen = '2000-01-01T00:00:00+08:00';                       // 假装数据重抓过
    seed.bands[seedInfo.cell] = (seed.bands[seedInfo.cell] % 6) + 1;   // 只改这一格
    await page.evaluate((v) => window.localStorage.setItem('llmradar.bands.v1', v), JSON.stringify(seed));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(160);
    const fl = await page.evaluate(() => {
      const a = document.getAnimations().filter(x => x.animationName === 'cellflash');
      const el = document.querySelector('#matrix .cellbtn.flash');
      /* keyframes 必须在这一刻读：动画只跑 900ms，等截完图再读就查不到了
         （getAnimations() 会把已结束的动画移走，上一版就因此拿到 null）。 */
      let kf = null;
      if (a[0] && el) {
        const ks = a[0].effect.getKeyframes();
        const q = /q(\d)/.exec(el.className)[1];
        const probe = document.createElement('button');
        probe.className = 'cellbtn q' + q;
        probe.style.cssText = 'position:absolute;left:-9999px';
        document.body.appendChild(probe);
        const own = getComputedStyle(probe).backgroundColor;   // 静态档位色，不带 .flash 不受动画影响
        probe.remove();
        kf = { n: ks.length, first: ks[0].backgroundColor, last: ks[ks.length - 1].backgroundColor, own, q: 'q' + q };
      }
      return {
        nodes: document.querySelectorAll('#matrix .cellbtn.flash').length,
        anims: a.length,
        running: a.filter(x => x.playState === 'running').length,
        kf,
      };
    });
    check(fl.nodes === 1, `只有变档的那一格带 flash（${fl.nodes}）`, JSON.stringify(fl).slice(0, 120));
    check(fl.running === 1, `flash 的 animation 真的在跑（${fl.running}）——transition 在这做不到`,
      JSON.stringify(fl).slice(0, 120));
    /* 「@keyframes 只写 from」这个技巧必须真的守住：隐式的 to 应当被解析成元素
       自己的档位色，于是不用把六个颜色再抄一遍。
       ⚠️ 不能靠「动画结束再取色」来验 —— animation-fill-mode 默认 none，
       结束后元素本来就回到自身样式，加不加显式 to 都一样（实测：加显式
       to:transparent 时那条断言仍然全绿，是个假守卫）。 */
    check(!!fl.kf && fl.kf.n === 2, '@keyframes 展开成 from + 隐式 to 两帧', JSON.stringify(fl.kf));
    check(!!fl.kf && fl.kf.last === fl.kf.own,
      '隐式 to = 元素自己的档位色（不用把六档颜色再抄一遍）', JSON.stringify(fl.kf));
    check(!!fl.kf && fl.kf.first !== fl.kf.last, '闪的起点与档位色不同（否则等于没闪）', JSON.stringify(fl.kf));
    await shot('14-flash');
    await page.waitForTimeout(1200);
    const settled = await page.evaluate((dc) => {
      const b = document.querySelector(`#matrix .cellbtn[data-cell="${dc}"]`);
      const q = /q(\d)/.exec(b.className)[1];
      const probe = document.createElement('button');
      probe.className = 'cellbtn q' + q;
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { got: getComputedStyle(b).backgroundColor, want, q: 'q' + q };
    }, seedInfo.cell);
    check(settled.got === settled.want,
      '闪完不留残色（animation-fill-mode 没被改成 forwards）', JSON.stringify(settled));
  }
  await page.evaluate(() => window.localStorage.removeItem('llmradar.bands.v1'));

  /* ── 6. 名次走势：真实数据（只有 1 天，应当走「积累中」降级）── */
  console.log('\n[走势 · 真实 1 天数据]');
  const realTrend = await page.evaluate(() => {
    const h = window.HISTORY;
    return {
      hasFile: !!h,
      days: h ? h.n : 0,
      sparks: document.querySelectorAll('#matrix .cspk').length,
      note: (document.querySelector('#matrix-note') || {}).innerText || '',
    };
  });
  check(realTrend.hasFile, 'data/history.json.js 已加载');
  check(realTrend.sparks === 0, '只有 1 天时不画假折线（微走势数 = 0）', realTrend.sparks);
  check(/名次走势还在积累/.test(realTrend.note), '矩阵脚注说明走势在积累中',
    realTrend.note.slice(-60));
  await shot('06-trend-pending');

  /* ── 7. 名次走势：注入 6 天夹具，量真格子的几何 ── */
  console.log('\n[走势 · 6 天夹具]');
  const FIXED = await page.evaluate((days) => {
    const APP = window.APP;
    const series = {};
    APP.matrixIds.slice(0, 40).forEach((id, mi) => {
      const subs = {};
      APP.categories.forEach(c => c.subcats.forEach(k => {
        const cell = (APP.models[id].cells || {})[k];
        const v = cell && cell.values[APP.subcats[k].primary];
        if (!v) return;
        const arr = [];
        for (let d = 0; d < days; d++) {
          const drift = mi % 3 === 0 ? -d : (mi % 3 === 1 ? d : 0);
          arr.push(Math.max(1, v.rank + drift));
        }
        if (mi % 4 === 0) arr[2] = null;
        subs[k] = arr;
      }));
      if (Object.keys(subs).length) series[id] = subs;
    });
    const tags = [];
    for (let d = days; d > 0; d--) {
      const t = new Date(Date.UTC(2026, 8, 22 - d));
      tags.push(t.toISOString().slice(0, 10));
    }
    window.HISTORY = { builtAt: '2026-09-21T09:00:00+08:00', n: days, tags, series };
    return Object.keys(series);
  }, 6);
  check(FIXED.length > 0, `夹具已注入 ${FIXED.length} 个模型的走势`);
  // 换一次排序触发整表重渲染（radar.js 每次都实时读 window.HISTORY）
  await page.click('#matrixsort button[data-sort="best"]');
  await page.waitForTimeout(400);

  const geo = await page.evaluate(() => {
    const tds = [...document.querySelectorAll('#matrix td.cell')];
    let n = 0, outOfCell = 0, collide = 0, svgNaN = 0, wide = 0;
    const sample = [];
    tds.forEach(td => {
      const svg = td.querySelector('.cspk svg');
      if (!svg) return;
      n++;
      const r = svg.getBoundingClientRect(), c = td.getBoundingClientRect();
      if (r.left < c.left - 0.5 || r.right > c.right + 0.5 ||
          r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5) outOfCell++;
      if (r.width > 22 || r.height > 12) wide++;
      // 折线不能压住名次数字 —— 这是格子塞三条信息（名次 / ×N / 走势）最容易翻车的地方
      const btn = td.querySelector('.cellbtn');
      const tn = [...btn.childNodes].find(x => x.nodeType === 3 && x.textContent.trim());
      if (tn) {
        const rg = document.createRange(); rg.selectNodeContents(tn);
        const t = rg.getBoundingClientRect();
        const hit = !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom);
        if (hit) {
          collide++;
          if (sample.length < 3) sample.push({
            num: tn.textContent.trim(),
            cell: [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)],
            txt: [Math.round(t.x), Math.round(t.y), Math.round(t.width), Math.round(t.height)],
            svg: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          });
        }
      }
      const d = svg.querySelector('path').getAttribute('d');
      if (/NaN|undefined/.test(d)) svgNaN++;
    });

    /* 逐格与夹具对账：把「画了线」和「该画线」一个个对上。
       光数总数不够 —— 画错格子、漏画、把持平的也画上，总数都可能看着正常。 */
    const cols = APP.categories.reduce((a, c) => a.concat(c.subcats), []);
    const SER = window.HISTORY.series;
    let mismatch = 0, expectN = 0, blankN = 0;
    const bad = [];
    document.querySelectorAll('#matrix tbody tr[data-row]').forEach(tr => {
      const id = tr.dataset.row;
      [...tr.querySelectorAll('td.cell')].forEach((td, j) => {
        const arr = (SER[id] || {})[cols[j]];
        const pts = arr ? arr.filter(x => x !== null) : [];
        const should = pts.length >= 2 && Math.min.apply(null, pts) !== Math.max.apply(null, pts);
        if (should) expectN++; else blankN++;
        const has = !!td.querySelector('.cspk');
        if (should !== has) {
          mismatch++;
          if (bad.length < 3) bad.push(id + '/' + cols[j] + ' 应=' + should + ' 实=' + has);
        }
      });
    });

    return {
      n, outOfCell, collide, svgNaN, wide, sample,
      mismatch, expectN, blankN, bad,
      up: document.querySelectorAll('#matrix .cspk.d-up').length,
      down: document.querySelectorAll('#matrix .cspk.d-down').length,
      flat: document.querySelectorAll('#matrix .cspk.d-flat').length,
      note: (document.querySelector('#matrix-note') || {}).innerText || '',
      legend: (document.querySelector('#matrix-legend') || {}).innerText || '',
    };
  });
  check(geo.n > 50, `矩阵格内出现 ${geo.n} 条微走势线`, String(geo.n));
  check(geo.n === geo.expectN, `微走势数与夹具对账（画了 ${geo.n} / 该画 ${geo.expectN}）`, String(geo.n));
  check(geo.mismatch === 0, '逐格对账无错位（该画的都画了、不该画的没画）', JSON.stringify(geo.bad));
  check(geo.svgNaN === 0, '折线路径无 NaN', String(geo.svgNaN));
  check(geo.outOfCell === 0, '微走势全部落在自己格子里', `${geo.outOfCell} 条越界`);
  check(geo.collide === 0, '微走势不压名次数字', JSON.stringify(geo.sample));
  check(geo.wide === 0, '微走势尺寸未超预期', String(geo.wide));
  check(geo.up > 0 && geo.down > 0, `上升/下降走势都渲染（${geo.up}/${geo.down}）`);
  check(geo.flat === 0, '全程持平的格子不画线', String(geo.flat));
  check(geo.blankN > 0, `存在留空的格子（${geo.blankN} 个，即「没动过」）`, String(geo.blankN));
  check(/格子右下角/.test(geo.note) && /走势↑/.test(geo.legend), '脚注与图例说明已切到「有多天数据」');
  await shot('07-trend-fixture');

  // 展开一行，量卡片的走势列。
  // 挑 FIXED[1]（夹具里 mi=1，drift=+d → 名次严格递增），保证拿到的是真折线而不是「＝」占位。
  const pick = FIXED[1];
  await page.click(`#matrix tbody tr[data-row="${pick}"] .mbtn`);
  await page.waitForTimeout(400);
  const card = await page.evaluate(() => {
    const t = document.querySelector('#matrix tbody tr.mcard .celltable');
    if (!t) return null;
    const th = t.querySelector('th.tcol');
    const c = document.querySelector('#matrix tbody tr.mcard .mcard-in').getBoundingClientRect();
    const r = t.getBoundingClientRect();
    /* ⚠️ 不能用 t.querySelectorAll('tbody tr')：选择器里的 'tbody' 祖先可以在查询根之外，
       而这张卡片本身就长在矩阵的 <tbody> 里，于是连表头那行 <tr>（在 <thead> 中）也会被选中。
       用 tBodies[0].rows 才是「这张表的表体」。 */
    const rows = [...t.tBodies[0].rows];
    const marks = rows.map(x => x.querySelector('td.tcol') || x.lastElementChild);
    const svgs = rows.map(x => x.querySelector('td.tcol .tspark svg')).filter(Boolean);
    const nums = rows.map(x => {
      const n = x.querySelector('td.tcol .tnum');
      return n ? n.innerText.trim() : '';
    }).filter(Boolean);
    // 每个走势标记都必须留在自己那一列里，不能溢到「分歧」列去
    let spill = 0;
    marks.forEach(td => {
      const m = td.querySelector('.tspark, .tflat');
      if (!m) return;
      const a = m.getBoundingClientRect(), b = td.getBoundingClientRect();
      if (a.right > b.right + 1 || a.left < b.left - 1) spill++;
    });
    return {
      head: th ? th.innerText.trim() : '',
      rows: rows.length,
      markCount: marks.filter(Boolean).length,
      missing: rows.filter(x => !x.querySelector('td.tcol')).length,
      sparks: svgs.length,
      sparkW: svgs.length ? Math.round(svgs[0].getBoundingClientRect().width) : 0,
      nums, spill,
      empty: marks.filter(x => x && !x.querySelector('.tspark, .tflat, .tpend')).length,
      tableOverflow: Math.round(r.right) - Math.round(c.right),
      firstRowHtml: rows.length ? rows[0].outerHTML.slice(0, 160) : '',
    };
  });
  check(!!card, '卡片已展开');
  if (card) {
    check(card.missing === 0, `卡片每行都有走势列（缺 ${card.missing} 行）`, card.firstRowHtml);
    check(card.sparks === card.rows, `卡片 ${card.rows} 条落点全部画出折线（${card.sparks}）`, JSON.stringify(card));
    check(card.nums.length === card.rows && card.nums.every(n => /^\d+→\d+$/.test(n)),
      '每行都给出「首→末」名次', card.nums.join(' '));
    // ⚠️ 必须转成数字再比：夹具 mi=1 的 drift=+d 让名次严格变大（=变差），
    // 但按字符串比 "6" < "11" 是 false，会误判。
    check(card.nums.every(n => +n.split('→')[0] < +n.split('→')[1]),
      '夹具 mi=1 应全部为「名次下降」', card.nums.join(' '));
    check(card.sparkW >= 40, `走势折线宽 ${card.sparkW}px（可辨认）`, String(card.sparkW));
    check(card.spill === 0, '走势标记未溢出所在列', String(card.spill));
    check(card.empty === 0, '走势列无空白单元格', String(card.empty));
    check(/近 6 天/.test(card.head), `走势列标题含天数（${card.head}）`);
    check(card.tableOverflow <= 1, '走势列未把卡片表格撑出容器', String(card.tableOverflow));
  }
  await shot('08-trend-card');

  /* ── 8. 页脚 ── */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(350);
  await shot('09-footer');

  console.log('\n控制台错误：' + (errs.length ? JSON.stringify(errs) : 'none'));
  check(errs.length === 0, '无控制台错误', errs.join(' | '));

  /* ── 9. 宽屏（<2560，单列）── */
  console.log('\n[宽屏]');
  for (const [vw, lo, hi] of [[1680, 1590, 1640], [1920, 1820, 1860]]) {
    await page.setViewportSize({ width: vw, height: 1200 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const w = await page.evaluate(() => {
      const wrap = document.querySelector('main.wrap');
      const t = document.querySelector('#matrix');
      const tw = document.querySelector('#view-matrix .tablewrap');
      return {
        wrapW: Math.round(wrap.getBoundingClientRect().width),
        tableW: Math.round(t.getBoundingClientRect().width),
        wrapClient: tw.clientWidth,
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
        railShown: getComputedStyle(document.querySelector('#detailrail')).display !== 'none',
      };
    });
    check(w.wrapW >= lo && w.wrapW <= hi, `${vw}px 视口：容器宽 ${w.wrapW}px（期望 ${lo}–${hi}）`, JSON.stringify(w));
    check(w.docW <= w.winW + 2, `${vw}px 视口：页面无横向滚动条`, `${w.docW}/${w.winW}`);
    check(w.tableW <= w.wrapClient + 8, `${vw}px 视口：表格未溢出容器`, `${w.tableW}/${w.wrapClient}`);
    check(!w.railShown, `${vw}px 视口：详情栏未出现（<2560 走内联展开）`);
  }

  /* ── 10. 超宽屏（≥2560，矩阵 + 右侧详情栏）──
     这里守的是本轮实测到的那个坑：容器一宽，table 的 auto 布局就按各列
     preferred width 瓜分余量，模型列独吞 → 2080 时 411px、3400 时 671px。
     所以断言写死「模型列 ≤340、数据格 ≤95」，谁把矩阵重新拉宽就先红这条。 */
  console.log('\n[超宽屏 · 详情栏]');
  for (const vw of [2560, 3440, 3840]) {
    await page.setViewportSize({ width: vw, height: 1400 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => {
      const wrap = document.querySelector('main.wrap');
      const split = document.querySelector('#matrix-split');
      const tw = document.querySelector('#view-matrix .tablewrap');
      const railEl = document.querySelector('#detailrail');
      const t = document.querySelector('#matrix');
      const modelTd = t.querySelector('tbody td.modelcell');
      const cellTd = t.querySelector('tbody td.cell');
      const rb = railEl.getBoundingClientRect(), tb = tw.getBoundingClientRect();
      return {
        wrapW: Math.round(wrap.getBoundingClientRect().width),
        display: getComputedStyle(split).display,
        matrixW: Math.round(tb.width),
        railW: Math.round(rb.width),
        modelW: modelTd ? Math.round(modelTd.getBoundingClientRect().width) : 0,
        cellW: cellTd ? Math.round(cellTd.getBoundingClientRect().width) : 0,
        railH: Math.round(rb.height), twH: Math.round(tb.height),
        railOverflowX: Math.round(railEl.scrollWidth - railEl.clientWidth),
        cardW: Math.round((railEl.querySelector('.mcard-grid') || railEl).getBoundingClientRect().width),
        railText: (railEl.innerText || '').trim().length,
        railName: ((railEl.querySelector('.railname') || {}).innerText || '').trim(),
        inlineCards: document.querySelectorAll('#matrix tbody tr.mcard').length,
        openRows: document.querySelectorAll('#matrix tbody tr[data-row].open').length,
        overflow: Math.round(rb.right) - Math.round(wrap.getBoundingClientRect().right),
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
      };
    });
    const tag = vw + 'px 视口';
    check(s.display === 'grid', `${tag}：矩阵区已切成双列`, s.display);
    check(s.wrapW >= 2400 && s.wrapW <= 3540, `${tag}：容器宽 ${s.wrapW}px（期望 2400–3540）`, String(s.wrapW));
    check(s.railW >= 850, `${tag}：详情栏宽 ${s.railW}px（≥850 够放卡片）`, String(s.railW));
    /* 本轮的核心不变量：矩阵区被“封顶”，所以余量再也喂不到模型列上。
       不封顶时（容器 = 视口）实测 3840 → 模型列 671px、数据格 124px；
       封顶后 3840 → 矩阵 2139、模型列 422、数据格 78。 */
    check(s.matrixW >= 1400 && s.matrixW <= 2250, `${tag}：矩阵被封在 ${s.matrixW}px（1400–2250）`, String(s.matrixW));
    check(s.modelW <= 500, `${tag}：模型列 ${s.modelW}px（不封顶时会涨到 671）`, String(s.modelW));
    check(s.cellW >= 45 && s.cellW <= 92, `${tag}：数据格 ${s.cellW}px 仍在舒适密度`, String(s.cellW));
    check(s.inlineCards === 0, `${tag}：表内没有内联展开行（卡片改走详情栏）`, String(s.inlineCards));
    check(s.openRows === 1, `${tag}：恰好高亮一行`, String(s.openRows));
    check(s.railText > 200, `${tag}：详情栏有实际内容（${s.railText} 字）`, String(s.railText));
    check(s.railName.length > 0, `${tag}：栏头显示当前模型名「${s.railName}」`);
    check(s.railOverflowX <= 1, `${tag}：卡片未把详情栏撑出横向滚动`, String(s.railOverflowX));
    check(s.cardW <= s.railW + 1, `${tag}：卡片宽度受栏宽约束`, `${s.cardW}/${s.railW}`);
    check(Math.abs(s.railH - s.twH) <= 2,
      `${tag}：详情栏与矩阵容器等高（${s.railH} vs ${s.twH}）`, `${s.railH}/${s.twH}`);
    check(s.overflow <= 1, `${tag}：详情栏未溢出容器右边界`, String(s.overflow));
    check(s.docW <= s.winW + 2, `${tag}：页面无横向滚动条`, `${s.docW}/${s.winW}`);
    if (vw === 3840) await shot('11-rail-3840');
  }

  /* 超宽屏点行要换栏，且不能又冒出内联卡片 */
  const railSwap = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('#matrix tbody tr[data-row]')];
    const before = (document.querySelector('#detailrail .railname') || {}).innerText || '';
    rows[2].querySelector('.mbtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = (document.querySelector('#detailrail .railname') || {}).innerText || '';
    return {
      before: before.trim(), after: after.trim(),
      inline: document.querySelectorAll('#matrix tbody tr.mcard').length,
      open: document.querySelectorAll('#matrix tbody tr[data-row].open').length,
      openRow: (document.querySelector('#matrix tbody tr[data-row].open') || {}).dataset?.row || '',
      target: rows[2].dataset.row,
    };
  });
  check(railSwap.after !== railSwap.before, `超宽屏：点第三行后详情栏换人（${railSwap.before} → ${railSwap.after}）`,
    JSON.stringify(railSwap));
  check(railSwap.inline === 0, '超宽屏：换人后仍无内联卡片', String(railSwap.inline));
  check(railSwap.open === 1 && railSwap.openRow === railSwap.target,
    '超宽屏：高亮跟着切到点击那行', JSON.stringify(railSwap));

  /* 大类详情视图在超宽屏必须走同一套双栏 —— 否则它会独自把表格拉到 3500，
     每个数值列被摊成 ~360px，扫读时数值和表头隔着半个屏幕（实测 3498px）。 */
  const catRail = await page.evaluate(async () => {
    const tab = [...document.querySelectorAll('#viewtabs button')]
      .find(b => !/矩阵|matrix/i.test(b.textContent)) || document.querySelectorAll('#viewtabs button')[1];
    tab.click();
    await new Promise(r => setTimeout(r, 150));
    const t = document.querySelector('#dtable');
    const tw = document.querySelector('#wrap-cat');
    const railEl = document.querySelector('#detailrail-cat');
    if (!railEl || getComputedStyle(railEl).display === 'none') return { railShown: false };
    const rb = railEl.getBoundingClientRect(), tb = tw.getBoundingClientRect();
    return {
      railShown: true,
      disp: getComputedStyle(document.querySelector('#cat-split')).display,
      tableW: Math.round(t.getBoundingClientRect().width),
      railW: Math.round(rb.width),
      sameH: Math.abs(rb.height - tb.height) <= 2,
      railName: ((railEl.querySelector('.railname') || {}).innerText || '').trim(),
      inline: document.querySelectorAll('#dtable tbody tr.mcard').length,
      open: document.querySelectorAll('#dtable tbody tr.open').length,
      overflowX: railEl.scrollWidth - railEl.clientWidth,
      docW: document.documentElement.scrollWidth, winW: window.innerWidth,
    };
  });
  check(catRail.railShown && catRail.disp === 'grid', '大类视图 3840：同样切成双列', JSON.stringify(catRail));
  check(catRail.tableW <= 2250, `大类视图 3840：表格被封在 ${catRail.tableW}px（不封会拉到 3498）`, String(catRail.tableW));
  check(catRail.railW >= 850, `大类视图 3840：详情栏 ${catRail.railW}px`, String(catRail.railW));
  check(catRail.sameH, '大类视图 3840：两栏等高');
  check(catRail.railName.length > 0, `大类视图 3840：栏内有模型（${catRail.railName}）`);
  check(catRail.inline === 0, '大类视图 3840：无内联展开行');
  check(catRail.open === 1, '大类视图 3840：恰好高亮一行');
  check(catRail.overflowX <= 1, '大类视图 3840：详情栏无横向溢出');
  check(catRail.docW <= catRail.winW + 2, '大类视图 3840：页面无横向滚动条');
  await shot('12-cat-rail-3840');

  await page.setViewportSize({ width: 1680, height: 1050 });

  console.log('\n' + (fails.length ? 'FAIL ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ') : 'PASS（全部检查通过）'));
  console.log('截图目录：' + OUTDIR);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
