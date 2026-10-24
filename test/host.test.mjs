/**
 * 宿主半测试（完全离线）：假 ctx + 假 fetch，跑通
 * 「工具 execute → 提示词优化 → 生图 → 附件/落盘 → 索引 → 路由取字节 → 鉴权栅栏」。
 *
 * 不联网、不用真 key、不写用户真实目录：DSH_HOME 与工作目录都是临时目录。
 * 跑法：node test/host.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCordis } from '../src/cordis.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

/* 1×1 PNG：附件/落盘/路由全链路都能真正解析字节，但不含任何真实图片内容 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const requested = [];
globalThis.fetch = async (url, init) => {
  requested.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ created: 1, data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'test' }] }),
  };
};

const homeDir = mkdtempSync(join(tmpdir(), 'igm-home-'));
const workDir = mkdtempSync(join(tmpdir(), 'igm-work-'));
process.env.DSH_HOME = homeDir;
process.env.IGM_TEST_KEY = 'Local-Test-Key-1234';

function pngSize(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const saved = [];
let registeredTool = null;
let registeredRoute = null;
const fakeCtx = {
  logger: { info: () => {}, warn: () => {} },
  reflect: { provide: () => () => {} },
  inject(deps, callback) {
    const child = {};
    for (const dep of deps) {
      const service = this.get(dep);
      if (!service) return () => {};
      child[dep] = service;
    }
    callback(child);
    return () => {};
  },
  get(name) {
    if (name === 'tools') return { register: def => { registeredTool = def; return () => {}; } };
    if (name === 'webServer') return { register: route => { registeredRoute = route; return () => {}; } };
    if (name === 'sessions') {
      return { get: () => ({ header: { cwd: workDir }, requestHeader: () => ({ config: { provider: 'fake', model: 'fake-model' } }) }) };
    }
    if (name === 'attachments') {
      return {
        saveImage: async input => {
          const { width, height } = pngSize(input.data);
          const ref = { attachmentId: `att-${saved.length + 1}`, mediaType: input.mediaType, bytes: input.data.length, width, height, name: input.name };
          saved.push({ ref, data: input.data });
          return ref;
        },
        readImage: async ref => {
          const hit = saved.find(s => s.ref.attachmentId === ref.attachmentId);
          if (!hit) throw new Error('attachment not found');
          return { ref: hit.ref, data: hit.data };
        },
      };
    }
    /* 恒拒的会话鉴权：/models 写端点必须经过它（见下面的栅栏用例） */
    if (name === 'connection') return { requestRejection: () => 401 };
    if (name === 'llm') return undefined; // 无 llm → 规则式兜底
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) };
    return undefined;
  },
};

const service = applyCordis(fakeCtx, { baseUrl: 'https://image.test', model: 'test-model', apiKeyEnv: 'IGM_TEST_KEY', size: '1K', ratio: '1:1' });
check('generate_image 工具已注册', !!registeredTool && registeredTool.name === 'generate_image');
check('图片路由已注册', !!registeredRoute);
check('参数只暴露 prompt/size/ratio', JSON.stringify(Object.keys(registeredTool.parameters.properties)) === '["prompt","size","ratio"]');

/* ---------- 走 generate_image 工具（离线） ---------- */
const callId = 'call-test-1';
const value = await registeredTool.execute(
  { prompt: '一只趴在窗台的橘猫，午后阳光', size: '1K' },
  { callId, agent: { id: 'session-fake' }, signal: new AbortController().signal },
);
check('工具返回 summary', /已生成 1 张图片/.test(value.summary), value.summary);
check('工具返回 1 张图', value.images.length === 1, JSON.stringify(value.images));
check('★ 工具返回的 /raw 地址带斜杠（早先是 /image-genraw/… 直接 404）', value.images[0].url === '/image-gen/raw/call-test-1/0', value.images[0].url);
check('请求打到配置的 baseUrl', requested[0].url === 'https://image.test/v1/images/generations', requested[0].url);
check('落盘文件存在', value.files.length === 1 && existsSync(value.files[0]), JSON.stringify(value.files));

const record = await service.result({ commandId: callId });
check('remote result 可查', record.found === true && record.images.length === 1);
check('★ remote result 的图片地址同样带斜杠', record.images[0].url === '/image-gen/raw/call-test-1/0', record.images[0].url);
check('remote result 上报的 size 与请求一致', record.api.size === '1K', JSON.stringify(record.api));

const served = await service.readImage(callId, 0);
check('路由能读到字节', served?.data.length === PNG.length && served?.mediaType === 'image/png', JSON.stringify(served && served.mediaType));

/* ---------- 同名文件不再互相覆盖（M3） ---------- */
const second = await registeredTool.execute(
  { prompt: '一只趴在窗台的橘猫，午后阳光', size: '1K' },
  { callId: 'call-test-1b', agent: { id: 'session-fake' }, signal: new AbortController().signal },
);
check('★ 同秒同提示词的第二次生成不覆盖第一张', second.files[0] !== value.files[0] && existsSync(second.files[0]), `${value.files[0]} vs ${second.files[0]}`);

/* ---------- 失败路径：空提示词 ---------- */
let threw = null;
try {
  await registeredTool.execute({ prompt: '  ' }, { callId: 'call-test-2', agent: { id: 'session-fake' }, signal: new AbortController().signal });
} catch (error) {
  threw = error;
}
check('空提示词抛错', !!threw && /提示词/.test(String(threw.message)));
const failed = await service.result({ commandId: 'call-test-2' });
check('失败记录可查', failed.found === true && /提示词/.test(String(failed.error)));

/* ---------- HTTP 栅栏：absolute-form 不能绕过会话鉴权（B1） ---------- */
function fakeResponse() {
  const res = {
    status: 0,
    headers: {},
    ended: false,
    body: '',
    writeHead(code) { this.status = code; return this; },
    end(chunk) { this.ended = true; if (chunk !== undefined) this.body += String(chunk); },
  };
  return res;
}
const baseReq = { method: 'GET', headers: { host: '127.0.0.1:58165' } };

let res = fakeResponse();
await registeredRoute.handler({ ...baseReq, url: '/image-gen/models' }, res);
check('★ origin-form + 无会话 → 401（走宿主鉴权）', res.status === 401, String(res.status));

res = fakeResponse();
await registeredRoute.handler({ ...baseReq, url: 'http://127.0.0.1:58165/image-gen/models' }, res);
check('★ absolute-form 被拒（400），不再绕过鉴权', res.status === 400, String(res.status));

res = fakeResponse();
await registeredRoute.handler({ method: 'POST', headers: { ...baseReq.headers, 'content-type': 'application/json' }, url: 'http://127.0.0.1:58165/image-gen/models' }, res);
check('absolute-form 的写请求同样被拒', res.status === 400, String(res.status));

res = fakeResponse();
await registeredRoute.handler({ ...baseReq, url: '/image-gen/raw/call-test-1/0' }, res);
check('/raw 不带 cookie 也能取图（回环栅栏放行）', res.status === 200 && res.body !== '', String(res.status));

res = fakeResponse();
await registeredRoute.handler({ method: 'GET', headers: { host: 'evil.example' }, url: '/image-gen/raw/call-test-1/0' }, res);
check('非回环 Host 被拒（403）', res.status === 403, String(res.status));

console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：宿主半离线全链路 + 鉴权栅栏');
process.env.DSH_HOME = undefined;
delete process.env.IGM_TEST_KEY;
rmSync(homeDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
