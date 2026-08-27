// dsh-proxy-routes —— DSH 按域名分流的代理路由插件（零依赖，纯 Node 核心）
//
// 作用：拦截本进程内所有 globalThis.fetch 请求，按域名决定走代理还是直连。
//   - 命中 via: "proxy" 的域名 → 经 SOCKS5（域名解析在代理端完成）或 HTTP CONNECT 隧道转发
//   - 其余域名 → 原样直连，行为与不装插件完全一致
//   - 配置文件保存后自动热生效，无需重启 dsh
//
// 日志：直接打印到运行 `dsh web` 的控制台（Cordis logger 的内存缓冲不外显）——
//   启动时打一行「配置已加载」，每个走代理的请求打一行路由记录。
//
// 配置文件默认位于 $DSH_HOME/proxy-routes.jsonc（JSON + 支持 // 注释），
// 不存在时首次启动会自动生成带注释的模板；也可在挂载条目的
// config.configFile 里指定别的路径。
//
// 挂载方式一（推荐，npm/git 安装）：`dsh plugin --profile web add dsh-proxy-routes`
//   自动登记本包的 cordis.patch.yml 为 bundle 层，无需手动编辑任何文件。
// 挂载方式二（手动文件复制）：把本目录复制到 profile 下，并在 profile 的
//   cordis.patch.yml 里加：
//   - insert:
//       - id: proxy-routes
//         name: './plugins/dsh-proxy-routes/index.mjs'
//
// 已知限制：
//   - 支持的代理协议：socks5://（socks5h://、socks:// 写法等价）与 http://
//     （HTTP CONNECT，支持 URL userinfo Basic 认证）；不支持代理端 TLS（https:// 代理）
//   - SOCKS5 不支持用户名/密码认证
//   - 走代理的请求不支持自动重定向（3xx）、仅使用 HTTP/1.1
//   - 工作线程（workflow worker thread）里自建的 fetch 不经过本补丁

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, watch, watchFile, unwatchFile } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const name = 'dsh-proxy-routes';
const inject = [];

const TAG = '[proxy-routes]';

/* ------------------------------------------------------------------ */
/* 代理隧道：SOCKS5 / HTTP CONNECT                                      */
/* ------------------------------------------------------------------ */

function proxyPort(url, fallback) {
	const p = Number(url.port);
	return Number.isFinite(p) && p > 0 ? p : fallback;
}

/**
 * 经 SOCKS5 代理建立到 host:port 的 TCP 隧道。
 * 使用 ATYP=0x03（域名）寻址 —— DNS 解析交给代理端，避免本地 DNS 污染。
 * @param {URL} proxyUrl 代理地址（socks5:// 或 socks5h://）
 * @param {string} host 目标域名
 * @param {number} port 目标端口
 * @param {number} timeoutMs 建立隧道超时
 * @returns {Promise<net.Socket>} 已连通的裸 TCP socket
 */
