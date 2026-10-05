// dsh-proxy-routes —— DSH 代理路由插件：按「提供商（账号）」分流，支持命名代理池。
//
// 配置来源（优先级从高到低）：
//   1. 配置文件（$DSH_HOME/proxy-routes.jsonc，JSONC 语法，保存热生效）—— v0.2
//      及以前用户的既有入口；存在即生效，设置页卡片提供一键迁移
//   2. DSH settings：dsh 0.1.5 为 seam.register() 命名空间；dsh 0.1.7 起改为
//      「从插件导出的 Config schema 派生」——本插件导出 volatile 字段的 Config，
//      官方设置表单可直接编辑，卡片保存走 SettingsForms.mutate（同一 op 协议）
//
// 路由语义（v0.4.1）：每个 LLM 请求都会带上其提供商的 API 密钥头
// （x-api-key / authorization: Bearer），fetch 补丁据此刻意识别「本次请求属于
// 哪个提供商（账号）」，实现同一域名下多账号走不同代理——这是域名规则做不到
// 的（v0.4.1 起按域名分流已整体移除）。优先级：提供商显式走向 > 默认走向。
// 旧版「按模型」的 modelRoutes 在归一化时自动迁移为按提供商（取前缀）。
//
// 传输层（transport.mjs）：DSH 自带 undici——Socks5ProxyAgent（socks5h 语义，
// 域名在代理端解析）/ ProxyAgent（http(s):// CONNECT，代理端 TLS + 认证），
// 按代理 URL 池化 dispatcher；不触碰全局 dispatcher，与官方 dsh-http-proxy、
// 其他代理插件互不抢占。fetch 补丁保留 v0.2 形态（dshProxyRoutedFetch）。
//
// 桥接（bridge）：第三方 settings namespace 不被 rc.6 apiproxy 白名单透出，
// 因此像 dsh-llm-proxy 一样在本机回环上自设同源 HTTP 桥
// （/api/dsh-proxy-routes/settings/{describe,mutate,models,test,migrate}），
// 走官方 settings seam 校验/持久化/事件。仅本机可访问。
//
// 注意：schemastery 在模块顶层静态导入（export const Config 需要在加载期就绪）。
// 静态 import 不含顶层 await，不影响桌面版 require(esm) 桥（v0.3.1 的教训只针对 TLA）。

import { readFile } from 'node:fs/promises';
import { existsSync, watch, watchFile, unwatchFile } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import Schema from '@deepseek-ai/schemastery';
import { ensureTransport, getUndici, normalizeProxyUrl, DispatcherPool, probeVia } from './transport.mjs';
import { ensurePiAiCatalog, listModels } from './catalog.mjs';

const name = 'dsh-proxy-routes';
const inject = [];

const TAG = '[proxy-routes]';
const NAMESPACE = 'proxy-routes';
const BRIDGE_PREFIX = '/api/dsh-proxy-routes/settings';

/* ------------------------------------------------------------------ */
/* 配置归一化（jsonc 文件值与 settings 值共用）                          */
/* ------------------------------------------------------------------ */

/**
 * 把原始配置对象（文件或 settings）归一化为内部形态。结构性问题抛错。
 * @param {unknown} raw 原始值
 * @param {string} label 出错信息里的来源描述
 */
