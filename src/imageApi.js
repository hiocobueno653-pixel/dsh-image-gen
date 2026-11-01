/**
 * 图像 API 客户端（零依赖，纯 node: 内置）。
 *
 * 协议：POST {baseUrl}/v1/images/generations
 *   headers: Authorization: Bearer <key>, Content-Type: application/json
 *   body: { model, prompt, size: '1K'|'2K'|'3K'|'4K', ratio?, return_base64?, extra_body: { response_format, image? } }
 *   resp: { created, data: [{ url, b64_json, revised_prompt }] }
 * 注意：response_format 放在 extra_body 里（部分服务要求必须在顶层，见 imageProviders.js 的 openai-images 分支）。
 * 服务端建议客户端超时 60–360s。
 *
 * ⚠️ 本文件不绑定任何服务商：baseUrl / model 全部来自配置，空值直接报错，
 *    绝不回落到写死的内网/商业端点。
 */
import { redactSecrets } from './redact.js';
import { GenerationTimeoutError, transportFailure, withGenerationTimeout } from './diagnostics.js';

export const DEFAULT_BASE_URL = '';
export const DEFAULT_MODEL = '';
export const IMAGE_SIZES = ['1K', '2K', '3K', '4K'];
export const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

export class ImageApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'ImageApiError';
    this.status = status;
    this.code = code || 'IMAGE_API_ERROR';
    this.body = body;
  }
}

/** baseUrl 必须显式配置：空值/非 http(s) 一律报错，避免请求打到意料外的地方。 */
export function assertBaseUrl(baseUrl) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new ImageApiError('未配置图像 API 地址（baseUrl）：请在 设置 · 图像模型 里填写服务地址', { code: 'MISSING_BASE_URL' });
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new ImageApiError(`图像 API 地址必须是 http(s) URL：${url}`, { code: 'BAD_BASE_URL' });
  }
  return url;
}

function joinUrl(baseUrl, path) {
  return assertBaseUrl(baseUrl) + path;
}

/**
 * 生成图像。返回 { created, images: [{ url?, base64?, bytes?, mediaType }] }。
 * 任一 image 若为 url，bytes 需要调用方再下载（downloadImage）。
 */
export async function generateImages(options) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    prompt,
    size = '2K',
    ratio = '1:1',
    count = 1,
    referenceImages,
    asBase64 = false,
    timeoutMs = 300000,
    signal,
    fetchImpl = fetch,
  } = options || {};

  if (!apiKey) throw new ImageApiError('缺少 API Key（配置 apiKeyEnv，或在 ~/.dsh/.env 里设置 IMAGE_API_KEY）', { code: 'MISSING_API_KEY' });
  if (!prompt || !String(prompt).trim()) throw new ImageApiError('提示词为空', { code: 'EMPTY_PROMPT' });

  const extra_body = {};
  extra_body.response_format = asBase64 ? 'b64_json' : 'url';
  if (Array.isArray(referenceImages) && referenceImages.length > 0) extra_body.image = referenceImages;

  const payload = {
    model,
    prompt: String(prompt),
    size: IMAGE_SIZES.includes(String(size).toUpperCase()) ? String(size).toUpperCase() : '2K',
    ratio: IMAGE_RATIOS.includes(ratio) ? ratio : '1:1',
    extra_body,
  };
  if (asBase64) payload.return_base64 = true;
  if (Number.isFinite(count) && count > 1) payload.n = Math.min(4, Math.trunc(count));

  /* 看门狗自己判超时（而不是靠 AbortSignal.timeout）：只有这样才能把
     「我们的超时」和「用户取消」分开，并在超时时提示上游可能已扣费。 */
  const startedAt = Date.now();
  let response;
  try {
    response = await withGenerationTimeout(timeoutMs, signal, combined =>
      fetchImpl(joinUrl(baseUrl, '/v1/images/generations'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: combined,
      }),
    );
  } catch (error) {
    /* 自己抛的（例如 baseUrl 没配）要原样透出，不能被包成"网络失败"。 */
    if (error instanceof ImageApiError) throw error;
    if (error instanceof GenerationTimeoutError || error?.name === 'TimeoutError') {
      throw new ImageApiError(error.message || `请求超时（${timeoutMs} ms）`, { code: 'TIMEOUT' });
    }
    if (signal?.aborted) throw new ImageApiError('请求已取消', { code: 'ABORTED' });
    if (error?.name === 'AbortError') throw new ImageApiError('请求已取消', { code: 'ABORTED' });
    throw new ImageApiError(transportFailure('图像 API 请求', startedAt, error, signal, [apiKey]).message, { code: 'NETWORK' });
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw new ImageApiError('请求已取消', { code: 'ABORTED' });
    throw new ImageApiError(transportFailure('读取响应', startedAt, error, signal, [apiKey]).message, { code: 'NETWORK' });
  }
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ImageApiError(`响应不是 JSON（HTTP ${response.status}）：${redactSecrets(text.slice(0, 300), apiKey)}`, { status: response.status, code: 'BAD_JSON' });
  }
  if (!response.ok) {
    /* 中转站经常把请求头（含 key）原样回显在错误体里，进对话前必须打码 */
    const detail = redactSecrets(String(json?.error?.message || json?.message || text.slice(0, 300)), apiKey);
    throw new ImageApiError(`服务返回 HTTP ${response.status}：${detail}`, { status: response.status, code: 'HTTP_ERROR', body: json });
  }

  const rows = Array.isArray(json?.data) ? json.data : [];
  const images = rows
    .map(row => ({
      url: row?.url || undefined,
      base64: row?.b64_json || undefined,
      revisedPrompt: row?.revised_prompt || undefined,
    }))
    .filter(row => row.url || row.base64);
  if (images.length === 0) throw new ImageApiError('服务响应里没有图像（data 为空）', { code: 'NO_IMAGE', body: json });

  return { created: json?.created, images, raw: json };
}

