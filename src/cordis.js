/**
 * 宿主半：服务 生图 + 提示词优化 + `/img` 命令 + `generate_image` 工具 + 图片 HTTP 路由。
 *
 * 零外部依赖：只用 node: 内置 + 本包的 imageApi.js / optimize.js / store.js，
 * 不 import 任何 @deepseek-ai/* 宿主包（插件被 pnpm 链接在 profile 目录下，
 * import 宿主包会解析出第二副本，Service 原型链跨副本失效）。全部走 ctx.get(...)。
 *
 * 「只要动画、不要思考」的机制：只有 `generate_image` 一个工具，工具卡在 preparing/start 阶段
 * 就渲染 GridReveal 动画，result 一到动画消失换成图片；工具描述明确要求模型"立刻调用、不写正文、
 * 不输出思考"，因此对话里没有命令、没有多余文字。不再注册任何斜杠命令。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateImages, downloadImage, decodeBase64Image, DEFAULT_BASE_URL, DEFAULT_MODEL, IMAGE_RATIOS, IMAGE_SIZES } from './imageApi.js';
import { resolveOptimizerTarget } from './optimize.js';
import { withPromptEnhancement } from './promptOptimizer.js';
import { ImageGenStore, resolveSecret, slugify, timestampTag } from './store.js';
import { ImageModelRegistry, builtinFromConfig, shapeSources, publicModel, KIND_CHOICES } from './imageModels.js';
import { generateWithModel, probeModel } from './imageProviders.js';

const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const SERVICE = 'imageGen';
const ROUTE_PREFIX = '/image-gen';   // 注意：webServer 的 prefix 是字符串前缀匹配，末尾不能带 '/'

/**
 * 本地栅栏：回环 Host + 非跨站 + Origin 自洽。
 * 挡住两类现实攻击面：① 任意网页拿 <img src="http://127.0.0.1:…/"> 跨站打；
 * ② DNS rebinding（Host 变成 attacker 域名 → 非回环 → 拒）。
 * 它**不校验会话 cookie**（签名密钥在宿主手里），所以用于 /raw 这类
 * "渲染进程要当资源直接加载"的路径 —— 强制要 cookie 一旦碰上某条不带
 * cookie 的加载路径，图片会整片打不开。
 *
 * @returns 状态码；undefined = 放行
 */
export function fenceLocal(req) {
  const headers = (req && req.headers) || {};
  const host = String(headers.host || '');
  if (!host) return 403;
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!loopback) return 403;
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403;
  const origin = headers.origin;
  /* ⚠️ 不给 'null'（不透明源 / sandbox iframe）开口子：攻击者把页面装进 sandbox
     iframe 就会发 Origin: null，而它此时仍是跨站。DSH 渲染进程与本机同源，
     同源资源加载根本不带 Origin 头，所以拒掉 null 不会挡坏正常显示。 */
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return 403;
    } catch {
      return 403;
    }
  }
  return undefined;
}

/**
 * 写端点的栅栏：优先用宿主的 connection.requestRejection()
 * （回环/Host + sec-fetch-site + Origin + **浏览器会话 cookie**，与 /api 同一道），
 * 取不到 connection 时退回本地栅栏。
 *
 * ⚠️ 为什么必须自己挡：插件用 webServer.register() 注册的路由**不经过**宿主鉴权管道
 * （只有 /api 通道走 connection.admit()）。早先这里没挡，实测不带 cookie 就能读模型
 * 配置、GET ?action=remove 改数据、action=probe 白烧生图额度。
 *
 * @returns 状态码；undefined = 放行
 */
export function fenceRequest(connection, req) {
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      return connection.requestRejection(req);
    } catch {
      /* 宿主实现抛错也别放行 */
      return 403;
    }
  }
  return fenceLocal(req);
}

const MEDIA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** mediaType → 文件扩展名；未知类型按 png（附件命名与落盘共用，避免出现 .png 包 jpeg）。 */
function extForMediaType(mediaType) {
  return MEDIA_EXT[String(mediaType || '').toLowerCase()] || 'png';
}

/**
 * 原子落盘：`wx` 标志保证同一秒、同一提示词的两次生成不会互相覆盖，
 * 撞名就换序号（早先是 writeFileSync 直接覆盖，等同于静默丢图）。
 */