function normalizeRawConfig(raw, label) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${TAG} ${label} 的根必须是对象`);
	}
	// 代理池：名字 → 归一化 URL
	const proxies = new Map();
	const rawProxies = typeof raw.proxies === 'object' && raw.proxies !== null && !Array.isArray(raw.proxies) ? raw.proxies : {};
	for (const [proxyName, url] of Object.entries(rawProxies)) {
		if (typeof url !== 'string' || url.trim() === '') throw new Error(`${TAG} ${label} 的 proxies["${proxyName}"] 必须是代理地址字符串`);
		proxies.set(proxyName, normalizeProxyUrl(url, `${TAG} ${label} 的 proxies["${proxyName}"]`));
	}
	// 单代理（v0.2 兼容）：相当于池里的 'default'
	let singleProxy = null;
	const singleRaw = typeof raw.singleProxy === 'string' && raw.singleProxy.trim() !== ''
		? raw.singleProxy
		: (typeof raw.proxy === 'string' && raw.proxy.trim() !== '' ? raw.proxy : null);
	if (singleRaw !== null) {
		singleProxy = normalizeProxyUrl(singleRaw, `${TAG} ${label} 的 "singleProxy"`);
		if (!proxies.has('default')) proxies.set('default', singleProxy);
	}
	// 默认走向
	const defaultVia = raw.default === undefined ? 'direct' : String(raw.default);
	// v0.4.1：按域名分流（routes）已整体移除——旧配置里的 routes 字段直接忽略
	// 按提供商路由（v0.4）：providerId → via。同域名的不同账号可走不同代理。
	const providerRoutes = {};
	if (raw.providerRoutes !== undefined) {
		if (typeof raw.providerRoutes !== 'object' || raw.providerRoutes === null || Array.isArray(raw.providerRoutes)) {
			throw new Error(`${TAG} ${label} 的 "providerRoutes" 必须是 providerId → 代理名/direct 的对象`);
		}
		Object.assign(providerRoutes, raw.providerRoutes);
	}
	// 按模型路由（v0.3 遗留）：自动迁移为按提供商——取 "providerId/modelId" 的前缀
	const modelRoutes = {};
	if (raw.modelRoutes !== undefined) {
		if (typeof raw.modelRoutes !== 'object' || raw.modelRoutes === null || Array.isArray(raw.modelRoutes)) {
			throw new Error(`${TAG} ${label} 的 "modelRoutes" 必须是 modelKey → 代理名/direct 的对象`);
		}
		Object.assign(modelRoutes, raw.modelRoutes);
	}
	for (const [key, via] of Object.entries(modelRoutes)) {
		const slash = key.indexOf('/');
		const pid = slash > 0 ? key.slice(0, slash) : '';
		if (pid && providerRoutes[pid] === undefined) providerRoutes[pid] = via;
	}
	for (const [pid, via] of Object.entries(providerRoutes)) {
		if (typeof via !== 'string' || via.trim() === '') delete providerRoutes[pid];
	}
	return {
		proxies,
		singleProxy,
		defaultVia,
		providerRoutes,
		modelRoutes,
		logRequests: raw.logRequests !== false,
		probeUrl: typeof raw.probeUrl === 'string' && raw.probeUrl.trim() !== '' ? raw.probeUrl.trim() : 'https://www.gstatic.com/generate_204',
	};
}

/**
 * 解析一个 via 值：'direct' | 'proxy'（单代理）| 代理池中的名字。
 * @returns {{kind: 'direct'} | {kind: 'proxy', name: string, url: URL}} 未知名字抛错
 */
function resolveVia(via, cfg, label) {
	if (via === 'direct') return { kind: 'direct' };
	if (via === 'proxy') {
		if (cfg.singleProxy) return { kind: 'proxy', name: '(default)', url: cfg.singleProxy };
		throw new Error(`${TAG} ${label} via="proxy" 但未配置单代理 "proxy" 字段`);
	}
	const url = cfg.proxies.get(via);
	if (url) return { kind: 'proxy', name: via, url };
	throw new Error(`${TAG} ${label} 引用了未知的代理 "${via}"（不在 proxies 池中）`);
}

/**
 * 编译路由决策表（v0.4.1：域名规则已移除，未命中提供商的一切流量走默认走向），
 * 以及 providerId → via 决策表（fetch 层按请求密钥识别提供商后使用，
 * 同域名多账号可各自分流）。
 * @param {object} cfg normalizeRawConfig 的输出
 * @returns {{decide: () => {kind:'direct'} | {kind:'proxy', name: string, url: URL},
 *            providerDecisions: Map<string, {kind:'direct'} | {kind:'proxy', name: string, url: URL}>,
 *            unknownProxies: string[]}}
 */
function compileRouting(cfg) {
	const unknownProxies = [];
	// 预检所有 via 的可解析性（未知代理名记警告，路由时按 direct 兜底）
	const checked = new Map();
	const checkVia = (via, where) => {
		if (checked.has(via)) return checked.get(via);
		let result;
		try {
			result = resolveVia(via, cfg, where);
		} catch (err) {
			unknownProxies.push(err.message);
			result = { kind: 'direct' };
		}
		checked.set(via, result);
		return result;
	};
	const defaultDecision = checkVia(cfg.defaultVia, 'default');
	const decide = () => defaultDecision;
	const providerDecisions = new Map();
	for (const [pid, via] of Object.entries(cfg.providerRoutes ?? {})) {
		providerDecisions.set(pid, checkVia(via, `providerRoutes[${pid}]`));
	}
	return { decide, providerDecisions, unknownProxies };
}

/* ------------------------------------------------------------------ */
/* JSONC 文件支持（v0.2 兼容）                                          */
/* ------------------------------------------------------------------ */

/** 剥离 JSON 文本中的 // 与 /* 注释（字符串内部的不受影响）。 */
function stripJsonComments(text) {
	let out = '';
	let i = 0;
	let inString = false;
	let escaped = false;
	while (i < text.length) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i += 1;
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i += 1;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
			i += 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* 日志                                                                 */
/* ------------------------------------------------------------------ */

/**
 * DSH 的 Cordis logger（ctx.logger）默认只写进内存环形缓冲——既不落到控制台、
 * 也不在 Web UI 显示，所以本插件的日志直接写真实控制台（`dsh web` 所在的
 * PowerShell 窗口；DSH Desktop 场景写入 %APPDATA%/DSH Desktop/logs/host/），
 * 同时镜像一份到 ctx.logger（测试脚本靠它捕获日志）。
 */
function makeLogger(ctx) {
	const inner = ctx && ctx.logger && typeof ctx.logger.info === 'function' ? ctx.logger : null;
	const emit = (level, method) => (...args) => {
		try { console[method](...args); } catch { /* ignore */ }
		if (inner) {
			try { inner[level](...args); } catch { /* ignore */ }
		}
	};
	return {
		info: emit('info', 'log'),
		warn: emit('warn', 'warn'),
		error: emit('error', 'error'),
	};
}

/* ------------------------------------------------------------------ */
/* 主体                                                                 */
/* ------------------------------------------------------------------ */

/**
 * **本模块不得有顶层 await**：DSH 桌面版经 require 桥加载插件（cordis-plugin-loader
 * 的 internal.import），含 TLA 的 ESM 图会抛 ERR_REQUIRE_ASYNC_MODULE，loader 收到
 * 空对象后在启动期报 "invalid plugin"（v0.3.0 因此导致桌面版启动错误循环）。
 * 所有动态 import（undici / schemastery / pi-ai 目录）都在 async apply 内完成。
 */

/**
 * 条目 Config schema（dsh 0.1.7+）：导出后官方设置从它派生我们的表单，卡片
 * 保存走 SettingsForms.mutate。可在线编辑的字段标记 `.volatile()`（SettingsForms
 * 只接受 volatile 路径的写入），值在 apply 里以引用形式到达，用 `.get()` 解包。
 * configFile / trustedOrigins 不标 volatile：改动它们本来就该重挂载。
 */
const CONFIG_FIELDS = {
	configFile: Schema.string().default(''),
	trustedOrigins: Schema.array(Schema.string()).default([]),
	proxies: Schema.dict(Schema.string()).default({}).volatile(),
	singleProxy: Schema.string().default('').volatile(),
	default: Schema.string().default('direct').volatile(),
	providerRoutes: Schema.dict(Schema.string()).default({}).volatile(),
	modelRoutes: Schema.dict(Schema.string()).default({}).volatile(),
	logRequests: Schema.boolean().default(true).volatile(),
	probeUrl: Schema.string().default('https://www.gstatic.com/generate_204').volatile(),
};
export const Config = Schema.object(CONFIG_FIELDS);

/** 0.1.5 的 seam.register() 通道用同一套字段（不带 volatile：旧版无热更语义）。 */
function makeRegisterSchema() {
	return Schema.object({
		singleProxy: Schema.string().default(''),
		proxies: Schema.dict(Schema.string()).default({}),
		default: Schema.string().default('direct'),
		providerRoutes: Schema.dict(Schema.string()).default({}),
		modelRoutes: Schema.dict(Schema.string()).default({}),
		logRequests: Schema.boolean().default(true),
		probeUrl: Schema.string().default('https://www.gstatic.com/generate_204'),
	});
}

/** volatile 字段到达 apply 时是引用（`.get()` 读取）；这里统一解包为普通对象。 */
function unwrapVolatileConfig(config) {
	if (config === null || typeof config !== 'object') return config;
	const out = {};
	for (const [key, value] of Object.entries(config)) {
		out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
	}
	return out;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文
 * @param {object} config 挂载条目配置（0.1.7 的 volatile 字段为引用形态）
 */
async function apply(ctx, config = {}) {
	const log = makeLogger(ctx);
	config = unwrapVolatileConfig(config);
	if (config && config.enabled === false) {
		log.info(`${TAG} 已通过条目配置禁用（enabled: false）`);
		return;
	}
	// 集中完成全部动态 import（见文件头「不得有顶层 await」注记）。
	const transportOk = await ensureTransport();
	await ensurePiAiCatalog();
	if (!transportOk || getUndici() === null) {
		log.error(`${TAG} 传输层不可用：未能加载 DSH 自带的 undici（需 ≥ 7.10，含 Socks5ProxyAgent）。插件已跳过——请确认 DSH ≥ 0.1.3；在本仓库内独立运行测试时先安装 devDependencies（pnpm install）`);
		return;
	}
	const home = process.env.DSH_HOME || join(homedir(), '.dsh');
	const configFile = typeof config?.configFile === 'string' && config.configFile.trim() !== ''
		? resolve(config.configFile)
		: join(home, 'proxy-routes.jsonc');

	const state = {
		/** normalizeRawConfig 的输出（当前生效配置）。 */
		cfg: null,
		/** 路由决策函数（compileRouting.decide）。 */
		decide: null,
		/** 提供商 → 决策（compileRouting.providerDecisions）。 */
		providerDecisions: new Map(),
		/** API 密钥 → 提供商 id（内存使用，绝不写日志）。 */
		keyRoutes: new Map(),
		/** 提供商 id → baseURL host（describe 得来，卡片展示用）。 */
		providerHosts: new Map(),
		/** 最近一次密钥映射的签名（条数+提供商集合）——未变化时不重复打日志。 */
		keyRoutesSignature: '',
		/** 当前模型目录（listModels 输出，settings 模式热刷新）。 */
		rows: [],
		/** 'file' | 'settings' */
		mode: null,
		originalFetch: null,
		patchedFetch: null,
		/** settings seam（describe/mutate/……），文件模式或不可用时为 null。 */
		seam: null,
	};
	const pool = new DispatcherPool();

	/* —— 请求密钥提取 + 提供商级决策（v0.4 核心）—— */
	/** 从 fetch 的 headers 参数（Headers 实例 / 普通对象 / [name, value] 数组）读一个头。 */
	const headerValue = (headers, name) => {
		if (headers === null || headers === undefined) return undefined;
		if (typeof headers.get === 'function') {
			const hit = headers.get(name);
			return typeof hit === 'string' && hit !== '' ? hit : undefined;
		}
		if (Array.isArray(headers)) {
			for (const pair of headers) {
				if (Array.isArray(pair) && String(pair[0]).toLowerCase() === name) {
					const hit = pair[1];
					return hit === null || hit === undefined ? undefined : String(hit);
				}
			}
			return undefined;
		}
		if (typeof headers === 'object') {
			for (const [key, value] of Object.entries(headers)) {
				if (String(key).toLowerCase() === name && value !== null && value !== undefined && String(value) !== '') {
					return String(value);
				}
			}
		}
		return undefined;
	};
	/**
	 * 提取请求携带的 API 密钥（llm-pi-ai 的出站协议：anthropic-messages 用
	 * x-api-key，其余用 authorization: Bearer）。仅内存匹配，绝不落日志。
	 */
	const extractApiKey = (input, init) => {
		for (const headers of [init?.headers, input?.headers]) {
			const direct = headerValue(headers, 'x-api-key');
			if (direct !== undefined) return direct;
			const auth = headerValue(headers, 'authorization');
			if (auth !== undefined && auth.startsWith('Bearer ')) return auth.slice(7).trim();
		}
		return undefined;
	};
	/**
	 * 一次请求的完整决策：先按密钥识别提供商（同域名多账号可各走各的），
	 * 未命中再落默认走向。
	 */
	const decideForRequest = (url, input, init) => {
		if (state.keyRoutes.size > 0) {
			const key = extractApiKey(input, init);
			if (key !== undefined) {
				const pid = state.keyRoutes.get(key);
				if (pid !== undefined) {
					const providerDecision = state.providerDecisions.get(pid);
					if (providerDecision !== undefined) return { decision: providerDecision, provider: pid };
				}
			}
		}
		return { decision: state.decide(), provider: null };
	};

	/* —— fetch 补丁 —— */
	const ensurePatched = () => {
		if (state.patchedFetch || typeof globalThis.fetch !== 'function') return;
		state.originalFetch = globalThis.fetch;
		state.patchedFetch = function dshProxyRoutedFetch(input, init) {
			try {
				let url = null;
				if (typeof input === 'string') url = new URL(input);
				else if (input instanceof URL) url = input;
				if (url && state.cfg && state.decide && (url.protocol === 'https:' || url.protocol === 'http:')) {
					const { decision, provider } = decideForRequest(url, input, init);
					if (decision.kind === 'proxy') {
						const dispatcher = pool.get(decision.url);
						const undici = getUndici();
						if (dispatcher && undici) {
							if (state.cfg.logRequests) {
								log.info(`${TAG} ${(init && init.method) || 'GET'} ${url.host}${url.pathname} -> ${provider ? `${provider}=>` : ''}${decision.name}:${decision.url.protocol}//${decision.url.host}`);
							}
							return undici.fetch(url, { ...init, dispatcher });
						}
						log.warn(`${TAG} 代理 ${decision.name} 的 dispatcher 尚未就绪，本次直连`);
					}
				}
				if (url) return state.originalFetch.call(this, input, init);
				// Request 对象输入
				if (input && typeof input === 'object' && typeof input.url === 'string') {
					const reqUrl = new URL(input.url);
					if (state.cfg && state.decide && (reqUrl.protocol === 'https:' || reqUrl.protocol === 'http:')) {
						const { decision, provider } = decideForRequest(reqUrl, input, init);
						if (decision.kind === 'proxy') {
							const dispatcher = pool.get(decision.url);
							const undici = getUndici();
							if (dispatcher && undici) {
								const mergedInit = {
									method: (init && init.method) || input.method,
									headers: (init && init.headers) || input.headers,
									body: init && init.body !== undefined ? init.body : input.body,
									signal: (init && init.signal) || input.signal,
									duplex: 'half',
								};
								if (state.cfg.logRequests) {
									log.info(`${TAG} ${mergedInit.method || 'GET'} ${reqUrl.host}${reqUrl.pathname} -> ${provider ? `${provider}=>` : ''}${decision.name}:${decision.url.protocol}//${decision.url.host}`);
								}
								return undici.fetch(reqUrl, { ...mergedInit, dispatcher });
							}
						}
					}
				}
			} catch {
				// 路由判断自身出错时退回原始 fetch（直连），绝不因插件让请求失败
			}
			return state.originalFetch.call(this, input, init);
		};
		globalThis.fetch = state.patchedFetch;
	};

	const unpatch = () => {
		if (!state.patchedFetch) return;
		if (globalThis.fetch === state.patchedFetch) {
			globalThis.fetch = state.originalFetch;
		} else {
			log.warn(`${TAG} 卸载时 globalThis.fetch 已被其他代码再次包装，跳过还原`);
		}
		state.patchedFetch = null;
		state.originalFetch = null;
	};

	/* —— 配置应用 —— */
	/** 把一份原始配置（文件或 settings 值）变成生效配置（normalize → 池重建 → 路由编译）。 */
	const applyRawConfig = (raw, label, announce) => {
		let cfg;
		try {
			cfg = normalizeRawConfig(raw, label);
		} catch (err) {
			log.error(`${TAG} 配置校验失败，保留上一份配置: ${err.message ?? err}`);
			return false;
		}
		// 重建 dispatcher 池（单代理 + 全部命名代理）
		const wanted = new Map();
		for (const [proxyName, url] of cfg.proxies) wanted.set(url.href, url);
		pool.rebuild(wanted);
		const routing = compileRouting(cfg);
		state.cfg = cfg;
		state.decide = routing.decide;
		state.providerDecisions = routing.providerDecisions;
		ensurePatched();
		for (const message of routing.unknownProxies) log.warn(`${TAG} ${message}`);
		if (announce) {
			const viaLabel = (via) => via === 'direct' ? '直连' : via === 'proxy' ? '代理' : via;
			const providerSummary = Object.entries(cfg.providerRoutes).map(([pid, via]) => `${pid}=>${viaLabel(via)}`).join('，');
			const poolNames = [...cfg.proxies.keys()].join(',');
			log.info(`${TAG} 配置已加载 ${label}（代理池=[${poolNames || '无'}]，默认=${viaLabel(cfg.defaultVia)}，提供商路由[${providerSummary || '无'}]，来源=${state.mode === 'file' ? '配置文件' : '设置页'}）`);
		}
		return true;
	};

	/** 重新编译路由（密钥映射变化时调用，配置不变）。 */
	const recompile = (announce) => {
		if (!state.cfg) return;
		applyRawConfig(rawSnapshotForRecompile, `${state.mode === 'file' ? configFile : '设置页(proxy-routes)'}（目录更新）`, announce === true);
	};
	let rawSnapshotForRecompile = null;

	/** 模型目录刷新 + 路由重编译（同步：目录加载已在 apply 顶部完成）。 */
	const refreshCatalog = (announce = false) => {
		if (!state.seam) return;
		try {
			state.rows = listModels(state.seam);
		} catch { /* 保持旧目录 */ }
		if (rawSnapshotForRecompile) recompile(announce);
	};

	/**
	 * 重建「API 密钥 → 提供商」映射：settings describe（未脱敏）读到各提供商的
	 * apiKeyEnv 引用，再经 credentials 服务解析成密钥。密钥只进内存，绝不写日志。
	 * @returns {Promise<boolean>} describe 可用即为 true（无提供商也允许）
	 */
	const rebuildKeyRoutes = async () => {
		const seam = state.seam;
		if (!seam || typeof seam.describe !== 'function') return false;
		let rows;
		try {
			rows = seam.describe();
		} catch {
			return false;
		}
		let credentials;
		try {
			credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined;
		} catch {
			credentials = undefined;
		}
		const next = new Map();
		const hosts = new Map();
		for (const row of rows ?? []) {
			const providers = row?.value?.providers;
			if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue;
			for (const [pid, profile] of Object.entries(providers)) {
				if (profile === null || typeof profile !== 'object') continue;
				// 判定 pi-ai 提供商形态：apiKeyEnv / apiKey / baseURL / models 至少其一
				const shape = typeof profile.apiKeyEnv === 'string' || typeof profile.apiKey === 'string'
					|| typeof profile.baseURL === 'string' || Array.isArray(profile.models);
				if (!shape) continue;
				if (typeof profile.baseURL === 'string' && profile.baseURL !== '' && !hosts.has(pid)) {
					try { hosts.set(pid, new URL(profile.baseURL).hostname.toLowerCase()); } catch { /* 忽略非法 baseURL */ }
				}
				let key;
				if (typeof profile.apiKey === 'string' && profile.apiKey !== '') {
					key = profile.apiKey;
				} else if (typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '') {
					const ref = profile.apiKeyEnv;
					try {
						const hit = credentials !== undefined && typeof credentials.resolve === 'function'
							? (await credentials.resolve(ref))?.value
							: process.env[ref];
						if (typeof hit === 'string' && hit !== '') key = hit;
					} catch { /* 该提供商暂无凭据 */ }
				}
				if (key === undefined) continue;
				const existing = next.get(key);
				if (existing !== undefined) {
					if (existing !== pid) log.warn(`${TAG} 提供商 "${pid}" 与 "${existing}" 的密钥相同，按先者生效`);
					continue;
				}
				next.set(key, pid);
			}
		}
		state.keyRoutes = next;
		state.providerHosts = hosts;
		// 仅在提供商集合真的变化时打日志——DSH 每条消息都可能触发无关的
		// settings 写入，重复重建若每次都打日志会刷屏。
		const names = [...new Set(next.values())].sort();
		const signature = `${next.size}|${names.join(',')}`;
		if (signature !== state.keyRoutesSignature) {
			state.keyRoutesSignature = signature;
			log.info(`${TAG} 密钥→提供商映射已建立：${next.size} 条（提供商 ${names.join(', ') || '无'}）`);
		}
		return true;
	};

	/* —— 文件模式（v0.2 兼容）—— */
	const readFileConfig = async (announce) => {
		let text;
		try {
			text = await readFile(configFile, 'utf8');
		} catch (err) {
			if (err?.code === 'ENOENT') {
				log.warn(`${TAG} 配置文件 ${configFile} 消失，保留上一份配置`);
				return;
			}
			log.warn(`${TAG} 读取配置失败，保留上一份配置: ${err?.message ?? err}`);
			return;
		}
		text = text.replace(/^\uFEFF/, '');
		let parsed;
		try {
			parsed = JSON.parse(stripJsonComments(text));
		} catch (err) {
			log.error(`${TAG} 配置文件语法错误，保留上一份配置: ${err?.message ?? err}`);
			return;
		}
		rawSnapshotForRecompile = parsed;
		applyRawConfig(parsed, configFile, announce);
	};

	const startFileMode = (announce) => {
		state.mode = 'file';
		void readFileConfig(announce);
	};

	const installFileWatcher = () => {
		let watcher = null;
		let usingWatchFile = false;
		let timer = null;
		let disposed = false;
		const schedule = () => {
			if (disposed) return;
			clearTimeout(timer);
			timer = setTimeout(() => void readFileConfig(false), 300);
		};
		const startWatch = () => {
			if (disposed || usingWatchFile) return;
			try {
				watcher = watch(configFile, () => {
					schedule();
					// Windows 编辑器常用「写临时文件再改名」保存，改名后原 watch 会失效 —— 重建
					stopWatch();
					startWatch();
				});
				watcher.on('error', () => { /* 交由 watchFile 兜底 */ });
			} catch {
				usingWatchFile = true;
				watchFile(configFile, { interval: 1000 }, () => schedule());
			}
		};
		const stopWatch = () => {
			if (watcher) {
				watcher.removeAllListeners();
				watcher.close();
				watcher = null;
			}
		};
		if (existsSync(configFile)) startWatch();
		else {
			usingWatchFile = true;
			watchFile(configFile, { interval: 1000 }, () => {
				schedule();
				if (existsSync(configFile)) {
					unwatchFile(configFile);
					usingWatchFile = false;
					startWatch();
				}
			});
		}
		return () => {
			disposed = true;
			clearTimeout(timer);
			stopWatch();
			if (usingWatchFile) unwatchFile(configFile);
		};
	};

	/* —— bridge（设置页卡片的同源 HTTP 端点，仅本机）—— */
	/** 回环 + 同源 + Host 校验，拒绝任何非本机访问。 */
	const makeGuard = (trustedOrigins) => (req, res) => {
		const socket = req.socket ?? req.connection;
		const remote = socket?.remoteAddress ?? '';
		const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
		if (!isLoopback) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: false, code: 'forbidden', message: 'loopback only' }));
			return false;
		}
		const host = String(req.headers.host ?? '').toLowerCase();
		const origin = String(req.headers.origin ?? '').toLowerCase();
		const trusted = Array.isArray(trustedOrigins) ? trustedOrigins.map((o) => String(o).toLowerCase()) : [];
		const hostAllowed = host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')
			|| trusted.some((t) => t === `http://${host}` || t === `https://${host}`);
		if (!hostAllowed) {
			res.writeHead(403, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: false, code: 'forbidden', message: 'host not allowed' }));
			return false;
		}
		if (origin && origin !== 'null') {
			const sameOrigin = origin.endsWith(`://${host}`) || trusted.some((t) => t === origin);
			if (!sameOrigin) {
				res.writeHead(403, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, code: 'csrf', message: 'origin mismatch' }));
				return false;
			}
		}
		return true;
	};

	const readJsonBody = (req) => new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > 1 << 20) { req.destroy(); resolve(undefined); return; }
			chunks.push(c);
		});
		req.on('end', () => {
			try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(undefined); }
		});
		req.on('error', () => resolve(undefined));
	});

	/** 构造 bridge 的全部路由（不依赖 settings seam：0.1.7 的 settings 服务
	 *  没有 register()，卡片与探测在文件/条目配置模式下也必须可用）。 */
	const makeBridgeRoutes = (opts) => {
		const guard = makeGuard(opts.trustedOrigins);
		const writeJson = (res, status, payload) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};
		/** 提供商清单（卡片「按提供商」区）：目录行 + 密钥映射 + describe 的
		 *  baseURL。绝不包含密钥本体。 */
		const providerRows = () => {
			const byId = new Map();
			const ensureRow = (pid) => {
				let row = byId.get(pid);
				if (row === undefined) {
					row = { id: pid, host: '', hasKey: false, via: state.cfg?.providerRoutes?.[pid] ?? '' };
					byId.set(pid, row);
				}
				return row;
			};
			for (const row of state.rows) {
				const hit = ensureRow(row.providerId);
				if (hit.host === '' && row.host !== '') hit.host = row.host;
			}
			for (const [pid, host] of state.providerHosts ?? []) {
				const hit = ensureRow(pid);
				if (hit.host === '' && host !== '') hit.host = host;
			}
			for (const pid of state.keyRoutes.values()) {
				ensureRow(pid).hasKey = true;
			}
			return [...byId.values()];
		};
		/** 当前生效配置的摘要（卡片状态区：文件模式提示 + 提供商清单）。 */
		const statusPayload = () => ({
			ok: true,
			value: {
				mode: state.mode,
				configFile: state.mode === 'file' ? configFile : null,
				proxies: Object.fromEntries([...state.cfg?.proxies.entries() ?? []].map(([n, u]) => [n, u.href])),
				singleProxy: state.cfg?.singleProxy?.href ?? null,
				default: state.cfg?.defaultVia ?? 'direct',
				providerRoutes: state.cfg?.providerRoutes ?? {},
				logRequests: state.cfg?.logRequests ?? true,
				probeUrl: state.cfg?.probeUrl ?? 'https://www.gstatic.com/generate_204',
				rows: state.rows.map((row) => ({ ...row })),
				providers: providerRows(),
			},
		});
		/** 0.1.7+ 的 settings 从插件 Config schema 派生，没有 register()/mutate
		 *  通道 —— 保存/迁移给出可操作的错误而不是 404/静默。 */
		const requireSeam = (res) => {
			const seam = state.seam;
			if (seam && typeof seam.mutate === 'function') return seam;
			writeJson(res, 200, { ok: false, code: 'settings-unavailable', message: '本版本 DSH 的设置由插件 Config schema 派生（无 settings 注册通道）；请使用配置文件或条目 config' });
			return null;
		};
		const routes = [];
		routes.push({
			kind: 'exact',
			path: `${BRIDGE_PREFIX}/describe`,
			handler: async (req, res) => {
				if (!guard(req, res)) return;
				writeJson(res, 200, statusPayload());
			},
		});
		routes.push({
			kind: 'exact',
			path: `${BRIDGE_PREFIX}/mutate`,
			handler: async (req, res) => {
				if (!guard(req, res)) return;
				const body = await readJsonBody(req);
				if (body === undefined || !Array.isArray(body.ops)) {
					writeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'expect { ops: [...] }' });
					return;
				}
				if (state.mode === 'file') {
					writeJson(res, 409, { ok: false, code: 'file-mode', message: `配置文件 ${configFile} 优先于设置页；请先迁移或删除该文件` });
					return;
				}
				const seam = requireSeam(res);
				if (!seam) return;
				try {
					const result = await seam.mutate(NAMESPACE, body.ops, typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined);
					writeJson(res, 200, { ok: true, value: result });
				} catch (error) {
					writeJson(res, 200, { ok: false, code: 'settings-rejected', message: error?.message ?? String(error) });
				}
			},
		});
		routes.push({
			kind: 'exact',
			path: `${BRIDGE_PREFIX}/models`,
			handler: async (req, res) => {
				if (!guard(req, res)) return;
				await ensurePiAiCatalog();
				writeJson(res, 200, { ok: true, value: { models: state.rows.map((row) => ({ ...row })) } });
			},
		});
		routes.push({
			kind: 'exact',
			path: `${BRIDGE_PREFIX}/test`,
			handler: async (req, res) => {
				if (!guard(req, res)) return;
				const body = await readJsonBody(req);
				if (body === undefined || typeof body !== 'object') {
					writeJson(res, 400, { ok: false, code: 'bad-request', message: 'unreadable JSON body' });
					return;
				}
				let probeUrl;
				try {
					probeUrl = new URL(state.cfg?.probeUrl ?? 'https://www.gstatic.com/generate_204');
				} catch {
					probeUrl = new URL('https://www.gstatic.com/generate_204');
				}
				// kind: 'proxy'（按代理名/单代理/草稿地址测）、'provider'（按提供商 id）
				// 或 'model'（按模型 key）——后两者先看提供商显式走向，再落默认走向
				const probeRoute = async (decision, key) => {
					if (decision.kind === 'direct') {
						const result = await probeVia(probeUrl, null, state.originalFetch ?? globalThis.fetch);
						writeJson(res, 200, { ok: result.ok, key, via: 'direct', ...result });
						return;
					}
					const dispatcher = pool.get(decision.url);
					const result = await probeVia(probeUrl, dispatcher, state.originalFetch ?? globalThis.fetch);
					writeJson(res, 200, { ok: result.ok, key, via: decision.name, ...result });
				};
				if (body.kind === 'proxy') {
					// 优先用卡片传来的**草稿地址**——「添加代理」后无需保存即可测试
					let url = null;
					let message = null;
					if (typeof body.url === 'string' && body.url.trim() !== '') {
						try {
							url = normalizeProxyUrl(body.url, `${TAG} /test`);
						} catch (err) {
							message = err?.message ?? String(err);
						}
					} else {
						try {
							if (body.name === '(default)' || body.name === 'proxy') url = state.cfg?.singleProxy ?? state.cfg?.proxies.get('default') ?? null;
							else url = state.cfg?.proxies.get(String(body.name)) ?? null;
						} catch { /* url 保持 null */ }
						if (!url) message = '未知代理';
					}
					if (!url) {
						writeJson(res, 200, { ok: false, key: String(body.name ?? ''), message });
						return;
					}
					const dispatcher = pool.get(url);
					const result = await probeVia(probeUrl, dispatcher, state.originalFetch ?? globalThis.fetch);
					writeJson(res, 200, { ok: result.ok, key: String(body.name), ...result });
					return;
				}
				if (body.kind === 'provider') {
					const pid = String(body.key ?? '');
					const known = state.providerDecisions.has(pid)
						|| state.rows.some((r) => r.providerId === pid)
						|| state.providerHosts.has(pid);
					if (!known) {
						writeJson(res, 200, { ok: false, key: pid, message: '未知提供商' });
						return;
					}
					// 无显式走向 → 默认走向（v0.4.1：不再报「未知」）
					const decision = state.providerDecisions.get(pid)
						?? (state.decide ? state.decide() : { kind: 'direct' });
					await probeRoute(decision, pid);
					return;
				}
				if (body.kind === 'model') {
					const row = state.rows.find((r) => r.key === body.key);
					if (!row) {
						writeJson(res, 200, { ok: false, key: String(body.key ?? ''), message: '未知模型' });
						return;
					}
					const providerDecision = state.providerDecisions.get(row.providerId);
					const decision = providerDecision !== undefined ? providerDecision
						: (state.decide ? state.decide() : { kind: 'direct' });
					await probeRoute(decision, row.key);
					return;
				}
				writeJson(res, 400, { ok: false, code: 'bad-request', message: 'kind must be "proxy", "provider" or "model"' });
			},
		});
		return routes;
	};

	/* —— apply 装配 —— */
	const effect = typeof ctx?.effect === 'function' ? (fn, label) => ctx.effect(fn, label) : (fn) => fn();

	effect(() => {
		// 卸载清理
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			unpatch();
			pool.close();
			if (typeof state.watchStopper === 'function') {
				try { state.watchStopper(); } catch { /* ignore */ }
			}
		};
		ctx?.on?.('dispose', stop);
		return stop;
	}, 'proxy-routes: cleanup');

	const fileMode = existsSync(configFile);
	if (fileMode) {
		// 文件模式：仅在用户**手动**创建了配置文件时生效（CLI 用户自管）。
		// 安装后绝不自动生成配置文件——桌面版/设置页是默认姿态。
		state.mode = 'file';
		startFileMode(true);
		effect(() => installFileWatcher(), 'proxy-routes: config file watcher');
	} else {
		state.mode = 'settings';
	}

	if (typeof ctx?.inject === 'function') {
		// —— bridge：**独立**挂载，不依赖 settings seam ——
		// dsh 0.1.7（Desktop 2.0.14）的 settings 服务没有 register()（配置改由
		// 插件 Config schema 派生），settings 回调会提前返回；桥接必须无条件
		// 可用，否则卡片 describe 404（v0.3.4 事故：配置区因此空白）。
		ctx.inject(['webServer'], (bridgeCtx) => {
			const disposers = [];
			for (const route of makeBridgeRoutes({ trustedOrigins: config?.trustedOrigins })) {
				disposers.push(bridgeCtx.webServer.register(route));
			}
			log.info(`${TAG} 设置桥接已挂载 ${BRIDGE_PREFIX}（${disposers.length} 条路由）`);
			bridgeCtx.effect(() => () => {
				for (const dispose of disposers) dispose();
			});
		});

		// —— settings：0.1.5 注册命名空间；0.1.7 用导出的 Config schema + describe/credentials ——
		// 回调必须**同步**（Cordis 的 inject 回调返回后 runtime session 即释放，
		// await 之后再调 sctx.effect 会炸）；所有动态 import 已在 apply 顶部完成，
		// 目录刷新这类异步工作放进 timer / watch 回调，绝不触碰 sctx。
		ctx.inject(['settings'], (sctx) => {
			const seam = sctx?.settings;
			if (!seam || typeof seam.describe !== 'function') {
				log.warn(`${TAG} settings 服务不可用：配置仅来自条目配置或配置文件；如需文件模式请手动创建 ${configFile}`);
				return;
			}
			state.seam = seam;
			const timers = [];
			/** 凭据可能注册晚于本插件：退避重试直到密钥映射可建（或到次数上限）。 */
			const scheduleKeyRetry = (attempt) => {
				if (attempt > 6) return;
				const timer = setTimeout(() => {
					void rebuildKeyRoutes().then((ok) => {
						if (!ok || state.keyRoutes.size === 0) scheduleKeyRetry(attempt + 1);
					});
				}, 200 * 2 ** attempt);
				timers.push(timer);
			};
			void rebuildKeyRoutes().then((ok) => {
				if (!ok || state.keyRoutes.size === 0) scheduleKeyRetry(0);
			});
			/** 从 describe 重读本插件条目配置（0.1.7 保存后的热生效路径）。 */
			const applyEntryConfigFromSettings = () => {
				if (state.mode !== 'settings') return; // 文件优先
				try {
					const row = seam.describe().find((d) => String(d.ns) === NAMESPACE);
					if (!row || row.value === null || typeof row.value !== 'object') return;
					rawSnapshotForRecompile = row.value;
					applyRawConfig(row.value, `条目配置(设置)`, false);
				} catch { /* describe 失败时保留现值 */ }
			};
			let keyRebuildDebounce = null;
			/** 文档更新（自己的保存 / provider 配置变化）→ 应用 + 目录 + 密钥映射。
			 * 其他条目的写入（DSH 每条消息都可能写会话状态等无关文档）一律忽略。 */
			const onDocumentUpdated = (ns) => {
				const nsId = ns === undefined ? undefined : String(ns);
				if (nsId === undefined || nsId === NAMESPACE) {
					applyEntryConfigFromSettings();
				} else {
					let providerDoc = false;
					try {
						const row = seam.describe().find((d) => String(d.ns) === nsId);
						const v = row?.value;
						providerDoc = v !== null && typeof v === 'object' && !Array.isArray(v)
							&& typeof v.providers === 'object' && v.providers !== null && !Array.isArray(v.providers);
					} catch { /* ignore */ }
					if (!providerDoc) return;
				}
				try { refreshCatalog(false); } catch { /* ignore */ }
				if (keyRebuildDebounce) clearTimeout(keyRebuildDebounce);
				keyRebuildDebounce = setTimeout(() => {
					keyRebuildDebounce = null;
					void rebuildKeyRoutes();
				}, 400);
				timers.push(keyRebuildDebounce);
			};
			if (typeof seam.register === 'function') {
				// —— dsh 0.1.5：注册 namespace（写入 settings.yaml 的 proxy-routes 段）——
				const registerSchema = makeRegisterSchema();
				try {
					const scope = seam.register(NAMESPACE, registerSchema, { base: config, applies: 'live' });
					// provider 命名空间（llm-pi-ai / llm-deepseek）注册晚于本插件：
					// 带退避重试直到模型目录可解析，并在 provider 文档变化时重编译。
					const PROVIDER_NS = new Set(['llm-pi-ai', 'llm-deepseek']);
					const providerReady = () => {
						try {
							return [...PROVIDER_NS].every((ns) => seam.describe({ redactSecrets: true }).some((d) => String(d.ns) === ns));
						} catch {
							return false;
						}
					};
					const applySettings = (announce = false) => {
						state.rows = listModels(seam);
						if (state.mode === 'file') return; // 文件优先，settings 值不覆盖
						rawSnapshotForRecompile = scope.get();
						applyRawConfig(scope.get(), `设置页(${NAMESPACE})`, announce);
					};
					const scheduleRetry = (attempt) => {
						if (attempt > 8) return;
						const timer = setTimeout(() => {
							try {
								applySettings(attempt === 0);
							} catch (error) {
								log.warn(`${TAG} settings 首次应用失败: ${error?.message ?? error}`);
							}
							if (!providerReady()) scheduleRetry(attempt + 1);
						}, 100 * 2 ** attempt);
						timers.push(timer);
					};
					try {
						applySettings(true);
					} catch (error) {
						log.warn(`${TAG} settings 首次应用失败: ${error?.message ?? error}`);
					}
					if (!providerReady()) scheduleRetry(0);
					const disposeWatch = scope.watch((next) => {
						if (state.mode === 'file') return;
						rawSnapshotForRecompile = next;
						applyRawConfig(next, `设置页(${NAMESPACE})`, false);
					});
					const disposeDoc = ctx.on('settings/document-updated', onDocumentUpdated);
					log.info(`${TAG} settings 命名空间 "${NAMESPACE}" 已注册 —— 设置 → 插件 → 代理路由 实时生效${state.mode === 'file' ? '（当前配置文件模式优先，可在卡片中一键迁移）' : ''}`);
					sctx.effect(() => () => {
						disposeWatch();
						disposeDoc();
						for (const timer of timers) clearTimeout(timer);
					});
				} catch (error) {
					log.error(`${TAG} settings 注册失败，配置仅来自条目/文件: ${error?.message ?? error}`);
				}
			} else {
				// —— dsh 0.1.7+：无 register()；配置从导出的 Config schema 派生，
				//    卡片保存走 SettingsForms.mutate（同一 op 协议），目录与密钥经
				//    describe + credentials 获取。条目配置初始值已在 apply 里生效。
				log.info(`${TAG} dsh 0.1.7+ settings（Config schema 派生）：条目配置 + describe 目录 + credentials 密钥映射已启用`);
				if (state.mode === 'settings') {
					applyEntryConfigFromSettings();
					if (state.cfg === null) {
						// describe 里还没有本条目行时（时序兜底）：直接用 apply 收到的条目配置
						rawSnapshotForRecompile = config;
						applyRawConfig(config, '条目配置', true);
					}
					// 提供商/模型目录（卡片的 providers 列表 + 测试按钮需要 host）
					try { refreshCatalog(false); } catch { /* ignore */ }
				} else {
					try { refreshCatalog(true); } catch { /* ignore */ }
				}
				const disposeDoc = ctx.on('settings/document-updated', onDocumentUpdated);
				sctx.effect(() => () => {
					disposeDoc();
					for (const timer of timers) clearTimeout(timer);
				});
			}
		});
	} else {
		// 无 cordis inject（mock ctx / 测试环境）：条目配置或配置文件直接生效。
		// 不再自动生成模板文件——需要文件模式的用户自己创建（CLI 姿态）。
		const hasConfig = config && (typeof config === 'object') && Object.keys(config).some((k) => !['enabled', 'configFile'].includes(k));
		if (!fileMode && hasConfig) {
			applyRawConfig(config, '条目配置', true);
		}
	}
}

export { apply, inject, name };
