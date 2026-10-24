/**
 * 真机验证：在真跑着的 DSH 里打开一个**真实生图会话**，确认图片在 Turn 尾、且不在过程组里。
 *
 *   node test/turn-card.live.mjs "<dsh web 打印的带 token 的 URL>" [session id 片段]
 *
 * 怎么拿到一个能跑的实例（不动正在用的那个桌面端）：
 *   # 1) 起一个隔离的 DSH_HOME，把真实会话与生图索引拷进去（只读复制）
 *   $h2 = "$env:TEMP\dsh-imgcheck"; New-Item -ItemType Directory -Force $h2
 *   Copy-Item "$env:USERPROFILE\.dsh\sessions"  "$h2\sessions"  -Recurse -Force
 *   Copy-Item "$env:USERPROFILE\.dsh\storages"  "$h2\storages"  -Recurse -Force
 *   New-Item -ItemType Directory -Force "$h2\cache\dsh-image-gen"
 *   Copy-Item "$env:USERPROFILE\.dsh\cache\dsh-image-gen\index.json" "$h2\cache\dsh-image-gen\index.json" -Force
 *   # 2) 纯 web 档位（base + web-app）装上本插件，端口随意，--no-open 免得抢占浏览器
 *   $env:DSH_HOME = $h2
 *   & $dsh plugin --profile imgcheck add "file:E:\deepseek harness\token-usage\plugin-image"
 *   & $dsh --profile imgcheck --port 19898 --no-open      # 输出里那条带 token 的 URL 就是参数
 *
 * 断言的底线：**图片必须在 Turn 尾、加载成功，且过程组里一个可见的生图痕迹都没有**。
 * （组里还剩思考等别的步骤、仍按宿主自己的折叠逻辑显示，那是正常的，不动它。）
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
/* 截图默认落到系统临时目录，可用 ARTIFACT_DIR 指到别处 */
const OUT = process.env.ARTIFACT_DIR || join(tmpdir(), 'image-gen-motion-shots');
mkdirSync(OUT, { recursive: true });

const url = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e && e.message).slice(0, 160)));

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-composer-card]', { timeout: 60000 }).catch(() => {});
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(800);
  const closed = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return false;
    const b = Array.from(d.querySelectorAll('button')).find(x => /稍后|以后|跳过|Skip|Later|Not now/i.test(x.textContent || '')) || d.querySelector('button');
    if (!b) return false;
    b.click();
    return true;
  }).catch(() => false);
  if (!closed) break;
}
await page.waitForTimeout(2500);

console.log('插件装载');
const loaded = await page.evaluate(() => ({
  css: !!document.querySelector('style[data-plugin="image-gen"]'),
  plugins: Array.from(document.querySelectorAll('style[data-plugin]')).map(s => s.getAttribute('data-plugin')).filter(n => /image-gen|motion/.test(n)),
}));
check('生图插件样式表已注入', loaded.css, JSON.stringify(loaded));

/* 找一个含生图会话的行：侧栏行的文字里有「沙滩」的那条。 */
const rowCount = await page.$$eval('[data-row-key^="session:"]', els => els.length);
console.log('侧栏会话行: ' + rowCount);
/* 目标会话：命令行给 session id（首选），否则按标题文字猜。 */
const wantSession = process.argv[3] || '';
const target = await page.evaluate(want => {
  const rows = Array.from(document.querySelectorAll('[data-row-key^="session:"]'));
  if (want) {
    const hit = rows.find(r => (r.getAttribute('data-row-key') || '').includes(want));
    if (hit) return hit.getAttribute('data-row-key');
  }
  const guess = rows.find(r => /沙滩|生成图片|赛博|未命名/.test(r.textContent || ''));
  return guess ? (guess.getAttribute('data-row-key') || '') : '';
}, wantSession);
check('找到含生图的会话', !!target, target || '(none)');

