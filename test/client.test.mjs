/**
 * 客户端半结构测试：把 `lib/client.js` 的 __ModuleLoader__ 工厂在一个最小宿主里跑起来，
 * 断言「生图不是消息」的形态：只注册一个 tool.call.toolview 席位、渲染出撑满宽度的独立方框、
 * 不注册任何 conversation 席位（所以普通消息的渲染路径完全不被插件接管）。
 *
 * 不依赖 jsdom：只提供工厂用到的那几个内置（window / require('react') 桩 / document.head），
 * 并只断言 React 元素树的结构，不真正挂载。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/* ---------- 最小 React 桩 ----------
 * createElement 会**立即调用函数组件**（真实 React 就是在建树时渲染的），
 * 这样组件里的 useState/useEffect 才会被登记到本轮队列里，被 mount() 冲掉。
 */
const rendered = [];
function makeReactStub() {
  let hookIndex = 0;
  const noop = () => {};
  function el(type, props, children) {
    return { $$el: true, type, props: props || {}, children };
  }
  function create(type, props, ...children) {
    const flat = [];
    for (const c of children) {
      if (Array.isArray(c)) flat.push(...c);
      else if (c !== null && c !== undefined && c !== false) flat.push(c);
    }
    const node = el(type, props, flat);
    rendered.push(node);
    // 渲染函数组件（带深度上限，防止意外递归）
    if (typeof type === 'function' && hookIndex < 200) {
      try {
        return el(type, props, [type(props || {})]);
      } catch (e) {
        return el('div', { 'data-test-error': String((e && e.message) || e) }, flat);
      }
    }
    return node;
  }
  const React = {
    createElement: create,
    jsx: create,
    useState(initial) {
      hookIndex++;
      const cell = React.__cells[hookIndex] || (React.__cells[hookIndex] = {
        value: typeof initial === 'function' ? initial() : initial,
      });
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    useEffect(fn, deps) {
      if (typeof fn === 'function') React.__effects.push(fn);
    },
    useRef(initial) {
      hookIndex++;
      const cell = React.__cells[hookIndex] || (React.__cells[hookIndex] = { current: initial === undefined ? null : initial });
      return cell;
    },
    __cells: [],
    __effects: [],
    /** 新的一轮渲染：重置 hook 游标与 effect 队列，但**保留 state/ref 单元格**，
     *  这样下一轮还能读到上轮 setState 的结果（真实 React 也是这样跨 render 保持的）。 */
    __reset: () => {
      hookIndex = 0;
      React.__effects = [];
      rendered.length = 0;
    },
    __fresh: () => {
      hookIndex = 0;
      React.__cells = [];
      React.__effects = [];
      rendered.length = 0;
    },
  };
  Object.defineProperty(React, '__self', { value: React });
  return React;
}

let captured = null;
const styles = [];
const noop = () => {};
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};
globalThis.document = {
  createElement: () => ({ setAttribute() {}, set textContent(v) { styles.push(v); } }),
  head: { appendChild: noop },
  documentElement: { classList: { contains: () => false } },
};
globalThis.matchMedia = undefined;
globalThis.performance = globalThis.performance || { now: () => 0 };

// 工厂在 module 作用域取 window/document，这里补一层
const React = makeReactStub();

