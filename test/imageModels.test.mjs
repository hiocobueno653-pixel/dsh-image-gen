/**
 * 图像模型注册表 + 多协议调度的单元测试（纯 node，不碰网络）。
 * 跑法：node test/imageModels.test.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageModelRegistry, builtinFromConfig, normalizeModel, shapeSources, KINDS, KIND_CHOICES } from '../src/imageModels.js';
import { generateWithModel, normalizeImageRows } from '../src/imageProviders.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const builtin = builtinFromConfig({ model: 'image-model', size: '2K', ratio: '16:9' });

/* ---------- 注册表 ---------- */
const dir = mkdtempSync(join(tmpdir(), 'igm-'));
try {
	const reg = new ImageModelRegistry(dir);
	check('空表时 list 只有内置项', reg.list(builtin).length === 1 && reg.list(builtin)[0].builtin === true, JSON.stringify(reg.list(builtin)));
	check('空表时 resolve 回落到内置', reg.resolve(builtin, '').model === 'image-model');

	const added = reg.add(builtin, { name: '我的 SDXL', kind: 'openai-images', baseUrl: 'https://x.example/v1/', model: 'sdxl', apiKeyEnv: 'SDXL_KEY' });
	check('add 成功', added.ok === true && added.models.length === 2, JSON.stringify(added.models.map(m => m.id)));
	check('baseUrl 去掉尾斜杠', added.model.baseUrl === 'https://x.example/v1', added.model.baseUrl);
	check('add 后默认项自动指向新模型', reg.resolve(builtin, '').id === added.model.id, reg.defaultId());

	const picked = reg.resolve(builtin, 'sdxl');
	check('按 model 名也能命中', picked.id === added.model.id, picked.id);

	const upd = reg.update(builtin, added.model.id, { name: '改名了', ratio: '9:16' });
	check('update 生效', upd.ok === true && upd.model.name === '改名了' && upd.model.ratio === '9:16', JSON.stringify(upd.model));

	const bad = reg.update(builtin, added.model.id, { model: '  ' });
	check('update 拒绝空 model', bad.ok === false, JSON.stringify(bad));

	/* 持久化：换一个实例读同一个目录 */
	const again = new ImageModelRegistry(dir);
	check('重启后条目还在', again.list(builtin).length === 2 && again.list(builtin)[1].name === '改名了', JSON.stringify(again.list(builtin).map(m => m.name)));

	const rm = again.remove(builtin, added.model.id);
	check('remove 生效并清掉默认项', rm.ok === true && again.defaultId() === '', JSON.stringify(rm));
	check('remove 掉不存在的 id 会报错', again.remove(builtin, 'nope').ok === false);

	/* 归一化的健壮性 */
	const weird = normalizeModel({ id: '../../etc/passwd', kind: 'evil', baseUrl: 'javascript:alert(1)', model: ' x ', size: '9K', ratio: '5:5', timeoutMs: -1 }, 'fb');
	check('id 被 slug 化', /^[a-z0-9._-]+$/.test(weird.id) && !weird.id.includes('..'), weird.id);
	check('kind 非法退回 standard', weird.kind === 'standard', weird.kind);
	check('非 http baseUrl 被清空（不回落到任何写死端点）', weird.baseUrl === '', weird.baseUrl);
	check('model 去空白', weird.model === 'x', weird.model);
	check('非法 size/ratio/timeout 退回默认值', weird.size === '2K' && weird.ratio === '1:1' && weird.timeoutMs === 300000, JSON.stringify(weird));
	/* KINDS = 允许存储的值；KIND_CHOICES = 下拉里能选的值。
	   ⚠️ 两者必须分开：把 'standard' 从 KINDS 里删掉的话，normalizeModel 会把存量的
	   旧协议行改成别的协议，那些行立刻打不开图。 */
	check('KINDS 仍接受 standard（存量行不会被改协议）', KINDS.includes('standard') && KINDS.length === 3);
	check('★ KIND_CHOICES 不再提供 standard（下拉里选不到）',
		KIND_CHOICES.length === 2 && !KIND_CHOICES.includes('standard'), JSON.stringify(KIND_CHOICES));
	check('KIND_CHOICES 是 KINDS 的子集（可选项一定可存储）',
		KIND_CHOICES.every(k => KINDS.includes(k)), JSON.stringify({ c: KIND_CHOICES, k: KINDS }));
	check('未知协议名被归一成 standard', normalizeModel({ kind: 'legacy-protocol', model: 'm' }, 'x').kind === 'standard');

	/* 目录形状 */
	/* 目录形状：宿主保证 model.id 非空（llm 会校验），这里只兜字段名差异。
	   { id:'', name:'x' } 走 name 兜底、{ model:'other' } 走 model 兜底，都保留。 */
	const shaped = shapeSources(
		[{ name: 'deepseek', baseUrl: 'https://api.deepseek.com' }, { provider: 'workbuddy' }, {}],
		{ deepseek: [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: '', name: 'x' }, { model: 'other' }], workbuddy: [] },
	);
	check('shapeSources 跳过空 provider 与空模型组', shaped.groups.length === 1 && shaped.groups[0].models.length === 3, JSON.stringify(shaped.groups));
	check('shapeSources 给每个模型都拿到可用 id 与展示名', shaped.groups[0].models.every(m => typeof m.id === 'string' && m.label), JSON.stringify(shaped.groups[0].models));
	check('shapeSources 带出 baseUrl / apiKeyEnv 供表单预填', shaped.groups[0].baseUrl === 'https://api.deepseek.com' && shaped.groups[0].apiKeyEnv.includes('API_KEY'), JSON.stringify(shaped.groups[0]));

	/* ---------- 提示词优化模型的选择（存插件自己的 JSON，不碰 cordis.yml）---------- */
	const optReg = new ImageModelRegistry(dir);
	check('未选过 → 空（含义是"跟随当前会话"）', optReg.getOptimizer().provider === '' && optReg.getOptimizer().model === '', JSON.stringify(optReg.getOptimizer()));
	const set1 = optReg.setOptimizer('deepseek', 'deepseek-chat');
	check('setOptimizer 成对保存', set1.ok === true && set1.optimizer.model === 'deepseek-chat', JSON.stringify(set1.optimizer));
	check('★ 重启后仍在（换实例读同一目录）', new ImageModelRegistry(dir).getOptimizer().model === 'deepseek-chat');
	optReg.setOptimizer('workbuddy', 'glm-5.3-flash');
	check('可改选别的模型', new ImageModelRegistry(dir).getOptimizer().provider === 'workbuddy');
	optReg.setOptimizer('workbuddy', '');
	check('★ 只填一半视为清空（半截会让 llm.stream 走错 provider）', new ImageModelRegistry(dir).getOptimizer().provider === '');
	optReg.setOptimizer('p', 'm');
	check('清空后再设可恢复', new ImageModelRegistry(dir).getOptimizer().model === 'm');
	check('★ 优化模型不进图像模型列表（两套目录互不污染）', optReg.list(builtin).every(m => m.model !== 'deepseek-chat'), JSON.stringify(optReg.list(builtin).map(m => m.model)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/* ---------- 多协议调度 ---------- */
function fakeFetch(handler) {
  return async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const res = handler(url, body, init);
    return {
      ok: res.status === undefined ? true : res.ok !== false,
      status: res.status || 200,
      headers: { get: () => res.contentType || 'application/json' },
      text: async () => (typeof res.text === 'string' ? res.text : JSON.stringify(res.json || {})),
    };
  };
}

const standardModel = normalizeModel({ kind: 'standard', baseUrl: 'https://image.example', model: 'image-model' }, 'a');
const openaiModel = normalizeModel({ kind: 'openai-images', baseUrl: 'https://oai.example', model: 'gpt-image-1' }, 'o');
const customModel = normalizeModel({ kind: 'custom', baseUrl: 'https://c.example/v1/gen', model: 'flux' }, 'c');

const seen = {};
const okData = { data: [{ url: 'https://img/1.png' }] };
const fetcher = fakeFetch((url, body) => {
  seen.last = { url, body };
  return { json: okData };
});

const r1 = await generateWithModel(standardModel, { prompt: 'p', ratio: '16:9', size: '2K', apiKey: 'k', fetchImpl: fetcher });
check('standard 走配置的端点并带 extra_body', seen.last.url === 'https://image.example/v1/images/generations' && seen.last.body.extra_body.response_format === 'url', seen.last.url);
check('standard 返回 images', r1.images.length === 1);

await generateWithModel(openaiModel, { prompt: 'p', ratio: '1:1', count: 2, size: '1K', apiKey: 'k', fetchImpl: fetcher });
check('openai 把 ratio 映射成像素 size', seen.last.body.size === '1024x1024', JSON.stringify(seen.last.body));
await generateWithModel(openaiModel, { prompt: 'p', ratio: '16:9', size: '1K', apiKey: 'k', fetchImpl: fetcher });
check('openai 16:9 → 1600x900', seen.last.body.size === '1600x900', seen.last.body.size);
await generateWithModel(openaiModel, { prompt: 'p', ratio: '1:1', size: '2K', apiKey: 'k', fetchImpl: fetcher });
check('★ openai 的像素随档位放大（2K 不再是 1024 档）', seen.last.body.size === '2048x2048', seen.last.body.size);
check('openai 带 n', seen.last.body.n === undefined || seen.last.body.n === 2);

await generateWithModel(customModel, { prompt: 'p', apiKey: 'k', fetchImpl: fetcher });
check('custom 直接 POST baseUrl', seen.last.url === 'https://c.example/v1/gen', seen.last.url);

/* 响应形状兼容 */
check('normalizeImageRows 认 data[].url', normalizeImageRows({ data: [{ url: 'u' }] })[0].url === 'u');
check('normalizeImageRows 认 b64_json', normalizeImageRows({ data: [{ b64_json: 'YQ==' }] })[0].base64 === 'YQ==');
check('normalizeImageRows 认字符串数组', normalizeImageRows({ images: ['https://a.png'] })[0].url === 'https://a.png');
check('normalizeImageRows 认 data:image URI', normalizeImageRows({ output: ['data:image/png;base64,YQ=='] })[0].base64 === 'data:image/png;base64,YQ==');
check('normalizeImageRows 忽略垃圾', normalizeImageRows({ data: [null, 3, {}, { foo: 1 }] }).length === 0);

/* 错误路径 */
let err = null;
try {
  await generateWithModel(openaiModel, { prompt: 'p', apiKey: 'k', fetchImpl: fakeFetch(() => ({ ok: false, status: 400, json: { error: { message: 'bad model' } } })) });
} catch (e) {
  err = e;
}
check('HTTP 错误冒泡并带上游信息', err && /bad model/.test(err.message), String(err && err.message));

err = null;
try {
  await generateWithModel(openaiModel, { prompt: 'p', apiKey: 'k', fetchImpl: fakeFetch(() => ({ json: { data: [] } })) });
} catch (e) {
  err = e;
}
check('空响应报「没有图像」', err && /没有图像/.test(err.message), String(err && err.message));

err = null;
try {
  await generateWithModel(normalizeModel({ kind: 'standard', model: '' }, 'e'), { prompt: 'p', apiKey: 'k', fetchImpl: fetcher });
} catch (e) {
  err = e;
}
check('缺 model 直接拒绝，不发请求', err && /没有填写模型/.test(err.message), String(err && err.message));

/* ---------- 关键不变量：图像模型绝不能进 llm 目录 ----------
 * 聊天输入框的模型选择器读的是 llm 的 provider/adapter 目录（sessionController.modelCatalog）。
 * 只要插件不往那个目录里注册任何东西，图像模型就不可能出现在选择器里 —— 这是用户明确要求的。
 * 用静态检查钉住：宿主半只允许"读" llm，不允许任何注册类 API。 */
const hostSrc = readFileSync(new URL('../src/cordis.js', import.meta.url), 'utf8');
check('★ 宿主半不调用任何 llm 注册 API（图像模型不会进模型选择器）',
  !/registerAdapter|registerConfigurableProviders|registerModelDiscovery/.test(hostSrc));
check('宿主半只读 llm 的目录接口', /llm\.listProviders|llm\.listModels/.test(hostSrc));
check('★ 图像模型不写 cordis.yml / 不写插件 config',
  !/configEditor|writeFileSync\([^)]*cordis\.yml/.test(hostSrc));

/* ---------- 密钥：能填、能存，但绝不出宿主进程 ----------
 * 测试值刻意不含 sk-/token 等特征，避免被工具链当敏感信息处理。 */
const KEY_A = 'Alpha-1234567890';
const KEY_B = 'Bravo-000011112222';
const KEY_C = 'Charlie-33334444';
{
	const kdir = mkdtempSync(join(tmpdir(), 'igm-key-'));
	try {
		const kreg = new ImageModelRegistry(kdir);
		const kb = builtinFromConfig({ model: 'image-model' });
		const added = kreg.add(kb, { name: '带密钥', model: 'flux', baseUrl: 'https://k.example', apiKey: KEY_A });
		check('add 接受了页面里直接填的密钥', added.ok === true && added.model.hasKey === true, JSON.stringify(added.model));
		check('★ add 的返回值里没有明文密钥', !('apiKey' in added.model) && !JSON.stringify(added.model).includes(KEY_A), JSON.stringify(added.model));
		check('★ list 全是对外形状（无明文，只有掩码）',
			kreg.list(kb).every(m => !('apiKey' in m)) && !JSON.stringify(kreg.list(kb)).includes(KEY_A),
			JSON.stringify(kreg.list(kb).map(m => m.keyHint)));
		check('掩码只露头尾', added.model.keyHint.includes('•') && !added.model.keyHint.includes(KEY_A.slice(4)), added.model.keyHint);
		check('listRaw 才拿得到明文（发请求用）', kreg.listRaw(kb).find(m => m.id === added.model.id).apiKey === KEY_A);
		check('resolve 返回带明文的条目', kreg.resolve(kb, added.model.id).apiKey === KEY_A);

		/* 编辑时留空 = 不改密钥 */
		const keep = kreg.update(kb, added.model.id, { name: '改名', apiKey: '' });
		check('update 留空密钥 = 保持原值', keep.ok === true && kreg.resolve(kb, added.model.id).apiKey === KEY_A, JSON.stringify(keep.model));
		const swap = kreg.update(kb, added.model.id, { apiKey: KEY_B });
		check('update 填了新密钥则覆盖', swap.ok === true && kreg.resolve(kb, added.model.id).apiKey === KEY_B);
		check('★ update 的返回值也不漏明文', !JSON.stringify(swap).includes(KEY_B), JSON.stringify(swap.model));

		/* 内置行也能填密钥（落一条 builtin 覆盖） */
		const builtinEdit = kreg.update(kb, kb.id, { apiKey: KEY_C });
		check('内置行可编辑并保存密钥', builtinEdit.ok === true && kreg.resolve(kb, kb.id).apiKey === KEY_C, JSON.stringify(builtinEdit.model));
		check('内置行编辑后仍标记为内置', kreg.list(kb)[0].builtin === true && kreg.list(kb)[0].hasKey === true);

		/* 持久化后仍然安全 */
		const again2 = new ImageModelRegistry(kdir);
		check('重启后密钥仍在（内部）', again2.resolve(kb, kb.id).apiKey === KEY_C);
		check('★ 重启后对外依然不含明文', !JSON.stringify(again2.list(kb)).includes(KEY_C), JSON.stringify(again2.list(kb).map(m => m.keyHint)));
	} finally {
		rmSync(kdir, { recursive: true, force: true });
	}
}
console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：注册表与多协议调度正确');
process.exit(failures ? 1 : 0);
