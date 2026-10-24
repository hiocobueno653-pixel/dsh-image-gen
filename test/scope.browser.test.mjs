/**
 * 作用域验证：用真实 Chromium 加载插件的 CSS，对着**仿真的宿主 DOM** 逐条判定。
 *
 * 为什么要真浏览器：`:has()` / `:not(:has())` 的匹配语义在 jsdom 与真实引擎之间有差异，
 * 只有在真实 CSS 引擎里跑一遍才算数。
 *
 * 当前架构：**生图不是消息，是这一轮的 Turn 尾卡片**
 *   · 生成中：工具行里播 GridReveal（含 running 标记的那一行/那个组要能看见）
 *   · 出图后：工具行整行收掉；只含生图的组连组头一起收掉；图片在 turnTail 上
 *   · 组里还有别的步骤时，只收生图那一行，组头和别的步骤照旧
 *   · 用户气泡、别的轮次、别的组一律不动
 * 只收「生图这一行 / 这一组 / 这一轮的耗时行」，**不藏整轮**。
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || join(tmpdir(), 'image-gen-artifacts');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
/**
 * 抠出 CSS 数组并求值成最终字符串。
 *
 * ⚠️ 不要按行解析：规则可以用 `"…" + "…"` 跨行拼接（长选择器为了可读性就这么写），
 * 按"整行都是字符串字面量"过滤会把它们整条丢掉——测出来的东西和实际注入的不一样，
 * 这类测试就会假装通过。这里直接把数组字面量交给 JS 求值，和 ensureCss 拿到的完全一致。
 */
function grabArray(name) {
  const head = 'var ' + name + ' = [';
  const start = source.indexOf(head);
  if (start < 0) throw new Error('找不到样式块 ' + name);
  const end = source.indexOf('].join(', start);
  if (end < 0) throw new Error('样式块 ' + name + ' 没有闭合');
  /* CSS 数组里会引用模块级的图标数据（navIconMask() 拼 mask 的 url()）。
     把 `var NAV_LABEL` 到 `var CSS` 之间那段原样取来当预lude，求值出来的
     才是 ensureCss 真正注入的东西，而不是一个近似版本。 */
  const preludeStart = source.indexOf('var NAV_LABEL');
  const prelude = preludeStart >= 0 && preludeStart < start
    ? source.slice(preludeStart, start)
    : '';
  return new Function(prelude + 'return [' + source.slice(start + head.length, end) + '];')().join('\n');
}
const cssText = grabArray('CSS');

/* ---- 仿真的宿主 DOM（结构来自运行中的 DSH 真机快照） ----
 *  [data-chat-turn]                                   一轮
 *    [data-chat-flow-kind=user]                       用户的提问
 *    [data-step-process]                              过程组
 *      div > ProcessGroupHeader                       「已调用工具」
 *      [data-step-process-body] > [data-step-process-content][data-chat-flow]
 *        [data-chat-anchor-key] > [data-chat-flow-kind=tool-call]
 *          span[data-slot=image-gen-slot][data-image-gen-state=running|done]
 *    [data-chat-flow-kind=turn-tail] > [data-turn-tail]   轮到尾部（图片卡在这层）
 *      [data-slot=image-gen-turn] > .ig-item > a > img
 *    button[data-turn-process]                        「已完成，用时 N 秒」
 */
