/** 生成结果索引：commandId → 记录（提示词、优化结果、附件引用、落盘文件）。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const MAX_RECORDS = 300;

export function cacheDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'cache', 'dsh-image-gen');
}

export class ImageGenStore {
  constructor(dir = cacheDir()) {
    this.dir = dir;
    this.file = join(dir, 'index.json');
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    let state = { version: 1, records: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object') state = parsed;
    } catch {
      /* 首次运行或文件损坏：从空索引开始 */
    }
    this.state = state;
    return state;
  }

  save() {
    const state = this.load();
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      /* 索引写失败不影响生成结果本身 */
    }
  }

  remember(record) {
    const state = this.load();
    state.records[record.commandId] = record;
    const ids = Object.keys(state.records);
    if (ids.length > MAX_RECORDS) {
      ids.sort((a, b) => (state.records[a].createdAt || 0) - (state.records[b].createdAt || 0));
      for (const id of ids.slice(0, ids.length - MAX_RECORDS)) delete state.records[id];
    }
    this.save();
    return record;
  }

  get(commandId) {
    return this.load().records[String(commandId)] || null;
  }

  recent(limit = 20) {
    const state = this.load();
    return Object.values(state.records)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }
}

/** 从 $DSH_HOME/.env 或进程环境变量里取密钥（宿主进程可能在 .env 之前就启动了）。 */
export function resolveSecret(envName) {
  const name = String(envName || '').trim();
  if (!name) return '';
  const fromEnv = (process.env[name] || '').trim();
  if (fromEnv) return fromEnv;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  try {
    const text = readFileSync(join(home, '.env'), 'utf8');
    return parseEnvValue(text, name);
  } catch {
    /* 没有 .env 就走空 */
  }
  return '';
}

/**
 * 按行解析 .env 取一个变量。不用拼正则：
 * 变量名来自设置页（用户可以随便填），拼进正则会把 `A(` 之类变成语法错误、
 * 把 `.*` 变成通配。顺带支持 `export KEY=...`、行尾注释与成对引号。
 */
export function parseEnvValue(text, name) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (key !== name) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1$/s.exec(value);
    if (quoted) return quoted[2].trim();
    /* 未加引号：`KEY=abc # 备注` 只取 # 之前的部分（# 前面要有空白才算注释） */
    value = value.replace(/\s+#.*$/, '').trim();
    return value;
  }
  return '';
}

/** 生成文件名用的安全 slug。 */
export function slugify(text, max = 40) {
  const cleaned = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
  const ascii = cleaned.replace(/[^\w\u4e00-\u9fa5-]/g, '');
  return (ascii || 'image').slice(0, max);
}

export function timestampTag(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
}
