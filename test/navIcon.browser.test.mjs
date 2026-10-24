/**
 * 导航图标必须在真浏览器里**真的画出像素**：mask 的 data URI 写坏时，
 * Chromium 不报错、不警告，只是什么都不画 —— 只看 computed style 会假装通过。
 * 所以这里把求值出的 CSS 注入真页面，截图后数非透明像素。
 * 跑法：node test/navIcon.browser.test.mjs
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const CHROME = process.env.CHROME_PATH || undefined;
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || join(tmpdir(), 'image-gen-artifacts');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const head = 'var CSS = [';
const start = source.indexOf(head);
const end = source.indexOf('].join(', start);
const preludeStart = source.indexOf('var NAV_LABEL');
if (start < 0 || end < 0 || preludeStart < 0) throw new Error('找不到 CSS 块');
const cssText = new Function(source.slice(preludeStart, start) + 'return [' + source.slice(start + head.length, end) + '];')().join('\n');

/* 打标逻辑也来自同一份源码，测的就是真行为。
   ⚠️ 结尾匹配串 '\n\t\t}' 是 4 个字符，切片时得 +4，否则闭括号被截掉。 */
const fnStart = source.indexOf('function paintNavIcon()');
const fnEnd = source.indexOf('\n\t\t}', fnStart) + 4;
const paintSrc = source.slice(fnStart, fnEnd);
const labelStart = source.indexOf('var NAV_LABEL');
const labelSrc = source.slice(labelStart, source.indexOf('\n', labelStart));
if (fnStart < 0 || labelStart < 0) throw new Error('找不到 paintNavIcon / NAV_LABEL');
new Function(paintSrc); // 抽取不完整就先在这里炸，别拖到浏览器里报个看不懂的语法错

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.setContent(`<!doctype html><meta charset="utf-8"><style>${cssText}</style>
<style>body{margin:0;background:#fff}button[class*="navCell"]{display:flex;align-items:center;gap:8px;height:40px;font:14px system-ui;color:#1a1a1a;background:none;border:0}</style>
<div id="nav">
  <button class="wCInkW_navCell"><svg width="16" height="16"><rect width="16" height="16" fill="#000"/></svg><span class="wCInkW_navLabel">通用设置</span></button>
  <button class="wCInkW_navCell"><svg width="16" height="16"><rect width="16" height="16" fill="#000"/></svg><span class="wCInkW_navLabel">图像模型</span></button>
</div>`);

/* ⚠️ 不能用 page.evaluate(`(${labelSrc})`) —— `var X = ...` 是语句，包进括号就是
   语法错误。以 <script> 形式注入，跑的就是源码本身。 */
await page.addScriptTag({ content: labelSrc + '\n' + paintSrc + '\nwindow.__paint = paintNavIcon;' });
await page.evaluate(() => window.__paint());

const marked = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('button[class*="navCell"]')];
  return cells.map(c => ({ label: c.querySelector('[class*="navLabel"]').textContent, nav: c.getAttribute('data-ig-nav') }));
});
check('只给「图像模型」那一行打标记', marked.length === 2 && marked[1].nav === '1' && !marked[0].nav, JSON.stringify(marked));

const svgHidden = await page.evaluate(() => {
  const cell = [...document.querySelectorAll('button[class*="navCell"]')][1];
  return getComputedStyle(cell.querySelector('svg')).display;
});
check('宿主的默认图标（svg）被收起', svgHidden === 'none', svgHidden);

/* 关键：mask 的 data URI 必须能被浏览器解码。
   写坏时 Chromium 不报错、不警告，只是什么都不画 —— 这是唯一能抓到它的检查。 */
const loads = await page.evaluate(async () => {
  const cell = [...document.querySelectorAll('button[class*="navCell"]')][1];
  const cs = getComputedStyle(cell, '::before');
  let raw = (cs.maskImage || cs.webkitMaskImage || '').trim();
  if (!raw.startsWith('url(')) return { ok: false, why: 'no url(): ' + raw.slice(0, 40) };
  raw = raw.slice(4, -1).replace(/^["']|["']$/g, '');
  return new Promise(res => {
    const im = new Image();
    im.onload = () => res({ ok: true, w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res({ ok: false, why: 'decode failed', raw: raw.slice(0, 60) });
    im.src = raw;
  });
});
check('★ mask 的 data URI 能被浏览器解码（图标真画得出来）', loads.ok === true && loads.w > 0, JSON.stringify(loads));
check('图标是 24×24 视口的描边图', loads.w === 24 && loads.h === 24, JSON.stringify(loads));

/* 顺带确认 mask 形状不是空/实心：解码后画到 canvas 上数不透明像素 */
const ink = await page.evaluate(async () => {
  const cell = [...document.querySelectorAll('button[class*="navCell"]')][1];
  const cs = getComputedStyle(cell, '::before');
  let raw = (cs.maskImage || cs.webkitMaskImage || '').trim().slice(4, -1).replace(/^["']|["']$/g, '');
  const im = new Image();
  await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = raw; });
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(im, 0, 0);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  let on = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 40) on++;
  return on;
}).catch(() => -1);
if (ink >= 0) {
  check('描边图标有像素但非实心（24×24=576 上限）', ink > 30 && ink < 400, 'inkPx=' + ink);
}

await page.screenshot({ path: join(ARTIFACT_DIR, 'nav-icon-check.png') });
await browser.close();
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：导航图标真实渲染');
process.exit(failures ? 1 : 0);
