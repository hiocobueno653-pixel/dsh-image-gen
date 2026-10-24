/**
 * 生图前的提示词优化。
 *
 * - 主路径：调 DSH 的 `ctx.llm.stream()`（provider/model 由设置页选，
 *   缺省跟随当前会话的 `session.requestHeader().config`，再退到进程默认模型）。
 * - 兜底：llm 缺席、超时、报错、或输出根本不像提示词（模型只回了句"好的"），
 *   一律退化为保守的规则式增强，保证**不会因为优化失败而生不出图**。
 *
 * System Prompt 与输出清洗在 `promptTemplates.js`（模板与调用逻辑分开）。
 */
import { PROMPT_OPTIMIZER_SYSTEM, buildUserMessage, cleanPromptOutput, looksLikePrompt } from './promptTemplates.js';

/** 兼容旧引用名。 */
export const OPTIMIZER_SYSTEM = PROMPT_OPTIMIZER_SYSTEM;

/** 规则式增强：只补用户没写的维度，不改变原意（回退路径，保持中文原样）。 */
const RULE_SUFFIX = {
  quality: '高细节，清晰锐利，专业摄影质感',
  lighting: '柔和自然光',
  composition: '主体居中，构图干净',
};

const has = (text, words) => words.some(w => text.includes(w));

export function ruleBasedEnhance(rawPrompt) {
  const base = String(rawPrompt || '').trim().replace(/[，,。.\s]+$/, '');
  if (!base) return base;
  const parts = [];
  if (!has(base, ['光', 'light', 'lighting', '阳光', '灯光', '照明'])) parts.push(RULE_SUFFIX.lighting);
  if (!has(base, ['构图', 'composition', '视角', '镜头', '广角', '特写', 'framing'])) parts.push(RULE_SUFFIX.composition);
  if (!has(base, ['高清', '细节', 'detail', '8k', '4k', '质感', '锐利', 'quality', '电影级', 'cinematic'])) parts.push(RULE_SUFFIX.quality);
  return parts.length ? `${base}，${parts.join('，')}` : base;
}

/** 从流式响应里收集纯文本。 */
async function collectText(stream) {
  let text = '';
  for await (const chunk of stream) {
    if (!chunk) continue;
    if (chunk.type === 'text-delta') text += chunk.text ?? '';
    else if (chunk.type === 'finish') break;
  }
  return text;
}

/**
 * 自己掐表，不能只把 signal 交给上游。
 *
 * ⚠️ 只传 signal 的话，超时是否生效**取决于上游 llm 老不老实**：它要是不看 signal，
 * `for await` 会永久挂住，整条生图链路跟着卡死 —— 而优化只是"加料"，最坏应该回退原文，
 * 绝不该把用户晾在那儿转圈。这里竞速出结果后顺手 requestStop() 让上游收尾。
 */
async function withDeadline(promise, ms, label) {
  if (!(ms > 0)) return promise;
  let timer = 0;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 解析优化用模型。优先级：
 *   1) 设置页显式选的 optimizerProvider/optimizerModel（"跟随当前会话"时两者为空）
 *   2) 当前会话的请求头模型
 *   3) 进程默认模型
 * @returns { provider, model, reasoningEffort? } 或 null
 */
export function resolveOptimizerTarget({ config, session, defaultSelection }) {
  const configured = config?.optimizer || {};
  if (configured.provider && configured.model) {
    return { provider: configured.provider, model: configured.model };
  }
  const header = session?.requestHeader?.();
  const cfg = header?.config;
  if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
  const selection = defaultSelection?.();
  if (selection && selection.provider && selection.model) {
    return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
  }
  return null;
}

/**
 * 优化提示词。
 * @returns {{ prompt: string, optimized: boolean, via: 'llm'|'rule'|'none',
 *             target?: object, error?: string, ms: number }}
 */
/* ---------- 优化结果复用 ----------
 * 同一条提示词重复生成（改比例重画、失败重试、同款再出几张）时，
 * 没必要每次都花 1-8 秒再问一遍模型。key 里带上画幅，因为画幅会改变构图指令。
 * 只缓存成功的 LLM 结果，10 分钟过期，最多 40 条。 */
