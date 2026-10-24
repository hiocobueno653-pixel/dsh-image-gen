/** 显影动画的确定性渲染测试：
 *  在真实 Chrome 里把 drawScene 按 dev=0→1 逐帧画出来，截图肉眼可验，
 *  并断言"先大形状、后细节"的像素特征（早期帧对比度低/模糊，末期帧与照片接近）。
 *  跑法：node test/develop.browser.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
/* 没装 Chrome 时用 Playwright 自带的 Chromium；可用 CHROME_PATH 指定 */
const CHROME = process.env.CHROME_PATH || undefined;
/* 帧图默认落到系统临时目录，可用 ARTIFACT_DIR 指到别处 */
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || join(tmpdir(), 'image-gen-artifacts');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// 一张有结构感的测试照片（彩色几何块，模拟"大形状→细节"）
const photoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#0a2a6b"/><stop offset="1" stop-color="#e0533a"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/>
<circle cx="180" cy="120" r="90" fill="#ffd166"/>
<rect x="360" y="60" width="200" height="120" fill="#06d6a0"/>
<path d="M0 360 L200 200 L420 360 Z" fill="#111"/>
<circle cx="520" cy="260" r="40" fill="#ef476f"/>
</svg>`;
const photo = 'data:image/svg+xml;base64,' + Buffer.from(photoSvg).toString('base64');

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.setContent('<canvas id="c" width="640" height="360"></canvas>');

const api = await page.evaluate(async (src) => {
  const captured = [];
  window.__ModuleLoader__ = { load: spec => captured.push(spec) };
  new Function('window', 'document', 'require', src)(window, document, () => { throw new Error('no deps'); });
  const plugin = captured[0];
  return Object.keys(plugin);
}, source).catch(e => ({ err: String(e) }));

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const frames = await page.evaluate(async ({ src, photoUrl }) => {
  const captured = [];
  window.__ModuleLoader__ = { load: spec => captured.push(spec) };
  const reactStub = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) };
  new Function('window', 'document', 'require', src)(window, document, n => (n === 'react' ? reactStub : (() => { throw new Error('no deps'); })()));
  /* load() 只收到 spec，工厂要自己调用才 return module.exports（与 client.test.mjs 一致） */
  const plugin = captured[0].factory(n => (n === 'react' ? reactStub : (() => { throw new Error('no deps'); })()));
  const G = plugin.__gridReveal;
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = photoUrl; });

  const tree = G.buildTree(640 / 360);
  const root = tree.root;
  // 读平均色（和插件运行时一样）
  const buf = document.createElement('canvas');
  buf.width = buf.height = 128;
  const bctx = buf.getContext('2d', { willReadFrequently: true });
  bctx.drawImage(img, 0, 0, 128, 128);
  G.measureTree(root, bctx.getImageData(0, 0, 128, 128).data, 128);
  G.orderByDetail(tree.branches, 0.72);

  const out = [];
  const devs = [0, 0.15, 0.35, 0.55, 0.75, 1];
  for (const dev of devs) {
    const split = Math.min(1, 0.72 + dev * 0.28);
    ctx.clearRect(0, 0, 640, 360);
    G.drawScene({
      ctx, root, width: 640, height: 360, scale: 1, dark: false,
      clock: dev * 2, split, dev, hasColors: true, image: img,
    });
    // 统计：颜色数（越少=越"大块"）、与照片的均色偏差
    const d = ctx.getImageData(0, 0, 640, 360).data;
    const set = new Set();
    let sum = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      set.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      sum += d[i] + d[i + 1] + d[i + 2];
    }
    out.push({ dev, colors: set.size, avg: Math.round(sum / (d.length / (4 * 97)) / 3) });
    canvas.toBlob(b => { window['__shot' + String(dev).replace('.', '_')] = b; }, 'image/png');
    await new Promise(r => setTimeout(r, 30));
  }
  return out;
}, { src: source, photoUrl: photo });

console.log('逐帧（dev=显影进度）:');
frames.forEach(f => console.log('  ', JSON.stringify(f)));

check('显影早期比末期"大块"（早期颜色数少）', frames[1].colors < frames[frames.length - 1].colors, `${frames[1].colors} vs ${frames[frames.length - 1].colors}`);
check('末期接近照片本身（颜色数 > 早期 3 倍）', frames[frames.length - 1].colors > frames[1].colors * 2, `${frames[1].colors} → ${frames[frames.length - 1].colors}`);
check('dev=0 时不崩（纯马赛克等待态）', frames[0].colors > 1 && frames[0].colors < frames[2].colors, JSON.stringify(frames[0]));

// 存图供肉眼确认
for (const f of frames) {
  const blob = await page.evaluate(k => {
    const b = window[k];
    return b ? b.arrayBuffer().then(ab => Array.from(new Uint8Array(ab))) : null;
  }, '__shot' + String(f.dev).replace('.', '_'));
  if (blob) writeFileSync(join(ARTIFACT_DIR, 'dev-frame-' + String(f.dev).replace('.', '') + '.png'), Buffer.from(blob));
}
console.log('帧图: ' + join(ARTIFACT_DIR, 'dev-frame-*.png'));

await browser.close();
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：显影节奏正确');
process.exit(failures ? 1 : 0);

