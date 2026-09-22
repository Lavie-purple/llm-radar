/* 线上部署核验（部署守卫）—— 每次 `git push` 之后跑一次。
 *
 * 为什么需要它
 * ------------
 * selftest / visual_check / falsify 三层守卫**全部在本地跑**，它们证明的是
 * 「我这份源码是对的」。它们都证明不了**「线上跑的就是这一份」**：
 *   · Pages 可能还在部署（推完 30~60 秒内必定不一致）
 *   · 可能部署失败，线上还是上一版
 *   · Jekyll 可能吃掉某个文件（已知：`_` 开头的目录线上 404，见 README）
 *   · 可能线上是旧数据（这次推了代码但数据没重建）
 * 这个脚本补的就是这一段：**逐字节比对线上与本地的同一份文件，
 * 再在无头浏览器里把线上页面真正渲染一遍，与本地的渲染结果对表。**
 * 它不替代前三层，是与之正交的第四类检查（源码 → 构建产物 → 线上）。
 *
 * 用法
 * ----
 *   node tools/check_deploy.js                  # 比对默认线上地址
 *   node tools/check_deploy.js --wait=120       # 推完立刻跑：等 Pages 追平 + 部署任务跑完（整轮 120s 预算）
 *   node tools/check_deploy.js http://127.0.0.1:9000/   # 也可拿来比对任意镜像
 *   GITHUB_TOKEN=xxx node tools/check_deploy.js # 额外核对 Pages 构建的 job 级结论
 *
 * 退出码
 * ------
 *   0  线上与本地一致，且线上渲染正常
 *   1  有检查不通过（不一致 / 渲染异常 / 数据落后）
 *   2  环境不满足（没装 playwright）
 *
 * ⚠️ 两个必须记住的坑（都踩过，写在源码里防止以后被"顺手优化"掉）
 *   1. **线上文件比本地每行少 1 字节**——仓库里是 CRLF，Pages 出去是 LF。
 *      直接逐字节比会全红。所以两边都先做行尾归一化（见 EOL）。
 *   2. **不要拿 `GET /pages` 或 `/pages/builds/latest` 判断部署成败**——
 *      那是 legacy 端点，会把「连推两次时前一次 deploy 被取消」记成 failed
 *      且不自我复位，长期假报 `errored`。判断成败要看
 *      `GET /actions/runs` 里 `pages build and deployment` 的 **job/step 级**结论。
 *      本脚本走的就是后者，并在输出里显式说明「不信 /pages」。
 *
 * 本脚本末尾**必定**打印 `线上核验：` 开头的收尾汇总——tools/falsify.py 靠这一行
 * 判断它到底跑完没有（详见 falsify.py 里关于「没跑完 ≠ 守卫是假的」的注释）。
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ONLINE = (process.argv.slice(2).find(a => !a.startsWith('--')) || 'https://lavie-purple.github.io/llm-radar/').replace(/\/?$/, '/');
const WAIT = (() => {
  const a = process.argv.slice(2).find(x => x.startsWith('--wait'));
  const n = a ? parseInt(a.split('=')[1] || '0', 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const OUTDIR = path.join(ROOT, '_shot', 'live');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
/* `--wait` 的预算是**整轮共享**的（静态轮询 + 等 Pages run 结束），不是每段各给一次。
 * 这样「等待上限 120s」就是字面意思，不会因为前一段等满了把后一段饿空。 */
const T0 = Date.now();
const DEADLINE = WAIT ? T0 + WAIT * 1000 : 0;

const fails = [];
let nchecks = 0;
function check(cond, label, detail) {
  nchecks++;
  if (!cond) fails.push(label + (detail !== undefined ? ' → ' + detail : ''));
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (!cond && detail !== undefined ? '   [' + detail + ']' : ''));
}

function loadPlaywright() {
  const tries = ['playwright', 'C:/Users/lavie/.workbuddy/binaries/node/workspace/node_modules/playwright'];
  for (const t of tries) { try { return require(t); } catch (e) { /* 下一个 */ } }
  console.error('找不到 playwright。先装：cd C:/Users/lavie/.workbuddy/binaries/node/workspace && npm i playwright');
  process.exit(2);
}