if (target) {
  await page.click(`[data-row-key="${target}"]`);
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("[data-slot='image-gen-turn']"));
    const imgs = Array.from(document.querySelectorAll("[data-slot='image-gen-turn'] img.ig-image"));
    const markers = Array.from(document.querySelectorAll("[data-slot='image-gen-slot']"));
    const flowRows = Array.from(document.querySelectorAll("[data-chat-flow-kind='tool-call']"));
    return {
      cards: cards.length,
      cardVisible: cards.filter(c => c.getBoundingClientRect().height > 8).length,
      cardInsideStep: cards.filter(c => c.closest('[data-step-process]')).length,
      cardInTurnTail: cards.filter(c => c.closest('[data-turn-tail]')).length,
      imgs: imgs.length,
      imgLoaded: imgs.filter(i => i.naturalWidth > 0).length,
      imgSize: imgs.map(i => Math.round(i.getBoundingClientRect().width) + 'x' + Math.round(i.getBoundingClientRect().height)).join(','),
      markers: markers.length,
      markerStates: [...new Set(markers.map(m => m.getAttribute('data-image-gen-state')))],
      imageRowsVisible: flowRows.filter(r => r.querySelector("[data-image-gen-state]") && getComputedStyle(r).display !== 'none').length,
      stepsWithImageRow: Array.from(document.querySelectorAll('[data-step-process]')).filter(g => g.querySelector("[data-image-gen-state='done']")).length,
      hiddenSteps: Array.from(document.querySelectorAll('[data-step-process]')).filter(g => g.querySelector("[data-image-gen-state='done']") && getComputedStyle(g).display === 'none').length,
      /* 过程组里**任何可见的**生图痕迹（标记 / 卡片）都算违规：
         图必须只在 Turn 尾卡片上。组里还剩别的步骤（思考等）是宿主自己的折叠逻辑，不动它。 */
      imageTracesInGroups: Array.from(document.querySelectorAll('[data-step-process]'))
        .flatMap(g => Array.from(g.querySelectorAll("[data-slot='image-gen-slot'],[data-slot='image-gen-frame']")))
        .filter(el => el.getBoundingClientRect().height > 0 || el.getBoundingClientRect().width > 0).length,
      groupsWithRowAttr: Array.from(document.querySelectorAll('[data-step-process]')).filter(g => g.querySelector('[data-image-gen-row]')).length,
      rowsWithRowAttr: Array.from(document.querySelectorAll('[data-image-gen-row]')).length,
      bodyText: (document.body.innerText || '').slice(0, 0),
    };
  });
  console.log('  ' + JSON.stringify(state));
  check('Turn 尾出现图片卡片', state.cards > 0, String(state.cards));
  check('卡片可见（有高度）', state.cardVisible > 0, String(state.cardVisible));
  check('★ 卡片不在过程组里', state.cardInsideStep === 0, String(state.cardInsideStep));
  check('★ 卡片挂在 Turn 尾节点上', state.cardInTurnTail > 0, String(state.cardInTurnTail));
  check('★ 图片真的加载出来了（naturalWidth>0）', state.imgLoaded > 0, state.imgs + ' 张，加载成功 ' + state.imgLoaded);
  check('图片有实际尺寸', /[1-9]\d*x[1-9]\d*/.test(state.imgSize), state.imgSize);
  check('出图后聊天流里不再有可见的生图行', state.imageRowsVisible === 0, String(state.imageRowsVisible));
  check('★ 过程组里没有任何可见的生图痕迹（图只在 Turn 尾）', state.imageTracesInGroups === 0, String(state.imageTracesInGroups));
  check('行上的 data-image-gen-row 由 JS 打上（CSS 靠它判断"只含生图"）', state.rowsWithRowAttr > 0, String(state.rowsWithRowAttr));
  console.log('  含生图的组 ' + state.stepsWithImageRow + ' 个（其中整组收掉 ' + state.hiddenSteps + ' 个；组里还有别的步骤时保持宿主自己的折叠）');
  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: OUT + '/turn-card.png' });
}

await browser.close();
console.log(failures ? '失败 ' + failures + ' 项' : '真机：图片在 Turn 尾、过程组里没有图');
process.exit(failures ? 1 : 0);
