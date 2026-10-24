/**
 * 「动画的比例和大小必须和图片一样」——真 Chromium 里逐像素量一遍。
 *
 * 为什么必须在真浏览器里测：这条要求涉及 `min()` / `calc(72vh × ratio)` / `aspect-ratio` /
 * `object-fit:cover` 的最终解析值，以及在真实列宽下的取舍，jsdom 完全算不出来。
 *
 * 测法：把「生成中的动画框」与「出图后的图」并排放进**真实会话的 Turn 尾容器**里，
 * 在同一列宽下量两者的 getBoundingClientRect()，要求宽高都相等（取整到 0.5px 内）。
 * 覆盖 1:1 / 16:9 / 4:3 / 9:16 / 2:3 / 21:9 六种比例。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
function grabArray(name) {
  const head = 'var ' + name + ' = [';
  const start = source.indexOf(head);
  if (start < 0) throw new Error('找不到样式块 ' + name);
  const end = source.indexOf('].join(', start);
  if (end < 0) throw new Error('样式块 ' + name + ' 没有闭合');
  return new Function('return [' + source.slice(start + head.length, end) + '];')().join('\n');
}
const cssText = grabArray('CSS');

/** boxStyle() 是插件里的函数：直接抠出来求值，保证测的就是它给出的盒子。 */
const boxSrc = /function boxStyle\(aspect\) \{[\s\S]*?\n\t\t\}/.exec(source);
if (!boxSrc) throw new Error('找不到 boxStyle()');
const boxStyle = new Function(
  'Number',
  boxSrc[0] + '\nreturn boxStyle;',
)(Number);

const CHROME = process.env.CHROME_PATH || undefined;
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/* 宿主侧的容器骨架（列宽 720px，取自真机会话的测量值） */
const shell = `
<div class="turn" style="width:720px">
  <div class="ig-turn" id="host"></div>
</div>`;
await page.setContent(`<!doctype html><html><head><style>${cssText}</style></head><body>${shell}</body></html>`);

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

/* 六种比例：包含非常宽的 21:9 与竖版 2:3，验证 min()/72vh 的取舍两头都对。 */
const CASES = [
  { label: '1:1', aspect: 1 },
  { label: '16:9', aspect: 16 / 9 },
  { label: '4:3', aspect: 4 / 3 },
  { label: '9:16', aspect: 9 / 16 },
  { label: '2:3', aspect: 2 / 3 },
  { label: '21:9', aspect: 21 / 9 },
  { label: '服务 真实像素比 1312×736', aspect: 1312 / 736 },
];