function writeUniqueFile(dir, baseName, ext, data) {
  for (let n = 1; n <= 999; n++) {
    const file = join(dir, n === 1 ? `${baseName}.${ext}` : `${baseName}-${n}.${ext}`);
    try {
      writeFileSync(file, data, { flag: 'wx' });
      return file;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`同名文件过多：${baseName}.${ext}`);
}

export const DEFAULT_CONFIG = {
  apiKeyEnv: 'IMAGE_API_KEY',
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  size: '2K',
  ratio: '1:1',
  count: 1,
  timeoutMs: 300000,
  optimize: true,
  /* 提示词增强只该"加料"，不该把整条链路的等待翻倍：超时即跳过、回退原文 */
  optimizeTimeoutMs: 8000,
  /* 0.7 = 创意扩展与结构稳定的折中 */
  optimizeTemperature: 0.7,
  optimizeMaxTokens: 700,
  optimizer: { provider: '', model: '' },
  saveFiles: true,
  saveDir: 'generated-images',
};

function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw || {}) };
  config.optimizer = { provider: '', model: '', ...(raw?.optimizer || {}) };
  config.size = IMAGE_SIZES.includes(String(config.size).toUpperCase()) ? String(config.size).toUpperCase() : DEFAULT_CONFIG.size;
  config.ratio = IMAGE_RATIOS.includes(String(config.ratio)) ? String(config.ratio) : DEFAULT_CONFIG.ratio;
  config.baseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  config.model = String(config.model || '').trim();
  return config;
}

