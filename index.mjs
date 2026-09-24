// dsh-proxy-routes —— DSH 代理路由插件：按「模型 / 域名」分流，支持命名代理池。
//
// 配置来源（优先级从高到低）：
//   1. 配置文件（$DSH_HOME/proxy-routes.jsonc，JSONC 语法，保存热生效）—— v0.2
//      及以前用户的既有入口；存在即生效，设置页卡片提供一键迁移
//   2. DSH settings（设置 → 插件 → 插件配置 → 代理路由 卡片，官方 settings 机制，
//      `applies: 'live'` 保存即热生效，写入 settings.yaml 的 proxy-routes 命名空间）
//
// 路由语义：传输层只能看到请求 URL，因此「按模型」的实际实现是
// 「模型 → 其 provider 的 baseURL host → 代理」（与官方模型选择器一致）。
// 同一域名下的模型共享同一路由；卡片按 host 分组提示。
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

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync, watch, watchFile, unwatchFile } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { ensureTransport, getUndici, normalizeProxyUrl, DispatcherPool, probeVia } from './transport.mjs';
import { ensurePiAiCatalog, listModels, compileModelRoutes } from './catalog.mjs';

const name = 'dsh-proxy-routes';
const inject = [];

const TAG = '[proxy-routes]';
const NAMESPACE = 'proxy-routes';
const BRIDGE_PREFIX = '/api/dsh-proxy-routes/settings';
/** 出现文件模式后，settings 桥延迟这段时间仍无任何配置时生成模板兜底（无 settings 的环境）。 */
const FALLBACK_TEMPLATE_DELAY_MS = 3000;

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
	if (typeof raw.proxy === 'string' && raw.proxy.trim() !== '') {
		singleProxy = normalizeProxyUrl(raw.proxy, `${TAG} ${label} 的 "proxy"`);
		if (!proxies.has('default')) proxies.set('default', singleProxy);
	}
	// 默认走向
	const defaultVia = raw.default === undefined ? 'direct' : String(raw.default);
	// 域名规则
	const domainRules = [];
	if (raw.routes !== undefined) {
		if (!Array.isArray(raw.routes)) throw new Error(`${TAG} ${label} 的 "routes" 必须是数组`);
		domainRules.push(...raw.routes.map((route, i) => {
			if (route === null || typeof route !== 'object') throw new Error(`${TAG} ${label} 的 routes[${i}] 必须是对象`);
			if (typeof route.via !== 'string' || route.via === '') throw new Error(`${TAG} ${label} 的 routes[${i}].via 必须是代理名、"direct" 或 "proxy"`);
			const domains = Array.isArray(route.domains)
				? route.domains.filter((d) => typeof d === 'string' && d.trim() !== '').map((d) => d.trim().toLowerCase().replace(/^\.+/, ''))
				: [];
			if (domains.length === 0) throw new Error(`${TAG} ${label} 的 routes[${i}].domains 必须是非空字符串数组`);
			return { domains, via: route.via };
		}));
	}
	// 按模型路由（原始记录，编译推迟到拿到模型目录后）
	const modelRoutes = {};
	if (raw.modelRoutes !== undefined) {
		if (typeof raw.modelRoutes !== 'object' || raw.modelRoutes === null || Array.isArray(raw.modelRoutes)) {
			throw new Error(`${TAG} ${label} 的 "modelRoutes" 必须是 modelKey → 代理名/direct 的对象`);
		}
		Object.assign(modelRoutes, raw.modelRoutes);
	}
	return {
		proxies,
		singleProxy,
		defaultVia,
		domainRules,
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
 * 编译完整的路由决策表：hostname → via 决策（模型 host 规则优先，其次域名规则，最后 default）。
 * @param {object} cfg normalizeRawConfig 的输出
 * @param {ReturnType<typeof listModels>} rows 当前模型目录
 * @returns {{decide: (hostname: string) => {kind:'direct'} | {kind:'proxy', name: string, url: URL},
 *            modelConflicts: string[], unknownProxies: string[]}}
 */
function compileRouting(cfg, rows) {
	const { hostRoutes, conflicts } = compileModelRoutes(rows, cfg.modelRoutes);
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
	for (const rule of cfg.domainRules) checkVia(rule.via, `routes[${rule.domains[0]}]`);
	const defaultDecision = checkVia(cfg.defaultVia, 'default');
	const decide = (hostname) => {
		const h = String(hostname || '').toLowerCase();
		const modelVia = hostRoutes.get(h);
		if (modelVia !== undefined) {
			const decision = checkVia(modelVia, `modelRoutes[${h}]`);
			if (decision.kind === 'proxy') return decision;
			// 模型路由显式 direct：直接直连（不再落域名规则）
			if (modelVia === 'direct') return { kind: 'direct' };
			return decision;
		}
		for (const rule of cfg.domainRules) {
			for (const domain of rule.domains) {
				if (h === domain || h.endsWith('.' + domain)) {
					const decision = checkVia(rule.via, `routes[${domain}]`);
					if (decision.kind === 'proxy') return decision;
					if (rule.via === 'direct') return { kind: 'direct' };
					return decision;
				}
			}
		}
		return defaultDecision;
	};
	return { decide, modelConflicts: conflicts, unknownProxies };
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

/** 首次启动时自动生成的配置模板。 */
const DEFAULT_CONFIG_TEMPLATE = `{
  // ============================================================
  // dsh-proxy-routes 代理分流配置（首次启动自动生成）
  // 保存后约 0.3 秒自动生效，无需重启 dsh。
  // 提示：删除本文件可改用设置页（插件 → 代理路由）图形化配置。
  // ============================================================
  //
  // proxy —— 单代理地址（v0.2 兼容字段，等价于 proxies 里名为 "default" 的一项）：
  //   "socks5://127.0.0.1:50939"  域名解析交给代理端（等效 socks5h，防 DNS 污染），
  //                              可带认证 socks5://user:pass@host:port
  //   "http://127.0.0.1:7890"     HTTP CONNECT 隧道（可带认证 http://user:pass@host:port）
  //   "https://127.0.0.1:7890"    代理端 TLS（由 undici 原生支持）
  //
  // proxies —— 命名代理池（v0.3）：给每个代理起名，供下方规则按名字引用
  //
  // default —— 没命中任何规则的域名走哪条路："direct"、代理名或 "proxy"（单代理）
  //
  // modelRoutes —— 按模型设置（v0.3）："providerId/modelId" → 代理名 / "direct"。
  //   实际按该模型 provider 的 API 域名生效：同一域名下的模型共享同一路由。
  //
  // routes —— 按域名分流，从上到下匹配，第一条命中生效。
  //   domains 写域名自动覆盖子域名；via = 代理名 / "direct" / "proxy"
  //
  // logRequests —— 打印每次走代理的请求（true/false，默认 true）

  "proxy": "socks5://127.0.0.1:50939",
  "default": "direct",
  "logRequests": true,

  "routes": [
    // Anthropic / Claude —— 海外 API，需要代理
    { "domains": ["anthropic.com", "claude.ai"], "via": "proxy" },

    // 智谱 / DeepSeek —— 国内直连
    { "domains": ["open.bigmodel.cn", "bigmodel.cn", "deepseek.com"], "via": "direct" }
  ]
}
`;

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

/** schemastery（settings 注册需要；DSH 环境自带，加载失败时降级为直接配置）。 */
let Schema = null;
let schemaTried = false;
function ensureSchema() {
	if (schemaTried) return Promise.resolve(Schema !== null);
	schemaTried = true;
	return import('@deepseek-ai/schemastery')
		.then((mod) => { Schema = mod?.default ?? null; return Schema !== null; })
		.catch(() => false);
}

/** settings namespace 的 Schemastery schema。 */
function makeConfigSchema() {
	if (!Schema) return null;
	return Schema.object({
		proxy: Schema.string().default(''),
		proxies: Schema.dict(Schema.string()).default({}),
		default: Schema.string().default('direct'),
		modelRoutes: Schema.dict(Schema.string()).default({}),
		routes: Schema.array(Schema.object({
			domains: Schema.array(Schema.string()),
			via: Schema.string(),
		})).default([]),
		logRequests: Schema.boolean().default(true),
		probeUrl: Schema.string().default('https://www.gstatic.com/generate_204'),
	});
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文
 * @param {{enabled?: boolean, configFile?: string}} config 挂载条目配置
 */
async function apply(ctx, config = {}) {
	const log = makeLogger(ctx);
	if (config && config.enabled === false) {
		log.info(`${TAG} 已通过条目配置禁用（enabled: false）`);
		return;
	}
	// 集中完成全部动态 import（见文件头「不得有顶层 await」注记）。
	const transportOk = await ensureTransport();
	await ensureSchema();
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
		/** 当前模型目录（listModels 输出，settings 模式热刷新）。 */
		rows: [],
		/** 'file' | 'settings' */
		mode: null,
		originalFetch: null,
		patchedFetch: null,
		/** settings seam（注册成功后引用），文件模式为 null。 */
		seam: null,
	};
	const pool = new DispatcherPool();

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
					const decision = state.decide(url.hostname);
					if (decision.kind === 'proxy') {
						const dispatcher = pool.get(decision.url);
						const undici = getUndici();
						if (dispatcher && undici) {
							if (state.cfg.logRequests) {
								log.info(`${TAG} ${(init && init.method) || 'GET'} ${url.host}${url.pathname} -> ${decision.name}:${decision.url.protocol}//${decision.url.host}`);
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
						const decision = state.decide(reqUrl.hostname);
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
									log.info(`${TAG} ${mergedInit.method || 'GET'} ${reqUrl.host}${reqUrl.pathname} -> ${decision.name}:${decision.url.protocol}//${decision.url.host}`);
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
		const routing = compileRouting(cfg, state.rows);
		state.cfg = cfg;
		state.decide = routing.decide;
		ensurePatched();
		for (const message of routing.modelConflicts) log.warn(`${TAG} 模型路由: ${message}`);
		for (const message of routing.unknownProxies) log.warn(`${TAG} ${message}`);
		if (announce) {
			const viaLabel = (via) => via === 'direct' ? '直连' : via === 'proxy' ? '代理' : via;
			const domainSummary = cfg.domainRules.map((r) => `${r.domains.join(',')}=>${viaLabel(r.via)}`).join('；');
			const modelCount = Object.keys(cfg.modelRoutes).length;
			const poolNames = [...cfg.proxies.keys()].join(',');
			log.info(`${TAG} 配置已加载 ${label}（代理池=[${poolNames || '无'}]，默认=${viaLabel(cfg.defaultVia)}，域名规则[${domainSummary}]，模型路由 ${modelCount} 条，来源=${state.mode === 'file' ? '配置文件' : '设置页'}）`);
		}
		return true;
	};

	/** 重新编译路由（模型目录变化时调用，配置不变）。 */
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

	/** 构造 bridge 的全部路由（settings seam 可用后调用）。 */
	const makeBridgeRoutes = (seam, opts) => {
		const guard = makeGuard(opts.trustedOrigins);
		const writeJson = (res, status, payload) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};
		/** 当前生效配置的摘要（卡片状态区：文件模式提示 + 冲突列表）。 */
		const statusPayload = () => ({
			ok: true,
			value: {
				mode: state.mode,
				configFile: state.mode === 'file' ? configFile : null,
				proxies: Object.fromEntries([...state.cfg?.proxies.entries() ?? []].map(([n, u]) => [n, u.href])),
				singleProxy: state.cfg?.singleProxy?.href ?? null,
				default: state.cfg?.defaultVia ?? 'direct',
				modelRoutes: state.cfg?.modelRoutes ?? {},
				routes: state.cfg?.domainRules ?? [],
				logRequests: state.cfg?.logRequests ?? true,
				probeUrl: state.cfg?.probeUrl ?? 'https://www.gstatic.com/generate_204',
				rows: state.rows.map((row) => ({ ...row })),
			},
		});
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
				// kind: 'proxy'（按代理名/单代理测）或 'model'（按模型 key，走它当前的路由）
				if (body.kind === 'proxy') {
					let url = null;
					try {
						if (body.name === '(default)' || body.name === 'proxy') url = state.cfg?.singleProxy ?? state.cfg?.proxies.get('default') ?? null;
						else url = state.cfg?.proxies.get(String(body.name)) ?? null;
					} catch { /* url 保持 null */ }
					if (!url) {
						writeJson(res, 200, { ok: false, key: String(body.name ?? ''), message: '未知代理' });
						return;
					}
					const dispatcher = pool.get(url);
					const result = await probeVia(probeUrl, dispatcher, state.originalFetch ?? globalThis.fetch);
					writeJson(res, 200, { ok: result.ok, key: String(body.name), ...result });
					return;
				}
				if (body.kind === 'model') {
					const row = state.rows.find((r) => r.key === body.key);
					if (!row) {
						writeJson(res, 200, { ok: false, key: String(body.key ?? ''), message: '未知模型' });
						return;
					}
					const decision = state.decide ? state.decide(row.host) : { kind: 'direct' };
					if (decision.kind === 'direct') {
						const result = await probeVia(probeUrl, null, state.originalFetch ?? globalThis.fetch);
						writeJson(res, 200, { ok: result.ok, key: row.key, via: 'direct', ...result });
						return;
					}
					const dispatcher = pool.get(decision.url);
					const result = await probeVia(probeUrl, dispatcher, state.originalFetch ?? globalThis.fetch);
					writeJson(res, 200, { ok: result.ok, key: row.key, via: decision.name, ...result });
					return;
				}
				writeJson(res, 400, { ok: false, code: 'bad-request', message: 'kind must be "proxy" or "model"' });
			},
		});
		routes.push({
			kind: 'exact',
			path: `${BRIDGE_PREFIX}/migrate`,
			handler: async (req, res) => {
				if (!guard(req, res)) return;
				if (state.mode !== 'file') {
					writeJson(res, 200, { ok: false, code: 'not-file-mode', message: '仅在配置文件模式下可迁移' });
					return;
				}
				try {
					const text = (await readFile(configFile, 'utf8')).replace(/^\uFEFF/, '');
					const parsed = JSON.parse(stripJsonComments(text));
					// 整段写入 settings 的 user 层（覆盖式）
					const ops = [
						{ op: 'set', path: ['proxy'], value: typeof parsed.proxy === 'string' ? parsed.proxy : '' },
						{ op: 'set', path: ['proxies'], value: parsed.proxies && typeof parsed.proxies === 'object' && !Array.isArray(parsed.proxies) ? parsed.proxies : {} },
						{ op: 'set', path: ['default'], value: typeof parsed.default === 'string' ? parsed.default : 'direct' },
						{ op: 'set', path: ['modelRoutes'], value: parsed.modelRoutes && typeof parsed.modelRoutes === 'object' && !Array.isArray(parsed.modelRoutes) ? parsed.modelRoutes : {} },
						{ op: 'set', path: ['routes'], value: Array.isArray(parsed.routes) ? parsed.routes : [] },
						{ op: 'set', path: ['logRequests'], value: parsed.logRequests !== false },
					];
					await seam.mutate(NAMESPACE, ops);
					await rename(configFile, `${configFile}.bak`);
					writeJson(res, 200, { ok: true, value: { migrated: true, backup: `${configFile}.bak` } });
					log.info(`${TAG} 配置已迁移到设置页（原文件保留为 ${configFile}.bak）`);
					state.mode = 'settings';
					// settings 的 watch 回调会应用新值；这里立即触发一次目录刷新
					await refreshCatalog(false);
				} catch (error) {
					writeJson(res, 200, { ok: false, code: 'migrate-failed', message: error?.message ?? String(error) });
				}
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
		// v0.2 兼容：配置文件存在即生效（优先于设置页）
		state.mode = 'file';
		startFileMode(true);
		effect(() => installFileWatcher(), 'proxy-routes: config file watcher');
	} else {
		state.mode = 'settings';
		// settings 服务完全不可用（inject 不会回调）时的兜底：延迟生成模板文件，
		// 保留 v0.2「首次启动自动生成模板」的行为；settings 正常时 state.cfg 已就绪，不触发。
		const timer = setTimeout(() => {
			if (state.cfg) return;
			mkdir(dirname(configFile), { recursive: true }).then(() => writeFile(configFile, DEFAULT_CONFIG_TEMPLATE, 'utf8')).then(() => {
				state.mode = 'file';
				log.info(`${TAG} 未找到配置文件且 settings 不可用，已生成模板 ${configFile}`);
				startFileMode(true);
				state.watchStopper = installFileWatcher();
			}).catch(() => { /* ignore */ });
		}, FALLBACK_TEMPLATE_DELAY_MS);
		timer.unref?.();
	}

	if (typeof ctx?.inject === 'function') {
		// —— settings 模式：注册 namespace + 热生效 + bridge ——
		// 回调必须**同步**（Cordis 的 inject 回调返回后 runtime session 即释放，
		// await 之后再调 sctx.effect 会炸）；所有动态 import 已在 apply 顶部完成，
		// 目录刷新这类异步工作放进 timer / watch 回调，绝不触碰 sctx。
		ctx.inject(['settings'], (sctx) => {
			const seam = sctx?.settings;
			if (!seam || typeof seam.register !== 'function') {
				log.warn(`${TAG} settings seam 不可用，配置仅来自条目/文件`);
				return;
			}
			state.seam = seam;
			const Config = makeConfigSchema();
			if (!Config) {
				log.warn(`${TAG} schemastery 不可用——settings 注册跳过，配置仅来自条目/文件`);
				return;
			}
			try {
				const scope = seam.register(NAMESPACE, Config, { base: config, applies: 'live' });
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
				const timers = [];
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
				const disposeDoc = ctx.on('settings/document-updated', (ns) => {
					if (ns !== undefined && PROVIDER_NS.has(String(ns))) {
						try { refreshCatalog(true); } catch { /* 重试 timer 兜底 */ }
					}
				});
				log.info(`${TAG} settings 命名空间 "${NAMESPACE}" 已注册 —— 设置 → 插件 → 代理路由 实时生效${state.mode === 'file' ? '（当前配置文件模式优先，可在卡片中一键迁移）' : ''}`);
				sctx.effect(() => () => {
					disposeWatch();
					disposeDoc();
					for (const timer of timers) clearTimeout(timer);
				});
				// bridge：等 webServer 服务可用后挂载（文件模式也挂——卡片要显示状态/迁移）
				ctx.inject(['settings', 'webServer'], (bridgeCtx) => {
					const disposers = [];
					for (const route of makeBridgeRoutes(bridgeCtx.settings, { trustedOrigins: config?.trustedOrigins })) {
						disposers.push(bridgeCtx.webServer.register(route));
					}
					log.info(`${TAG} 设置桥接已挂载 ${BRIDGE_PREFIX}（${disposers.length} 条路由）`);
					bridgeCtx.effect(() => () => {
						for (const dispose of disposers) dispose();
					});
				});
			} catch (error) {
				log.error(`${TAG} settings 注册失败，配置仅来自条目/文件: ${error?.message ?? error}`);
			}
		});
	} else {
		// 无 cordis inject（mock ctx / 测试环境）：条目配置或配置文件直接生效
		const hasConfig = config && (typeof config === 'object') && Object.keys(config).some((k) => !['enabled', 'configFile'].includes(k));
		if (!fileMode && hasConfig) {
			applyRawConfig(config, '条目配置', true);
		}
		if (state.cfg === null) {
			// 无文件、无配置、无 settings：延迟生成模板兜底（v0.2 行为）
			const timer = setTimeout(() => {
				if (state.cfg) return;
				mkdir(dirname(configFile), { recursive: true }).then(() => writeFile(configFile, DEFAULT_CONFIG_TEMPLATE, 'utf8')).then(() => {
					state.mode = 'file';
					startFileMode(true);
				}).catch(() => { /* ignore */ });
			}, FALLBACK_TEMPLATE_DELAY_MS);
			timer.unref?.();
		}
	}
}

export { apply, inject, name };
