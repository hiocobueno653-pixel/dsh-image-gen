/**
 * 图像模型注册表。
 *
 * ⚠️ 为什么单独存一份 JSON，而不是写进 cordis.yml / 注册成 llm 适配器：
 *   聊天里的模型选择器读的是 sessionController.modelCatalog()，其数据来自 llm 服务的
 *   provider/adapter 目录。只要图像模型不进那个目录，它就**不可能**出现在模型选择器里
 *   （用户明确要求：图像模型的名称不要在模型选择器的模型列表中出现）。
 *   所以这里只落 ~/.dsh/cache/dsh-image-gen/models.json，由本插件自己读取。
 *
 * 条目形状（kind 决定请求怎么发）：
 *   { id, name, kind: 'standard' | 'openai-images' | 'custom',
 *     baseUrl, model, apiKeyEnv, size, ratio, timeoutMs, builtin }
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, IMAGE_SIZES, IMAGE_RATIOS } from './imageApi.js';

/* KINDS = 允许存储的值；KIND_CHOICES = 设置页下拉里能选的值。两者刻意不同：
 * 'standard' 是内置那条（由 cordis.yml 的 baseUrl/model 派生）的协议。
 * 存量 models.json 里可能还留着旧协议名，normalizeModel 会把它归一到 'standard'
 * —— 两者发的是同一种请求体，归一不会改掉协议、也不会让旧行打不开图。 */
export const KINDS = ['standard', 'openai-images', 'custom'];
export const KIND_CHOICES = ['openai-images', 'custom'];
const MAX_MODELS = 64;

export function modelsDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'cache', 'dsh-image-gen');
}

function safeId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    /* 只允许出现在中间：首尾的点/横线去掉，避免 ".." 之类被当成路径片段。 */
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 48);
}

/** 由插件既有配置派生的内置条目：注册表为空时它也保证生图照常工作。 */
export function builtinFromConfig(config) {
  const cfg = config || {};
  return {
    id: 'default',
    name: 'Default Image Model',
    kind: 'standard',
    baseUrl: String(cfg.baseUrl || DEFAULT_BASE_URL),
    model: String(cfg.model || DEFAULT_MODEL),
    apiKeyEnv: String(cfg.apiKeyEnv || 'IMAGE_API_KEY'),
    size: IMAGE_SIZES.includes(String(cfg.size).toUpperCase()) ? String(cfg.size).toUpperCase() : '2K',
    ratio: IMAGE_RATIOS.includes(String(cfg.ratio)) ? String(cfg.ratio) : '1:1',
    timeoutMs: Number.isFinite(Number(cfg.timeoutMs)) && Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 300000,
    builtin: true,
  };
}

export function normalizeModel(raw, fallbackId) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = safeId(src.id) || safeId(src.name) || fallbackId || `model-${Date.now().toString(36)}`;
  const kind = KINDS.includes(src.kind) ? src.kind : 'standard';
  const baseUrl = String(src.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return {
    id,
    name: String(src.name || src.model || id).trim().slice(0, 60),
    kind,
    /* 空 baseUrl 保持为空：真正发请求前由 assertBaseUrl 报一条能照着做的错，
       而不是偷偷回落到一个写死的端点。非 http(s) 的脏数据同样清空。 */
    baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : '',
    model: String(src.model || '').trim().slice(0, 80),
    apiKeyEnv: String(src.apiKeyEnv || 'IMAGE_API_KEY').trim().slice(0, 60),
    /* 页面上直接填的密钥明文。只落 ~/.dsh/cache/dsh-image-gen/models.json
       （与插件早已使用的 ~/.dsh/.env 同一信任域），**绝不回传前端**：
       对外一律走 publicModel() 换成 hasKey/keyHint。 */
    apiKey: String(src.apiKey || '').trim().slice(0, 400),
    size: IMAGE_SIZES.includes(String(src.size).toUpperCase()) ? String(src.size).toUpperCase() : '2K',
    ratio: IMAGE_RATIOS.includes(String(src.ratio)) ? String(src.ratio) : '1:1',
    timeoutMs: Number.isFinite(Number(src.timeoutMs)) && Number(src.timeoutMs) > 0 ? Math.min(1800000, Number(src.timeoutMs)) : 300000,
    builtin: src.builtin === true,
  };
}