function socks5Connect(proxyUrl, host, port, timeoutMs = 20000) {
	return new Promise((resolveP, rejectP) => {
		/** @type {net.Socket} */
		let socket;
		let buffer = Buffer.alloc(0);
		let stage = 'greeting';
		let finished = false;
		const fail = (err) => {
			if (finished) return;
			finished = true;
			try { socket?.destroy(); } catch { /* ignore */ }
			rejectP(err);
		};
		const step = () => {
			if (stage === 'greeting') {
				if (buffer.length < 2) return;
				if (buffer[0] !== 0x05) return fail(new Error(`${TAG} ${proxyUrl.host} 不是 SOCKS5 服务器`));
				if (buffer[1] === 0x02) return fail(new Error(`${TAG} SOCKS5 代理要求用户名/密码认证，暂不支持`));
				if (buffer[1] !== 0x00) return fail(new Error(`${TAG} SOCKS5 服务器拒绝了免认证方式（method=${buffer[1]}）`));
				buffer = buffer.subarray(2);
				stage = 'connect';
				const domain = Buffer.from(host, 'ascii');
				const req = Buffer.alloc(7 + domain.length);
				req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
				req[4] = domain.length;
				domain.copy(req, 5);
				req.writeUInt16BE(port, 5 + domain.length);
				socket.write(req);
				step();
			} else if (stage === 'connect') {
				if (buffer.length < 4) return;
				const atyp = buffer[3];
				let addrLen = 0;
				if (atyp === 0x01) addrLen = 4;
				else if (atyp === 0x03) {
					if (buffer.length < 5) return;
					addrLen = 1 + buffer[4];
				} else if (atyp === 0x04) addrLen = 16;
				else return fail(new Error(`${TAG} SOCKS5 应答包含未知地址类型 ${atyp}`));
				if (buffer.length < 4 + addrLen + 2) return;
				if (buffer[1] !== 0x00) {
					const codes = { 1: '一般性失败', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒绝', 6: 'TTL 过期', 7: '不支持的命令', 8: '不支持的地址类型' };
					return fail(new Error(`${TAG} SOCKS5 CONNECT 失败（code=${buffer[1]}${codes[buffer[1]] ? ' ' + codes[buffer[1]] : ''}），请检查代理端日志/规则`));
				}
				finished = true;
				socket.setTimeout(0);
				socket.removeAllListeners('data');
				socket.removeAllListeners('error');
				socket.on('error', () => { /* 隧道已交接，错误由上层（TLS/HTTP）接管 */ });
				resolveP(socket);
			}
		};
		socket = net.connect({ host: proxyUrl.hostname, port: proxyPort(proxyUrl, 1080) });
		socket.setTimeout(timeoutMs);
		socket.once('timeout', () => fail(new Error(`${TAG} 连接 SOCKS5 代理 ${proxyUrl.host} 超时，代理是否在运行？`)));
		socket.once('error', (e) => fail(new Error(`${TAG} 无法连接 SOCKS5 代理 ${proxyUrl.host}: ${e.message}`)));
		socket.on('data', (c) => {
			buffer = Buffer.concat([buffer, c]);
			step();
		});
		socket.write(Buffer.from([0x05, 0x01, 0x00]));
		step();
	});
}

/**
 * 经 HTTP 代理的 CONNECT 方法建立到 host:port 的 TCP 隧道。
 * 支持 URL userinfo 形式的 Basic 认证（http://user:pass@host:port）。
 * @param {URL} proxyUrl 代理地址（http:// 或 https://）
 */
function httpConnectTunnel(proxyUrl, host, port, timeoutMs = 20000) {
	return new Promise((resolveP, rejectP) => {
		/** @type {net.Socket} */
		let socket;
		let received = '';
		let finished = false;
		const fail = (err) => {
			if (finished) return;
			finished = true;
			try { socket?.destroy(); } catch { /* ignore */ }
			rejectP(err);
		};
		socket = net.connect({ host: proxyUrl.hostname, port: proxyPort(proxyUrl, 8080) });
		socket.setTimeout(timeoutMs);
		socket.once('timeout', () => fail(new Error(`${TAG} 连接 HTTP 代理 ${proxyUrl.host} 超时`)));
		socket.once('error', (e) => fail(new Error(`${TAG} 无法连接 HTTP 代理 ${proxyUrl.host}: ${e.message}`)));
		socket.once('connect', () => {
			const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
			if (proxyUrl.username || proxyUrl.password) {
				const userinfo = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
				lines.push(`Proxy-Authorization: Basic ${Buffer.from(userinfo).toString('base64')}`);
			}
			lines.push('', '');
			socket.write(lines.join('\r\n'));
		});
		socket.on('data', (c) => {
			received += c.toString('latin1');
			const idx = received.indexOf('\r\n\r\n');
			if (idx === -1) {
				if (received.length > 16384) fail(new Error(`${TAG} HTTP 代理 CONNECT 应答过大`));
				return;
			}
			const statusLine = received.slice(0, received.indexOf('\r\n'));
			if (!/\s200\s/.test(` ${statusLine} `)) {
				fail(new Error(`${TAG} HTTP 代理 CONNECT 失败: ${statusLine}`));
				return;
			}
			finished = true;
			socket.setTimeout(0);
			socket.removeAllListeners('data');
			socket.removeAllListeners('error');
			socket.on('error', () => { /* 隧道已交接，错误由上层（TLS/HTTP）接管 */ });
			resolveP(socket);
		});
	});
}

/** 根据代理 URL 协议选择隧道建立函数。 */
function tunnelFactoryFor(proxyUrl) {
	const scheme = proxyUrl.protocol.replace(/:$/, '').toLowerCase();
	if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks') return (h, p) => socks5Connect(proxyUrl, h, p);
	if (scheme === 'http') return (h, p) => httpConnectTunnel(proxyUrl, h, p);
	throw new Error(`${TAG} 不支持的代理协议 "${proxyUrl.protocol}"（支持 socks5:// 与 http://）`);
}

/* ------------------------------------------------------------------ */
/* HTTP(S) 客户端：把隧道伪装成 http.Agent                              */
/* ------------------------------------------------------------------ */

/**
 * 自定义 Agent：每次建连都先打隧道，再（对 https）在隧道上做 TLS。
 * keepAlive 开启 —— 同一目标域名的后续请求复用已建好的隧道连接。
 * 注意：Node 会校验 agent.protocol 与请求模块一致，因此 https 用
 * https.Agent 子类、http 用 http.Agent 子类（两个类共享同一实现）。
 */
function makeTunnelAgentClass(Base, secure) {
	return class TunnelAgent extends Base {
		#tunnel;

		constructor(tunnel) {
			super({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 32 });
			this.#tunnel = tunnel;
		}

		createConnection(options, callback) {
			const host = String(options.hostname || options.host || '');
			const port = Number(options.port || (secure ? 443 : 80));
			let done = false;
			const finish = (err, sock) => {
				if (done) {
					if (sock) try { sock.destroy(); } catch { /* ignore */ }
					return;
				}
				done = true;
				callback(err, sock);
			};
			this.#tunnel(host, port).then((raw) => {
				if (!secure) {
					finish(null, raw);
					return;
				}
				const tlsSock = tls.connect({
					socket: raw,
					servername: options.servername || (net.isIP(host) ? undefined : host),
					ALPNProtocols: ['http/1.1'],
				});
				tlsSock.once('secureConnect', () => finish(null, tlsSock));
				tlsSock.once('error', (e) => finish(e));
				raw.once('error', (e) => {
					tlsSock.destroy();
					finish(e);
				});
			}, finish);
		}
	};
}

