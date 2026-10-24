/**
 * 提示词前置增强模块的测试（模板清洗 + 输出校验 + 回退 + 拦截器接线）。
 * 全程不碰网络：llm 用假对象注入，生图函数用假实现捕获收到的 prompt。
 * 跑法：node test/promptOptimizer.test.mjs
 */
import {
	cleanPromptOutput,
	looksLikePrompt,
	buildUserMessage,
	describeCanvas,
	stripRatioMentions,
	PROMPT_OPTIMIZER_SYSTEM,
} from '../src/promptTemplates.js';
import { optimizePrompt, resolveOptimizerTarget, ruleBasedEnhance, __clearOptimizerCache } from '../src/optimize.js';
import { withPromptEnhancement } from '../src/promptOptimizer.js';

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
	if (!ok) failures++;
};

/* ═══════ 模板：System Prompt 的关键约束在位 ═══════ */
check('System Prompt 要求输出英文', /Always output in high-precision, descriptive English/.test(PROMPT_OPTIMIZER_SYSTEM));
check('覆盖构图与留白（海报排版）', /Composition & Layout/.test(PROMPT_OPTIMIZER_SYSTEM) && /copy space/.test(PROMPT_OPTIMIZER_SYSTEM));
check('海报文字用双引号定位置', /enclose the exact text in double quotation marks/.test(PROMPT_OPTIMIZER_SYSTEM));
check('禁止 fluff 词', /Avoid fluff words/.test(PROMPT_OPTIMIZER_SYSTEM));
check('styleHint 拼进 user 消息而不是 system（保住 prompt cache）',
	buildUserMessage('冰红茶海报', '瑞士平面设计').includes('Style direction: 瑞士平面设计') &&
	!PROMPT_OPTIMIZER_SYSTEM.includes('瑞士'));

/* ═══════ 输出清洗 ═══════ */
check('剥掉 markdown 代码块', cleanPromptOutput('```text\nA poster\n```') === 'A poster');
check('剥掉包裹引号', cleanPromptOutput('"A summer poster"') === 'A summer poster');
check('剥掉 Prompt: 前缀', cleanPromptOutput('Prompt: A poster of tea') === 'A poster of tea');
check('剥掉自报家门取正文', /poster/.test(cleanPromptOutput("Sure! Here is the prompt:\nA summer poster with splashing water")));
check('正常输入不被改坏', cleanPromptOutput('A poster, rim light') === 'A poster, rim light');

/* ═══════ 输出校验：宁可回退也别把半句解释送去生图 ═══════ */
check('结构完整的英文提示词 → 通过', looksLikePrompt('A chilled iced-tea bottle centered on wet slate, water splashing outward, generous copy space at top, softbox key light, cool cyan and amber palette'));
check('空串 → 拒绝', !looksLikePrompt(''));
check('太短 → 拒绝', !looksLikePrompt('a cat'));
check('只给前言 → 拒绝', !looksLikePrompt('Sure! Here you go.'));
check('模型反问 → 拒绝', !looksLikePrompt('What style would you like me to use?'));
check('拒绝回答 → 拒绝', !looksLikePrompt("I can't help with that request."));
check('中文道歉 → 拒绝', !looksLikePrompt('抱歉，我无法处理这个请求。'));

/* ═══════ optimizePrompt：每条回退路径都必须出图 ═══════ */
const GOOD = 'A chilled iced-tea bottle on wet slate, water splashing outward, low-angle macro framing, generous empty copy space at top, Swiss typography poster, softbox key light with rim highlight, cool cyan and warm amber palette';
const llmReturning = text => ({ stream: async function* () { yield { type: 'text-delta', text }; yield { type: 'finish' }; } });
const target = { provider: 'deepseek', model: 'deepseek-chat' };

const r1 = await optimizePrompt({ llm: llmReturning(GOOD), target, rawPrompt: '冰红茶海报，夏日感，水花' });
check('正常改写 → via=llm 且返回英文', r1.via === 'llm' && r1.prompt === GOOD, r1.via);
check('带上用的模型（日志/排查用）', r1.target && r1.target.model === 'deepseek-chat', JSON.stringify(r1.target));

