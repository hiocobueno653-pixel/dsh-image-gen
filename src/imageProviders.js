/**
 * 图像模型请求调度：按注册表条目的 kind 发不同形状的请求。
 *
 *   standard       → 复用 imageApi.js（该协议特有的 ratio / extra_body.response_format）
 *   openai-images  → OpenAI 兼容 /v1/images/generations（size 用 WxH，n 控制张数）
 *   custom         → 直接 POST baseUrl，尽量兼容常见响应形状
 *
 * 三者统一返回 { created, images: [{ url?, base64?, revisedPrompt? }], raw }，
 * 所以下游（附件落地、路由、卡片）完全不用改。
 */
import { generateImages, ImageApiError, assertBaseUrl } from './imageApi.js';
import { IMAGE_RATIOS } from './imageApi.js';

/* 比例 → 1K 档像素。2K/3K/4K 按边长倍率放大（线性档位，不是面积倍率），
   否则用户选 4K 仍只拿到 1024 档，和设置页显示的不符。 */
const RATIO_TO_PIXELS = {
  '1:1': '1024x1024',
  '3:4': '896x1152',
  '4:3': '1152x896',
  '16:9': '1600x900',
  '9:16': '900x1600',
  '2:3': '800x1200',
  '3:2': '1200x800',
  '21:9': '1680x720',
};

const SIZE_SCALE = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };

/** 按档位缩放像素串；未知档位按 1K。 */
export function scalePixels(pixels, sizeTier) {
  const scale = SIZE_SCALE[String(sizeTier || '').toUpperCase()] || 1;
  if (scale === 1) return pixels;
  const [w, h] = String(pixels).split('x').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return pixels;
  return `${w * scale}x${h * scale}`;
}

function joinUrl(baseUrl, path) {
  return assertBaseUrl(baseUrl) + path;
}

function pickArray(json, keys) {
  for (const key of keys) {
    const value = json?.[key];
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

/** 把各家响应规整成统一的 images 形状。 */
export function normalizeImageRows(json) {
  const rows = [
    ...pickArray(json, ['data', 'images', 'output', 'results', 'artifacts']),
  ];
  const images = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      if (/^https?:\/\//.test(row) || /^data:image/.test(row)) images.push({ url: row.startsWith('data:') ? undefined : row, base64: row.startsWith('data:') ? row : undefined });
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const url = row.url || row.image_url || (typeof row.imageUrl === 'string' ? row.imageUrl : undefined) || row.href;
    const base64 = row.b64_json || row.base64 || row.b64 || row.data_base64;
    const item = {
      url: typeof url === 'string' ? url : undefined,
      base64: typeof base64 === 'string' ? base64 : undefined,
      revisedPrompt: row.revised_prompt || row.revisedPrompt || undefined,
    };
    if (item.url || item.base64) images.push(item);
  }
  return images;
}

async function post(url, { apiKey, body, timeoutMs, signal, fetchImpl }) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  const composed = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: composed,
    });
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    if (error?.name === 'TimeoutError') throw new ImageApiError(`请求超时（${timeoutMs} ms）`, { code: 'TIMEOUT' });
    if (error?.name === 'AbortError') throw new ImageApiError('请求已取消', { code: 'ABORTED' });
    throw new ImageApiError(`请求失败：${error?.message || error}`, { code: 'NETWORK' });
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ImageApiError(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`, { status: response.status, code: 'BAD_JSON' });
  }
  if (!response.ok) {
    const detail = json?.error?.message || json?.message || text.slice(0, 300);
    throw new ImageApiError(`模型服务返回 HTTP ${response.status}：${detail}`, { status: response.status, code: 'HTTP_ERROR', body: json });
  }
  return json;
}

/**
 * @param model  注册表条目（{ kind, baseUrl, model, apiKeyEnv, size, ratio, timeoutMs }）
 * @param apiKey 已解析好的密钥明文
 */
export async function generateWithModel(model, options) {
  const { prompt, ratio, size, count = 1, asBase64 = false, referenceImages, apiKey, signal, fetchImpl = fetch } = options || {};
  const wanted = IMAGE_RATIOS.includes(String(ratio || model.ratio)) ? String(ratio || model.ratio) : '1:1';
  const timeoutMs = Number.isFinite(Number(model.timeoutMs)) ? Number(model.timeoutMs) : 300000;

  if (!model.model) throw new ImageApiError(`图像模型「${model.name || model.id}」没有填写模型名（model）`, { code: 'NO_MODEL' });

  if (model.kind === 'standard') {
    return generateImages({
      apiKey,
      baseUrl: model.baseUrl,
      model: model.model,
      prompt,
      size: String(size || model.size || '2K'),
      ratio: wanted,
      count,
      referenceImages,
      asBase64,
      timeoutMs,
      signal,
      fetchImpl,
    });
  }

  if (model.kind === 'openai-images') {
    const body = {
      model: model.model,
      prompt: String(prompt),
      size: scalePixels(RATIO_TO_PIXELS[wanted] || '1024x1024', size || model.size),
      response_format: asBase64 ? 'b64_json' : 'url',
    };
    if (Number.isFinite(count) && count > 1) body.n = Math.min(4, Math.trunc(count));
    if (Array.isArray(referenceImages) && referenceImages.length) body.image = referenceImages;
    const json = await post(joinUrl(model.baseUrl, '/v1/images/generations'), { apiKey, body, timeoutMs, signal, fetchImpl });
    const images = normalizeImageRows(json);
    if (!images.length) throw new ImageApiError('响应里没有图像（data 为空）', { code: 'NO_IMAGE', body: json });
    return { created: json?.created, images, raw: json };
  }

  // custom：把参数摊平发出去，响应形状尽量兼容
  const body = { model: model.model, prompt: String(prompt), ratio: wanted, size: String(size || model.size || '2K') };
  if (Number.isFinite(count) && count > 1) body.n = Math.min(4, Math.trunc(count));
  if (Array.isArray(referenceImages) && referenceImages.length) body.image = referenceImages;
  const json = await post(joinUrl(model.baseUrl, ''), { apiKey, body, timeoutMs, signal, fetchImpl });
  const images = normalizeImageRows(json);
  if (!images.length) throw new ImageApiError('响应里没有图像，检查 baseUrl 与响应格式', { code: 'NO_IMAGE', body: json });
  return { created: json?.created, images, raw: json };
}

/** 连通性自检：设置页「测试」按钮用，只要求能拿到一个可解析的响应。 */
export async function probeModel(model, { apiKey, fetchImpl = fetch, signal } = {}) {
  const started = Date.now();
  const result = await generateWithModel(
    model,
    { prompt: 'a small red dot on white background', count: 1, asBase64: true, apiKey, fetchImpl, signal },
  );
  return { ok: true, ms: Date.now() - started, images: result.images.length };
}