const TunnelAgentHttps = makeTunnelAgentClass(https.Agent, true);
const TunnelAgentHttp = makeTunnelAgentClass(http.Agent, false);

/* ------------------------------------------------------------------ */
/* fetch 兼容层：在隧道上实现 fetch 语义                                 */
/* ------------------------------------------------------------------ */

function flattenHeaders(h) {
	const out = {};
	if (!h) return out;
	if (typeof h.entries === 'function') {
		for (const [k, v] of h.entries()) out[k] = v;
		return out;
	}
	if (Array.isArray(h)) {
		for (const pair of h) if (Array.isArray(pair)) out[pair[0]] = pair[1];
		return out;
	}
	if (typeof h === 'object') {
		for (const [k, v] of Object.entries(h)) out[k] = v;
		return out;
	}
	return out;
}

function abortError() {
	const e = new Error('The operation was aborted');
	e.name = 'AbortError';
	return e;
}

async function sendBody(req, body) {
	if (body == null) {
		req.end();
		return;
	}
	if (typeof body === 'string') {
		req.end(body);
		return;
	}
	if (Buffer.isBuffer(body) || body instanceof Uint8Array || ArrayBuffer.isView(body)) {
		req.end(body);
		return;
	}
	if (body instanceof URLSearchParams) {
		req.end(body.toString());
		return;
	}
	if (typeof body.arrayBuffer === 'function') {
		req.end(Buffer.from(await body.arrayBuffer()));
		return;
	}
	if (typeof body.getReader === 'function') {
		const nodeStream = Readable.fromWeb(body);
		nodeStream.on('error', (e) => req.destroy(e));
		nodeStream.pipe(req);
		return;
	}
	if (typeof body.pipe === 'function') {
		body.on('error', (e) => req.destroy(e));
		body.pipe(req);
		return;
	}
	if (typeof body[Symbol.asyncIterator] === 'function') {
		for await (const chunk of body) req.write(chunk);
		req.end();
		return;
	}
	req.end(String(body));
}

/**
 * 在代理隧道上发起一次 fetch 语义的请求。
 * @param {object} state 插件运行态（含 agents 与路由表）
 * @param {URL} url 目标地址
 * @param {RequestInit} init fetch 的 init 参数
 */