const r2 = await optimizePrompt({ llm: null, target, rawPrompt: '冰红茶海报' });
check('没有 llm → 回退规则式，仍能出图', r2.via === 'rule' && r2.prompt.includes('冰红茶海报'), r2.via);

const r3 = await optimizePrompt({
	llm: { stream: async function* () { await new Promise(res => setTimeout(res, 300)); yield { type: 'text-delta', text: GOOD }; } },
	target, rawPrompt: '冰红茶海报', timeoutMs: 40,
});
check('★ 超时 → 回退原文（不阻塞生图）', r3.via === 'rule' && r3.prompt.includes('冰红茶海报'), r3.via + ' ' + r3.error);

const r4 = await optimizePrompt({ llm: { stream: () => { throw new Error('上游 500'); } }, target, rawPrompt: '冰红茶海报' });
check('llm 抛错 → 回退', r4.via === 'rule' && /上游 500/.test(r4.error || ''), r4.via);

const r5 = await optimizePrompt({ llm: llmReturning('Sure! Here you go.'), target, rawPrompt: '冰红茶海报' });
check('★ 输出不像提示词 → 回退（不会把"Sure!"送去生图）', r5.via === 'rule' && !r5.prompt.includes('Sure'), r5.prompt);

const r6 = await optimizePrompt({ llm: llmReturning(GOOD), target: null, rawPrompt: '冰红茶海报' });
check('没解析到模型 → 回退规则式', r6.via === 'rule', r6.via);

const r7 = await optimizePrompt({ llm: llmReturning(GOOD), target, rawPrompt: '   ' });
check('空输入直接返回空（不浪费一次 LLM 调用）', r7.via === 'none' && r7.prompt === '', r7.via);

check('规则式回退保留用户原意', ruleBasedEnhance('一只橘猫').startsWith('一只橘猫'));

__clearOptimizerCache();
/* 温度/超时按交付要求：0.7 与 8s 默认 */
let seen = null;
await optimizePrompt({
	llm: { stream: opts => { seen = opts; return (async function* () { yield { type: 'text-delta', text: GOOD }; })(); } },
	target, rawPrompt: '冰红茶海报',
});
check('默认 temperature=0.7', seen && seen.temperature === 0.7, String(seen && seen.temperature));
check('默认超时 8s（优化不该翻倍等待）', /timeoutMs = 8000/.test((await import('node:fs')).readFileSync(new URL('../src/optimize.js', import.meta.url), 'utf8')));
check('system 用的是海报向 Art Director 模板', seen && /Art Director/.test(seen.system));

/* ═══════ resolveOptimizerTarget：设置页选的 > 会话 > 进程默认 ═══════ */
const t1 = resolveOptimizerTarget({ config: { optimizer: { provider: 'p1', model: 'm1' } }, session: { requestHeader: () => ({ config: { provider: 's', model: 's' } }) } });
check('设置页选过 → 用它', t1.provider === 'p1' && t1.model === 'm1', JSON.stringify(t1));
const t2 = resolveOptimizerTarget({ config: { optimizer: { provider: '', model: '' } }, session: { requestHeader: () => ({ config: { provider: 'sess', model: 'glm' } }) } });
check('没选 → 跟随当前会话', t2.provider === 'sess' && t2.model === 'glm', JSON.stringify(t2));
const t3 = resolveOptimizerTarget({ config: {}, session: null, defaultSelection: () => ({ provider: 'd', model: 'dm' }) });
check('连会话都没有 → 进程默认模型', t3.model === 'dm', JSON.stringify(t3));
check('全都没有 → null（走回退而不是崩）', resolveOptimizerTarget({ config: {}, session: null, defaultSelection: () => null }) === null);

__clearOptimizerCache();
/* ═══════ 拦截器：非侵入 + 开关 + 阶段上报 ═══════ */
const calls = [];
const fakeGenerate = async (model, options) => {
	calls.push({ model, prompt: options.prompt });
	return { created: 1, images: [{ url: 'u' }], raw: {} };
};