const OPT_CACHE_MAX = 40;
const OPT_CACHE_TTL = 10 * 60 * 1000;
const optCache = new Map();

function optCacheKey(target, raw, styleHint, canvas) {
  return JSON.stringify([
    target && target.provider,
    target && target.model,
    raw,
    String(styleHint || ''),
    String((canvas && canvas.ratio) || ''),
    String((canvas && canvas.size) || ''),
  ]);
}

function optCacheGet(key) {
  const hit = optCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > OPT_CACHE_TTL) {
    optCache.delete(key);
    return null;
  }
  /* 重新插入以维持"最近使用"顺序 */
  optCache.delete(key);
  optCache.set(key, hit);
  return hit;
}

function optCacheSet(key, prompt) {
  optCache.set(key, { prompt, at: Date.now() });
  while (optCache.size > OPT_CACHE_MAX) {
    const oldest = optCache.keys().next();
    if (oldest.done) break;
    optCache.delete(oldest.value);
  }
}

/** 测试用：清空缓存，避免用例之间互相干扰。 */
export function __clearOptimizerCache() {
  optCache.clear();
}

export async function optimizePrompt({
  llm,
  target,
  rawPrompt,
  styleHint,
  /* 真实画幅（比例/尺寸）。不传的话模型会自己编一个 —— 实测 1:1 的画布被写成 "vertical 3:4" */
  canvas,
  signal,
  maxTokens = 700,
  /* 交付要求建议 5-8s：优化只是加料，不该把整条链路的等待翻倍。
     超时不是失败而是"跳过"——回退原文继续生图。 */
  timeoutMs = 8000,
  /* 0.7 = 创意扩展与结构稳定的折中（0.3 太保守几乎不改写，1.0 会跑题） */
  temperature = 0.7,
}) {
  const started = Date.now();
  const trimmed = String(rawPrompt || '').trim();
  if (!trimmed) return { prompt: '', optimized: false, via: 'none', ms: 0 };
  if (!llm || typeof llm.stream !== 'function' || !target) {
    const prompt = ruleBasedEnhance(trimmed);
    return { prompt, optimized: prompt !== trimmed, via: 'rule', ms: Date.now() - started };
  }

  const key = optCacheKey(target, trimmed, styleHint, canvas);
  const cached = optCacheGet(key);
  if (cached) {
    return {
      prompt: cached.prompt,
      optimized: true,
      via: 'cache',
      target: { provider: target.provider, model: target.model },
      ms: Date.now() - started,
    };
  }

  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const composed = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout;

  /* 声明在 try 外：catch 里要拿它收尾（超时后上游那条流还挂着） */
  let stream = null;
  try {
    stream = llm.stream({
      provider: target.provider,
      model: target.model,
      system: PROMPT_OPTIMIZER_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserMessage(trimmed, styleHint, canvas) }] }],
      temperature,
      maxTokens,
      signal: composed,
    });
    const text = cleanPromptOutput(await withDeadline(collectText(stream), timeoutMs, '提示词优化'));
    /* 光"非空"不够：模型经常回一句"Sure! Here you go."，那玩意送去生图会出一张垃圾。 */
    if (!looksLikePrompt(text)) throw new Error(text ? '模型输出不像提示词：' + text.slice(0, 60) : '模型返回空文本');
    optCacheSet(key, text);
    return { prompt: text, optimized: true, via: 'llm', target: { provider: target.provider, model: target.model }, ms: Date.now() - started };
  } catch (error) {
    /* 超时/出错时尽量让上游流收尾，别留一个永远挂着的 async iterator */
    try {
      if (typeof stream?.return === 'function') await stream.return();
      else if (typeof stream?.requestStop === 'function') stream.requestStop();
    } catch {
      /* 收尾失败无所谓，回退路径照走 */
    }
    const prompt = ruleBasedEnhance(trimmed);
    return {
      prompt,
      optimized: prompt !== trimmed,
      via: 'rule',
      target: { provider: target.provider, model: target.model },
      error: String(error?.message || error),
      ms: Date.now() - started,
    };
  }
}
