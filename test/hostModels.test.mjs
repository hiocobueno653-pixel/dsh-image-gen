/**
 * 宿主半 modelsAdmin 的直连测试：用假 ctx 起真服务，跑遍
 * list / add / update / remove / default / sources / probe，
 * 并钉住最重要的那条契约 —— 图像模型绝不注册进 llm（否则会出现在模型选择器里）。
 * 跑法：node test/hostModels.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCordis, DEFAULT_CONFIG } from '../src/cordis.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const dir = mkdtempSync(join(tmpdir(), 'igm-host-'));
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = dir;   // 注册表与索引都落在临时目录，不碰真配置

/* 记录 llm 被怎么用了：只允许读，任何注册调用都算违约 */
const llmCalls = [];
const fakeLlm = {
  listProviders() { llmCalls.push('listProviders'); return [{ name: 'deepseek', baseUrl: 'https://api.deepseek.com' }]; },
  async listModels(p) { llmCalls.push('listModels:' + p); return [{ id: 'glm-5.3', name: 'GLM 5.3' }]; },
  registerAdapter() { llmCalls.push('!!registerAdapter'); throw new Error('不该被调用'); },
  registerConfigurableProviders() { llmCalls.push('!!registerConfigurable'); throw new Error('不该被调用'); },
  registerModelDiscovery() { llmCalls.push('!!registerModelDiscovery'); throw new Error('不该被调用'); },
};

let provided = null;
const ctx = {
  get: name => (name === 'llm' ? fakeLlm : undefined),
  reflect: { provide: (key, value) => { if (key === 'imageGen') provided = value; } },
  logger: { info() {}, warn() {}, error() {} },
  inject(_deps, run) { /* 宿主半只在 wire 里用；这里同步交付即可 */ run({ llm: fakeLlm }); return () => {}; },
  on: () => () => {},
  effect: fn => (typeof fn === 'function' ? fn() : undefined),
};

applyCordis(ctx, { ...DEFAULT_CONFIG, model: 'image-model', ratio: '16:9' });
check('服务已 provide', !!provided && typeof provided.modelsAdmin === 'function');

const call = payload => provided.modelsAdmin(payload);

let res = await call({ action: 'list' });
check('list 返回内置项', res.ok === true && res.models.length === 1 && res.models[0].builtin === true, JSON.stringify(res.models));
/* 下拉选项（kinds）现在只有 2 项：用户要求把 服务商从接口类型里去掉。
   内置那条仍然是 standard 协议，只是不能再被"新选"（见 imageModels.test 的 KINDS/KIND_CHOICES）。 */
check('list 把 kinds/sizes/ratios 交给设置页', Array.isArray(res.kinds) && res.kinds.length === 2 && !res.kinds.includes('standard') && res.ratios.includes('16:9'), JSON.stringify({ k: res.kinds, r: res.ratios }));
check('★ 内置 standard 行照常返回（协议没被改）', res.models[0].kind === 'standard', JSON.stringify(res.models[0]));
check('内置项沿用插件配置里的档位', res.models[0].ratio === '16:9', res.models[0].ratio);
/* 绿点/「未配置密钥」的判定靠 keyReady（密钥到底解析得到吗）。
   hasKey 只代表"页面里存过明文"——配在环境变量里的会被误标成没密钥。 */
check('★ list 带 keyReady（布尔，供设置页标"未配置密钥"）',
  res.models.every(m => typeof m.keyReady === 'boolean'), JSON.stringify(res.models.map(m => [m.hasKey, m.keyReady])));
check('★ list 依然不漏明文密钥', !JSON.stringify(res.models).includes('IsoKey'), JSON.stringify(res.models.map(m => m.keyHint)));

res = await call({ action: 'add', input: { name: '测试模型', kind: 'openai-images', baseUrl: 'https://t.example', model: 'flux-pro', apiKeyEnv: 'T_KEY' } });
check('add 成功', res.ok === true && res.models.length === 2, JSON.stringify(res.models.map(m => m.name)));
const addedId = res.model.id;