console.log('动画框 vs 成图：同一个盒子（宽、高、比例都要一样）');
for (const c of CASES) {
  const measured = await page.evaluate(
    ({ style, naturalW, naturalH }) => {
      const host = document.querySelector('#host');
      host.innerHTML = '';

      /* A：生成中的动画框（.ig-frame + canvas，style 来自 boxStyle） */
      const itemA = document.createElement('div');
      itemA.className = 'ig-item';
      const frame = document.createElement('div');
      frame.className = 'ig-frame';
      Object.assign(frame.style, style);
      const canvas = document.createElement('canvas');
      canvas.className = 'ig-canvas';
      canvas.width = 640;
      canvas.height = 360;
      frame.appendChild(canvas);
      itemA.appendChild(frame);
      host.appendChild(itemA);

      /* B：出图后的图（.ig-item > a.ig-frameLink[style 来自 boxStyle] > img.ig-image） */
      const itemB = document.createElement('div');
      itemB.className = 'ig-item';
      const link = document.createElement('a');
      link.className = 'ig-frameLink';
      Object.assign(link.style, style);
      const img = document.createElement('img');
      img.className = 'ig-image';
      /* 故意让图片原始像素比与请求比例**不一致**（服务的 16:9 实际返回 1312×736），
         验证这时盒子仍然由 aspect-ratio 决定、不受图片内在尺寸影响。 */
      img.src =
        'data:image/svg+xml;base64,' +
        btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${naturalW}" height="${naturalH}"><rect width="100%" height="100%" fill="#3c82c6"/></svg>`);
      link.appendChild(img);
      itemB.appendChild(link);
      host.appendChild(itemB);

      const a = frame.getBoundingClientRect();
      const b = link.getBoundingClientRect();
      return {
        anim: { w: a.width, h: a.height },
        img: { w: b.width, h: b.height },
        imgFitsBox: Math.abs(img.getBoundingClientRect().width - b.width) < 0.5 && Math.abs(img.getBoundingClientRect().height - b.height) < 0.5,
      };
    },
    { style: boxStyle(c.aspect), naturalW: 1312, naturalH: 736 },
  );

  const { anim, img } = measured;
  const dw = Math.abs(anim.w - img.w);
  const dh = Math.abs(anim.h - img.h);
  const ratioAnim = anim.w / anim.h;
  const ratioImg = img.w / img.h;
  check(
    `${c.label}：宽度一致（${anim.w.toFixed(1)}px）`,
    dw < 0.5,
    `动画 ${anim.w.toFixed(2)} / 图片 ${img.w.toFixed(2)}`,
  );
  check(
    `${c.label}：高度一致（${anim.h.toFixed(1)}px）`,
    dh < 0.5,
    `动画 ${anim.h.toFixed(2)} / 图片 ${img.h.toFixed(2)}`,
  );
  check(
    `${c.label}：比例一致且等于请求比例`,
    Math.abs(ratioAnim - c.aspect) < 0.01 && Math.abs(ratioImg - c.aspect) < 0.01,
    `动画 ${ratioAnim.toFixed(4)} / 图片 ${ratioImg.toFixed(4)} / 期望 ${c.aspect.toFixed(4)}`,
  );
  check(`${c.label}：图片填满盒子（不变形、不溢出）`, measured.imgFitsBox, JSON.stringify(measured));
}

console.log('竖版/超宽两头都要落在一屏内（72vh 上限）');
{
  const tall = await page.evaluate(style => {
    const host = document.querySelector('#host');
    host.innerHTML = '';
    const f = document.createElement('div');
    f.className = 'ig-frame';
    Object.assign(f.style, style);
    host.appendChild(f);
    const r = f.getBoundingClientRect();
    return { w: r.width, h: r.height, vh: window.innerHeight };
  }, boxStyle(2 / 3));
  check('竖版 2:3 的高度不超过 72vh', tall.h <= tall.vh * 0.72 + 1, `${tall.h.toFixed(1)} vs ${(tall.vh * 0.72).toFixed(1)}`);

  const wide = await page.evaluate(style => {
    const host = document.querySelector('#host');
    host.innerHTML = '';
    const f = document.createElement('div');
    f.className = 'ig-frame';
    Object.assign(f.style, style);
    host.appendChild(f);
    const r = f.getBoundingClientRect();
    return { w: r.width, h: r.height, column: 720 };
  }, boxStyle(21 / 9));
  check('超宽 21:9 的宽度不超过列宽', wide.w <= wide.column + 1, `${wide.w.toFixed(1)} vs ${wide.column}`);
}

console.log('异常输入兜底');
check('aspect 为 0 → 退回 1:1（不会出现除零/零宽盒子）', boxStyle(0).aspectRatio === '1', JSON.stringify(boxStyle(0)));
check('aspect 为 NaN → 退回 1:1', boxStyle(NaN).aspectRatio === '1', JSON.stringify(boxStyle(NaN)));
check('aspect 为负 → 退回 1:1', boxStyle(-3).aspectRatio === '1', JSON.stringify(boxStyle(-3)));
check('aspect 缺失 → 退回 1:1', boxStyle(undefined).aspectRatio === '1', JSON.stringify(boxStyle(undefined)));

await browser.close();
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：动画框与成图是同一个像素盒子（比例与大小都一致）');
process.exit(failures ? 1 : 0);
