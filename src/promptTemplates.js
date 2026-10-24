/**
 * 提示词增强模块的模板与常量（对应交付要求里的 prompt_templates.py）。
 *
 * 单独成文件的原因：System Prompt 是这个模块唯一"会长期被人改"的东西，
 * 和调用/回退逻辑分开，改文案不碰控制流，测试也不用跟着动。
 *
 * ⚠️ 注意这里刻意**不写死 provider/model**：用哪个模型优化由设置页选，
 *    缺省跟随当前会话的模型（见 optimize.js 的 resolveOptimizerTarget）。
 */
import { IMAGE_RATIOS } from './imageApi.js';

/** 海报/构图向的 Art Director 提示词：输出高精度英文，结构化覆盖四个维度。 */
export const PROMPT_OPTIMIZER_SYSTEM = `You are an expert Art Director and Generative AI Prompt Engineer.
Your task is to rewrite, expand, and structure rough user ideas into highly professional English prompts for text-to-image models (FLUX.1, SDXL, Midjourney).

Rules:
1. Always output in high-precision, descriptive English.
2. Structure the scene covering:
   - Subject & Action: Specific entity, materials, micro-details, state.
   - Composition & Layout: Framing (macro, eye-level, low-angle), geometric balance, and explicit negative space/copy space (e.g., "generous empty copy space at top/bottom").
   - Style & Aesthetic: Visual genre (e.g., Swiss typography graphic design, 3D Octane render, commercial editorial print).
   - Lighting & Palette: Lighting style (rim light, volumetric rays, softbox) and harmonious color choices.
3. Typography: If the user requires specific poster words, enclose the exact text in double quotation marks with designated placement (e.g., 'with the text "SUMMER FRESH" in clean modern typography across the header').
4. Avoid fluff words like "photorealistic", "hyper-detailed", "8k", or "masterpiece". Use concrete visual features instead.
5. Strict output format: Output ONLY the enhanced prompt string. Do not include introductory text, explanations, or markdown code blocks.`;

/**
 * 可选的风格倾向。设置页不暴露它，但调用方可以传（工具参数 / 将来的样式预设），
 * 拼进 user 消息而不是 system 消息 —— 保持 system 稳定能吃到上游的 prompt cache。
 */
export function buildUserMessage(rawPrompt, styleHint, canvas) {
  const hint = String(styleHint || '').trim();
  const ratio = String((canvas && canvas.ratio) || '').trim();
  const size = String((canvas && canvas.size) || '').trim();
  const lines = [`Idea: ${rawPrompt}`];
  if (hint) lines.push(`Style direction: ${hint}`);
  if (ratio) {
    const shape = describeCanvas(ratio);
    lines.push(
      `Final canvas: ${ratio}${shape ? ` (${shape})` : ''}${size ? `, ${size}` : ''}.` +
        ' Compose the scene for exactly this aspect ratio and reserve copy space where this canvas needs it.' +
        ' Do NOT write any aspect ratio or resolution into the prompt: the renderer applies it,' +
        ' and stating a different one contradicts the canvas.',
    );
  } else if (size) {
    lines.push(`Final canvas: ${size}. Do not write a resolution into the prompt.`);
  }
  return lines.join('\n');
}

/** 把 "3:4" 说成人话，模型更容易据此安排构图（方形/横幅/竖幅…）。 */
export function describeCanvas(ratio) {
  const m = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(String(ratio || '').trim());
  if (!m) return '';
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return '';
  const r = w / h;
  if (Math.abs(r - 1) < 0.02) return 'square';
  if (r >= 2.2) return 'ultra-wide horizontal';
  if (r > 1.15) return 'horizontal';
  if (r <= 0.46) return 'tall vertical';
  if (r < 0.87) return 'vertical';
  return 'near-square';
}

/**
 * 清洗模型输出：它经常无视"只输出提示词"这条规则。
 * 只剥外壳（代码块、引号、"Prompt:" 前缀），不改写内容 —— 内容层面的
 * 兜底交给 looksLikePrompt()，宁可回退原文也不要送半句解释去生图。
 */
