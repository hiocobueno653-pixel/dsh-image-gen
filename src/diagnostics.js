/**
 * 传输层失败诊断与生成看门狗（照参考实现的做法搬，零依赖）。
 *
 * 两件独立的事：
 *   · describeTransportFailure: Node/undici 把真正原因（socket reset / DNS / TLS）
 *     藏在 error.cause 里，宿主只渲染 .message，于是对话里只剩一句
 *     "fetch failed"。这里把 cause 链、耗时、阶段拼成一行，并过一遍脱敏。
 *   · withGenerationTimeout: 区分「我们的超时」与「调用方取消」。超时必须能告诉用户
 *     "上游可能已扣费或仍在生成"，而不是和用户按取消混成同一个错误。
 */
import { redactSecrets } from './redact.js';

/** 单条诊断的上限，避免日志/对话被刷屏。 */
const TRANSPORT_DETAIL_LIMIT = 600;
/** error.cause 链的展开深度；undici 实际最多两层。 */
const CAUSE_CHAIN_DEPTH = 3;

/** 上游可能已经扣费时给用户的提醒。 */
export const UPSTREAM_TIMEOUT_HINT = '上游可能已扣费或仍在生成，请到服务商后台确认';

/** 把 error 及其 cause 链渲染成一行，如 `TypeError: fetch failed <- Error [UND_ERR_SOCKET]: other side closed`。 */
export function describeErrorChain(error, depth = 0) {
  try {
    if (depth >= CAUSE_CHAIN_DEPTH) return '...';
    if (error === undefined || error === null) return 'unknown transport error';
    if (typeof error === 'object') {
      const details = error;
      if (error instanceof Error || typeof details.message === 'string') {
        const label = [typeof details.name === 'string' ? details.name : 'Error', typeof details.code === 'string' && details.code.length > 0 ? `[${details.code}]` : '']
          .filter(part => part.length > 0)
          .join(' ');
        const message = typeof details.message === 'string' ? details.message : '';
        const text = label.length > 0 && message.length > 0 ? `${label}: ${message}` : label || message;
        return details.cause !== undefined && details.cause !== null && depth + 1 < CAUSE_CHAIN_DEPTH
          ? `${text} <- ${describeErrorChain(details.cause, depth + 1)}`
          : text || 'unknown transport error';
      }
      /* 宿主取消工具时传的是 data 对象（{ kind: 'user' } / { kind: 'hook', reason }），不是 Error */
      if (typeof details.kind === 'string') {
        return details.reason === undefined || details.reason === null
          ? details.kind
          : `${details.kind}: ${describeErrorChain(details.reason, depth + 1)}`;
      }
    }
    return String(error).trim() || 'unknown transport error';
  } catch {
    /* 取不到的 getter / 会抛的 toString：诊断不能盖掉原始失败 */
    return 'unknown transport error';
  }
}

/** 一行说明这次 fetch 为什么失败：调用方取消给 abort 原因，否则给 cause 链。 */
export function describeTransportFailure(error, signal) {
  try {
    if (signal && signal.aborted === true) return `aborted (${describeErrorChain(signal.reason ?? error)})`;
    return describeErrorChain(error);
  } catch {
    return 'unknown transport error';
  }
}

/**
 * 带着阶段/耗时/脱敏重抛一次 fetch 失败：
 * `${label} failed after 12.3s: ${cause 链}`。原始错误挂在 cause 上，不丢。
 */
export function transportFailure(label, startedAt, error, signal, secrets) {
  const elapsed = Math.max(0, Date.now() - startedAt) / 1000;
  const detail = redactSecrets(describeTransportFailure(error, signal), ...(secrets || []))
    .replace(/\s+/g, ' ')
    .slice(0, TRANSPORT_DETAIL_LIMIT);
  const wrapped = new Error(`${label} failed after ${elapsed.toFixed(1)}s: ${detail}`);
  wrapped.cause = error;
  return wrapped;
}

export class GenerationTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`生图超时（${String(timeoutMs / 1000)} 秒未返回），请检查网络或代理后重试；${UPSTREAM_TIMEOUT_HINT}`);
    this.name = 'GenerationTimeoutError';
    this.code = 'TIMEOUT';
  }
}

/**
 * 给一次生成套看门狗：超时由我们自己判定，调用方取消原样透传。
 * `operation` 拿到的是合并了调用方 signal 与看门狗 signal 的 AbortSignal。
 */
export async function withGenerationTimeout(timeoutMs, signal, operation) {
  const watchdog = new AbortController();
  const combined = signal && AbortSignal.any ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      watchdog.abort();
    } catch {
      /* 已经中止过 */
    }
  }, timeoutMs);
  /* 刻意不 unref：unref 的定时器不会把事件循环撑住，单测/短命脚本里会让
     "等超时"这个 Promise 永远settle不下来。finally 里一定会 clear。 */
  try {
    return await operation(combined);
  } catch (error) {
    /* 只有「看门狗先动、调用方没动」才算超时；用户取消不能被误报成超时 */
    if (timedOut && !(signal && signal.aborted)) throw new GenerationTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