export class ImageGenService {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = normalizeConfig(config);
    this.store = new ImageGenStore();
    /* 图像模型注册表：独立 JSON，绝不注册成 llm 适配器 —— 这样它不可能出现在
       聊天里的模型选择器（modelCatalog 的数据源是 llm 的 provider 目录）。 */
    this.models = new ImageModelRegistry();
    this.stages = new Map();
    // 由 applyCordis 在依赖就绪时回填（apply 当下服务可能尚未注册，ctx.get 会拿到 undefined）
    this.services = { sessions: undefined, attachments: undefined, llm: undefined, agentDefaultModel: undefined, connection: undefined };
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE, namespace: SERVICE });
    /* 提示词前置增强拦截器（装饰器模式）：
       [用户原始输入] → [轻量 LLM 改写] → [generateWithModel] → [图像]
       imageApi.js / imageProviders.js 一行不改，只在调用前换掉 prompt；
       优化失败/超时/输出不像提示词 → 回退原文，绝不影响出图。
       llm 用 getter 惰性取：apply 当下宿主可能还没注册它。 */
    this.generateImage = withPromptEnhancement(
      (model, options) =>
        generateWithModel(model, Object.assign({ apiKey: this.requireKey(model) }, options)),
      {
        getLlm: () => this.pick("llm"),
        log: ctx.logger,
        timeoutMs: this.config.optimizeTimeoutMs,
        temperature: this.config.optimizeTemperature,
        maxTokens: this.config.optimizeMaxTokens,
        /* 画幅要传给优化器：它得按真实比例安排构图与留白 */
        canvas: options => ({ ratio: options.ratio, size: options.size }),
        isEnabled: options => this.config.optimize !== false && !options.noOptimize,
        resolveTarget: options =>
          resolveOptimizerTarget({
            config: this.optimizerConfig(),
            session: options.session,
            defaultSelection: () => this.pick("agentDefaultModel")?.currentSelection?.(),
          }),
      },
    );
  }

  /** 内置条目：由 cordis.yml 里已有的 baseUrl/model/apiKeyEnv 派生，注册表为空时兜底。 */
  get builtinModel() {
    return builtinFromConfig(this.config);
  }

  /**
   * 设置页用的对外列表：剥掉明文密钥（publicModel），并补 keyReady ——
   * 密钥到底能不能解析出来（页面填的 / 条目自己的环境变量 / 插件全局的）。
   * 只看 hasKey 会把「密钥配在环境变量里」的模型误标成没密钥。
   */
  publicList() {
    const builtin = this.builtinModel;
    return this.models.listRaw(builtin).map(model => ({
      ...publicModel(model),
      keyReady: Boolean(this.keyFor(model)),
    }));
  }

  /**
   * 优化用模型的配置来源：设置页选的（存 models.json）优先，
   * 没选就用 cordis.yml 里的 optimizer.*，都没有则跟随当前会话的模型。
   */
  optimizerConfig() {
    const saved = this.models.getOptimizer();
    if (saved.provider && saved.model) return { ...this.config, optimizer: saved };
    return this.config;
  }

  /** 本次生成用哪个图像模型（显式 id > 注册表默认 > 内置）。 */
  pickModel(id) {
    return this.models.resolve(this.builtinModel, id);
  }

  /** 优先用注入就绪的子上下文里的服务，退回 ctx.get。 */
  pick(name) {
    return this.services[name] || this.ctx.get?.(name);
  }

  setStage(commandId, stage) {
    this.stages.set(String(commandId), stage);
    if (this.stages.size > 64) {
      const keys = [...this.stages.keys()];
      for (const key of keys.slice(0, keys.length - 64)) this.stages.delete(key);
    }
  }

  /** Remote：命令卡在运行中的阶段提示。 */
  async progress(query) {
    const commandId = query && typeof query === 'object' ? String(query.commandId || '') : String(query || '');
    return { commandId, stage: this.stages.get(commandId) || null };
  }

  get apiKey() {
    return resolveSecret(this.config.apiKeyEnv);
  }

  /**
   * 取本次生成用的密钥明文，优先级：
   *   1) 设置页里直接填的 apiKey（存在插件自己的 models.json）
   *   2) 条目自己指定的环境变量名 apiKeyEnv（进程环境或 ~/.dsh/.env）
   *   3) 插件全局配置的 apiKeyEnv —— 老用户只配了 IMAGE_API_KEY 时照常能用
   */
  keyFor(model) {
    const direct = String((model && model.apiKey) || '').trim();
    if (direct) return direct;
    const own = resolveSecret(model && model.apiKeyEnv);
    return own || this.apiKey;
  }

  /** 没有密钥时给一条能照着做的错误，别让请求打到上游再报 401。 */
  requireKey(model) {
    const key = this.keyFor(model);
    if (!key) {
      throw new Error(
        `图像模型「${model.name || model.model}」还没有 API 密钥：请到 设置 · 图像模型 里填写密钥` +
          `（或配置环境变量 ${model.apiKeyEnv || 'IMAGE_API_KEY'}）`,
      );
    }
    return key;
  }

  /** 优化 + 生成 + 落地。供工具 execute 使用。 */
  async run(request) {
    const { prompt, size, ratio, count, noOptimize, asBase64, sessionId, signal, onStage, model: modelWanted } = request;
    const started = Date.now();
    if (!String(prompt || '').trim()) {
      throw new Error('请给出提示词，例如：一只趴在窗台的橘猫，午后阳光');
    }
    const stage = name => {
      if (typeof onStage === 'function') {
        try {
          onStage(name);
        } catch {
          /* 进度回调失败不影响主流程 */
        }
      }
    };

    const sessions = this.pick('sessions');
    const session = sessionId ? sessions?.get?.(sessionId) : undefined;

    stage('generate');
    const startedAt = Date.now();
    /* 图像模型来自注册表（设置页里管理）：没选就是默认项，再兜回内置那条。
       档位/比例没显式传时用该模型自己的默认值，而不是插件全局配置。
       generateImage 是装饰过的：进这里之前先做提示词增强，阶段由拦截器自己上报。 */
    const chosen = this.pickModel(modelWanted);
    /* 三个参数各解析一次就复用：上报给卡片的 api 必须和真正发出去的一致
       （早先 api.size 用的是 `size || chosen.size`，回退到全局配置时会上报 undefined）。 */
    const usedSize = size || chosen.size || this.config.size;
    const usedRatio = ratio || chosen.ratio || this.config.ratio;
    const usedCount = count || this.config.count;
    const result = await this.generateImage(chosen, {
      prompt,
      size: usedSize,
      ratio: usedRatio,
      count: usedCount,
      asBase64: !!asBase64,
      signal,
      session,
      noOptimize,
      onStage: stage,
    });
    /* 增强结果（via/ms/raw→optimized）由拦截器挂在增量字段上 */
    const optimized = result.optimization || { prompt, optimized: false, via: 'none', ms: 0 };
    const optimizeMs = optimized.ms || 0;
    const generateMs = Math.max(0, Date.now() - startedAt - optimizeMs);

    stage('save');
    const attachments = this.pick('attachments');
    const cwd = session?.header?.cwd;
    const stamp = timestampTag();
    const slug = slugify(optimized.prompt);
    const files = [];
    const images = [];
    const failures = [];
    /* 每张图独立失败：多图里坏一张不该把已经生成好的其余图片一起丢掉（生图很贵）。 */
    for (let index = 0; index < result.images.length; index++) {
      const item = result.images[index];
      try {
        const bytes = item.base64 ? decodeBase64Image(item.base64) : await downloadImage(item.url, { signal });
        const baseName = `${stamp}-${slug}${result.images.length > 1 ? `-${index + 1}` : ''}`;
        const ext = extForMediaType(bytes.mediaType);
        /* 附件保存单独兜底：宿主在"声明的类型与字节不符 / 超出大小上限"时会抛错，
           此时图其实已经生成好了，不能因此让整次调用失败 —— 还有落盘与 /raw 兜着。 */
        let ref = null;
        if (attachments?.saveImage) {
          try {
            ref = await attachments.saveImage({ data: bytes.data, mediaType: bytes.mediaType, name: `${baseName}.${ext}` });
          } catch (error) {
            ref = null;
            this.ctx?.logger?.warn?.(`[image-gen] 附件保存失败，已跳过附件：${error?.message || error}`);
          }
        }
        let file = null;
        if (this.config.saveFiles !== false && cwd) {
          try {
            const dir = join(cwd, this.config.saveDir || DEFAULT_CONFIG.saveDir);
            mkdirSync(dir, { recursive: true });
            file = writeUniqueFile(dir, baseName, ext, bytes.data);
            files.push(file);
          } catch (error) {
            file = null;
            this.ctx?.logger?.warn?.(`[image-gen] 写入生成图失败：${error?.message || error}`);
          }
        }
        images.push({
          index,
          width: ref?.width ?? 0,
          height: ref?.height ?? 0,
          bytes: bytes.data.length,
          mediaType: bytes.mediaType,
          attachment: ref,
          file,
        });
      } catch (error) {
        failures.push({ index, error: String(error?.message || error) });
      }
    }
    if (images.length === 0) {
      throw new Error(failures.map(f => f.error).filter(Boolean).join('；') || '图片全部保存失败');
    }

    return {
      prompt,
      optimizedPrompt: optimized.prompt,
      optimizer: { via: optimized.via, provider: optimized.target?.provider, model: optimized.target?.model, error: optimized.error, ms: optimized.ms },
      api: { model: chosen.model, name: chosen.name, kind: chosen.kind, baseUrl: chosen.baseUrl, size: usedSize, ratio: usedRatio, count: images.length },
      images,
      files,
      failures,
      ms: { optimize: optimizeMs, generate: generateMs, total: Date.now() - started },
    };
  }

  /** Remote：命令卡渲染用的一次性记录。 */
  async result(query) {
    const commandId = query && typeof query === 'object' ? String(query.commandId || '') : String(query || '');
    const record = this.store.get(commandId);
    if (!record) return { found: false, commandId };
    return {
      found: true,
      commandId: record.commandId,
      createdAt: record.createdAt,
      prompt: record.prompt,
      optimizedPrompt: record.optimizedPrompt,
      optimizer: record.optimizer,
      api: record.api,
      ms: record.ms,
      files: record.files,
      error: record.error || null,
      images: (record.images || []).map(img => ({
        index: img.index,
        width: img.width,
        height: img.height,
        bytes: img.bytes,
        mediaType: img.mediaType,
        url: `${ROUTE_PREFIX}/raw/${encodeURIComponent(record.commandId)}/${img.index}`,
        file: img.file || null,
      })),
    };
  }

  /** Remote：最近若干次生成。 */
  async recent(query) {
    const limit = query && typeof query === 'object' ? Number(query.limit) : Number(query);
    return {
      items: this.store.recent(Number.isFinite(limit) ? limit : 20).map(record => ({
        commandId: record.commandId,
        createdAt: record.createdAt,
        optimizedPrompt: record.optimizedPrompt,
        count: (record.images || []).length,
        files: record.files || [],
      })),
    };
  }

  /**
   * Remote：设置页「图像模型」的唯一入口。
   *
   * 一个方法承载所有动作（action 分发），而不是每件事一个 remote —— 少一个描述符
   * 就少一处激活失败的机会（宿主对客户端半的激活是致命的，见 README 踩坑 #11）。
   *
   * action:
   *   list     → { models, defaultId, builtin }
   *   sources  → { groups: [{ provider, models: [{ id, label }] }] }  「已添加的模型列表」
   *   add      → { ok, model, models }
   *   update   → { ok, model, models }
   *   remove   → { ok, models, defaultId }
   *   default  → { ok, defaultId, models }
   *   probe    → { ok, ms, images } | { ok:false, error }
   */
  async modelsAdmin(query) {
    const req = query && typeof query === 'object' ? query : {};
    const action = String(req.action || 'list');
    const builtin = this.builtinModel;
    const snapshot = () => ({
      models: this.publicList(),
      defaultId: this.models.defaultId(),
      builtin,
      kinds: KIND_CHOICES,
      sizes: IMAGE_SIZES,
      ratios: IMAGE_RATIOS,
      /* 设置页的「提示词优化模型」下拉：当前选择 + 可选的轻量 LLM 列表 */
      optimizer: this.models.getOptimizer(),
      optimizeOn: this.config.optimize !== false,
    });

    switch (action) {
      case 'list':
        return { ok: true, ...snapshot() };
      case 'sources':
        return { ok: true, ...(await this.modelSources()) };
      case 'add':
        return { ...this.models.add(builtin, req.input), ...snapshot() };
      case 'update':
        return { ...this.models.update(builtin, req.id, req.patch || req.input), ...snapshot() };
      case 'remove': {
        const res = this.models.remove(builtin, req.id);
        return { ...res, ...snapshot() };
      }
      case 'setOptimizer':
        /* provider+model 成对存；只填一半按"清空"处理（见 registry.setOptimizer） */
        return { ...this.models.setOptimizer(req.provider, req.model), ...snapshot() };
      case 'default': {
        const res = this.models.setDefault(builtin, req.id);
        return { ...res, ...snapshot() };
      }
      case 'probe': {
        /* 必须用 listRaw：list() 是对外形状，明文密钥已被剥掉，探测会拿不到 key */
        const model = this.models.listRaw(builtin).find(m => m.id === String(req.id || ''));
        if (!model) return { ok: false, error: `没有找到模型 ${req.id}` };
        try {
          return await probeModel(model, { apiKey: this.requireKey(model) });
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }
      default:
        return { ok: false, error: `未知动作 ${action}` };
    }
  }

  /**
   * 「从已经添加的列表里提取」：读 llm 的 provider 目录 + 各 provider 的模型列表。
   * 只读不改 —— 图像模型绝不注册回 llm，所以它不会出现在聊天的模型选择器里。
   */
  async modelSources() {
    const llm = this.pick('llm');
    if (!llm || typeof llm.listProviders !== 'function') return { groups: [], unavailable: 'llm 服务尚未就绪' };
    let providers = [];
    try {
      providers = llm.listProviders() || [];
    } catch (error) {
      return { groups: [], unavailable: String(error?.message || error) };
    }
    /* ⚠️ listModels/listModels/stream 收的都是**路由 id**；LlmProviderInfo.name 只是
       显示名（"DeepSeek Account"）。拿显示名去查会全部落空（实测 groups 为空）。 */
    const routes = providers
      .map(p => ({
        id: String((p && (p.id || p.provider || p.name)) || '').trim(),
        name: String((p && (p.name || p.provider || p.id)) || '').trim(),
      }))
      .filter((r, i, all) => r.id && all.findIndex(x => x.id === r.id) === i);
    const modelsByProvider = {};
    if (typeof llm.listModels === 'function') {
      await Promise.all(
        routes.map(async route => {
          try {
            modelsByProvider[route.id] = (await llm.listModels(route.id)) || [];
          } catch {
            modelsByProvider[route.id] = [];
          }
        }),
      );
    }
    return { names: routes.map(r => r.name), ...shapeSources(providers, modelsByProvider) };
  }

  /** 供 HTTP 路由使用：按 commandId + index 取原图字节。 */
  async readImage(commandId, index) {
    const record = this.store.get(commandId);
    if (!record) return null;
    const image = (record.images || [])[index];
    if (!image) return null;
    if (image.file) {
      try {
        const { readFileSync } = await import('node:fs');
        return { data: new Uint8Array(readFileSync(image.file)), mediaType: image.mediaType };
      } catch {
        /* 落盘文件被删则退回附件 */
      }
    }
    const attachments = this.pick('attachments');
    if (attachments?.readImage && image.attachment) {
      const stored = await attachments.readImage(image.attachment);
      return { data: stored.data, mediaType: stored.ref?.mediaType || image.mediaType };
    }
    return null;
  }

  /** 记录一次生成（命令 handler 与工具共用）。 */
  remember(commandId, sessionId, result, error) {
    const record = {
      commandId,
      sessionId: sessionId || null,
      createdAt: Date.now(),
      prompt: result?.prompt ?? '',
      optimizedPrompt: result?.optimizedPrompt ?? '',
      optimizer: result?.optimizer ?? null,
      api: result?.api ?? null,
      ms: result?.ms ?? null,
      files: result?.files ?? [],
      images: (result?.images ?? []).map(img => ({
        index: img.index,
        width: img.width,
        height: img.height,
        bytes: img.bytes,
        mediaType: img.mediaType,
        attachment: img.attachment,
        file: img.file,
      })),
      error: error ? String(error) : null,
    };
    return this.store.remember(record);
  }
}