/** 掩码：只露头尾各一点，够用户确认"是哪个 key"。 */
export function maskKey(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 3)}••••${text.slice(-4)}`;
}

/** 对外形状：剥掉明文密钥，换成 hasKey / keyHint。 */
export function publicModel(model) {
  const { apiKey, ...rest } = model;
  return { ...rest, hasKey: Boolean(apiKey), keyHint: maskKey(apiKey) };
}

export class ImageModelRegistry {
  constructor(dir = modelsDir()) {
    this.dir = dir;
    this.file = join(dir, 'models.json');
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    let state = { version: 1, models: [], defaultId: '', optimizer: { provider: '', model: '' } };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const models = Array.isArray(parsed.models) ? parsed.models : [];
        const savedOpt = parsed.optimizer && typeof parsed.optimizer === 'object' ? parsed.optimizer : {};
        state = {
          version: 1,
          models: models.slice(0, MAX_MODELS).map((m, i) => normalizeModel(m, `row-${i}`)).filter(m => m.model),
          defaultId: String(parsed.defaultId || ''),
          /* 提示词优化用的 LLM。不解析这一行，保存后重启就丢。 */
          optimizer: { provider: String(savedOpt.provider || ''), model: String(savedOpt.model || '') },
        };
      }
    } catch {
      /* 首次运行或文件损坏：从空表开始 */
    }
    this.state = state;
    return state;
  }

  save() {
    const state = this.load();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
      renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 全部条目（不含内置派生项）+ 内置项永远排在最前作为兜底。
   * ⚠️ 默认只回 publicModel()（明文密钥不出宿主进程）；要拿明文用 listRaw()。
   */
  list(builtin) {
    return this.listRaw(builtin).map(publicModel);
  }

  /**
   * 内部用：带明文密钥的完整条目（生成请求要用）。
   * 内置项由插件配置派生；若用户在设置页给它填过密钥/档位，用持久化的那条覆盖
   * 派生值（只覆盖填了的字段，空值不覆盖），这样内置行也可编辑、可换 key。
   */
  listRaw(builtin) {
    const state = this.load();
    const base = builtin || {};
    const derivedId = safeId(base.id) || 'default';
    /* 内置行的 id 可能被旧版本写成别的值（存量 models.json），所以按 builtin 标记
       找覆盖行，而不是只认 id —— 否则用户在内置行上填的密钥/档位会被静默忽略。 */
    const override = state.models.find(m => m.builtin && m.id === derivedId) || state.models.find(m => m.builtin);
    const merged = { ...base, id: derivedId, builtin: true };
    if (override) {
      for (const field of ['name', 'kind', 'baseUrl', 'model', 'apiKeyEnv', 'apiKey', 'size', 'ratio', 'timeoutMs']) {
        const value = override[field];
        if (value !== undefined && value !== '' && value !== null) merged[field] = value;
      }
    }
    const head = normalizeModel(merged, derivedId);
    const custom = state.models.filter(m => !m.builtin && m.id !== derivedId);
    return [head, ...custom];
  }

  defaultId() {
    return String(this.load().defaultId || '');
  }

  /**
   * 提示词优化用的 LLM 选择（设置页里挑）。
   * 存这里而不是 cordis.yml：插件不该写宿主的配置文件（改坏了应用起不来），
   * 而 models.json 本来就是插件私有的可写状态。
   * @returns {{ provider: string, model: string }} 全空 = 跟随当前会话的模型
   */
  getOptimizer() {
    const saved = this.load().optimizer;
    if (!saved || typeof saved !== 'object') return { provider: '', model: '' };
    return { provider: String(saved.provider || ''), model: String(saved.model || '') };
  }

  /**
   * 记住优化模型。只填一半视为清空：llm.stream 要 provider+model 同时才有意义，
   * 留半截会让 resolveOptimizerTarget 走到错误的 provider 上。
   */
  setOptimizer(provider, model) {
    const state = this.load();
    const p = String(provider || '');
    const m = String(model || '');
    state.optimizer = p && m ? { provider: p, model: m } : { provider: '', model: '' };
    this.save();
    return { ok: true, optimizer: { ...state.optimizer } };
  }

  /** 当前生效的模型：默认项 → 内置兜底。返回**带明文密钥**的完整条目。 */
  resolve(builtin, id) {
    const all = this.listRaw(builtin);
    const want = String(id || '').trim();
    if (want) {
      const hit = all.find(m => m.id === want || m.name === want || m.model === want);
      if (hit) return hit;
    }
    const def = this.defaultId();
    if (def) {
      const hit = all.find(m => m.id === def);
      if (hit) return hit;
    }
    return all[0] || normalizeModel(builtin || {}, 'default');
  }

  add(builtin, input) {
    const state = this.load();
    const model = normalizeModel(input, `m-${Date.now().toString(36)}`);
    if (!model.model) return { ok: false, error: '模型名（model）不能为空' };
    if (state.models.some(m => m.id === model.id)) {
      /* 重名兜底：一直加到不重复为止（`m-1` 已存在时不能直接拼成 `m-1-2` 又撞上）。 */
      const base = model.id.replace(/-\d+$/, '');
      let n = 2;
      while (state.models.some(m => m.id === model.id)) model.id = `${base}-${n++}`;
    }
    state.models.push(model);
    if (state.models.length > MAX_MODELS) state.models.splice(0, state.models.length - MAX_MODELS);
    if (!state.defaultId) state.defaultId = model.id;
    this.save();
    /* 明文密钥不回前端：回 publicModel */
    return { ok: true, model: publicModel(model), models: this.list(builtin) };
  }

  /**
   * 更新一条。内置行（default）平时不在 state.models 里，
   * 用户一旦改它就落一条 builtin:true 的覆盖记录（见 listRaw 的合并规则）。
   * apiKey 传空字符串 = 保持原值不变（页面上"留空表示不改"）。
   */
  update(builtin, id, patch) {
    const state = this.load();
    const want = String(id || '');
    const derivedId = safeId((builtin && builtin.id) || '') || 'default';
    let idx = state.models.findIndex(m => m.id === want);
    const current = idx >= 0 ? state.models[idx] : want === derivedId ? { ...builtin, id: derivedId, builtin: true } : null;
    if (!current) return { ok: false, error: `没有找到模型 ${want}` };
    const next = { ...current, ...(patch || {}), id: want };
    /* 留空的密钥 = 不改；显式传 null/undefined 也不改 */
    if (patch && (patch.apiKey === '' || patch.apiKey == null)) next.apiKey = current.apiKey || '';
    const merged = normalizeModel(next, want);
    if (!merged.model) return { ok: false, error: '模型名（model）不能为空' };
    if (idx >= 0) state.models[idx] = merged;
    else state.models.push(merged);
    this.save();
    return { ok: true, model: publicModel(merged), models: this.list(builtin) };
  }

  remove(builtin, id) {
    const state = this.load();
    const want = String(id || '');
    const before = state.models.length;
    state.models = state.models.filter(m => m.id !== want);
    if (state.models.length === before) return { ok: false, error: `没有找到模型 ${want}` };
    if (state.defaultId === want) state.defaultId = state.models[0]?.id || '';
    this.save();
    return { ok: true, models: this.list(builtin), defaultId: state.defaultId };
  }

  /**
   * 设默认模型。必须校验 id 存在：设置页/HTTP 端点传进来的 id 可能过期，
   * 直接写进 defaultId 会让 resolve() 指向一条不存在的模型（表现为"默认项莫名其妙变了"）。
   */
  setDefault(builtin, id) {
    const state = this.load();
    const want = String(id || '');
    if (!this.listRaw(builtin).some(m => m.id === want)) {
      return { ok: false, error: `没有找到模型 ${want}` };
    }
    state.defaultId = want;
    this.save();
    return { ok: true, defaultId: state.defaultId };
  }
}

/**
 * 把 llm 服务返回的 provider / model 目录规整成设置页能渲染的形状。
 * 宿主各版本字段名不完全一致（provider/name/id、model/id/value、baseUrl/url），
 * 所以逐个兜；同时把 baseUrl / 可能的密钥环境变量名带出去，
 * 设置页「从已添加的模型里提取」才能一次填好表单。
 */
export function shapeSources(providerInfos, modelsByProvider) {
  const groups = [];
  for (const info of providerInfos || []) {
    /* provider = 路由 id（llm.stream 只认它）；label = 显示名（给人看）。
       测试桩没有 id 字段时回退到 name，两边同形。 */
    const id = String((info && (info.id || info.provider || info.name)) || '').trim();
    if (!id) continue;
    const name = String((info && (info.name || info.provider || info.id)) || '').trim() || id;
    const baseUrl = String((info && (info.baseUrl || info.baseURL || info.url || info.endpoint)) || '').trim();
    const raw = (modelsByProvider && modelsByProvider[id]) || [];
    const models = [];
    for (const m of raw) {
      const modelId = String((m && (m.model || m.id || m.value || m.name)) || '').trim();
      if (!modelId) continue;
      models.push({ id: modelId, label: String((m && (m.label || m.name || m.title)) || modelId).slice(0, 60) });
    }
    groups.push({
      provider: id,
      label: name,
      baseUrl,
      /* 宿主不把密钥明文交给插件，这里只给出"可能的环境变量名"供用户确认。 */
      apiKeyEnv: String((info && (info.apiKeyEnv || info.keyEnv)) || '').trim() || `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
      models,
    });
  }
  return { groups: groups.filter(g => g.models.length > 0) };
}