/* keyReady 必须能真的区分"有可用密钥"和"没有"——设置页的「未配置密钥」全靠它。
   先清掉全局回退（keyFor 会退回插件配置的 apiKeyEnv），否则所有模型都算可用，
   这条断言就永远通过、抓不出 bug。
   同时钉住"密钥配在环境变量里"的情形：hasKey=false 但 keyReady=true，
   早期版本只看 hasKey 就标灰点，把能用的模型误报成没密钥。 */
delete process.env.IMAGE_API_KEY;
process.env.IGM_TEST_KEY = 'Alpha-1234567890';
await call({ action: 'add', input: { name: '有密钥', model: 'm-key', apiKeyEnv: 'IGM_TEST_KEY' } });
const noKey = await call({ action: 'add', input: { name: '没密钥', model: 'm-nokey', apiKeyEnv: 'IGM_NOT_SET_KEY' } });
const byName = name => noKey.models.find(m => m.name === name);
check('★ keyReady=true：密钥来自环境变量（hasKey 却是 false）',
  byName('有密钥').keyReady === true && byName('有密钥').hasKey === false,
  JSON.stringify(byName('有密钥')));
check('★ keyReady=false：真的解析不到密钥，才标"未配置密钥"',
  byName('没密钥').keyReady === false && byName('没密钥').hasKey === false,
  JSON.stringify(byName('没密钥')));
/* 用完就撤，别把后面的计数/回落断言带偏 */
await call({ action: 'remove', id: byName('有密钥').id });
await call({ action: 'remove', id: byName('没密钥').id });
delete process.env.IGM_TEST_KEY;

res = await call({ action: 'update', id: addedId, patch: { name: '改名' } });
check('update 生效', res.ok === true && res.models.find(m => m.id === addedId).name === '改名', JSON.stringify(res.models.find(m => m.id === addedId)));

res = await call({ action: 'default', id: addedId });
check('default 切换', res.ok === true && res.defaultId === addedId, res.defaultId);
check('resolve 命中新默认', provided.pickModel().id === addedId, provided.pickModel().id);

/* sources：读 llm 目录，不注册 */
res = await call({ action: 'sources' });
check('sources 返回已添加的模型分组', res.ok === true && res.groups.length === 1 && res.groups[0].models[0].id === 'glm-5.3', JSON.stringify(res.groups));
check('★ 全程没有调用任何 llm 注册 API（图像模型不会进模型选择器）',
  !llmCalls.some(x => x.startsWith('!!')), JSON.stringify(llmCalls));
check('sources 只用了 listProviders/listModels', llmCalls.every(x => x === 'listProviders' || x.startsWith('listModels:')), JSON.stringify(llmCalls));

/* probe：没有密钥时应当报错而不是崩 */
res = await call({ action: 'probe', id: addedId });
check('probe 失败时返回 ok:false + 原因', res.ok === false && typeof res.error === 'string' && res.error.length > 0, JSON.stringify(res));

res = await call({ action: 'probe', id: 'nope' });
check('probe 不存在的 id 有明确错误', res.ok === false && /没有找到/.test(res.error), JSON.stringify(res));

res = await call({ action: 'remove', id: addedId });
check('remove 生效', res.ok === true && !res.models.some(m => m.id === addedId), JSON.stringify(res.models.map(m => m.id)));
check('remove 后回落到内置', provided.pickModel().builtin === true, provided.pickModel().id);

res = await call({ action: 'wat' });
check('未知动作不抛异常', res.ok === false && /未知动作/.test(res.error), JSON.stringify(res));

/* remote 方法清单必须包含 modelsAdmin，否则客户端调不到 */
const MARK = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const marked = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(provided), MARK);
const methods = marked && marked.value ? marked.value.methods.map(m => m.method) : [];
check('★ modelsAdmin 已登记进 Remote 方法清单', methods.includes('modelsAdmin'), JSON.stringify(methods));

process.env.DSH_HOME = prevHome;
rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：宿主侧图像模型管理正确且不污染模型选择器');
process.exit(failures ? 1 : 0);