const hostDom = `
<div id="app">
  <!-- ===== 轮次 A：普通对话（思考组 + 另一个工具组）——必须完全不受影响 ===== -->
  <div data-chat-turn="A" id="turnA">
    <div data-chat-flow-kind="user" id="bubbleA">画一只橘猫</div>
    <div data-step-process data-chat-group-key="A-think" id="groupAthink">
      <div id="headAthink"><span class="lbl">已完成分析</span></div>
      <div data-step-process-body>
        <div data-step-process-content data-chat-flow>
          <div data-chat-anchor-key="msg:1"><div data-chat-flow-kind="assistant-step">我先查一下文件…</div></div>
        </div>
      </div>
    </div>
    <div data-step-process data-chat-group-key="A-tools" id="groupAtools">
      <div id="headAtools"><span class="lbl">已调用工具</span></div>
      <div data-step-process-body>
        <div data-step-process-content data-chat-flow>
          <div data-chat-anchor-key="msg:2"><div data-chat-flow-kind="tool-call"><div class="toolcard">运行命令 · dir</div></div></div>
        </div>
      </div>
    </div>
    <div data-chat-flow-kind="turn-tail"><div data-turn-tail="A"></div></div>
    <button data-turn-process data-open id="tailA">已完成，用时 23 秒</button>
  </div>

  <!-- ===== 轮次 B：只生图 —— 行与组全收，图片在 Turn 尾卡片 ===== -->
  <div data-chat-turn="B" id="turnB">
    <div data-chat-flow-kind="user" id="bubbleB">再画一张雪山</div>
    <div data-step-process data-chat-group-key="B-tools" id="groupBtools">
      <div id="headBtools"><span class="lbl">已调用工具</span></div>
      <div data-step-process-body>
        <div data-step-process-content data-chat-flow>
          <!-- ⚠️ 真实宿主 DOM：data-chat-anchor-key 与 data-chat-flow-kind/data-image-gen-row
               挂在**同一个** flowItem 元素上（实测 xz4KEq_flowItem 同时带这四个属性）。
               fixture 必须照这个形状写，否则 :has() 只匹配后代、不含自身的坑测不出来。 -->
          <div data-chat-anchor-key="msg:2b" data-chat-flow-kind="assistant-step" id="textBInGroup">我这就为你生成图片</div>
          <div data-chat-anchor-key="msg:3" data-chat-flow-kind="tool-call" id="toolrowB" data-image-gen-row="done">
            <span data-slot="image-gen-slot" data-image-gen-state="done" data-image-gen-call="call-b"></span>
          </div>
        </div>
      </div>
    </div>
    <div data-chat-flow-kind="turn-tail" id="tailNodeB">
      <div data-turn-tail="B">
        <div class="ig-turn" data-slot="image-gen-turn" id="cardB">
          <div class="ig-item">
            <a class="ig-frameLink" href="/image-gen/raw/call-b/0"><img class="ig-image" style="width:min(100%, calc(36vh * 1.7777777777777777))" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAwIiBoZWlnaHQ9IjkwMCI+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iIzNjODJjNiIvPjwvc3ZnPg=="></a>
          </div>
        </div>
      </div>
    </div>
    <button data-turn-process data-open id="tailB" data-image-gen-quiet>已完成，用时 45 秒</button>
  </div>

  <!-- ===== 轮次 C：混合组（生图 + 另一个工具）——只收生图那一行 ===== -->
  <div data-chat-turn="C" id="turnC">
    <div data-chat-flow-kind="user" id="bubbleC">帮我找参考图再画一张</div>
    <div data-step-process data-chat-group-key="C-tools" id="groupCtools">
      <div id="headCtools"><span class="lbl">已调用工具</span></div>
      <div data-step-process-body>
        <div data-step-process-content data-chat-flow>
          <div data-chat-anchor-key="msg:4a" data-chat-flow-kind="assistant-step" id="textCInGroup">先找一张参考图</div>
          <div data-chat-anchor-key="msg:4" data-chat-flow-kind="tool-call" id="toolrowC" data-image-gen-row="done">
            <span data-slot="image-gen-slot" data-image-gen-state="done" data-image-gen-call="call-c"></span>
          </div>
          <div data-chat-anchor-key="msg:5" data-chat-flow-kind="tool-call" id="toolrowC2"><div class="toolcard">web_search · 参考图</div></div>
        </div>
      </div>
    </div>
    <div data-chat-flow-kind="turn-tail"><div data-turn-tail="C"></div></div>
    <button data-turn-process data-open id="tailC">已完成，用时 12 秒</button>
  </div>

  <!-- ===== 轮次 D：正在生成 —— 过程组被宿主折起来，动画必须在里面看得见 ===== -->
  <div data-chat-turn="D" id="turnD">
    <div data-chat-flow-kind="user" id="bubbleD">画一张赛博朋克街景</div>
    <div data-step-process data-chat-group-key="D-tools" id="groupDtools">
      <div id="headDtools"><span class="lbl">正在调用工具…</span></div>
      <div data-step-process-body hidden="until-found" id="bodyD" style="max-height:400px">
        <div data-step-process-content data-chat-flow>
          <div data-chat-anchor-key="msg:6" data-chat-flow-kind="tool-call" id="toolrowD" data-image-gen-row="running" data-chat-turn="D">
            <span data-slot="image-gen-slot" data-image-gen-state="running" data-image-gen-call="call-d"></span>
            <div class="ig-item" id="animD">
              <div class="ig-frame" id="animFrameD" style="width:min(100%, calc(36vh * 1.7777777777777777));aspect-ratio:1.7777777777777777"><canvas class="ig-canvas" width="320" height="320"></canvas></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div data-chat-running id="runD" data-image-gen-quiet>深度求索中，用时 12 秒 ···</div>
  </div>
</div>`;