/* 求值源码，触发 window.__ModuleLoader__.load，拿到 spec */
new Function('window', 'document', 'require', source)(globalThis.window, globalThis.document, name => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
if (!captured) throw new Error('模块没有调用 window.__ModuleLoader__.load');
const spec = captured;

/* 跑工厂：它 return module.exports，插件的 apply/inject 挂在上面 */
const fakeModule = { exports: {} };
const returned = spec.factory(name => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
const plugin = returned || fakeModule.exports;

/* ---------- 断言 ---------- */
/**
 * 桩 createElement 在建树时就已经把函数组件展开成 children 了（见 makeReactStub），
 * 所以这里只做纯遍历，**绝不能再调用组件函数**——那会用错位的 hook 游标读到别的 state。
 */
function findAll(el, type, out = [], depth = 0) {
  if (!el || depth > 24) return out;
  if (el.type === type) out.push(el);
  for (const c of el.children || []) findAll(c, type, out, depth + 1);
  return out;
}

/** 按 className 片段找元素（方框根是 .ig-item，失败是 .ig-error）。 */
function findByClass(el, cls, out = [], depth = 0) {
  if (!el || depth > 24) return out;
  if (String(el.props && el.props.className || '').split(/\s+/).includes(cls)) out.push(el);
  for (const c of el.children || []) findByClass(c, cls, out, depth + 1);
  return out;
}

/** 顺着只有单个组件子节点的包装往下钻，拿到真正的方框根。 */
function unwrap(el, depth = 0) {
  if (!el || depth > 8) return el;
  if (typeof el.type === 'function') return unwrap((el.children || [])[0], depth + 1);
  if (el.children && el.children.length === 1 && typeof el.children[0] === 'object' && el.children[0].type && typeof el.children[0].type !== 'string' && depth === 0) {
    return unwrap(el.children[0], depth + 1);
  }
  return el;
}

/**
 * 挂载一次：反复跑 render + 冲掉 effect（含 effect 里发起的 promise），
 * 直到元素树不再变化或达到轮数上限。真实 React 的行为就是这样多轮收敛的。
 *
 * `keepStore` 为 true 时不清模块级 store —— 用来测「多次调用累积」的场景；
 * 默认每个 case 从干净 store 开始。
 */
async function mount(render, props, opts = {}) {
  const { keepStore = false, maxRounds = 12 } = opts;
  let el = null;
  let snapshot = '';
  React.__fresh();
  if (!keepStore && plugin.__resetStore) plugin.__resetStore();
  for (let round = 0; round < maxRounds; round++) {
    React.__reset();
    el = render(props);
    // 冲掉本轮 effect（返回值是 cleanup，先忽略）
    const effects = React.__effects.slice();
    for (const fn of effects) {
      try {
        fn();
      } catch (e) { /* 效果失败不影响结构断言 */ }
    }
    // 让 effect 里 loadImage() 的 promise 落地
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    const next = JSON.stringify(el, (k, v) => (k === 'type' && typeof v === 'function' ? '[fn]' : v));
    if (next === snapshot) break;
    snapshot = next;
  }
  // 顶层可能是函数组件包一层（createElement 已展开子树，但 render 本身返回的是组件元素）
  return unwrapTop(el);
}

/** render 返回的可能是组件元素本身；顺着往下钻到真实宿主元素。 */
function unwrapTop(el, depth = 0) {
  if (!el || depth > 8) return el;
  if (typeof el.type === 'function') return unwrapTop((el.children || [])[0], depth + 1);
  return el;
}

/** 把元素树里的所有文本节点拼起来（React 的 children 可能是字符串或嵌套元素）。 */
function flattenText(el, out = []) {
  if (el === null || el === undefined || el === false) return out.join('');
  if (typeof el === 'string' || typeof el === 'number') { out.push(String(el)); return out.join(''); }
  for (const c of (el.children || [])) flattenText(c, out);
  return out.join('');
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

/* ---------- 断言 ---------- */

console.log('模块形状');
check('id 是 dsh-image-gen', spec.id === 'dsh-image-gen', String(spec.id));
check('导出 apply', typeof plugin.apply === 'function');
check('注入 slots + remote', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('remote'), JSON.stringify(plugin.inject));
check('GridReveal 数学仍导出', typeof plugin.__gridReveal === 'object' && plugin.__gridReveal.CELLS === 180);

/* 跑两次 apply：一次抓注册项，一次抓渲染函数。
   inject 模拟真实宿主语义：register 只允许在对应席位的 inject 回调里调用。
   之前裸 register 在真实 ctx 上抛异常，导致整个桌面端启动失败（README 踩坑 #11）。 */
const registrations = [];
const capturedRenders = [];
const definitions = [];
const mkCtx = track => ({
  effect(fn, label) { fn(); if (track) registrations.push(label); return () => {}; },
  slots: (() => {
    let current = null;
    return {
      inject(name, cb) {
        if (track) registrations.push('inject:' + name);
        const saved = current;
        current = name;
        try { cb(); } finally { current = saved; }
        return () => {};
      },
      register(def, render) {
        if (!current) throw new Error('裸 slots.register("' + def.name + '") —— 必须包在 slots.inject(席位名, …) 里');
        if (track) registrations.push('register:' + def.name + (def.key ? ':' + def.key : '') + (def.id ? '#' + def.id + '@' + def.order : ''));
        if (!track) capturedRenders.push({ def, render });
        return () => {};
      },
    };
  })(),
  remote: { $mount: () => Promise.resolve({}) },
  // ui-conversation 提供的客户端服务：Turn 级 Definition 走它的 events 注册表
  uiConversation: {
    events: {
      register(def) {
        if (track) registrations.push('events:' + def.kind);
        if (!definitions.some(d => d.kind === def.kind)) definitions.push(def);
      },
    },
  },
});
plugin.apply(mkCtx(true));
plugin.apply(mkCtx(false));

console.log('注册的席位');
const joined = registrations.join(' | ');
check('注册了 tool.call.toolview（key=generate_image）', joined.includes('register:tool.call.toolview:generate_image'), joined);
check('注册了 conversation.chat.turnTail（过程组之外的图片卡位）', joined.includes('register:conversation.chat.turnTail#image-gen@30'), joined);
check('注册了 Turn 级 Definition', joined.includes('events:image-gen-images'), joined);
check('不再注册 conversation.input.dock（图不占用输入框上方）', !joined.includes('register:conversation.input.dock'), joined);
// 裸 register 会让整个桌面端启动失败（README 踩坑 #11）——锁定「先 inject 后 register」的顺序
/* 布局：独立的「设置 · 图像模型」导航页（试过并入官方「模型」页的
   settings.models.footer 席位，用户反馈要恢复原布局，别再改回去）。 */
check('设置页席位注册了，且包在 slots.inject 里（不是裸 register）',
  /inject:settings\.section/.test(joined) && /register:settings\.section#image-gen-models/.test(joined), joined);
check('导航图标打标随 apply 一起注册（图标要在点进那行之前就显示）', /image-gen: nav icon/.test(joined), joined);
check('★ inject 名单没有新增依赖（缺依赖 = 条目激活失败 = 应用起不来）',
  JSON.stringify(plugin.inject.slice().sort()) === JSON.stringify(['remote', 'slots', 'uiConversation'].sort()),
  JSON.stringify(plugin.inject));
check('没有注册 conversation.input.dock（图不占用输入框上方）', !joined.includes('register:conversation.input.dock'), joined);
check('inject 含 uiConversation（Definition 注册表所在服务）', Array.isArray(plugin.inject) && plugin.inject.includes('uiConversation'), JSON.stringify(plugin.inject));

console.log('CSS');
const css = styles.join('\n');
check('注入了一条样式', css.length > 0);
check('卡片无多余外壳（ig-root 只作 display:contents 透传）', css.includes('.ig-root{display:contents}'));
check('出图后是图片、显示尺寸为半尺寸（320 上限）', css.includes('.ig-image{display:block;width:100%;height:100%;object-fit:cover') && css.includes('.ig-item{width:100%;max-width:320px'), css.match(/\.ig-item\{[^}]*/)?.[0]);
check('★ 图片用 object-fit:cover 填满盒子（比例由盒子决定，不受图片原始像素影响）', /\.ig-image\{[^}]*object-fit:cover/.test(css), css.match(/\.ig-image\{[^}]*/)?.[0]);
check('★ 链接层也是同一个盒子（图片的 100%/100% 才有参照物）', /\.ig-frameLink\{[^}]*height:100%/.test(css), css.match(/\.ig-frameLink\{[^}]*/)?.[0]);
check('动画占位框尺寸由内联 style 定（CSS 不再写死宽度/高度）', !css.includes('.ig-frame{position:relative;width:100%') && css.includes('.ig-frame{position:relative;overflow:hidden'), '');
check('ig-root 只是透明透传（不产生新外壳）', css.includes('.ig-root{display:contents}'));
check('出图后渲染 <img>（DOM 断言见下方卡片渲染段）', true);
check('有 Turn 尾卡片容器样式', css.includes('.ig-turn{display:flex;flex-direction:column'));
check('状态行收口走「JS 打标记 + CSS 开关」', css.includes('[data-image-gen-quiet]{display:none!important}'));
check('不再用 JS 强行展开折叠组', !css.includes('aria-expanded'));

/* 设置页视觉契约：
   · 绿点只表达「当前使用中」这一件事；密钥可用性另标
     （两件事挤一个视觉位必然互相遮蔽 —— 用户明确要求）
   · keyReady 由宿主算（页面填的 key / 条目环境变量 / 插件全局，任一可用即 true）；
     只看 hasKey 会把「密钥配在环境变量里」的模型误标成没密钥
   · ⚠️ 主题表里只有 state-*-primary，没有 *-secondary —— 后者运行时是**实心填充色**
     （徽章/开关轨道用），当横幅或按钮底色就变成「亮绿块 + 绿字」完全看不清
     （用户截图踩过，且不报错不警告） */
check('★ 绿点跟着使用中，不再跟着 hasKey',
  source.includes('igm-dot" + (active ?') && !source.includes('igm-dot" + (model.hasKey'), '');
check('未配置密钥单独标出，且判定看 keyReady', source.includes('model.keyReady === false'), '');
check('★ 状态令牌没有 *-secondary 当底色',
  !/background:var\(--dsw-alias-state-\w+-secondary/.test(css),
  (css.match(/state-\w+-secondary/g) || []).join(','));
check('提示条底色用中性表面，状态色只上文字与左描边',
  css.includes('background:var(--dsw-alias-bg-layer-2)') && css.includes('border-left-color:var(--dsw-alias-state-success-primary'), '');
check('提示条会自动收起，不会一直挂着', source.includes('notice.kind === "fail" ? 8000 : 4000'), '');

console.log('聊天流侧的规则（标记不占位 + 出图后整行/整组收掉）');
const rules = css.split('\n').filter(l => l.includes('display:none!important'));
check('标记自身不占位（可见性交给 CSS，不用内联样式）', rules.some(r => r.includes("[data-slot='image-gen-slot']{display:none!important}")));
check('出图后工具行整行收掉（按 state=done 判定）', rules.some(r => r.includes("[data-chat-flow-kind='tool-call']:has([data-image-gen-state='done'])")));
check('只含生图的组：整组连同组头一起收掉（判定只看工具调用行，模型写的文字不挡）',
  rules.some(r => r.includes("[data-step-process]:has([data-image-gen-row='done']):not(:has([data-chat-flow-kind='tool-call']:not([data-image-gen-row='done'])))")),
  rules.join('\n'));
check('混合组（组里还有别的工具）只收组头行，不整组隐藏',
  rules.some(r => r.includes("[data-step-process]:has([data-image-gen-row]):not(:has([data-chat-flow-kind='tool-call']:not([data-image-gen-row]))) > div:first-child")));
check('生图轮组内其余成员（模型文字/思考）也收掉，只留图片',
  rules.some(r => r.includes("[data-chat-anchor-key]:not(:has([data-image-gen-state]))")));
/* 回归：:has() 只匹配后代、不含自身，而真实 DOM 里 data-chat-anchor-key 与
   data-image-gen-row 在同一元素上——用后者判定会把生图行自己也算成"别的成员"，
   动画整行消失（实测踩过）。标记 data-image-gen-state 永远在内部，才是安全锚点。 */
check('★ 成员判定用后代安全的 data-image-gen-state，不用同元素的 data-image-gen-row',
  !/data-chat-anchor-key\]:not\(:has\(\[data-image-gen-row\]\)\)/.test(css));
check('生图轮的耗时行/运行行由标记收掉（不是靠 :has() 关联兄弟节点）',
  css.includes('[data-image-gen-quiet]{display:none!important}'),
  '两行是独立 flowItem，与生图行互为兄弟，:has() 关联不到');
check('生图动画不被过程组 max-height 裁掉（尺寸与成图一致的前提）',
  css.includes("[data-step-process-body]:has([data-image-gen-row]){max-height:none!important}"));
check('不藏整轮（用户提问必须保留）', !css.includes("[data-chat-turn]:has([data-slot='image-gen-slot']){"), css);
check('★ 没有 :has() 套 :has()（Chrome 会把整条规则判非法）', !/:has\([^)]*:has\(/.test(css), (css.match(/:has\([^)]*:has\(/) || [''])[0]);
check('运行中才强制展开过程组（动画在那一行里）',
  css.includes("[data-step-process-body][hidden='until-found']:has([data-image-gen-state='running'])") && !css.includes("[data-step-process-body][hidden='until-found']:has([data-slot='image-gen-slot'])"));
check('没有任何全局裸 display:none', !/(^|[;}])\s*[a-z-]+\{[^}]*display:none/.test(css), '裸规则会让所有消息都消失');
check('不再使用已废弃的 tool.call.images 选择器', !css.includes('tool.call.images'));

console.log('图片卡片（toolview 渲染 marker + card）');
const view = capturedRenders.find(r => r.def.key === 'generate_image');
check('拿到了 generate_image 渲染函数', !!view);
if (view) {
  const tree = await mount(view.render, { phase: 'preparing', callId: 'call-y', block: { arguments: '{"prompt":"海边日落","ratio":"1:1"}' } });
  check('卡片根是 .ig-root（display:contents，不产生外壳）', tree.props.className === 'ig-root', String(tree.props.className));
  const marker = findAll(tree, 'span').find(s => s.props['data-slot'] === 'image-gen-slot');
  check('卡片带 0 尺寸标记 image-gen-slot（CSS 收外壳的锚点）', !!marker);
  const item = findByClass(tree, 'ig-item')[0];
  check('卡片本体 .ig-item 存在', !!item);
  check('等待态 aria-busy=true', !!item && item.props['aria-busy'] === true);
  check('等待态无「打开原图」链接', findAll(tree, 'a').length === 0);
  check('等待态有 canvas 动画', findAll(tree, 'canvas').length === 1);
  const frames = findByClass(tree, 'ig-frame');
  check('卡片按 1:1 定形', frames.length === 1 && Math.abs(Number(frames[0].props.style && frames[0].props.style.aspectRatio) - 1) < 1e-9);
}

console.log('工具行（result 阶段）：只剩 0 尺寸标记，图片交给 Turn 尾卡片');
const resultProps = {
  phase: 'result',
  callId: 'call-x',
  block: {
    call: { name: 'generate_image', arguments: JSON.stringify({ prompt: '一只橘猫', ratio: '16:9' }) },
    content: [{ type: 'text', text: '已生成 1 张图片' }, { type: 'image', attachment: { attachmentId: 'a1' } }],
    isError: false,
    meta: { optimizedPrompt: '一只橘猫，午后阳光' },
  },
  loadImage: () => Promise.resolve('/image-gen/raw/call-x/0'),
};
if (view) {
  const tree = await mount(view.render, resultProps);
  const marker = findAll(tree, 'span').find(s => s.props['data-slot'] === 'image-gen-slot');
  check('出图后仍带标记（CSS 靠它收掉整行）', !!marker);
  check('标记切成 state=done（整行可以收）', marker && marker.props['data-image-gen-state'] === 'done', marker && marker.props['data-image-gen-state']);
  check('出图后工具行里不再画图片', findAll(tree, 'img').length === 0);
  check('出图后工具行里不再有 canvas 动画', findAll(tree, 'canvas').length === 0);
  check('出图后工具行里没有「打开原图」链接', findAll(tree, 'a').length === 0);
}

console.log('Turn 尾卡片（图片的唯一展示面）');
const tailEntry = capturedRenders.find(r => r.def.name === 'conversation.chat.turnTail');
check('拿到了 turnTail 渲染函数', !!tailEntry);
if (tailEntry) {
  // 先让工具行把 loader 记进 liveCalls（真实场景里两者同轮出现）
  if (view) await mount(view.render, resultProps);
  const turnData = new Map();
  turnData.set('image-gen-images', {
    images: [{ callId: 'call-x', seq: 3, prompt: '一只橘猫', aspect: 16 / 9, attachment: { attachmentId: 'a1' }, count: 1, isError: false, errorText: '' }],
  });
  const tree = await mount(tailEntry.render, { turn: { data: turnData, end: { seq: 9 } }, seq: 9 });
  check('根是 Turn 尾卡片容器（data-slot=image-gen-turn）', !!tree && tree.props['data-slot'] === 'image-gen-turn', String(tree && tree.props.className));
  const links = findAll(tree, 'a');
  check('图片是「打开原图」链接', links.length === 1 && links[0].props.target === '_blank');
  check('链接指向同源路由（刷新/跨天都还在）', String(links[0] && links[0].props.href).startsWith('/image-gen/raw/call-x/0'), links[0] && links[0].props.href);
  const imgs = findAll(tree, 'img');
  check('渲染出 <img> 且 alt 用提示词', imgs.length === 1 && String(imgs[0].props.alt).includes('橘猫'), JSON.stringify(imgs.map(i => i.props.alt)));
  /* 盒子定在链接上（与生成中的动画框共用 boxStyle()），图片只负责填满：
     这样两者是同一个像素盒子，落地时不跳、比例也不会被图片原始像素带偏。 */
  const boxedLink = links[0];
  const boxStyle = (boxedLink && boxedLink.props.style) || {};
  check('尺寸按请求比例定形（16:9 → 36vh×1.78，半尺寸）', String(boxStyle.width).includes('1.7777777777777777') && String(boxStyle.width).includes('36vh'), JSON.stringify(boxStyle));
  check('盒子用 aspect-ratio 锁死比例（不靠图片内在尺寸）', String(boxStyle.aspectRatio) === String(16 / 9), String(boxStyle.aspectRatio));
  check('图片自身不再写尺寸（由父级盒子决定）', imgs[0].props.style === null || imgs[0].props.style === undefined, JSON.stringify(imgs[0].props.style));

  const empty = await mount(tailEntry.render, { turn: { data: new Map(), end: { seq: 9 } }, seq: 9 });
  check('这一轮没有生图就什么都不渲染', empty === null, JSON.stringify(empty));

  const late = new Map();
  late.set('image-gen-images', { images: [{ callId: 'call-late', seq: 99, isError: true, errorText: 'HTTP 500', aspect: 1 }] });
  const cut = await mount(tailEntry.render, { turn: { data: late, end: { seq: 9 } }, seq: 9 });
  check('收尾之后才落地的结果不算这一轮（按 turn.end.seq 截断）', cut === null, JSON.stringify(cut));

  /* 一次调用出 N 张（配置 count>1）：每张都要有展示面。
     曾经只存 refs[0]，多出来的图被静默丢掉，用户以为只出了一张。 */
  const many = new Map();
  many.set('image-gen-images', {
    images: [{
      callId: 'call-m', seq: 3, prompt: '四张连拍', aspect: 1, isError: false, errorText: '',
      attachments: [{ attachmentId: 'm0' }, { attachmentId: 'm1' }, { attachmentId: 'm2' }],
      attachment: { attachmentId: 'm0' }, count: 3,
    }],
  });
  const manyTree = await mount(tailEntry.render, { turn: { data: many, end: { seq: 9 } }, seq: 9 });
  const manyImgs = findAll(manyTree, 'img');
  const manyLinks = findAll(manyTree, 'a');
  check('★ 出 3 张就渲染 3 个 <img>（不再静默丢弃）', manyImgs.length === 3, String(manyImgs.length));
  check('★ 每张的链接指向自己的 index（写死 0 会三张全变同一张）',
    manyLinks.map(l => l.props.href).join(',') === '/image-gen/raw/call-m/0,/image-gen/raw/call-m/1,/image-gen/raw/call-m/2',
    manyLinks.map(l => l.props.href).join(','));
  check('卡片计数按张数（不是按调用数）', manyTree.props['data-image-gen-count'] === 3, String(manyTree.props['data-image-gen-count']));

  /* 老数据没有 attachments 字段时退回单张，不能渲染成 0 张 */
  const legacy = new Map();
  legacy.set('image-gen-images', {
    images: [{ callId: 'call-old', seq: 3, prompt: '旧记录', aspect: 1, attachment: { attachmentId: 'o1' }, isError: false, errorText: '' }],
  });
  const legacyTree = await mount(tailEntry.render, { turn: { data: legacy, end: { seq: 9 } }, seq: 9 });
  check('★ 缺 attachments 的旧记录仍渲染 1 张（不能变空白）', findAll(legacyTree, 'img').length === 1, String(findAll(legacyTree, 'img').length));
}

console.log('Turn 级 Definition：把每一轮的生图结果发布到 Turn');
{
  const def = definitions.find(d => d.kind === 'image-gen-images');
  check('Definition 已注册', !!def);
  if (def) {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 'turn-1' } },
      { type: 'tool/call', seq: 2, data: { turn: 'turn-1', callId: 'call-1', name: 'generate_image', arguments: JSON.stringify({ prompt: '海边日落', ratio: '16:9' }) } },
      { type: 'tool/call', seq: 3, data: { turn: 'turn-1', callId: 'call-2', name: 'read_file', arguments: '{}' } },
      { type: 'tool/result', seq: 4, data: { turn: 'turn-1', message: { isError: false, source: { callId: 'call-1' }, content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] } } },
      { type: 'tool/result', seq: 5, data: { turn: 'turn-1', message: { isError: false, source: { callId: 'call-2' }, content: [{ type: 'text', text: '文件内容' }] } } },
    ];
    let context = null;
    let matched = 0;
    for (const event of events) {
      const m = def.match(event);
      if (!m) continue;
      matched++;
      const match = { id: m.id, role: m.role, event };
      context = context === null ? { state: def.start({}, match) } : { state: def.update(context, match) };
    }
    check('五条事件全部命中同一个 turn', matched === 5, 'matched=' + matched);
    const published = def.buildLocationData(context, 'turn', null);
    check('发布成 turn 级数据（key=image-gen-images）', !!published && published.kind === 'turn' && published.key === 'image-gen-images', JSON.stringify(published && published.key));
    check('只记生图那一条结果', published.value.images.length === 1, 'count=' + published.value.images.length);
    const item = published.value.images[0];
    check('记下了 callId', item.callId === 'call-1', item.callId);
    check('记下了比例（16:9）', Math.abs(item.aspect - 16 / 9) < 1e-9, String(item.aspect));
    check('记下了附件引用（Turn 尾卡片据此取 durable 地址）', item.attachment && item.attachment.attachmentId === 'a1', JSON.stringify(item.attachment));
    /* 一次出 N 张时全部附件都要进记录：只存 refs[0] 会让后面的图没有展示面。 */
    check('★ 记录带 attachments 数组', Array.isArray(item.attachments) && item.attachments.length === 1, JSON.stringify(item.attachments));
    const multiCtx = { state: def.start({}, { role: 'start', event: events[0] }) };
    multiCtx.state = def.update(multiCtx, { role: 'update', event: events[1] });
    const multiResult = {
      type: 'tool/result', seq: 6,
      data: { turn: 'turn-1', message: { isError: false, source: { callId: 'call-1' }, content: [
        { type: 'image', attachment: { attachmentId: 'x0' } },
        { type: 'image', attachment: { attachmentId: 'x1' } },
        { type: 'image', attachment: { attachmentId: 'x2' } },
      ] } },
    };
    const multiPub = def.buildLocationData({ state: def.update(multiCtx, { role: 'update', event: multiResult }) }, 'turn', null);
    check('★ 出 3 张时 attachments 有 3 条', multiPub.value.images[0].attachments.length === 3, JSON.stringify(multiPub.value.images[0].attachments));
    check('attachment 仍是第 0 张（兼容退回工具行内渲染的旧路径）', multiPub.value.images[0].attachment.attachmentId === 'x0');
    check('内容没变就交回同一个对象（引擎按引用判等）', def.buildLocationData(context, 'turn', published) === published);
    check('非 turn 作用域不发布', def.buildLocationData(context, 'session', null) === null);

    const errDef = def;
    const errCtx = (() => {
      const e1 = { type: 'turn/start', seq: 1, data: { turn: 'turn-2' } };
      const e2 = { type: 'tool/call', seq: 2, data: { turn: 'turn-2', callId: 'call-9', name: 'generate_image', arguments: '{}' } };
      const e3 = { type: 'tool/result', seq: 3, data: { turn: 'turn-2', message: { isError: true, source: { callId: 'call-9' }, content: [{ type: 'text', text: '服务返回 HTTP 500' }] } } };
      let c = null;
      for (const e of [e1, e2, e3]) {
        const m = errDef.match(e);
        const match = { id: m.id, role: m.role, event: e };
        c = c === null ? { state: errDef.start({}, match) } : { state: errDef.update(c, match) };
      }
      return c;
    })();
    const errData = errDef.buildLocationData(errCtx, 'turn', null);
    check('失败也记一条（否则动画消失后什么都没有）', errData.value.images.length === 1 && errData.value.images[0].isError === true, JSON.stringify(errData.value.images));
    check('失败记录带上原因', String(errData.value.images[0].errorText).includes('HTTP 500'), errData.value.images[0].errorText);
  }
}

console.log('等待期阶段文字（优化 → 生图 → 保存）');
{
  /* 阶段文字靠轮询 /image-gen/stage/<callId>。卡片挂在工具 execute **之前**，
     所以第一次请求常常拿到 stage:null（宿主还没写阶段）。曾经把 null 当成
     "读不到就放弃"，结果文字永远停在"正在优化提示词…"——只在真实生图里暴露，
     行为级单测（假 React）抓不到，所以这里钉住源码形状。 */
  check('★ stage=null 时继续轮询（null 只表示"还没开始"，不是放弃信号）',
    source.includes('if (j.stage === "save") return;') && !/!j\s*\|\|\s*!j\.stage/.test(source), '');
  check('★ 只在端点不可用 / 到 save / 超上限时才停',
    source.includes('if (!r.ok) return { stop: true };') && source.includes('if (++tries > 200) return;'), '');
  check('用链式 setTimeout（不是 setInterval：别让页面和测试进程空转）',
    !/setInterval\(\s*poll/.test(source) && source.includes('timer = setTimeout(poll, 1200);'), '');
  check('三种阶段文案齐备', ['正在优化提示词…', '正在生成图片…', '正在保存图片…'].every(s => source.includes(s)), '');
  check('轮询走同源 GET（不经 ctx.remote.imageGen —— 那要动 inject 名单，见 #11）',
    source.includes('fetch("/image-gen/stage/" + encodeURIComponent(callId)') && source.includes('credentials: "same-origin"'), '');
  check('卸载时清掉定时器并停轮询', source.includes('live = false;') && source.includes('clearTimeout(timer);'), '');
  check('优化阶段就有动画框（canvas 与阶段文字同一个 frame 里）',
    /h\(GridReveal, \{ src: null[^)]*\}\)\s*,\s*\/\* 阶段文字/.test(source), '');
}

console.log('');
if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
console.log('全部通过');