function proxiedFetch(state, url, init) {
	return new Promise((resolveP, rejectP) => {
		const isTLS = url.protocol === 'https:';
		const lib = isTLS ? https : http;
		const agent = isTLS ? state.agentHttps : state.agentHttp;
		const method = String((init && init.method) || 'GET').toUpperCase();
		const headers = flattenHeaders(init && init.headers);
		const req = lib.request({
			method,
			host: url.hostname.replace(/^\[|\]$/g, ''),
			port: url.port || (isTLS ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers,
			agent,
		});
		const signal = init && init.signal;
		const onAbort = () => req.destroy(abortError());
		let settled = false;
		if (signal) {
			if (signal.aborted) {
				req.destroy();
				rejectP(abortError());
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
		req.once('response', (res) => {
			if (settled) return;
			settled = true;
			if (signal) signal.removeEventListener('abort', onAbort);
			const status = res.statusCode ?? 200;
			const h = new Headers();
			const raw = res.rawHeaders;
			for (let i = 0; i + 1 < raw.length; i += 2) h.append(raw[i], raw[i + 1]);
			let body = null;
			// 204/205/304 按规范不允许有响应体
			if (status !== 204 && status !== 205 && status !== 304) body = Readable.toWeb(res);
			resolveP(new Response(body, { status, statusText: res.statusMessage ?? '', headers: h }));
		});
		req.once('error', (err) => {
			if (settled) return;
			settled = true;
			if (signal) signal.removeEventListener('abort', onAbort);
			if (err && err.name === 'AbortError') rejectP(err);
			else rejectP(new TypeError(`fetch failed: ${err?.message ?? err}`, { cause: err }));
		});
		sendBody(req, init && init.body).catch((e) => req.destroy(e));
	});
}

/* ------------------------------------------------------------------ */
/* 配置：JSONC（JSON + 注释）解析与校验                                   */
/* ------------------------------------------------------------------ */

/**
 * 剥离 JSON 文本中的 // 与 /* 注释（字符串内部的不受影响）。
 */
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

/**
 * 校验并归一化配置。任何结构性问题都抛错（启动期/热重载期可见）。
 * @param {unknown} raw 解析出的 JSON 对象
 * @param {string} sourceLabel 配置来源描述（用于报错信息）
 */
function validateConfig(raw, sourceLabel) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${TAG} ${sourceLabel} 的根必须是对象`);
	}
	const defaultVia = raw.default === 'proxy' ? 'proxy' : 'direct';
	const routes = Array.isArray(raw.routes) ? raw.routes : [];
	if (raw.routes !== undefined && !Array.isArray(raw.routes)) {
		throw new Error(`${TAG} ${sourceLabel} 的 "routes" 必须是数组`);
	}
	const normalizedRoutes = routes.map((route, i) => {
		if (route === null || typeof route !== 'object') throw new Error(`${TAG} ${sourceLabel} 的 routes[${i}] 必须是对象`);
		if (route.via !== 'proxy' && route.via !== 'direct') {
			throw new Error(`${TAG} ${sourceLabel} 的 routes[${i}].via 必须是 "proxy" 或 "direct"`);
		}
		const domains = Array.isArray(route.domains)
			? route.domains.filter((d) => typeof d === 'string' && d.trim() !== '')
			: [];
		if (domains.length === 0) throw new Error(`${TAG} ${sourceLabel} 的 routes[${i}].domains 必须是非空字符串数组`);
		return {
			domains: domains.map((d) => d.trim().toLowerCase().replace(/^\.+/, '')),
			via: route.via,
		};
	});
	const needsProxy = defaultVia === 'proxy' || normalizedRoutes.some((r) => r.via === 'proxy');
	let proxyUrl = null;
	if (needsProxy) {
		if (typeof raw.proxy !== 'string' || raw.proxy.trim() === '') {
			throw new Error(`${TAG} ${sourceLabel} 存在 via:"proxy" 的规则，但缺少 "proxy" 代理地址`);
		}
		let parsed;
		try {
			parsed = new URL(raw.proxy.trim());
		} catch {
			throw new Error(`${TAG} ${sourceLabel} 的 "proxy" 不是合法 URL: ${raw.proxy}`);
		}
		const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
		if (scheme === 'socks5h' || scheme === 'socks') parsed = new URL(parsed.href.replace(/^[a-z0-9+]+:/i, 'socks5:'));
		if (scheme === 'https') {
			throw new Error(`${TAG} ${sourceLabel} 的 "proxy" 不支持 https://（代理端 TLS）；本地代理客户端请用 http:// 或 socks5://`);
		}
		if (scheme !== 'socks5' && scheme !== 'socks5h' && scheme !== 'socks' && scheme !== 'http') {
			throw new Error(`${TAG} ${sourceLabel} 的 "proxy" 协议不支持（支持 socks5:// 与 http://）: ${raw.proxy}`);
		}
		if (!parsed.hostname) throw new Error(`${TAG} ${sourceLabel} 的 "proxy" 缺少主机名: ${raw.proxy}`);
		proxyUrl = parsed;
	}
	return { proxyUrl, defaultVia, routes: normalizedRoutes, logRequests: raw.logRequests !== false };
}

