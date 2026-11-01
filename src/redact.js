/**
 * 把上游错误文本里的密钥形状内容打码。
 *
 * 为什么必须有：Provider 与中转站经常把请求头原样回显在错误体里
 * （`Authorization: Bearer sk-...`），而这条错误会进对话、进日志、进设置页提示。
 * 所以每个适配器在把响应文本塞进异常之前都过一遍这里，并同时传入本次真实密钥，
 * 保证即便是非标准格式的 key 也不会漏出去。
 */
const REDACTED = '[REDACTED]';

const KEY_SHAPED_PATTERNS = [
  /* OpenAI / 阿里云百炼风格，如 sk-abc123... */
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /* Google API key，如 AIzaSy... */
  /\bAIza[A-Za-z0-9_-]{10,}/g,
  /* 中转站回显的 Authorization 头 */
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /* 回显的键值对，如 "api_key": "..." 或 token=... */
  /\b(?:api[_-]?key|apikey|token|secret)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  /* 关键词后面直接跟引号值，如 invalid token "..." */
  /\b(?:api[_-]?key|apikey|token|secret)\s*["'][A-Za-z0-9._~+/=-]{8,}["']/gi,
];

/** 已知密钥逐字替换 + 密钥形状兜底打码。 */
export function redactSecrets(text, ...secrets) {
  let redacted = String(text ?? '');
  for (const secret of secrets) {
    /* 太短的值盲替换会把正常单词拆碎 */
    if (typeof secret === 'string' && secret.length >= 8) redacted = redacted.split(secret).join(REDACTED);
  }
  for (const pattern of KEY_SHAPED_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
  return redacted;
}
