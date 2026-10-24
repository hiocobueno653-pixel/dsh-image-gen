/**
 * 图像 API 客户端单元测试（纯 node，不联网、不用真 key）。
 * 跑法：node test/imageApi.test.mjs
 */
import { generateImages, downloadImage, decodeBase64Image, normalizeMediaType, sniffMediaType, assertBaseUrl } from '../src/imageApi.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function fakeFetch(handler) {
  return async (url, init) => {
    const body = init && init.body ? JSON.parse(String(init.body)) : null;
    const res = handler(String(url), body, init);
    return {
      ok: res.ok !== false,
      status: res.status || 200,
      headers: { get: key => (key === 'content-type' ? res.contentType || 'application/json' : null) },
      text: async () => (typeof res.text === 'string' ? res.text : JSON.stringify(res.json || {})),
      arrayBuffer: async () => res.bytes || new ArrayBuffer(0),
    };
  };
}

const seen = [];
const opts = { apiKey: 'k', baseUrl: 'https://image.test', model: 'm', prompt: 'a cat', size: '2K', ratio: '16:9' };

/* ---------- 请求形状 ---------- */
let result = await generateImages({
  ...opts,
  fetchImpl: fakeFetch((url, body) => {
    seen.push({ url, body });
    return { json: { created: 1, data: [{ url: 'https://img.test/1.png', revised_prompt: 'x' }] } };
  }),
});
check('POST 到 {baseUrl}/v1/images/generations', seen[0].url === 'https://image.test/v1/images/generations', seen[0].url);
check('size 透传档位', seen[0].body.size === '2K', JSON.stringify(seen[0].body));
check('ratio 透传', seen[0].body.ratio === '16:9');
check('response_format 在 extra_body 里', seen[0].body.extra_body?.response_format === 'url', JSON.stringify(seen[0].body));
check('URL 结果被解析出来', result.images.length === 1 && result.images[0].url === 'https://img.test/1.png');

/* ---------- base64 输出 ---------- */
result = await generateImages({
  ...opts,
  asBase64: true,
  fetchImpl: fakeFetch(() => ({ json: { data: [{ b64_json: PNG.toString('base64') }] } })),
});
check('b64 结果被解析出来', result.images.length === 1 && typeof result.images[0].base64 === 'string');

/* ---------- count ---------- */
seen.length = 0;
await generateImages({ ...opts, count: 3, fetchImpl: fakeFetch((url, body) => { seen.push({ body }); return { json: { data: [{ url: 'u' }] } }; }) });
check('count>1 时带 n', seen[0].body.n === 3, JSON.stringify(seen[0].body));
await generateImages({ ...opts, count: 99, fetchImpl: fakeFetch((url, body) => { seen.push({ body }); return { json: { data: [{ url: 'u' }] } }; }) });
check('n 上限 4', seen[1].body.n === 4);

/* ---------- 参数校验 ---------- */
const expectError = async (label, promise, pattern) => {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  check(label, !!err && pattern.test(`${err.code} ${err.message}`), err ? `${err.code} ${err.message}` : '没有抛错');
};
await expectError('缺 apiKey 直接报错', generateImages({ ...opts, apiKey: '' }), /MISSING_API_KEY/);
await expectError('空提示词报错', generateImages({ ...opts, prompt: '  ' }), /EMPTY_PROMPT/);
await expectError('缺 baseUrl 报错而不是发到默认端点', generateImages({ ...opts, baseUrl: '' }), /MISSING_BASE_URL|未配置/);
await expectError('HTTP 401 冒泡上游信息', generateImages({ ...opts, fetchImpl: fakeFetch(() => ({ ok: false, status: 401, json: { error: { message: 'bad key' } } })) }), /bad key/);
await expectError('非 JSON 响应有明确错误', generateImages({ ...opts, fetchImpl: fakeFetch(() => ({ text: 'not json' })) }), /BAD_JSON|不是 JSON/);
await expectError('空 data 报「没有图像」', generateImages({ ...opts, fetchImpl: fakeFetch(() => ({ json: { data: [] } })) }), /NO_IMAGE|没有图像/);
await expectError(
  '取消（AbortError）单独归类，不混成网络失败',
  generateImages({
    ...opts,
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  }),
  /ABORTED/,
);

/* ---------- 下载与类型嗅探 ---------- */
const downloaded = await downloadImage('https://img.test/x', {
  fetchImpl: fakeFetch(() => ({ bytes: PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length), contentType: 'application/octet-stream' })),
});
check('下载拿到字节', downloaded.data.length === PNG.length);
check('★ header 是 octet-stream 时按魔数判成 png（附件类型不会被猜错）', downloaded.mediaType === 'image/png', downloaded.mediaType);

check('魔数：PNG', sniffMediaType(new Uint8Array(PNG)) === 'image/png');
check('魔数：JPEG', sniffMediaType(new Uint8Array(JPEG_HEAD)) === 'image/jpeg');
check('魔数：未知返回空串', sniffMediaType(new Uint8Array([1, 2, 3, 4])) === '');
check('normalizeMediaType 无字节时退回扩展名', normalizeMediaType('', 'https://x/a.webp') === 'image/webp');
check('normalizeMediaType 兜底 png', normalizeMediaType('', '') === 'image/png');

/* ---------- base64 解码 ---------- */
const b64Png = decodeBase64Image(PNG.toString('base64'));
check('裸 base64 → png', b64Png.mediaType === 'image/png' && b64Png.data.length === PNG.length);
const b64Jpeg = decodeBase64Image('data:image/jpeg;base64,' + JPEG_HEAD.toString('base64'));
check('data URI 的 jpeg 按魔数判定', b64Jpeg.mediaType === 'image/jpeg', b64Jpeg.mediaType);

/* ---------- baseUrl 校验 ---------- */
const rejectBase = url => {
  try {
    assertBaseUrl(url);
    return false;
  } catch {
    return true;
  }
};
check('baseUrl 为空被拒', rejectBase(''));
check('baseUrl 非 http(s) 被拒', rejectBase('javascript:alert(1)'));
check('baseUrl 去尾斜杠', assertBaseUrl('https://x.test///') === 'https://x.test');

console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：图像 API 客户端与类型嗅探正确');
process.exit(failures ? 1 : 0);