const decorated = withPromptEnhancement(fakeGenerate, {
	getLlm: () => llmReturning(GOOD),
	target,
	isEnabled: () => true,
	timeoutMs: 8000,
});
const out1 = await decorated({ id: 'm' }, { prompt: '冰红茶海报，夏日感，水花' });
check('★ 生图收到的是增强后的英文提示词', calls[0].prompt === GOOD, calls[0].prompt.slice(0, 40));
check('★ 原 client 的返回字段一个不少（非侵入）', out1.images.length === 1 && out1.created === 1 && out1.raw);
check('增强结果挂在增量字段上', out1.optimization && out1.optimization.via === 'llm');
check('model 参数原样透传', calls[0].model.id === 'm');

const out2 = await withPromptEnhancement(fakeGenerate, { getLlm: () => llmReturning(GOOD), target, isEnabled: () => false })({ id: 'm' }, { prompt: '原样' });
check('★ 开关关掉 → 直接用原文，且不调 LLM', calls[calls.length - 1].prompt === '原样' && out2.optimization.via === 'off', out2.optimization.via);

const stages = [];
await withPromptEnhancement(fakeGenerate, { getLlm: () => llmReturning(GOOD), target, isEnabled: () => true })({ id: 'm' }, { prompt: 'x', onStage: s => stages.push(s) });
check('阶段按 optimize → generate → save 顺序上报（动画卡片用）', stages.join(',') === 'optimize,generate', stages.join(','));

__clearOptimizerCache();
/* llm 挂掉也不能影响出图 */
const out3 = await withPromptEnhancement(fakeGenerate, { getLlm: () => ({ stream: () => { throw new Error('llm 挂了'); } }), target, isEnabled: () => true })({ id: 'm' }, { prompt: '冰红茶海报' });
check('★ llm 崩了照样出图', out3.images.length === 1 && /冰红茶/.test(calls[calls.length - 1].prompt), calls[calls.length - 1].prompt);

/* 日志：优化前后都要留痕 */
const logged = [];
await withPromptEnhancement(fakeGenerate, { getLlm: () => llmReturning(GOOD), target, isEnabled: () => true, log: { info: m => logged.push(m) } })({ id: 'm' }, { prompt: '冰红茶海报，夏日感，水花' });
check('★ 记录了 raw 与 optimized 对照', logged.length === 1 && /raw/.test(logged[0]) && /optimized/.test(logged[0]), String(logged[0]).slice(0, 60));

__clearOptimizerCache();
/* ═══════ 交付要求的样例（假 llm 返回真实风格的英文）═══════ */
const sample = await optimizePrompt({
	llm: llmReturning('A chilled iced-tea bottle centered on wet black slate, water splashing outward in frozen motion, droplets catching light, low-angle macro framing, generous empty copy space across the top third, Swiss typography poster aesthetic, softbox key light with cool rim highlight, palette of deep amber, cyan and warm white'),
	target,
	rawPrompt: '冰红茶海报，夏日感，水花',
});
console.log('\n─── 样例输出（冰红茶海报，夏日感，水花）───');
console.log(sample.prompt);
console.log(`via=${sample.via}  ${sample.ms}ms\n`);
check('★ 样例：输出结构完整的英文提示词', sample.via === 'llm' && /^[A-Z]/.test(sample.prompt) && !/[一-龥]/.test(sample.prompt));

/* ═══════ 画幅感知：不告诉模型真实比例，它会自己编一个 ═══════ */
console.log('画幅感知（真实画幅 → 构图指令）');
check('★ 带画幅时把比例说成人话（1:1 → square）',
	buildUserMessage('冰红茶海报', null, { ratio: '1:1', size: '2K' }).includes('1:1 (square), 2K'));
check('★ 明确禁止把比例写进正文（比例由渲染器强制）',
	/Do NOT write any aspect ratio or resolution into the prompt/.test(buildUserMessage('x', null, { ratio: '16:9' })));