/* 行尾归一化：仓库里是 CRLF，Pages 出去是 LF —— 实测 scripts/radar.js
 * 本地 68571 字节 / 1307 个 CRLF，线上 67264 字节 / 0 个 CRLF，差值恰好 1307。
 * 不做这一步，逐字节比对会把「同一份文件」全部判成不一致。 */
const EOL = /\r\n/g;
const norm = s => String(s).replace(EOL, '\n');
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/* ── 静态文件清单：只列「页面真的会加载」的那些 ──
 * index.html 显式列出；scripts/ styles/ 下的 js/css、data/ 下的 js 由目录扫描得出，
 * 这样以后新增样式或脚本会自动进清单，不会因为忘了改脚本而漏检。
 * 刻意**不含 data/*.json** —— 页面走的是 app.json.js（避开 file:// 的 CORS），
 * .json 是构建中间产物，线上有没有它不影响页面。 */
function manifest() {
  const out = ['index.html'];
  for (const d of ['scripts', 'styles', 'data']) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (/\.(js|css)$/.test(f)) out.push(d + '/' + f);
    }
  }
  return out;
}

/* 抓线上文件：带重试，**并把每次重试打出来**。
 * 本机走代理，偶发 502 / 超时是常事 —— 实测有一次 7 个文件抓了 99s，
 * 全程没有任何提示，看起来就像脚本"卡住了"。把原因打出来比让它快更重要：
 * 慢得莫名其妙，和慢得有解释，是完全不同的两件事。 */
