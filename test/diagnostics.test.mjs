/**
 * 错误脱敏 / 传输诊断 / 超时看门狗 的单元测试（纯 node，不联网）。
 * 跑法：node test/diagnostics.test.mjs
 */
import { redactSecrets } from '../src/redact.js';
import {
  GenerationTimeoutError,
  describeErrorChain,
  describeTransportFailure,
  transportFailure,
  withGenerationTimeout,
  UPSTREAM_TIMEOUT_HINT,
} from '../src/diagnostics.js';
import { generateImages } from '../src/imageApi.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

/* ---------- 脱敏 ---------- */
const LIVE_KEY = 'sk-live-abcdef1234567890';
const body = `401 unauthorized: {"Authorization":"Bearer ${LIVE_KEY}", "api_key":"${LIVE_KEY}", token=abc123def456}`;
const clean = redactSecrets(body, LIVE_KEY);
check('★ 已知密钥逐字打码', !clean.includes(LIVE_KEY), clean);
check('sk- 形状的 key 被打码', !clean.includes('sk-live-abcdef1234567890') && clean.includes('[REDACTED]'), clean);
check('Bearer 头被打码', !/Bearer\s+sk-/.test(clean), clean);
check('★ 错误体里回显的 key 不会漏进对话', !clean.includes('abcdef1234567890'));

/* ---------- cause 链 ---------- */
const root = Object.assign(new Error('other side closed'), { name: 'Error', code: 'UND_ERR_SOCKET' });
const outer = Object.assign(new TypeError('fetch failed'), { cause: root });
const chain = describeErrorChain(outer);
check('★ cause 链被展开（undici 只给 "fetch failed"）', /fetch failed/.test(chain) && /UND_ERR_SOCKET/.test(chain), chain);

const aborted = new AbortController();
aborted.abort('user cancel');
check('调用方取消时给 abort 原因', /aborted/.test(describeTransportFailure(new Error('x'), aborted.signal)));

const wrapped = transportFailure('图像 API 请求', Date.now() - 1234, outer, undefined, [LIVE_KEY]);
check('诊断行带阶段与耗时', /^图像 API 请求 failed after 1\.[0-9]s:/.test(wrapped.message), wrapped.message);
check('诊断行过脱敏', !wrapped.message.includes(LIVE_KEY) && !wrapped.message.includes('abcdef1234567890'));

/* ---------- 超时看门狗 ---------- */
let timeoutError = null;
try {
  await withGenerationTimeout(40, new AbortController().signal, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
} catch (error) {
  timeoutError = error;
}
check('★ 超时抛 GenerationTimeoutError', timeoutError instanceof GenerationTimeoutError, String(timeoutError && timeoutError.name));
check('超时文案提示上游可能已扣费', String(timeoutError && timeoutError.message).includes(UPSTREAM_TIMEOUT_HINT), String(timeoutError && timeoutError.message));

const caller = new AbortController();
setTimeout(() => caller.abort('user'), 10);
let callerError = null;
try {
  await withGenerationTimeout(5000, caller.signal, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
} catch (error) {
  callerError = error;
}
check('★ 用户取消不被误报成超时', !(callerError instanceof GenerationTimeoutError) && callerError?.name === 'AbortError', String(callerError && callerError.name));

/* ---------- 端到端：上游错误体回显密钥 ---------- */
const fakeFetch = async () => ({
  ok: false,
  status: 401,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify({ error: { message: `invalid key ${LIVE_KEY} (Authorization: Bearer ${LIVE_KEY})` } }),
  arrayBuffer: async () => new ArrayBuffer(0),
});
let apiError = null;
try {
  await generateImages({
    apiKey: LIVE_KEY,
    baseUrl: 'https://image.test',
    model: 'm',
    prompt: 'a cat',
    fetchImpl: fakeFetch,
  });
} catch (error) {
  apiError = error;
}
check('★ HTTP 错误信息里的密钥被打码后才冒泡', !!apiError && !String(apiError.message).includes(LIVE_KEY) && /\[REDACTED\]/.test(String(apiError.message)), String(apiError && apiError.message));

console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：脱敏 / 诊断 / 超时看门狗');
process.exit(failures ? 1 : 0);