export function cleanPromptOutput(text) {
  let out = String(text || '').trim();
  out = out.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  out = out.replace(/^["'「“](.*)["'」”]$/s, '$1').trim();
  out = out.replace(/^(enhanced prompt|optimized prompt|prompt|改写后|优化后|提示词)\s*[:：]\s*/i, '').trim();
  /* 模型偶尔会自报家门再给正文，取最后一个非空段落 */
  if (/^(here(?:'s| is)|sure|ok|好的|以下是)/i.test(out)) {
    const parts = out.split(/\n{1,}/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) out = parts[parts.length - 1];
  }
  return stripRatioMentions(stripFluff(out));
}

/**
 * 模板规则 4 禁止 fluff 词（photorealistic / hyper-detailed / 8k / masterpiece）。
 * 模型偶尔还是会带出来（实测 deepseek-flash 的输出就带了 "photorealistic ... 8K"），
 * 在出口统一剥掉：这些词对文生图模型只有害处，且删掉不会破坏句子结构。
 */
export function stripFluff(text) {
  return String(text || '')
    .replace(/[,;\s]+\b(?:photorealistic|hyper-?detailed|ultra-?detailed|masterpiece|8k|4k|high quality|best quality|ultra hd)\b\s*[,.]?\s*/gi, ', ')
    .replace(/\b(?:photorealistic|hyper-?detailed|ultra-?detailed|masterpiece)\s+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/^(?:,\s*)+|(?:,\s*)+$/g, '')
    .trim();
}

/**
 * 抹掉正文里的画幅声明（"3:4 aspect ratio" / "(9:16)" / 裸的 "16:9"）。
 *
 * 为什么必须清：比例是渲染器按 api.ratio 强制的，提示词里再写一个数字，
 * 一旦不一致就是自相矛盾（实测 1:1 的画布被写成 "A vertical 3:4 aspect ratio"，
 * 构图按竖幅排、画布却是方的）。"vertical/horizontal" 这类构图词保留 ——
 * 那是描述画面内容，不是声明画幅。
 */
export function stripRatioMentions(text) {
  let out = String(text || '');
  out = out.replace(/\b(?:an?\s+)?\d{1,2}\s*:\s*\d{1,2}\s*(?:aspect\s+ratio|ratio)\b/gi, '');
  out = out.replace(/\b(?:aspect\s+ratio|ratio)\s*(?:of\s*)?\(?\s*\d{1,2}\s*:\s*\d{1,2}\s*\)?/gi, '');
  out = out.replace(/\s*\(\s*\d{1,2}\s*:\s*\d{1,2}\s*\)/g, '');
  /* 裸 N:M 只在**确实是画幅**时才删：无差别删会把画面内容一起删掉
     （"a wristwatch reading 10:30" → "a wristwatch reading"）。
     已知画幅集合之外的 N:M 一律保留 —— 宁可留一个没被提取的比例词，
     也不能把时间、比例尺之类的画面细节删没。 */
  const known = new Set(IMAGE_RATIOS);
  out = out.replace(/\b(\d{1,2})\s*:\s*(\d{1,2})\b/g, (match, w, h) => (known.has(`${w}:${h}`) ? '' : match));
  out = out.replace(/\s{2,}/g, ' ');
  out = out.replace(/\s+([,.;:])/g, '$1');
  out = out.replace(/,\s*,/g, ',');
  out = out.replace(/\(\s*\)/g, '');
  out = out.replace(/^[\s,;]+/, '');
  return out.trim();
}

/**
 * 输出到底像不像一条提示词。抓这几类真实失败：
 *   · "I can't help with that."          —— 拒绝
 *   · "Sure! Here is the prompt:"        —— 只给了前言
 *   · 空串 / 只有标点
 * 判定标准：够长 + 不是问句/拒绝 + 至少有一个描述性逗号或介词短语。
 */
export function looksLikePrompt(text) {
  const s = String(text || '').trim();
  if (s.length < 24) return false;
  if (/[?？]\s*$/.test(s)) return false;
  if (/^(i (?:can'?t|cannot|am unable)|sorry|抱歉|我无法|作为(?:ai|语言模型))/i.test(s)) return false;
  if (/(?:please|请)\s*(?:provide|tell|specify|提供|描述)/i.test(s)) return false;
  return true;
}
