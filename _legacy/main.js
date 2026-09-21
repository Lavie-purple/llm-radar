/* ============================================================================
 * 模型决策台 · 渲染逻辑
 * 不合成总分：每个源列显示原始分，百分位分歧带才做跨源归一化。
 * LMArena 列可点改并存 localStorage。
 * ==========================================================================*/
(function () {
  'use strict';

  const LS_PREFIX = 'llm-radar:lm:';
  const state = { dim: 'agent', open: 'all', sort: 'score' };

  /* ---------- localStorage 覆盖（仅 LMArena 人工快照） ---------- */
  function loadLM(dimKey, modelName) {
    try {
      const v = localStorage.getItem(LS_PREFIX + dimKey + '::' + modelName);
      return v === null ? null : parseFloat(v);
    } catch (e) { return null; }
  }
  function saveLM(dimKey, modelName, val) {
    try { localStorage.setItem(LS_PREFIX + dimKey + '::' + modelName, String(val)); } catch (e) {}
  }

  function getScore(dim, model, srcKey) {
    if (srcKey === 'lm') {
      const o = loadLM(dim.key, model.name);
      if (o !== null && !isNaN(o)) return o;
    }
    const v = model.scores[srcKey];
    return (typeof v === 'number') ? v : null;
  }

  /* ---------- 每源百分位（仅在本维度、本源内排序） ---------- */
  function computePct(dim) {
    const map = {};
    dim.models.forEach(m => { map[m.name] = { pct: {}, avg: 0, diverge: 0, n: 0 }; });
    dim.cols.forEach(srcKey => {
      const present = dim.models
        .map(m => ({ m, v: getScore(dim, m, srcKey) }))
        .filter(x => x.v !== null)
        .sort((a, b) => a.v - b.v);
      const n = present.length;
      present.forEach((x, i) => {
        map[x.m.name].pct[srcKey] = n > 1 ? (i / (n - 1)) * 100 : 100;
      });
    });
    // avg + 分歧（标准差）
    dim.models.forEach(m => {
      const vals = Object.values(map[m.name].pct);
      if (!vals.length) return;
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      const variance = vals.reduce((s, v) => s + (v - avg) * (v - avg), 0) / vals.length;
      map[m.name].avg = avg;
      map[m.name].diverge = Math.sqrt(variance);
      map[m.name].n = vals.length;
    });
    return map;
  }

  /* ---------- 代表成本（用于性价比排序） ---------- */
  function costRep(dim, model) {
    const c = model.cost || {};
    if (dim.key === 'image') return (c.per1k === undefined ? null : c.per1k);
    if (dim.key === 'video') return (c.perSec === undefined ? null : c.perSec);
    if (c.perTask != null) return c.perTask;
    if (c.perM != null) return c.perM;
    return null;
  }
  function costLabel(dim, model) {
    const c = model.cost || {};
    if (dim.key === 'image') return c.per1k == null ? '—' : '$' + c.per1k;
    if (dim.key === 'video') return c.perSec == null ? '—' : (c.perSec === 0 ? '免费' : '$' + c.perSec);
    if (c.perTask != null) return '$' + c.perTask + '/任';
    if (c.perM != null) return '$' + c.perM + '/M';
    return '—';
  }
  function speedLabel(dim, model) {
    const s = model.speed || {};
    if (dim.key === 'image') return s.gen == null ? '—' : s.gen + 's';
    if (dim.key === 'video') return '—';
    if (s.aa != null) return s.aa + ' t/s';
    return '—';
  }

  /* ---------- 源列指标小标签 ---------- */
  function srcMetric(dim, srcKey) {
    if (srcKey === 'aa') {
      if (dim.key === 'image') return 'Image Elo';
      if (dim.key === 'video') return 'Video Elo';
      return '智能指数';
    }
    if (srcKey === 'ls') return '综合分';
    if (srcKey === 'lb') return 'Agentic';
    if (srcKey === 'lm') return dim.lmMetric.replace(/\(.*\)/, '').trim();
    return '';
  }
  function fmtScore(dim, srcKey, v) {
    if (v == null) return null;
    if (srcKey === 'aa' && (dim.key === 'image' || dim.key === 'video')) return Math.round(v);
    if (srcKey === 'ls') return v.toFixed(1);
    if (srcKey === 'lb') return v.toFixed(1);
    return String(Math.round(v));
  }

  /* ---------- 渲染：溯源 + 图例 + 维度导航 ---------- */
  function renderProvenance() {
    const ul = document.getElementById('srcList');
    ul.innerHTML = Object.values(SOURCES).map(s => `
      <li class="src-item ${s.stale ? 'is-stale' : ''}">
        <span class="src-dot" style="background:${s.color}"></span>
        <span class="src-name">${s.name}</span>
        <span class="src-meta">${s.date}${s.stale ? ' · 滞后' : ''}</span>
      </li>`).join('');

    const lg = document.getElementById('legend');
    lg.innerHTML = Object.values(SOURCES).map(s => `
      <li><span class="legend-dot" style="background:${s.color}"></span>
      <span class="legend-name">${s.short} · ${s.name}</span></li>`).join('');
  }

  function renderDimNav() {
    const ul = document.getElementById('dimNav');
    ul.innerHTML = DIMENSIONS.map((d, i) => `
      <li>
        <button class="dim-btn" data-dim="${d.key}" aria-current="${d.key === state.dim}">
          <span class="dim-mark"></span>
          <span class="dim-label">${d.label}</span>
          <span class="dim-idx">0${i + 1}</span>
        </button>
      </li>`).join('');
    ul.querySelectorAll('.dim-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.dim = btn.dataset.dim;
        ul.querySelectorAll('.dim-btn').forEach(b => b.setAttribute('aria-current', b === btn));
        renderBoard();
      });
    });
  }

  /* ---------- 渲染：主表 ---------- */
  function renderBoard() {
    const dim = DIMENSIONS.find(d => d.key === state.dim);
    document.getElementById('dimKicker').textContent = dim.kicker;
    document.getElementById('dimTitle').textContent = dim.label;
    document.getElementById('dimSub').textContent = dim.sub;

    // 表头
    const head = document.getElementById('tableHead');
    let headCols = '<th>模型</th>';
    dim.cols.forEach(srcKey => {
      const s = SOURCES[srcKey];
      headCols += `<th class="metric"><span class="th-src" style="color:${s.color}">${s.short}</span>` +
        `<span class="th-main">${srcMetric(dim, srcKey)}</span></th>`;
    });
    headCols += `<th class="metric">${dim.costLabel}</th>`;
    if (dim.speedLabel !== '—') headCols += `<th class="metric">${dim.speedLabel}</th>`;
    headCols += '<th class="metric">跨源分歧</th>';
    head.innerHTML = `<tr>${headCols}</tr>`;

    // 数据 + 过滤 + 排序
    const pct = computePct(dim);
    let rows = dim.models.filter(m => {
      if (state.open === 'open') return m.open;
      if (state.open === 'closed') return !m.open;
      return true;
    });

    const maxBySrc = {};
    dim.cols.forEach(srcKey => {
      let mx = -Infinity;
      dim.models.forEach(m => { const v = getScore(dim, m, srcKey); if (v != null && v > mx) mx = v; });
      maxBySrc[srcKey] = mx;
    });

    rows.sort((a, b) => {
      if (state.sort === 'score') return pct[b.name].avg - pct[a.name].avg;
      if (state.sort === 'diverge') return pct[a.name].diverge - pct[b.name].diverge;
      // cost
      const ca = costRep(dim, a), cb = costRep(dim, b);
      const ra = ca == null ? -1 : (ca === 0 ? Infinity : pct[a.name].avg / ca);
      const rb = cb == null ? -1 : (cb === 0 ? Infinity : pct[b.name].avg / cb);
      return rb - ra;
    });

    const body = document.getElementById('tableBody');
    if (!rows.length) {
      body.innerHTML = '';
      document.getElementById('emptyState').hidden = false;
    } else {
      document.getElementById('emptyState').hidden = true;
      body.innerHTML = rows.map(m => {
        const p = pct[m.name];
        let tds = `<td><div class="cell-model">
            <span class="model-name">${m.name}</span>
            <span class="model-maker">${m.maker}</span>
          </div>
          ${m.open ? `<span class="tag tag-open"><span class="tag-dot"></span>开源${m.flag ? ' · ' + m.flag : ''}</span>` : `<span class="tag"><span class="tag-dot"></span>闭源</span>`}
          </td>`;

        dim.cols.forEach(srcKey => {
          const v = getScore(dim, m, srcKey);
          const isBest = v != null && v === maxBySrc[srcKey];
          if (v == null) {
            tds += `<td class="metric editable" data-dim="${dim.key}" data-model="${m.name}" data-src="${srcKey}">
              <span class="edit-slot is-empty" contenteditable="true" spellcheck="false">— 填</span></td>`;
          } else {
            const editableCls = srcKey === 'lm' ? ' editable' : '';
            const editAttr = srcKey === 'lm' ? ` data-dim="${dim.key}" data-model="${m.name}" data-src="${srcKey}" contenteditable="true" spellcheck="false"` : '';
            tds += `<td class="metric${editableCls} ${isBest ? 'val-best' : ''}"${editAttr}>
              <span class="edit-slot">${fmtScore(dim, srcKey, v)}</span>
              <span class="src-flag" style="color:${SOURCES[srcKey].color}">${SOURCES[srcKey].short}</span></td>`;
          }
        });

        tds += `<td class="metric">${costLabel(dim, m)}</td>`;
        if (dim.speedLabel !== '—') tds += `<td class="metric">${speedLabel(dim, m)}</td>`;

        // 分歧带
        const pvals = dim.cols.map(sk => p.pct[sk]).filter(v => v != null);
        const lo = pvals.length ? Math.min(...pvals) : 0;
        const hi = pvals.length ? Math.max(...pvals) : 0;
        const wide = p.diverge >= 18;
        let dots = dim.cols.map(sk => {
          const v = p.pct[sk];
          if (v == null) return '';
          return `<span class="ribbon-dot" style="left:${v}%;background:${SOURCES[sk].color}" title="${SOURCES[sk].short} ${Math.round(v)}%"></span>`;
        }).join('');
        tds += `<td><div class="ribbon">
            <span class="ribbon-track"></span>
            ${pvals.length > 1 ? `<span class="ribbon-span" style="left:${lo}%;width:${hi - lo}%"></span>` : ''}
            ${dots}
          </div><span class="ribbon-num ${wide ? 'is-wide' : ''}">σ ${p.diverge.toFixed(0)}${p.n < dim.cols.length ? ' · 缺源' : ''}</span></td>`;

        return `<tr>${tds}</tr>`;
      }).join('');
    }

    document.getElementById('countNum').textContent = rows.length;
    renderAnalysis(dim);
    bindEditable();
  }

  /* ---------- 可编辑 LMArena 格子 ---------- */
  function bindEditable() {
    document.querySelectorAll('td.editable .edit-slot').forEach(slot => {
      slot.addEventListener('blur', () => {
        const td = slot.closest('td');
        const dimKey = td.dataset.dim, modelName = td.dataset.model, srcKey = td.dataset.src;
        const raw = slot.textContent.replace(/[^\d.\-]/g, '');
        const val = parseFloat(raw);
        if (!isNaN(val)) {
          saveLM(dimKey, modelName, val);
          slot.classList.remove('is-empty');
        }
        renderBoard();
      });
      slot.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); slot.blur(); } });
    });
  }

  /* ---------- 渲染：分析区（编辑式） ---------- */
  function renderAnalysis(dim) {
    const el = document.getElementById('analysis');
    const blocks = dim.analysis.map((a, i) => {
      const list = (a.body || []).map(li => `<li><span class="a-num">${String.fromCharCode(97 + i)}.</span><span>${li}</span></li>`).join('');
      return `<div class="a-block ${i === 0 ? 'wide' : ''}">
        <p class="a-kicker">${a.k}</p>
        <h3>${a.lead}</h3>
        <div class="a-body a-lead">${a.body && a.body[0] ? a.body[0] : ''}</div>
        ${a.body && a.body.length > 1 ? `<ul class="a-list">${a.body.slice(1).map(li => `<li><span class="a-num">›</span><span>${li}</span></li>`).join('')}</ul>` : ''}
        ${a.note ? `<p class="a-note">${a.note}</p>` : ''}
      </div>`;
    }).join('');
    el.innerHTML = blocks;
  }

  /* ---------- 渲染：页脚网格 ---------- */
  function renderFooter() {
    const grid = document.getElementById('footerGrid');
    const cards = [
      { h: 'LMArena', p: '人类偏好唯一真实来源；无公开 API，分数需人工快照。看 Agent/WebDev/Chat/图像/视频五个对口榜。' },
      { h: 'Artificial Analysis', p: '分析最厚：智能指数 + 速度（72h P50）+ 价格（$/task）+ 开源指数 + Image/Video Arena。含 20% LLM 评委主观分。' },
      { h: 'llm-stats', p: '聚合层：只用排名顺序、TrueSkill μ−3σ、缺失≠零。本页综合分取 2026-09-03 公开榜，少数新模型为估算，待接 API 自动化。' },
      { h: 'LiveBench', p: '最干净（全客观、绝不用 LLM 裁判），但半年一刷；有唯一把质量与成本合在一起的 $/成功任务。' },
    ];
    grid.innerHTML = cards.map(c => `<div class="f-card"><h4>${c.h}</h4><p>${c.p}</p></div>`).join('');
  }

  /* ---------- 绑定筛选 chips ---------- */
  function bindChips() {
    document.querySelectorAll('.chip[data-open]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.open = btn.dataset.open;
        document.querySelectorAll('.chip[data-open]').forEach(b => {
          const on = b === btn; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on);
        });
        renderBoard();
      });
    });
    document.querySelectorAll('.chip[data-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.sort = btn.dataset.sort;
        document.querySelectorAll('.chip[data-sort]').forEach(b => {
          const on = b === btn; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on);
        });
        renderBoard();
      });
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    renderProvenance();
    renderDimNav();
    renderFooter();
    bindChips();
    renderBoard();
    // 入场动画
    requestAnimationFrame(() => {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
