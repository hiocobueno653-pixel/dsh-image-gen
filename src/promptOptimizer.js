/**
 * 提示词前置增强拦截器（Prompt Optimizer Interceptor）。
 *
 *   [用户原始输入] → [本模块：轻量 LLM 改写] → [生图 API Client] → [图像]
 *
 * 设计约束（交付要求）：
 *   · 对原有生图 Client **非侵入** —— 用 withPromptEnhancement() 装饰，
 *     imageProviders.js / imageApi.js 一行不改，只在调用前换掉 prompt。
 *   · 容错回退 —— 超时/报错/输出不像提示词，一律回退用户原文，绝不因为
 *     优化失败而生不出图。
 *   · 开关透传 —— enablePromptEnhancement（配置或单次请求）关掉时整步跳过。
 *   · 记录优化前后 —— ctx.logger 打一条 info，含 raw 与 optimized。
 */
import { optimizePrompt } from './optimize.js';

/**
 * llm 服务在 apply 当下可能还没注册（宿主依赖顺序不固定），所以既接受现成的
 * llm 对象，也接受一个 getter —— 每次调用时才解析，拿到 undefined 就走回退。
 */
function resolveLlm(deps) {
  if (typeof deps.getLlm === 'function') return deps.getLlm();
  return deps.llm;
}

/** 优化前后的对照日志：出图效果不好时要能判断是谁的锅。 */
export function logOptimization(logger, raw, result) {
  if (!logger?.info) return result;
  const head = s => String(s || '').replace(/\s+/g, ' ').slice(0, 160);
  logger.info(
    `[image-gen] 提示词增强 via=${result.via} ${result.ms}ms` +
      (result.target ? ` model=${result.target.provider}/${result.target.model}` : '') +
      `\n  raw      : ${head(raw)}` +
      `\n  optimized: ${head(result.prompt)}` +
      (result.error ? `\n  error    : ${head(result.error)}` : ''),
  );
  return result;
}

/**
 * 装饰一个生图函数：调用前把 options.prompt 换成增强后的英文提示词。
 *
 * @param generate (model, options) => Promise<result>   原样透传的生图实现
 * @param deps {
 *   llm, resolveTarget, isEnabled, styleHint, timeoutMs, log,
 * }
 * @returns 同签名的函数，额外在结果上挂 optimization 字段（纯增量，不动已有字段）
 */
export function withPromptEnhancement(generate, deps = {}) {
  return async function enhancedGenerate(model, options = {}) {
    const raw = String(options.prompt || '');
    /* 工具卡按 callId 轮询阶段，这里由"知道 optimize 何时结束的人"来上报 */
    const stage = name => {
      try {
        if (typeof options.onStage === 'function') options.onStage(name);
      } catch {
        /* 上报失败不影响生图 */
      }
    };
    const enabled = typeof deps.isEnabled === 'function' ? deps.isEnabled(options) : deps.isEnabled !== false;
    if (!enabled || !raw.trim()) {
      stage('generate');
      const result = await generate(model, options);
      return Object.assign({}, result, { optimization: { prompt: raw, optimized: false, via: enabled ? 'none' : 'off', ms: 0 } });
    }
    stage('optimize');
    const target = typeof deps.resolveTarget === 'function' ? deps.resolveTarget(options) : deps.target;
    const optimization = await optimizePrompt({
      llm: resolveLlm(deps),
      target,
      rawPrompt: raw,
      styleHint: typeof deps.styleHint === 'function' ? deps.styleHint(options) : deps.styleHint,
      canvas: typeof deps.canvas === "function" ? deps.canvas(options) : deps.canvas,
      signal: options.signal,
      timeoutMs: deps.timeoutMs,
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
    });
    if (deps.log) logOptimization(deps.log, raw, optimization);
    stage('generate');
    const result = await generate(model, Object.assign({}, options, { prompt: optimization.prompt }));
    /* 增强结果挂在增量字段上：run() 要把它写进记录与卡片 meta，
       而下游（附件、路由、卡片）读的还是原来的 images/files。 */
    return Object.assign({}, result, { optimization });
  };
}
