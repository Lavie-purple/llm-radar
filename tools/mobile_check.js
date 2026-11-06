/* 手机端布局/交互核验（第三层守卫，2026-11-06 落地）
 *
 * 为什么单独一层：visual_check.js 只在 ≥1680 跑，手机断点（≤720）的回归
 * 它一条都看不见。而这里守的不是「好看」，是几条会直接让信息消失的硬事实：
 *   · 两根 sticky 列之和 > 容器宽 → 初始可见数据格 0 个（整屏只有模型名）；
 *   · max-height:none → 表头 sticky 失效，横滑之后不知道每列是什么；
 *   · 触屏没有 hover → 名次的来源/原始分（tooltip）完全够不着；
 *   · 31px 高的格子点不中。
 * 全部用 DOM 数字断言，不靠看截图。每条断言都要能被 falsify.py 拆红。
 *
 * 用法：先起 8758 静态服务，再 node tools/mobile_check.js [base]
 * 产物：_shot/mobile-*.png（供肉眼复核形状，几何断言之外的最后一道）
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8758/';
const OUTDIR = path.resolve(__dirname, '..', '_shot');

function loadPlaywright() {
  const tries = [
    'playwright',
    'C:/Users/lavie/.workbuddy/binaries/node/workspace/node_modules/playwright',
  ];
  for (const t of tries) {
    try { return require(t); } catch (e) { /* 下一个 */ }
  }
  console.error('找不到 playwright'); process.exit(2);
}
const { chromium } = loadPlaywright();