const CHROME = process.env.CHROME_PATH || undefined;
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
// 描边方便肉眼确认（截图用）
const fixtureCss =
  cssText +
  `
[data-step-process]{outline:1px dashed #94a3b8;padding:4px}
[data-chat-turn]{outline:1px solid #cbd5e1;margin:8px 0;padding:4px}
.ig-turn{outline:2px solid #16a34a}
.ig-canvas{background:#dbeafe;display:block}
[data-turn-tail]{padding:4px}`;
await page.setContent(`<!doctype html><html><head><style>${fixtureCss}</style></head><body>${hostDom}</body></html>`);

const view = id => page.$eval(`#${id}`, el => ({ display: getComputedStyle(el).display, contentVisibility: getComputedStyle(el).contentVisibility }));
const visible = async id => (await view(id)).display !== 'none';
const hidden = async id => (await view(id)).display === 'none';
/* 被祖先整组隐藏时，子元素自身的 computed display 仍是 block，所以按"有没有渲染"判定 */
const notRendered = async id => page.$eval('#' + id, el => { const r = el.getBoundingClientRect(); return r.width === 0 && r.height === 0; });

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

console.log('轮次 B：只生图 —— 聊天流里不留痕迹，图片在 Turn 尾');
check('生图的工具行整行收掉', await hidden('toolrowB'), (await view('toolrowB')).display);
check('只含生图的组整组收掉（组头也不占位）', await hidden('groupBtools'), (await view('groupBtools')).display);
check('该轮耗时行收掉', await hidden('tailB'), (await view('tailB')).display);
check('★ 生图轮里模型写的文字（"我这就生成…"）也收掉——只留图片', await notRendered('textBInGroup'), JSON.stringify(await view('textBInGroup')));
check('★ 用户的提问必须留着', await visible('bubbleB'), (await view('bubbleB')).display);
check('整轮容器没有被藏', await visible('turnB'));
check('★ 图片卡片在 Turn 尾、且可见', await visible('cardB'));
check('图片卡不在过程组里（过程组之外）', await page.$eval('#cardB', el => el.closest('[data-step-process]') === null && el.closest('[data-turn-tail]') !== null));
check('卡片显示尺寸＝半尺寸（320 上限内、非缩略图）', await page.$eval('#cardB img.ig-image', el => { const w = Math.round(el.getBoundingClientRect().width); return w > 200 && w <= 320; }), await page.$eval('#cardB img.ig-image', el => Math.round(el.getBoundingClientRect().width)));
check('高度由图片比例决定（16:9）', await page.$eval('#cardB img.ig-image', el => { const r = el.getBoundingClientRect(); return Math.abs(r.width / r.height - 16 / 9) < 0.05; }));

console.log('轮次 C：混合组 —— 只收生图那一行');
check('生图行收掉', await hidden('toolrowC'), (await view('toolrowC')).display);
check('★ 组头保留（点得开、看得见还有别的步骤）', await visible('headCtools'), (await view('headCtools')).display);
check('★ 组壳保留', await visible('groupCtools'));
check('★ 同组里别的工具行照旧', await page.$eval('#toolrowC2', el => getComputedStyle(el).display !== 'none'));
check('该轮耗时行照旧（这一轮不只生图）', await visible('tailC'), (await view('tailC')).display);
check('★ 混合轮里助手文字一个字都不动', (await visible('textCInGroup')) && !(await notRendered('textCInGroup')), (await view('textCInGroup')).display);