/** 手写 SRC Remote 标记（形态 = typert-protocol mark() 产物）。 */
Object.defineProperty(ImageGenService.prototype, REMOTE_METHODS_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'result', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'recent', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'progress', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'modelsAdmin', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
});

export const name = 'image-gen';
export const inject = [];

/**
 * 取服务：apply 当下目标服务可能还没注册（ctx.get 得到 undefined），
 * 所以用 Cordis 的 `ctx.inject(deps, child => …)` —— 依赖齐了才回调，回调拿到带依赖的子上下文。
 * 同时把子上下文里的服务回填给 ImageGenService，供运行时（命令 handler / 工具 execute）使用。
 */
function wire(ctx, deps, run) {
  const deliver = child => {
    try {
      run(child);
    } catch (error) {
      ctx.logger?.warn?.(`[image-gen] 挂载 ${deps.join(',')} 失败：${error?.message || error}`);
    }
  };
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(deps, deliver);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`[image-gen] inject(${deps.join(',')}) 失败：${error?.message || error}`);
    }
  }
  return false;
}

export function applyCordis(ctx, config) {
  const service = new ImageGenService(ctx, config || {});

  ctx.reflect.provide(SERVICE, service);

  // 运行时服务：命令 handler 里要用（会话、附件、llm、默认模型）
  wire(ctx, ['sessions'], child => {
    service.services.sessions = child.sessions;
  });
  wire(ctx, ['attachments'], child => {
    service.services.attachments = child.attachments;
  });
  wire(ctx, ['llm'], child => {
    service.services.llm = child.llm;
  });
  wire(ctx, ['agentDefaultModel'], child => {
    service.services.agentDefaultModel = child.agentDefaultModel;
  });
  /* 宿主的会话鉴权服务：/models 写端点必须用它（requestRejection）而不是只验回环。
     拿不到时 fenceRequest 会静默退化为仅本地栅栏 —— 所以显式注入，别靠 ctx.get 碰运气。 */
  wire(ctx, ['connection'], child => {
    service.services.connection = child.connection;
  });
  wire(ctx, ['sessions', 'attachments'], () => {
    ctx.logger?.info?.('[image-gen] 会话与附件服务已就绪');
  });
  // 不再注册斜杠命令：生图完全由对话里的 generate_image 工具触发，
  // 工具卡在 preparing/start 阶段就渲染 GridReveal 动画，出图后动画消失换成图片。
  wire(ctx, ['tools'], child => {
    child.tools.register({
      name: 'generate_image',
      description:
        '用 图像模型生成图片。用户要求画图/生图/配图/出海报时——包括只说“只生成图片”——必须**立刻调用本工具**：不要写任何正文，不要输出思考或计划，不要反问确认，参数从用户的话里直接取。' +
        '工具内部会自动把提示词优化后再送模型，所以你不需要替用户润色提示词。调用之后这一轮就结束了：不要再补任何总结文字（不要写“已生成几张”“画面/规格/文件”之类），聊天里只该出现生成动画和图片本身。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要生成的画面描述，直接采用用户给的画面内容（可原样照抄，不必润色）' },
          size: { type: 'string', enum: IMAGE_SIZES, description: '输出档位，默认 2K' },
          ratio: { type: 'string', enum: IMAGE_RATIOS, description: '宽高比，默认 1:1' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            optimizedPrompt: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, value) => {
          const blocks = [{ type: 'text', text: String(value?.summary || '已生成图片') }];
          for (const image of value?.images || []) {
            if (image.attachment) blocks.push({ type: 'image', attachment: image.attachment });
          }
          return blocks;
        },
        presentationMeta: (args, value) => ({
          summary: String(value?.summary || ''),
          optimizedPrompt: String(value?.optimizedPrompt || ''),
          files: Array.isArray(value?.files) ? value.files : [],
        }),
      },
      execute: async (args, exec) => {
        const input = args || {};
        const callId = String(exec?.callId || `tool-${Date.now()}`);
        // 进度按 callId 记（命令卡/工具卡可轮询）
        const onStage = stage => service.setStage(callId, stage);
        // 出图后直接结束这一轮：模型不会再补一段"已生成…画面/规格/文件"的文字
        try {
          exec?.concludeTurn?.();
        } catch {
          /* 没有这个能力时照常走 */
        }
        onStage('optimize');
        try {
          const result = await service.run({
            prompt: input.prompt,
            size: input.size,
            ratio: input.ratio,
            sessionId: exec?.agent?.id,
            signal: exec?.signal,
            onStage,
          });
          service.remember(callId, exec?.agent?.id, result, null);
          return {
            summary: `已生成 ${result.images.length} 张图片（${(result.ms.total / 1000).toFixed(1)}s）`,
            optimizedPrompt: result.optimizedPrompt,
            files: result.files,
            images: result.images.map(img => ({
              attachment: img.attachment,
              width: img.width,
              height: img.height,
              url: `/image-gen/raw/${encodeURIComponent(callId)}/${img.index}`,
            })),
          };
        } catch (error) {
          service.remember(callId, exec?.agent?.id, null, error?.message || error);
          throw error;
        }
      },
    });
  });

  wire(ctx, ['webServer'], child => {
    child.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        /* 请求目标必须是 origin-form（`/path`）。allow absolute-form（`GET http://host/path`）
           会让"前缀判定"与"URL 解析"看到两个不同的路径：前缀判定拿到的 req.url 以
           `http://` 开头 → 落到只验回环的分支，而下面 new URL() 解析出的 pathname 仍是
           `/image-gen/models` → 写端点照常执行。本机任意进程/curl 都能这么绕过 cookie 校验，
           而这条端点的卖点恰恰是"要会话 cookie"，所以直接拒掉非 origin-form。 */
        const rawUrl = String(req.url || '/');
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('bad request-target');
          return;
        }
        let url;
        try {
          url = new URL(rawUrl, 'http://127.0.0.1');
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('bad request-target');
          return;
        }
        /* 两档栅栏（判定用解析后的 pathname，不再用原始 req.url 前缀）：
           · /raw   —— 渲染进程要当图片资源直接加载，只过本地栅栏（回环+非跨站+Origin）。
                        强制要会话 cookie 有整片打不开图的风险（某条加载路径不带 cookie）。
           · /models —— 会改配置、会花钱（probe 真调服务），必须过宿主的完整鉴权。
           ⚠️ 插件自注册的 webServer 路由**不经过**宿主鉴权管道（/api 通道才走
           connection.admit()）。早先这里完全没挡，实测不带 cookie 即可读模型配置、
           GET ?action=remove 改数据、action=probe 白烧额度，甚至能 add 一个 baseUrl
           指向攻击者服务器的模型并设为默认——之后每次生图，真实 API key 会被当
           Bearer 发出去。 */
        const isModels = url.pathname === `${ROUTE_PREFIX}/models`;
        const rejection = isModels ? fenceRequest(service.pick('connection'), req) : fenceLocal(req);
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : 'unauthorized');
          return;
        }
        try {
          /* 设置页 · 图像模型：走 HTTP 而不是 Remote。
             客户端半要拿到 remote.imageGen 必须把它写进 inject 名单，而 inject 里
             任何一项缺失都会让条目激活失败 → 整个桌面端起不来（README 踩坑 #11）。
             这个端点读写插件自己的 models.json（含密钥与环境变量名）。 */
          if (url.pathname === '/image-gen/models') {
            let query = {};
            if (req.method === 'POST') {
              /* 写操作要求 JSON content-type：浏览器发 application/json 必然先过 CORS
                 预检，跨站页面伪造不出来（它只能发 text/plain 这类"简单请求"）。
                 与上面的 Origin 栅栏叠加，才堵得住 CSRF。 */
              const ctype = String(req.headers['content-type'] || '');
              if (!ctype.includes('application/json')) {
                res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ ok: false, error: '需要 application/json 请求体' }));
                return;
              }
              /* 边读边计数：先 Buffer.concat 再判大小等于把整个请求体读进内存后才拒绝，
                 上限就形同虚设。超限立刻回 413 并断开。 */
              const chunks = [];
              let total = 0;
              for await (const chunk of req) {
                total += chunk.length;
                if (total > 64 * 1024) {
                  res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                  res.end(JSON.stringify({ ok: false, error: '请求体过大' }));
                  req.destroy?.();
                  return;
                }
                chunks.push(chunk);
              }
              const text = Buffer.concat(chunks).toString('utf8');
              try {
                query = text ? JSON.parse(text) : {};
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }));
                return;
              }
            } else {
              /* GET 只许读。之前 GET ?action=remove 也会执行写操作 ——
                 一张 <img src="…?action=probe&id=…"> 就能跨站触发（还会烧额度）。 */
              const action = url.searchParams.get('action') || 'list';
              if (action !== 'list' && action !== 'sources') {
                res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
                res.end(JSON.stringify({ ok: false, error: '该动作需要 POST' }));
                return;
              }
              query = { action };
            }
            const result = await service.modelsAdmin(query);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(result));
            return;
          }

          /* 等待框的阶段文字：客户端轻量轮询这个只读端点（不经 remote，免 inject）。
             只暴露 stage 名（optimize/generate/save），无敏感数据；栅栏同 /raw。 */
          const stageMatch = /^\/image-gen\/stage\/([^/]+)$/.exec(url.pathname);
          if (stageMatch) {
            const stage = service.stages.get(decodeURIComponent(stageMatch[1])) || null;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, stage }));
            return;
          }

          const match = /^\/image-gen\/raw\/([^/]+)\/(\d+)$/.exec(url.pathname);
          if (!match) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
          }
          const image = await service.readImage(decodeURIComponent(match[1]), Number(match[2]));
          if (!image) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('image not found');
            return;
          }
          const body = Buffer.from(image.data);
          res.writeHead(200, {
            'Content-Type': image.mediaType,
            'Content-Length': String(body.length),
            'Cache-Control': 'private, max-age=31536000, immutable',
          });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch (error) {
          /* 已经发过 200/图片头之后再 writeHead 会抛 ERR_STREAM_WRITE_AFTER_END，
             异常会从路由里再抛出去；这里只补结束，不再改响应。 */
          if (res.headersSent) {
            res.end();
            return;
          }
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`image route failed: ${error?.message || error}`);
        }
      },
    });
  });

  ctx.logger?.info?.(`[image-gen] generate_image 工具与 ${SERVICE} remote 已就绪（模型 ${service.config.model}，默认 ${service.config.size} ${service.config.ratio}）`);
  return service;
}

export default { name, inject, apply: applyCordis };
export { ImageGenService as Service };