/** 下载图片字节；返回 { data: Uint8Array, mediaType }。 */
export async function downloadImage(url, { timeoutMs = 120000, signal, fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  let response;
  try {
    response = await withGenerationTimeout(timeoutMs, signal, combined => fetchImpl(url, { signal: combined }));
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    if (error instanceof GenerationTimeoutError || error?.name === 'TimeoutError') {
      throw new ImageApiError(`下载图片超时（${String(timeoutMs / 1000)} 秒）`, { code: 'TIMEOUT' });
    }
    if (signal?.aborted) throw new ImageApiError('请求已取消', { code: 'ABORTED' });
    throw new ImageApiError(transportFailure('下载图片', startedAt, error, signal, []).message, { code: 'DOWNLOAD_FAILED' });
  }
  if (!response.ok) throw new ImageApiError(`下载图片失败 HTTP ${response.status}`, { status: response.status, code: 'DOWNLOAD_FAILED' });
  const buffer = new Uint8Array(await response.arrayBuffer());
  const headerType = response.headers?.get?.('content-type');
  return { data: buffer, mediaType: normalizeMediaType(headerType, url, buffer) };
}

/** 按魔数判类型：上游 header 经常是 application/octet-stream，而宿主的附件校验要求声明与字节一致。 */
export function sniffMediaType(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return '';
}

/**
 * 归一化 mediaType：header/扩展名都可能骗人，所以拿到字节时以魔数为准。
 * 没给字节（例如只有 URL）时才退回 header → 扩展名 → png。
 */
export function normalizeMediaType(headerType, url, data) {
  if (data) {
    const sniffed = sniffMediaType(data);
    if (sniffed) return sniffed;
  }
  const clean = String(headerType || '').split(';')[0].trim().toLowerCase();
  if (clean === 'image/png' || clean === 'image/jpeg' || clean === 'image/webp' || clean === 'image/gif') return clean;
  const ext = String(url || '').split('?')[0].toLowerCase();
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
  if (ext.endsWith('.webp')) return 'image/webp';
  if (ext.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

/** base64（可带 data URI 前缀）→ { data, mediaType }。 */
export function decodeBase64Image(value) {
  const text = String(value || '');
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(text);
  const body = match ? match[2] : text;
  const data = new Uint8Array(Buffer.from(body, 'base64'));
  const mediaType = normalizeMediaType(match ? match[1] : '', '', data);
  return { data, mediaType };
}