async function fetchText(url, tries = 3, label = '') {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const ac = new AbortController();
      const tid = setTimeout(() => ac.abort(), 20000);
      const r = await fetch(url, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'llm-radar-check' },
        signal: ac.signal,
      });
      clearTimeout(tid);
      const text = await r.text();
      if (!r.ok) { last = 'HTTP ' + r.status; }
      else return { status: r.status, text };
    } catch (e) { last = e.name === 'AbortError' ? '超时 20s' : String(e.message || e); }
    if (i < tries - 1) {
      console.log(`  ! 线上取 ${label || url} 失败（${last}），1.5s 后重试 ${i + 2}/${tries}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return { status: 0, text: '', err: last };
}

/* 首个不同处的行号 + 两侧原文（截断），不一致时给的是可定位的线索而不是一句"不一样" */
function firstDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) {
      const cut = s => (s === undefined ? '(无此行)' : (s.length > 78 ? s.slice(0, 78) + '…' : s || '(空行)'));
      return { line: i + 1, local: cut(A[i]), online: cut(B[i]) };
    }
  }
  return null;
}

/* 独立重算「该有几个「新」徽章」——**故意不复用 radar.js 的代码**。
 * 与 verify_lmarena.py 同一个思路：交叉校验的价值恰恰在于它是另写一遍。
 * 口径必须与雷达页一致：按 generatedAt 的**日期**（UTC 零点）算天数，窗口含端点。 */
function expectBadges(app) {
  const ref = Date.parse(String(app.generatedAt).slice(0, 10) + 'T00:00:00Z');
  const win = app.newWindowDays;
  let lit = 0, dated = 0, undated = 0;
  for (const id of app.matrixIds || []) {
    const rd = (app.models[id] || {}).releasedAt;
    if (!rd) { undated++; continue; }
    const b = Date.parse(String(rd).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(b)) { undated++; continue; }
    dated++;
    const d = Math.round((ref - b) / 86400000);
    if (d >= 0 && d <= win) lit++;
  }
  return { lit, dated, undated, win, rows: (app.matrixIds || []).length };
}

/* 再独立算一遍「矩阵该有多少个有值格子」——与 tools/stat_app.py 的 has_value 同口径：
 * 只要该模型在该子类的**主指标**上有值就算有值。用来把 DOM 数出来的格数与数据对上，
 * 免得「页面把空位也渲染成有值」这类问题溜过去。 */
function expectFilled(app) {
  const subs = Object.values(app.subcats || {});
  let n = 0;
  for (const id of app.matrixIds || []) {
    const cells = (app.models[id] || {}).cells || {};
    for (const sc of subs) {
      const v = ((cells[sc.key] || {}).values || {})[sc.primary];
      if (v !== undefined && v !== null) n++;
    }
  }
  return n;
}

/* 取本地 HEAD 与远端 slug：**直接读 .git 里的文本，不起子进程**。
 * 实测本机（WorkBuddy 沙箱）里 `execSync` / `execFileSync` 一律抛
 * `spawnSync ... EBUSY` —— 连 cmd.exe 都起不来。而 `.git/HEAD`、`.git/config`
 * 本来就是纯文本，读文件比调 git 更稳，也不依赖 PATH 上有没有 git。 */
function readGitInfo() {
  const g = path.join(ROOT, '.git');
  const info = { head: null, slug: null };
  try {
    let head = fs.readFileSync(path.join(g, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const loose = path.join(g, ref);
      if (fs.existsSync(loose)) {
        head = fs.readFileSync(loose, 'utf8').trim();
      } else {
        // 打包过的仓库里 ref 不在 .git/refs 下，而在 packed-refs 里
        const line = fs.readFileSync(path.join(g, 'packed-refs'), 'utf8')
          .split('\n').find(l => l.endsWith(' ' + ref));
        if (line) head = line.split(' ')[0];
      }
    }
    if (/^[0-9a-f]{40}$/.test(head)) info.head = head.slice(0, 7);
  } catch (e) { /* 不是 git 仓库就留空 */ }
  try {
    const cfg = fs.readFileSync(path.join(g, 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    const mm = m && /github\.com[/:]([^/]+)\/(.+?)(\.git)?$/.exec(m[1].trim());
    if (mm) info.slug = mm[1] + '/' + mm[2];
  } catch (e) { /* 没配 remote 就留空 */ }
  return info;
}

/* 线上 app.json.js 是 `window.APP={...};` —— 尾部有个分号，直接 JSON.parse 会报
 * "Unexpected non-whitespace character after JSON"。必须把尾分号切掉。 */
function parseAppPayload(text) {
  return JSON.parse(text.slice(text.indexOf('{')).replace(/;\s*$/, ''));
}

/* 零依赖静态服务：让本地渲染对照不必依赖「另开一个终端起 8758」。
 * 监听 0 号端口由系统分配，避免与 visual_check 的 8758 抢口。 */
function serveLocal(root) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((ok, bad) => { srv.on('error', bad); srv.listen(0, '127.0.0.1', () => ok(srv)); });
}

/* 页面渲染指标：两个视图都看不到的东西不算核验过了，所以同时采矩阵与页脚。
 * ⚠️ `filled` 不能直接数 `.cellbtn` —— 空位也是 `.cellbtn`（里面套一个 `.miss` 的 `·`），
 * 实测两边都等于 1938，等于没量。必须是「有值 = 格子数 − 空位数」。 */
const METRICS = () => {
  const cells = document.querySelectorAll('#matrix td.cell').length;
  const miss = document.querySelectorAll('#matrix .cellbtn .miss').length;
  return {
    title: document.title,
    rows: document.querySelectorAll('#matrix tbody tr[data-row]').length,
    cells,
    miss,
    filled: cells - miss,
    badges: document.querySelectorAll('#matrix .newbadge').length,
    models: window.APP ? Object.keys(window.APP.models || {}).length : 0,
    win: window.APP ? window.APP.newWindowDays : null,
    gen: window.APP ? window.APP.generatedAt : null,
    note: ((document.querySelector('#matrix-note') || {}).innerText || '').replace(/\s+/g, ' ').trim(),
    gaps: ((document.querySelector('#footer-gaps') || {}).innerText || '').replace(/\s+/g, ' ').trim(),
  };
};

async function gotoAndMeasure(page, url, errs, failed) {
  errs.length = 0;
  failed.length = 0;
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(600);
  const m = await page.evaluate(METRICS);
  return { status: resp ? resp.status() : 0, m, errs: errs.slice(), failed: failed.slice() };
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const gi = readGitInfo();
  const head = gi.head || '';
  console.log('线上地址 : ' + ONLINE);
  console.log('本地 HEAD : ' + (head || '(不是 git 仓库)')
    + (gi.slug ? ('   origin ' + gi.slug) : '') + (WAIT ? ('   等待上限 ' + WAIT + 's') : ''));

  /* ────────── 1. 静态文件逐字节比对 ────────── */
  console.log('\n[静态文件]');
  const files = manifest();
  console.log(`  ${files.join('  ')}`);
  const onlineText = {};
  for (;;) {
    let bad = 0;
    for (const f of files) {
      const r = await fetchText(ONLINE + f, 3, f);
      if (!r.text) { onlineText[f] = null; bad++; continue; }
      onlineText[f] = r.text;
      if (norm(fs.readFileSync(path.join(ROOT, f), 'utf8')) !== norm(r.text)) bad++;
    }
    if (bad === 0) break;
    if (!WAIT || Date.now() >= DEADLINE) break;
    const waited = Math.round((Date.now() - T0) / 1000);
    console.log(`  .. 线上还没追上（${bad} 个文件不一致或缺失），10s 后重试（已等 ${waited}s / 上限 ${WAIT}s）`);
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log(`  清单 ${files.length} 个，抓取耗时 ${Math.round((Date.now() - T0) / 1000)}s`);
  const nStaticFail = fails.length;
  for (const f of files) {
    const lp = path.join(ROOT, f);
    if (!fs.existsSync(lp)) { check(false, f + ' 本地存在', '本地缺文件'); continue; }
    const lraw = fs.readFileSync(lp, 'utf8');
    const local = norm(lraw);
    const remote = onlineText[f];
    if (remote === null || remote === undefined) {
      check(false, f, '线上取不到（404 或网络失败）—— 检查是不是 `_` 开头的目录被 Jekyll 吃掉了');
      continue;
    }
    const rn = norm(remote);
    const lcrlf = (lraw.match(EOL) || []).length;
    const info = '本地 ' + Buffer.byteLength(lraw) + 'B(' + lcrlf + ' CRLF) / 线上 ' + Buffer.byteLength(remote)
      + 'B / 行 ' + local.split('\n').length + ' / sha ' + sha(local) + (rn === local ? '' : ' vs ' + sha(rn));
    check(rn === local, f, info + (rn === local ? '' : ' —— 内容不一致'));
    if (rn !== local) {
      const d = firstDiff(local, rn);
      if (d) {
        console.log('         首个不同处 第 ' + d.line + ' 行');
        console.log('           本地: ' + d.local);
        console.log('           线上: ' + d.online);
      }
    }
  }
  /* 不一致有两种完全不同的成因，处理方式也不同，所以必须分开提示：
   *   (a) 本地有没推上去的改动 —— 常态，`git status` 一看就知道；
   *   (b) 推了但 Pages 还没部署完（通常 30~60s）或部署失败 —— 用 --wait 等，或去看 run 结论。
   * 不提示的话，人第一反应容易是「线上坏了」，其实是自己还没推。 */
  if (fails.length > nStaticFail) {
    console.log('  ⚠️ 上面这些不一致的两种可能成因，先分清楚再看线上：');
    console.log('     (a) 本地有未提交/未推送的改动 —— 跑 `git status` 看一眼；');
    console.log('     (b) 推了但 Pages 还没部署完或部署失败 —— 加 `--wait=120` 等它追平，');
    console.log('         再跑一次；若仍不一致，去 `/actions/runs` 看 pages 任务的 job 级结论。');
  }

  /* ────────── 2. 线上数据自洽 ────────── */
  console.log('\n[线上数据]');
  const localApp = parseAppPayload(fs.readFileSync(path.join(ROOT, 'data', 'app.json.js'), 'utf8'));
  const remoteAppRaw = onlineText['data/app.json.js'];
  let remoteApp = null;
  try { remoteApp = remoteAppRaw ? parseAppPayload(remoteAppRaw) : null; } catch (e) { remoteApp = null; }
  check(!!remoteApp, '线上 app.json.js 可解析', remoteApp ? '' : '取不到或不是合法 JSON');
  const exp = expectBadges(localApp);
  const expFilled = expectFilled(localApp);
  if (remoteApp) {
    check(remoteApp.newWindowDays === localApp.newWindowDays, '窗口默认值一致',
      '本地 ' + localApp.newWindowDays + ' / 线上 ' + remoteApp.newWindowDays);
    const cLocal = Object.values(localApp.models).filter(m => m.releasedAt).length;
    const cRemote = Object.values(remoteApp.models).filter(m => m.releasedAt).length;
    check(cRemote === cLocal, '带发布日期的模型数一致', '本地 ' + cLocal + ' / 线上 ' + cRemote);
    check(remoteApp.generatedAt === localApp.generatedAt, '数据生成时间戳一致',
      '本地 ' + localApp.generatedAt + ' / 线上 ' + remoteApp.generatedAt);
  }
  console.log('  独立重算：矩阵 ' + exp.rows + ' 行 / 有日期 ' + exp.dated + ' / 无日期 ' + exp.undated
    + ' → 窗口 ' + exp.win + ' 天应亮 ' + exp.lit + ' 个「新」徽章；有值格子 ' + expFilled + ' 个');

  /* ────────── 3. 线上渲染（无头浏览器）────────── */
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [], failed = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('requestfailed', r => failed.push(r.url() + ' :: ' + ((r.failure() || {}).errorText || '')));

  console.log('\n[线上渲染]');
  const on = await gotoAndMeasure(page, ONLINE + '?t=' + Date.now(), errs, failed);
  check(on.status === 200, 'HTTP 200', 'status ' + on.status);
  check(on.m.rows === exp.rows, '矩阵行数与数据一致', on.m.rows + ' vs ' + exp.rows);
  check(on.m.filled === expFilled, '有值格子数与独立重算一致', on.m.filled + ' vs ' + expFilled);
  check(on.m.cells === exp.rows * Object.keys(localApp.subcats || {}).length,
    '格子总数 = 行数 × 子类数', on.m.cells + ' vs ' + (exp.rows * Object.keys(localApp.subcats || {}).length));
  check(on.m.badges === exp.lit, '「新」徽章数与独立重算一致', on.m.badges + ' vs ' + exp.lit);
  check(on.m.models > 0, 'APP 数据已加载（模型库 ' + on.m.models + ' 个）');
  check(on.m.win === localApp.newWindowDays, '页面生效窗口 = 本地默认值', on.m.win + ' vs ' + localApp.newWindowDays);
  check(on.m.gen === localApp.generatedAt, '线上渲染用的数据 = 本地当前数据', on.m.gen + ' vs ' + localApp.generatedAt);
  check(/LLM Radar/.test(on.m.title), '标题正确', on.m.title);
  check(errs.length === 0, '无 JS 错误', errs.join(' | '));
  /* 字体走 Google Fonts，被网络策略挡住是常事，不是本站的问题 ——
   * 只对**同源**请求失败叫错，否则会因为一个 CDN 抖动把部署判成坏的。 */
  const ownFailed = on.failed.filter(u => u.includes(new URL(ONLINE).host));
  check(ownFailed.length === 0, '无同源请求失败', ownFailed.join(' | ') || ('跨域失败 ' + on.failed.length + ' 个（不计）'));

  console.log('  矩阵 ' + on.m.rows + ' 行 / 有值 ' + on.m.filled + ' 格 / 空位 ' + on.m.miss
    + '（共 ' + on.m.cells + '）/ 徽章 ' + on.m.badges + ' / 窗口 ' + on.m.win + ' 天 / 模型库 ' + on.m.models);
  console.log('  脚注 ' + on.m.note.slice(0, 96));
  await page.screenshot({ path: path.join(OUTDIR, 'online-top.png') });

  /* 徽章特写：17px 宽的东西只能靠裁特写肉眼看（详见 README 里 shot('17-newbadge') 那条教训）。
   * 先把目标行滚进 .tablewrap 的可视区再取坐标 —— 矩阵是在 .tablewrap 里自己滚的，
   * tr.offsetTop 相对的是 <table> 而不是文档。 */
  const clip = await page.evaluate(() => {
    const b = document.querySelector('#matrix .newbadge');
    if (!b) return null;
    const row = b.closest('tr'), wrap = document.querySelector('#view-matrix .tablewrap');
    const rt = row.getBoundingClientRect(), wt = wrap.getBoundingClientRect();
    if (rt.top < wt.top + 8 || rt.bottom > wt.bottom - 8) wrap.scrollTop += (rt.top - wt.top) - 40;
    return true;
  });
  let clipBox = null;
  if (clip) {
    await page.waitForTimeout(180);
    clipBox = await page.evaluate(() => {
      const b = document.querySelector('#matrix .newbadge');
      const mbtn = b.closest('.mbtn');
      if (!mbtn) return null;
      const r = mbtn.getBoundingClientRect();
      const pad = 6;
      return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 };
    });
    if (clipBox) await page.screenshot({ path: path.join(OUTDIR, 'online-badge.png'), clip: clipBox });
  }
  check(!!clipBox, '徽章特写已裁到（线上至少有一个徽章）');
  if (clipBox) {
    check(clipBox.width >= 40 && clipBox.width <= 500,
      '徽章特写不是整屏图（' + Math.round(clipBox.width) + '×' + Math.round(clipBox.height) + 'px）',
      JSON.stringify({ w: Math.round(clipBox.width), h: Math.round(clipBox.height) }));
  }

  /* ────────── 4. 线上 URL 覆盖实测 ────────── */
  console.log('\n[线上 URL 覆盖]');
  const off = await gotoAndMeasure(page, ONLINE + '?new=0&t=' + Date.now(), errs, failed);
  check(off.m.badges === 0, '?new=0 关掉全部徽章', off.m.badges + ' 个');
  const wide = await gotoAndMeasure(page, ONLINE + '?new=3650&t=' + Date.now(), errs, failed);
  check(wide.m.badges >= on.m.badges && wide.m.badges <= exp.dated,
    '?new=3650 放宽到全部有日期的行（' + wide.m.badges + ' 个，上限 ' + exp.dated + '）', wide.m.badges + ' 个');
  check(off.m.rows === on.m.rows && wide.m.rows === on.m.rows, '换个窗口不改变行数', off.m.rows + '/' + wide.m.rows);

  /* ────────── 5. 本地渲染对照 ────────── */
  console.log('\n[本地渲染对照]');
  const srv = await serveLocal(ROOT);
  const localBase = 'http://127.0.0.1:' + srv.address().port + '/';
  try {
    const lo = await gotoAndMeasure(page, localBase + '?t=' + Date.now(), errs, failed);
    console.log('  本地服务 ' + localBase + ' → 矩阵 ' + lo.m.rows + ' 行 / 徽章 ' + lo.m.badges);
    for (const k of ['rows', 'cells', 'miss', 'filled', 'badges', 'models', 'win', 'gen', 'title']) {
      check(lo.m[k] === on.m[k], '线上与本地渲染一致：' + k, '本地 ' + lo.m[k] + ' / 线上 ' + on.m[k]);
    }
    check(norm(lo.m.note) === norm(on.m.note), '线上与本地脚注一致', norm(lo.m.note).slice(0, 70));
    check(norm(lo.m.gaps) === norm(on.m.gaps), '线上与本地「已知缺口」一致');
  } finally {
    srv.close();
  }

  /* ────────── 6. GitHub Pages 构建结论（需 token，可选）────────── */
  console.log('\n[GitHub Pages 构建结论]');
  if (!TOKEN) {
    console.log('  跳过（未设 GITHUB_TOKEN）：这一项要读 /actions/runs 的 job 级结论，');
    console.log('  取 token 的办法见 README「推送」一节（本机凭据管理器里已有）。');
  } else {
    if (!gi.slug) {
      console.log('  跳过（.git/config 里没有 github 的 origin）');
    } else {
      const api = async p => {
        const r = await fetch('https://api.github.com' + p, {
          headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'llm-radar-check' },
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      };
      try {
        /* 取 run 时**优先挑对应当前 HEAD 的那个** —— 否则「推完立刻跑」很可能拿到上一次的
         * run（Pages 还没为这个 commit 建任务），于是拿别人的结论当自己的。 */
        const pickRun = async () => {
          const runs = (await api('/repos/' + gi.slug + '/actions/runs?per_page=10')).workflow_runs || [];
          const pages = runs.filter(r => /pages/i.test(r.name || ''));
          return pages.find(r => !head || r.head_sha.startsWith(head)) || pages[0] || null;
        };
        let mine = null;
        /* `--wait` 也必须等这个 run 结束。实测踩过：这次提交只动了 tools/ 与 README，
         * 静态文件全等 → 上面那轮轮询立刻通过、等不到任何东西，而部署其实还在跑，
         * 于是报出 3 条 FAIL（run in_progress / Deploy step 为 null），
         * 看着像「线上坏了」，其实只是「没等」。 */
        for (;;) {
          mine = await pickRun();
          if (mine && mine.status === 'completed') break;
          if (!WAIT || Date.now() >= DEADLINE) break;
          const waited = Math.round((Date.now() - T0) / 1000);
          console.log(`  .. Pages ${mine ? 'run ' + mine.head_sha.slice(0, 7) + ' 还在 ' + mine.status : '还没为这个 commit 起任务'}`
            + `，10s 后重试（已等 ${waited}s / 上限 ${WAIT}s）`);
          await new Promise(r => setTimeout(r, 10000));
        }
        if (!mine) {
          console.log('  跳过（最近 10 次 run 里没有 pages 相关任务）');
        } else {
          console.log('  最新 pages run ' + mine.head_sha.slice(0, 7) + ' | status ' + mine.status + ' | conclusion ' + mine.conclusion);
          check(mine.status === 'completed', 'Pages run 已完成（当前 status=' + mine.status + '）', mine.status);
          check(mine.conclusion === 'success', 'Pages run 结论 success', String(mine.conclusion));
          if (mine.status !== 'completed') {
            console.log('     ↑ 这是「推完马上跑」的正常中间态，不是部署坏了：');
            console.log('       加 `--wait=120` 等它跑完，或过一会儿重跑本脚本。');
          }
          const jobs = (await api('/repos/' + gi.slug + '/actions/runs/' + mine.id + '/jobs')).jobs || [];
          for (const j of jobs) {
            for (const s of j.steps || []) {
              console.log('    ' + (s.conclusion === 'success' ? '✓' : '✗') + ' ' + j.name + ' / ' + s.name + ' → ' + s.conclusion);
              check(s.conclusion === 'success', '步骤 ' + s.name, String(s.conclusion));
            }
          }
          /* HEAD 是否已对应到这个 run —— **刻意只打印、不判定**。
           * 原因：若某次 push 没改动清单里的任何文件（只改了 tools/ 或 README），
           * 静态比对会立刻通过、`--wait` 也等不到任何东西，而 Pages 可能还没为这个
           * commit 起任务 —— 此时把「run 的 sha ≠ HEAD」判成失败就是**误报**。
           * 真正「线上 == 这一份」的证据是上面那段逐字节比对，这一行只是补充信息。 */
          if (!head || mine.head_sha.startsWith(head)) {
            console.log('  该 run 对应当前 HEAD ' + head);
          } else {
            console.log('  ⚠️ 该 run 是 ' + mine.head_sha.slice(0, 7) + '，不是当前 HEAD ' + (head || '(空)'));
            console.log('     若上面静态文件已全部一致，说明这次改动没影响线上文件（只动了 tools/ 等），属正常；');
            console.log('     否则说明 Pages 还没为这个 commit 起任务，稍后重跑即可。');
          }
          console.log('  注：**不看** `GET /pages` —— 那是 legacy 端点，会把「连推两次时前一次 deploy 被取消」');
          console.log('      记成 failed 且不复位，长期假报 errored。上面 job/step 级结论才是权威。');
        }
      } catch (e) {
        console.log('  GitHub API 读取失败：' + e.message + '（这一项不作为不通过，但要人工看一眼）');
      }
    }
  }

  console.log('\n核验截图：' + OUTDIR);
  await browser.close();

  /* 这一行是 tools/falsify.py 的判定锚点，必须**无论成败都打印**。 */
  console.log(fails.length
    ? '线上核验：FAIL ' + fails.length + ' 项\n  - ' + fails.join('\n  - ')
    : '线上核验：PASS（' + nchecks + ' 项检查全部通过）');
  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  console.log('线上核验：CRASH —— ' + String(e && e.stack || e).split('\n').slice(0, 4).join(' / '));
  process.exit(1);
});