let pass = 0;
const fails = [];
function check(cond, label, detail) {
  if (cond) pass++;
  else fails.push(label + (detail !== undefined ? ' → ' + detail : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (!cond && detail !== undefined ? '   [' + detail + ']' : ''));
}

/* 在页面里量「第一行里不被 sticky 首列挡住、且完整落在容器里」的数据格。
   ⚠️ 只数第一行：数全表会把 118 行 × 2 格 = 236 当成「可见 236 个」，
   于是任何「≥2」的断言都假绿 —— 指标选错，全绿也是假的。 */
const VISIBLE_CELLS = `(() => {
  const wrap = document.querySelector('#wrap-matrix');
  const wr = wrap.getBoundingClientRect();
  const model = document.querySelector('#matrix tbody td.modelcell');
  const mr = model.getBoundingClientRect();
  const row = document.querySelector('#matrix tbody tr[data-row]');
  const cells = Array.from(row.querySelectorAll('td.cell'));
  return cells.filter(c => {
    const r = c.getBoundingClientRect();
    return r.left >= mr.right - 1 && r.right <= wr.right + 1;
  }).length;
})()`;

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch();

  /* ── 手机 375×812 ── */
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = (m.location() || {}).url || '';
    if (/^Failed to load resource/.test(m.text()) && !loc.includes('127.0.0.1:8758')) return;
    errs.push(m.text());
  });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#matrix tbody td.cell', { timeout: 10000 });

  const m = await page.evaluate(() => {
    const R = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const wrap = document.querySelector('#wrap-matrix');
    const wr = R('#wrap-matrix');
    const model = R('#matrix tbody td.modelcell');
    const price = document.querySelector('#matrix tbody td.pricecell');
    const tapH = s => { const r = R(s); return r ? Math.round(r.height) : 0; };
    return {
      winW: window.innerWidth,
      docW: document.documentElement.scrollWidth,
      coarse: window.matchMedia('(pointer: coarse)').matches,
      wrapW: wrap.clientWidth,
      wrapTop: Math.round(wr.top + window.scrollY),
      wrapH: Math.round(wr.height),
      maxH: getComputedStyle(wrap).maxHeight,
      modelW: Math.round(model.width),
      pricePos: getComputedStyle(price).position,
      priceW: Math.round(R('#matrix tbody td.pricecell').width),
      nameW: Math.round(R('#matrix tbody .mname').width),
      hintShown: getComputedStyle(document.querySelector('#view-matrix .swipehint')).display !== 'none',
      taps: {
        cell: tapH('#matrix tbody td.cell .cellbtn'),
        mbtn: tapH('#matrix tbody .mbtn'),
        tab: tapH('.viewtabs button'),
        seg: tapH('#openfilter button'),
        search: tapH('#q'),
      },
    };
  });
  console.log('\n[375×812 手机]');
  console.log(JSON.stringify(m));

  check(m.coarse, '触屏环境确认为 pointer:coarse（否则点按分支测不到）');
  check(m.docW <= m.winW + 2, '页面无横向溢出', `${m.docW}/${m.winW}`);
  check(m.modelW <= 165, 'sticky 首列瘦到 ≤165px', m.modelW + 'px');
  check(m.modelW + (m.pricePos === 'static' ? 0 : m.priceW) <= m.wrapW - 90,
        'sticky 列给数据格留 ≥90px', `首列 ${m.modelW} + 容器 ${m.wrapW}`);
  check(m.pricePos === 'static', '价格列横向不再 sticky', m.pricePos);
  check(m.nameW >= 70, '模型名仍有 ≥70px 可读宽度', m.nameW + 'px');
  check(m.wrapTop <= 620, '表前装饰 ≤620px', m.wrapTop + 'px');
  check(m.maxH !== 'none' && m.wrapH < 812 * 0.8, '表格有高度上限（表头 sticky 才有滚动容器）',
        `${m.maxH} / 实高 ${m.wrapH}`);
  check(m.taps.cell >= 40, '格子触摸目标 ≥40px', m.taps.cell + 'px');
  check(m.taps.mbtn >= 40, '模型名按钮 ≥40px', m.taps.mbtn + 'px');
  check(m.taps.tab >= 38 && m.taps.seg >= 38 && m.taps.search >= 38,
        '标签/分段/搜索 ≥38px', JSON.stringify(m.taps));
  check(m.hintShown, '手机端显示横滑提示');

  const cells0 = await page.evaluate(VISIBLE_CELLS);
  check(cells0 >= 2, '初始位置可见 ≥2 个完整数据格（旧版是 0 个）', cells0 + ' 个');

  /* 表头 sticky 实测：滚 300px 后两行都钉住、且**互不重叠**。
     曾把断言写成「sub 钉在 16–30px」，恰好把一个 bug 写成期望值：
     分组行实际 45px、sub 钉在 22px，两行压了 23px 的字，断言却全绿。
     改成语义性质：grp.bottom <= sub.top + 2，且 sub 仍在容器顶部附近。 */
  const sticky = await page.evaluate(() => {
    const wrap = document.querySelector('#wrap-matrix');
    wrap.scrollTop = 300;
    const wr = wrap.getBoundingClientRect();
    const grp = document.querySelector('#matrix thead tr.grp th.grp').getBoundingClientRect();
    const th = document.querySelector('#matrix thead tr.sub th.sub').getBoundingClientRect();
    return {
      scrollTop: wrap.scrollTop,
      grpTop: Math.round(grp.top - wr.top),
      grpBottom: Math.round(grp.bottom - wr.top),
      subTop: Math.round(th.top - wr.top),
      grph: getComputedStyle(document.querySelector('#matrix')).getPropertyValue('--grph').trim(),
    };
  });
  check(sticky.scrollTop > 0 && sticky.subTop >= 0 && sticky.subTop <= 90,
        '纵滚 300px 后列头仍钉在顶部（sticky 生效）', JSON.stringify(sticky));
  /* 既要不重叠、也要不留缝：只写「grp.bottom <= sub.top」会漏掉
     --grph 量错（量到 rowspan=2 的角格 85px）时把子类列头顶进 tbody、
     中间露出一排数字那次事故。相等才是「两行严丝合缝」的正确性质。 */
  check(Math.abs(sticky.grpBottom - sticky.subTop) <= 2,
        '两行表头严丝合缝（既无重叠也无缝隙）', JSON.stringify(sticky));
  check(sticky.grph === (sticky.grpBottom - sticky.grpTop) + 'px',
        '--grph 等于分组行实测高度（不是 rowspan 角格的高度）',
        `${sticky.grph} / 行高 ${sticky.grpBottom - sticky.grpTop}px`);

  /* 表头「钉住了」不等于「看得见」：把窗口滚到表格顶部后，
     若顶栏还是 sticky 就会整条盖住表头。用 elementFromPoint 直接问
     「这个坐标上到底是谁」，比量 top 更能反映用户看到的东西。 */
  const headerHit = await page.evaluate(() => {
    const de = document.documentElement;
    const old = de.style.scrollBehavior;
    de.style.scrollBehavior = 'auto';           // html 默认 smooth，滚完立刻读 rect 会拿到动画中途
    const wrap = document.querySelector('#wrap-matrix');
    const sy = window.scrollY, sx = wrap.scrollLeft, st = wrap.scrollTop;
    /* 还原必须在 scrollBehavior='auto' 期间做完；先还原样式再滚，
       那条 window.scrollTo 会重新变成 smooth 动画，后续测量拿到中途位置。 */
    const restore = () => {
      window.scrollTo(0, sy); wrap.scrollLeft = sx; wrap.scrollTop = st;
      de.style.scrollBehavior = old;
    };
    window.scrollTo(0, Math.round(wrap.getBoundingClientRect().top + window.scrollY));
    wrap.scrollTop = 300; wrap.scrollLeft = 300;
    const wr = wrap.getBoundingClientRect();
    const mr = document.querySelector('#matrix tbody td.modelcell').getBoundingClientRect();
    const ths = Array.from(document.querySelectorAll('#matrix thead tr.sub th.sub'));
    const th = ths.find(t => {
      const r = t.getBoundingClientRect();
      return r.left >= mr.right + 4 && r.right <= wr.right - 4 && r.top >= wr.top;
    });
    if (!th) { restore(); return { err: 'no visible th' }; }
    const r = th.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const out = {
      label: th.querySelector('.sbl').textContent.slice(0, 8),
      hit: hit ? hit.tagName + '.' + (hit.className || '') : null,
      inThead: !!(hit && hit.closest && hit.closest('thead')),
      thTop: Math.round(r.top), winH: window.innerHeight,
    };
    restore();
    return out;
  });
  console.log('表头命中：' + JSON.stringify(headerHit));
  check(headerHit.inThead, '页面滚到表格后表头真的可见（没被顶栏盖住）', JSON.stringify(headerHit));

  /* 横滚 300px：首列仍钉住，且能看到更多数据格 */
  const afterScroll = await page.evaluate(() => {
    const wrap = document.querySelector('#wrap-matrix');
    wrap.scrollLeft = 300;
    const wr = wrap.getBoundingClientRect();
    const mr = document.querySelector('#matrix tbody td.modelcell').getBoundingClientRect();
    const cells = Array.from(document.querySelector('#matrix tbody tr[data-row]').querySelectorAll('td.cell'));
    const vis = cells.map((c, i) => ({ i, r: c.getBoundingClientRect() }))
      .filter(x => x.r.left >= mr.right - 1 && x.r.right <= wr.right + 1);
    return {
      leftDelta: Math.round(mr.left - wr.left),
      cells: vis.length,
      firstIdx: vis.length ? vis[0].i : -1,
    };
  });
  check(Math.abs(afterScroll.leftDelta) <= 4, '横滚后首列仍钉在左边',
        afterScroll.leftDelta + 'px');
  /* 不写死「≥3 格」：列头文字长短不一，auto 布局下有些列会被撑到 65px，
     206px 的可见带里 legitimately 只放得下 2 格。真正要守的是「能滑到别的维度」：
     初始可见的是第 0 列，横滚 300px 后必须换到更靠后的列。 */
  check(afterScroll.cells >= 2, '横滚后仍能看到 ≥2 个完整数据格', afterScroll.cells + ' 个');
  check(afterScroll.firstIdx >= 3, '横滚确实换到更靠后的维度（初始第 0 列）',
        '首个可见列 #' + afterScroll.firstIdx);

  await page.screenshot({ path: path.join(OUTDIR, 'mobile-375-top.png') });
  await page.locator('#wrap-matrix').screenshot({ path: path.join(OUTDIR, 'mobile-375-matrix.png') });

  /* 触屏 tooltip：用合成 click（不派发 mouseover）隔离点按分支。
     Playwright 的 tap() 会补发兼容鼠标事件，那样测不出「只有 hover」的回归。 */
  await page.evaluate(() => { document.querySelector('#wrap-matrix').scrollLeft = 0; });
  const tapTip = await page.evaluate(() => {
    const cell = document.querySelector('#matrix tbody td.cell .cellbtn[data-cell]');
    if (!cell) return { err: 'no cell' };
    const r = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('click', {
      bubbles: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.bottom),
    }));
    const tip = document.getElementById('tip');
    const tr = tip.getBoundingClientRect();
    return {
      hidden: tip.hidden,
      key: tip.dataset.key || '',
      expect: cell.dataset.cell,
      hasRaw: tip.textContent.indexOf('原始分') >= 0,
      hasRank: tip.textContent.indexOf('名次') >= 0,
      box: { l: Math.round(tr.left), t: Math.round(tr.top), r: Math.round(tr.right), b: Math.round(tr.bottom) },
      winW: window.innerWidth, winH: window.innerHeight,
    };
  });
  console.log('点格子后 tooltip: ' + JSON.stringify(tapTip));
  check(!tapTip.hidden, '点格子弹出 tooltip（触屏也能追溯来源）');
  check(tapTip.key === tapTip.expect && tapTip.key.length > 0,
        'tooltip 绑定到被点的那一格', `${tapTip.key} / ${tapTip.expect}`);
  check(tapTip.hasRaw && tapTip.hasRank, 'tooltip 含「名次 / 原始分」');
  check(tapTip.box.l >= 0 && tapTip.box.t >= 0
        && tapTip.box.r <= tapTip.winW + 1 && tapTip.box.b <= tapTip.winH + 1,
        'tooltip 完整落在视口内', JSON.stringify(tapTip.box));

  const hide = await page.evaluate(() => {
    document.querySelector('.topbar').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return document.getElementById('tip').hidden;
  });
  check(hide, '点别处收起 tooltip');

  /* 展开卡片不能撑破手机视口 */
  const card = await page.evaluate(() => {
    const btn = document.querySelector('#matrix tbody .mbtn[data-toggle]');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const c = document.querySelector('#matrix .mcard-in');
    if (!c) return { ok: false };
    const r = c.getBoundingClientRect();
    return { ok: true, right: Math.round(r.right), w: Math.round(r.width), win: window.innerWidth,
             name: (c.querySelector('.mcard-title strong') || {}).textContent || '' };
  });
  check(card.ok && card.right <= card.win + 2, '展开卡片不撑破视口', JSON.stringify(card));
  check(card.ok && card.name.length > 0, '展开卡片显示完整模型名', card.name);

  /* ── 大类详情视图：手机断点同样要生效，别只改矩阵那一半 ── */
  const cat = await page.evaluate(() => {
    document.querySelector('.viewtabs button[data-view="cat"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const q = s => document.querySelector(s);
    const w = q('#wrap-cat'), wr = w.getBoundingClientRect();
    const mr = q('#dtable tbody td.modelcell').getBoundingClientRect();
    const row = q('#dtable tbody tr');   // 大类表的行没有 data-row 属性，别套矩阵的写法
    const vals = row ? Array.from(row.querySelectorAll('td.dval')) : [];
    const vis = vals.filter(c => {
      const r = c.getBoundingClientRect();
      return r.left >= mr.right - 1 && r.right <= wr.right + 1;
    }).length;
    return {
      shown: !q('#view-cat').hidden,
      maxH: getComputedStyle(w).maxHeight,
      modelW: Math.round(mr.width),
      hint: getComputedStyle(q('#view-cat .swipehint')).display,
      visibleVals: vis,
      docW: document.documentElement.scrollWidth, winW: window.innerWidth,
    };
  });
  console.log('大类详情视图：' + JSON.stringify(cat));
  check(cat.shown, '手机端能切到大类详情视图');
  check(cat.maxH !== 'none', '大类视图表格也有高度上限', cat.maxH);
  check(cat.modelW <= 165, '大类视图首列同样瘦身', cat.modelW + 'px');
  check(cat.visibleVals >= 1, '大类视图初始可见 ≥1 个完整数值格', cat.visibleVals + ' 个');
  check(cat.hint !== 'none', '大类视图显示横滑提示');
  check(cat.docW <= cat.winW + 2, '大类视图无横向溢出', `${cat.docW}/${cat.winW}`);

  check(errs.length === 0, '无控制台错误', errs.join(' | '));
  await ctx.close();

  /* ── 桌面回归：手机规则不许漏到 ≥1680 ── */
  const dctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  const dpage = await dctx.newPage();
  await dpage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await dpage.waitForSelector('#matrix tbody td.cell', { timeout: 10000 });
  const d = await dpage.evaluate(() => {
    const wrap = document.querySelector('#wrap-matrix');
    const model = document.querySelector('#matrix tbody td.modelcell');
    const price = document.querySelector('#matrix tbody td.pricecell');
    const hint = document.querySelector('#view-matrix .swipehint');
    return {
      modelW: Math.round(model.getBoundingClientRect().width),
      pricePos: getComputedStyle(price).position,
      cellH: Math.round(document.querySelector('#matrix tbody td.cell').getBoundingClientRect().height),
      hintShown: getComputedStyle(hint).display !== 'none',
      maxH: getComputedStyle(wrap).maxHeight,
      subTop: getComputedStyle(document.querySelector('#matrix thead tr.sub th.sub')).top,
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  });
  console.log('\n[1680×1050 桌面回归]');
  console.log(JSON.stringify(d));
  check(d.modelW >= 210 && d.modelW <= 360, '桌面首列宽度未被手机规则改写', d.modelW + 'px');
  check(d.pricePos === 'sticky', '桌面价格列仍是横向 sticky', d.pricePos);
  check(d.cellH === 31, '桌面格子高度仍是 31px', d.cellH + 'px');
  check(!d.hintShown, '桌面不显示横滑提示');
  check(d.maxH !== 'none', '桌面表格高度上限未被改掉', d.maxH);
  check(d.subTop === '26px', '桌面子类表头仍用 26px（--grph 只在手机分支生效）', d.subTop);
  check(d.docW <= d.winW + 2, '桌面无横向溢出', `${d.docW}/${d.winW}`);
  await dctx.close();

  await browser.close();
  console.log('\n截图目录：' + OUTDIR);
  console.log(`手机端核验：${fails.length ? 'FAIL ' + fails.length + ' 条' : 'PASS'}（${pass} 项检查通过）`);
  if (fails.length) {
    fails.forEach(f => console.log('  x ' + f));
    process.exit(1);
  }
})().catch(e => {
  console.error('CRASH —— ' + (e && e.stack || e));
  console.error('手机端核验：CRASH（没跑完，结论不作数）');
  process.exit(2);
});