check('不给画幅时不注入画幅指令（老调用方行为不变）', !buildUserMessage('x', null).includes('Final canvas'));
check('describeCanvas 分类正确',
	describeCanvas('1:1') === 'square' && describeCanvas('16:9') === 'horizontal' &&
	describeCanvas('21:9') === 'ultra-wide horizontal' && describeCanvas('9:16') === 'vertical' &&
	describeCanvas('') === '' && describeCanvas('乱写') === '');

console.log('比例清洗（比例由渲染器强制，正文里写数字只会自相矛盾）');
check('★ 清掉编造的 "3:4 aspect ratio"（实测 1:1 画布被写成 vertical 3:4）',
	!stripRatioMentions('A vertical 3:4 aspect ratio, high-resolution commercial photograph').includes('3:4'));
check('清掉括号形式 "(9:16)"', !stripRatioMentions('portrait orientation (9:16) with empty space').includes('9:16'));
check('清掉裸比例 "21:9"', !stripRatioMentions('A cinematic ultra-wide 21:9 shot of dunes').includes('21:9'));
check('保留构图词（vertical 是画面描述，不是画幅声明）',
	/vertical/i.test(stripRatioMentions('A vertical 3:4 aspect ratio, photo')));
check('★ cleanPromptOutput 出口已串上比例清洗',
	!cleanPromptOutput('A poster at 16:9 aspect ratio with warm light').includes('16:9'));
check('不误伤正常文本', stripRatioMentions('A warm poster with golden light').includes('golden light'));

console.log('优化请求真的带上了画幅');
{
	let seen = '';
	const capture = {
		stream: opts => {
			seen = opts.messages[0].content[0].text;
			return (async function* () { yield { type: 'text-delta', text: GOOD }; })();
		},
	};
	await optimizePrompt({ llm: capture, target, rawPrompt: '冰红茶海报', canvas: { ratio: '9:16', size: '2K' } });
	check('★ 用户消息里带 Final canvas 9:16', /Final canvas: 9:16/.test(seen), seen.split('\n')[1] || seen.slice(0, 80));
}

console.log('同一提示词复用（不重复烧 LLM）');
{
	__clearOptimizerCache();
	let calls = 0;
	const counting = {
		stream: () => {
			calls++;
			return (async function* () { yield { type: 'text-delta', text: GOOD }; })();
		},
	};
	const a1 = await optimizePrompt({ llm: counting, target, rawPrompt: '复用一个提示词', canvas: { ratio: '16:9', size: '2K' } });
	const a2 = await optimizePrompt({ llm: counting, target, rawPrompt: '复用一个提示词', canvas: { ratio: '16:9', size: '2K' } });
	check('第一次走 llm', a1.via === 'llm', a1.via);
	check('★ 第二次直接命中缓存（省一次 LLM 往返）', a2.via === 'cache' && a2.prompt === a1.prompt, a2.via);
	check('★ LLM 只被调了一次', calls === 1, 'calls=' + calls);
	const a3 = await optimizePrompt({ llm: counting, target, rawPrompt: '复用一个提示词', canvas: { ratio: '1:1', size: '2K' } });
	check('★ 换了画幅就不再命中（构图指令不同）', a3.via === 'llm' && calls === 2, a3.via + ' calls=' + calls);

	__clearOptimizerCache();
	let n = 0;
	const flaky = {
		stream: () => {
			n++;
			if (n === 1) throw new Error('boom');
			return (async function* () { yield { type: 'text-delta', text: GOOD }; })();
		},
	};
	const f1 = await optimizePrompt({ llm: flaky, target, rawPrompt: '失败不缓存' });
	const f2 = await optimizePrompt({ llm: flaky, target, rawPrompt: '失败不缓存' });
	check('★ 回退结果不写缓存，下次重新请求', f1.via === 'rule' && f2.via === 'llm' && n === 2, f1.via + '/' + f2.via + ' n=' + n);
}

console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：增强模块可用、失败必回退、对原 client 非侵入');
process.exit(failures ? 1 : 0);