console.log('轮次 D：正在生成 —— 折叠的过程组要露出动画');
check('含 running 标记的折叠组被强制展开', await page.$eval('#bodyD', el => {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.contentVisibility === 'visible';
}), JSON.stringify(await view('bodyD')));
check('动画框在里面可见', await page.$eval('#animD', el => el.getBoundingClientRect().height > 0));
check('★ 生图动画不被过程组 max-height 裁掉（否则"太大、显示不全"）',
  await page.$eval('#bodyD', el => getComputedStyle(el).maxHeight === 'none'), await page.$eval('#bodyD', el => getComputedStyle(el).maxHeight));
check('★ 动画框与成图框同尺寸（同比例 → 同宽高，落地不跳）', await page.evaluate(() => {
  const a = document.querySelector('#animFrameD').getBoundingClientRect();
  const b = document.querySelector('#cardB img.ig-image').getBoundingClientRect();
  return Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
}), JSON.stringify(await page.evaluate(() => {
  const a = document.querySelector('#animFrameD').getBoundingClientRect();
  const b = document.querySelector('#cardB img.ig-image').getBoundingClientRect();
  return { anim: Math.round(a.width) + 'x' + Math.round(a.height), img: Math.round(b.width) + 'x' + Math.round(b.height) };
})));
check('running 这一行没有被收掉', await visible('toolrowD'));
check('★ 运行中的「深度求索中，用时…」收掉（同一轮）', await hidden('runD'), (await view('runD')).display);
check('只含生图的组：组头文字行让位给动画（不显示「正在调用工具…」）', await hidden('headDtools'), (await view('headDtools')).display);

console.log('轮次 A：普通对话完全不受影响');
check('用户气泡保留', await visible('bubbleA'));
check('思考组头保留', await visible('headAthink'));
check('思考组壳保留', await visible('groupAthink'));
check('思考正文保留', await page.$eval('#groupAthink [data-chat-flow-kind="assistant-step"]', el => getComputedStyle(el).display !== 'none'));
check('另一工具组组头保留', await visible('headAtools'));
check('另一工具组工具卡保留', await page.$eval('#groupAtools .toolcard', el => getComputedStyle(el).display !== 'none'));
check('A 轮耗时行保留', await visible('tailA'), (await view('tailA')).display);
check('A 轮整轮保留', await visible('turnA'));
check('A 轮没有生图卡片', await page.$eval('#turnA', el => el.querySelector('[data-slot="image-gen-turn"]') === null));

console.log('不误伤：被收掉的只能是生图相关的那几个节点');
const strayHidden = await page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('#app *')) {
    if (getComputedStyle(el).display !== 'none') continue;
    /* 祖先已经被收掉 → 这是继承来的 display:none，不是独立的隐藏点。 */
    let hiddenByAncestor = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).display === 'none') { hiddenByAncestor = true; break; }
    }
    if (hiddenByAncestor) continue;
    if (el.matches('[data-slot="image-gen-slot"]')) continue;
    if (el.matches("[data-chat-flow-kind='tool-call']") && el.querySelector('[data-image-gen-state="done"]')) continue;
    if (el.matches('[data-step-process]') && el.querySelector('[data-image-gen-state="done"]')) continue;
    if (el.matches('[data-turn-process]')) continue;
    /* 生图轮的状态行（"深度求索中，用时…"/"已完成，用时…"）由插件打标记后收掉，
       这两行是与生图行同级的独立 flowItem，属于有意隐藏。 */
    if (el.matches('[data-image-gen-quiet]')) continue;
    /* 只含生图的组：组头行被有意收掉（"正在调用工具…" 之类由动画本身替代）。 */
    const group = el.parentElement && el.parentElement.matches('[data-step-process]') ? el.parentElement : null;
    if (group && group.querySelector('[data-image-gen-row]') && !group.querySelector('[data-chat-flow-kind]:not([data-image-gen-row])')) continue;
    bad.push(el.id || el.className || el.tagName);
  }
  return bad.join(',');
});
check('display:none 的独立节点只有生图行/生图组/耗时行', strayHidden === '', strayHidden);

await page.screenshot({ path: join(ARTIFACT_DIR, 'scope-check.png'), fullPage: true });
console.log('\n截图: ' + join(ARTIFACT_DIR, 'scope-check.png'));
await browser.close();
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：生图行收干净、混合组不误伤、Turn 尾图片永远可见');
process.exit(failures ? 1 : 0);