/**
 * 域名是否命中规则（域名本身 + 所有子域名）。
 */
function routeFor(cfg, hostname) {
	const h = String(hostname || '').toLowerCase();
	for (const route of cfg.routes) {
		for (const domain of route.domains) {
			if (h === domain || h.endsWith('.' + domain)) return route.via;
		}
	}
	return cfg.defaultVia;
}

/** 首次启动时自动生成的配置模板（$DSH_HOME/proxy-routes.jsonc 不存在时落盘）。 */
const DEFAULT_CONFIG_TEMPLATE = `{
  // ============================================================
  // dsh-proxy-routes 代理分流配置（首次启动自动生成）
  // 修改保存后约 0.3 秒自动生效，无需重启 dsh。
  // ============================================================
  //
  // proxy —— 你的代理服务器地址，改成你自己的！常见客户端默认端口：
  //   Clash / Clash Verge   "socks5://127.0.0.1:7890"
  //   v2rayN                "socks5://127.0.0.1:10808"
  //   也支持 HTTP 代理（可带认证）："http://user:pass@127.0.0.1:8080"
  //
  // default —— 没命中任何规则的域名走哪条路："direct"（直连）或 "proxy"
  //
  // routes —— 分流规则，从上到下匹配，第一条命中生效。
  //   domains 写域名即可自动覆盖它的所有子域名
  //   （写 "anthropic.com" 就同时匹配 "api.anthropic.com"）
  //   via: "proxy" 走代理 / "direct" 直连
  //
  // logRequests —— 控制台打印每次走代理的请求（true/false，默认 true）

  "proxy": "socks5://127.0.0.1:7890",
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
/* 插件主体                                                             */
/* ------------------------------------------------------------------ */

/**
 * DSH 的 Cordis logger（ctx.logger）默认只写进内存环形缓冲（最近 1000 条），
 * 既不落到 PowerShell 控制台、也不在 Web UI 显示 —— 用它等于静默。因此本插件的
 * 日志直接写真实控制台（`dsh web` 所在的那个 PowerShell 窗口就能看到），
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

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文
 * @param {{enabled?: boolean, configFile?: string}} config 挂载条目配置
 */
function apply(ctx, config = {}) {
	const log = makeLogger(ctx);
	if (config && config.enabled === false) {
		log.info(`${TAG} 已通过条目配置禁用（enabled: false）`);
		return;
	}
	const home = process.env.DSH_HOME || join(homedir(), '.dsh');
	const configFile = typeof config?.configFile === 'string' && config.configFile.trim() !== ''
		? resolve(config.configFile)
		: join(home, 'proxy-routes.jsonc');

	const state = {
		cfg: null,
		agentHttps: null,
		agentHttp: null,
		originalFetch: null,
		patchedFetch: null,
	};

	const rebuildAgents = () => {
		if (!state.cfg || !state.cfg.proxyUrl) {
			state.agentHttps = null;
			state.agentHttp = null;
			return;
		}
		const tunnel = tunnelFactoryFor(state.cfg.proxyUrl);
		state.agentHttps = new TunnelAgentHttps(tunnel);
		state.agentHttp = new TunnelAgentHttp(tunnel);
	};

	const ensurePatched = () => {
		if (state.patchedFetch || typeof globalThis.fetch !== 'function') return;
		state.originalFetch = globalThis.fetch;
		state.patchedFetch = function dshProxyRoutedFetch(input, init) {
			try {
				let url = null;
				if (typeof input === 'string') url = new URL(input);
				else if (input instanceof URL) url = input;
				if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
					if (routeFor(state.cfg, url.hostname) === 'proxy') {
						if (state.cfg.logRequests) {
							log.info(`${TAG} ${(init && init.method) || 'GET'} ${url.host}${url.pathname} -> ${state.cfg.proxyUrl.protocol}//${state.cfg.proxyUrl.host}`);
						}
						return proxiedFetch(state, url, init);
					}
				}
				if (url) return state.originalFetch.call(this, input, init);
				// Request 对象输入
				if (input && typeof input === 'object' && typeof input.url === 'string') {
					const reqUrl = new URL(input.url);
					if ((reqUrl.protocol === 'https:' || reqUrl.protocol === 'http:') && routeFor(state.cfg, reqUrl.hostname) === 'proxy') {
						const mergedInit = {
							method: (init && init.method) || input.method,
							headers: (init && init.headers) || input.headers,
							body: init && init.body !== undefined ? init.body : input.body,
							signal: (init && init.signal) || input.signal,
							duplex: 'half',
						};
						if (state.cfg.logRequests) {
							log.info(`${TAG} ${mergedInit.method || 'GET'} ${reqUrl.host}${reqUrl.pathname} -> ${state.cfg.proxyUrl.protocol}//${state.cfg.proxyUrl.host}`);
						}
						return proxiedFetch(state, reqUrl, mergedInit);
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

	/** 读取并应用配置文件；失败时保留上一份可用配置。 */
	const reloadFromFile = async (announce) => {
		let text;
		try {
			text = await readFile(configFile, 'utf8');
		} catch (err) {
			if (err?.code === 'ENOENT') {
				// 首次使用：落一份带注释的模板并立即按模板生效（默认直连 + anthropic 走代理），
				// 新装用户改一行 proxy 地址即可，无需先研究文件格式。
				try {
					await mkdir(dirname(configFile), { recursive: true });
					await writeFile(configFile, DEFAULT_CONFIG_TEMPLATE, 'utf8');
					log.info(`${TAG} 未找到配置文件，已生成模板 ${configFile} —— 修改其中的 "proxy" 地址后自动生效`);
					text = DEFAULT_CONFIG_TEMPLATE;
				} catch (writeErr) {
					log.warn(`${TAG} 未找到配置文件 ${configFile} 且模板写入失败（${writeErr?.message ?? writeErr}）—— 全部流量保持直连`);
					return;
				}
			} else {
				log.warn(`${TAG} 读取配置失败，保留上一份配置: ${err?.message ?? err}`);
				return;
			}
		}
		// 兼容 Windows 编辑器/PowerShell 写入的 UTF-8 BOM
		text = text.replace(/^\uFEFF/, '');
		let parsed;
		try {
			parsed = JSON.parse(stripJsonComments(text));
		} catch (err) {
			log.error(`${TAG} 配置文件语法错误，保留上一份配置: ${err?.message ?? err}`);
			return;
		}
		let cfg;
		try {
			cfg = validateConfig(parsed, configFile);
		} catch (err) {
			log.error(`${TAG} 配置校验失败，保留上一份配置: ${err?.message ?? err}`);
			return;
		}
		state.cfg = cfg;
		rebuildAgents();
		ensurePatched();
		if (announce || announce === undefined) {
			const summary = cfg.routes.map((r) => `${r.domains.join(',')}=>${r.via === 'proxy' ? '代理' : '直连'}`).join('；');
			log.info(`${TAG} 配置已加载 ${configFile}（代理=${cfg.proxyUrl ? cfg.proxyUrl.href : '无'}，默认=${cfg.defaultVia === 'proxy' ? '代理' : '直连'}，规则[${summary}]）`);
		}
	};

	ctx.effect(() => {
		void reloadFromFile(true);
		// 配置文件热重载（防抖 + 断线重挂）
		let watcher = null;
		let usingWatchFile = false;
		let timer = null;
		let disposed = false;
		const schedule = () => {
			if (disposed) return;
			clearTimeout(timer);
			timer = setTimeout(() => void reloadFromFile(false), 300);
		};
		const startWatch = () => {
			if (disposed) return;
			if (usingWatchFile) return;
			try {
				watcher = watch(configFile, () => {
					schedule();
					// Windows 编辑器常用「写临时文件再改名」保存，改名后原 watch 会失效 —— 重建
					stopWatch();
					startWatch();
				});
				watcher.on('error', () => { /* 目录缺失等场景交由 watchFile 兜底 */ });
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
			// 文件还不存在时轮询等待创建
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
			unpatch();
			// 关闭空闲隧道连接（在途请求会自然完成）
			try { state.agentHttps?.destroy(); } catch { /* ignore */ }
			try { state.agentHttp?.destroy(); } catch { /* ignore */ }
		};
	}, 'proxy-routes: fetch 按域名分流');
}

export { apply, inject, name };
