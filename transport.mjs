// dsh-proxy-routes — 传输层：DSH 自带 undici 的代理 dispatcher 池。
//
// v0.3.0 起支持命名代理池：每个代理（socks5:// 或 http(s)://）对应一个独立的
// undici dispatcher（Socks5ProxyAgent / ProxyAgent），按需惰性创建、配置变化时
// 重建。不声明 npm 依赖——DSH（npm 与桌面版）安装树里始终自带 undici（官方
// dsh-http-proxy 同样以动态 import 使用它）。
//
// - socks5://（socks5h://、socks:// 写法等价归一化）：目标域名一律按 ATYP=域名
//   发给代理端解析——等效 socks5h，避免本地 DNS 污染；URL userinfo 认证原生支持
// - http:// / https:// 代理：CONNECT 隧道（https 为代理端 TLS）；代理侧禁用空闲
//   连接复用，规避 Clash 等静默关闭空闲隧道导致 undici 复用死连接的挂起问题
//   （clientFactory + pipelining: 0，实证 workaround 另见 dsh-llm-proxy）
//
// **本模块不得有顶层 await**：DSH 桌面版经 require 桥加载插件，含 TLA 的
// ESM 图会抛 ERR_REQUIRE_ASYNC_MODULE（v0.3.0 因此导致桌面版启动报错）。
// undici 通过 ensureTransport() 在插件 apply 时惰性加载。

/** 已加载的 undici 模块；null = 未加载或不可用（详见 ensureTransport）。 */
export let undici = null;
let transportLoaded = false;
let transportPromise = null;

/**
 * 确保 undici 已加载（幂等、并发安全）。失败（未安装）时 undici 保持 null。
 * 在 apply 顶部 await 一次，之后本模块的同步读面即可用。
 * @returns {Promise<boolean>} 传输层是否可用
 */
export function ensureTransport() {
	if (transportLoaded) return Promise.resolve(undici !== null);
	if (transportPromise === null) {
		transportPromise = import('undici')
			.then((mod) => { undici = mod; return true; })
			.catch(() => false)
			.finally(() => { transportLoaded = true; });
	}
	return transportPromise;
}

/**
 * undici 的同步读面（ensureTransport() 完成后使用）。
 * @returns {typeof import('undici')} 已加载的 undici；未加载时为 null
 */
export function getUndici() {
	return undici && typeof undici.fetch === 'function' && typeof undici.Socks5ProxyAgent === 'function' && typeof undici.ProxyAgent === 'function'
		? undici
		: null;
}

/**
 * 校验并归一化一个代理地址字符串。
 * @param {string} raw 原始值（来自配置）
 * @param {string} label 出错信息里的来源描述
 * @returns {URL} 归一化后的代理 URL（socks5h/socks 统一为 socks5 协议）
 * @throws 协议不支持或地址非法时抛错
 */
export function normalizeProxyUrl(raw, label) {
	let parsed;
	try {
		parsed = new URL(String(raw).trim());
	} catch {
		throw new Error(`${label} 不是合法 URL: ${raw}`);
	}
	const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
	if (scheme === 'socks5h' || scheme === 'socks') parsed = new URL(parsed.href.replace(/^[a-z0-9+]+:/i, 'socks5:'));
	if (scheme !== 'socks5' && scheme !== 'socks5h' && scheme !== 'socks' && scheme !== 'http' && scheme !== 'https') {
		throw new Error(`${label} 的代理协议不支持（支持 socks5:// 与 http(s)://）: ${raw}`);
	}
	if (!parsed.hostname) throw new Error(`${label} 的代理地址缺少主机名: ${raw}`);
	return parsed;
}

/**
 * 按代理 URL 协议构建 undici dispatcher（http/https 目标共用同一个 dispatcher）。
 * @param {URL} proxyUrl 归一化后的代理地址
 */
export function makeProxyDispatcher(proxyUrl) {
	const scheme = proxyUrl.protocol.replace(/:$/, '').toLowerCase();
	if (scheme === 'socks5' || scheme === 'socks') {
		return new undici.Socks5ProxyAgent(proxyUrl.href);
	}
	return new undici.ProxyAgent({
		uri: proxyUrl.href,
		clientFactory: (origin, opts) => new undici.Pool(origin, { ...opts, pipelining: 0 }),
	});
}

/**
 * 代理 dispatcher 池：按归一化 URL 缓存，配置变化后调用 rebuild。
 * 同一 URL 的所有名称共享一个 dispatcher；rebuild 后旧 dispatcher 优雅关闭
 * （在途请求自然完成）。
 */
export class DispatcherPool {
	constructor() {
		/** @type {Map<string, import('undici').Dispatcher>} */
		this.active = new Map();
	}

	/**
	 * 用一组代理 URL（含 '' 直连占位）重建池；保持仍被引用的 dispatcher 存活。
	 * @param {Map<string, URL>} wanted 键为代理 URL href，值为归一化后的 URL
	 */
	rebuild(wanted) {
		const keys = new Set(wanted.keys());
		for (const [key, dispatcher] of this.active) {
			if (!keys.has(key)) {
				this.active.delete(key);
				try { dispatcher.close().catch(() => { /* ignore */ }); } catch { /* ignore */ }
			}
		}
		for (const key of keys) {
			if (!this.active.has(key)) this.active.set(key, makeProxyDispatcher(wanted.get(key)));
		}
	}

	/**
	 * 取一个代理 URL 对应的 dispatcher（必须在 rebuild 之后调用才存在）。
	 * @param {URL} proxyUrl 归一化后的代理 URL
	 */
	get(proxyUrl) {
		return this.active.get(proxyUrl.href) ?? null;
	}

	/** 关闭全部 dispatcher（插件卸载时）。 */
	close() {
		for (const dispatcher of this.active.values()) {
			try { dispatcher.close().catch(() => { /* ignore */ }); } catch { /* ignore */ }
		}
		this.active.clear();
	}
}

/**
 * 经指定代理（或直连）发一次探测请求，用于设置页的「测试连接」。
 * @param {URL} probeUrl 探测目标（默认 https://www.gstatic.com/generate_204）
 * @param {import('undici').Dispatcher|null} dispatcher null = 直连（走原始 fetch 路径）
 * @param {string} originalFetch 原始 fetch（直连探测用它，保持与真实直连路径一致）
 * @returns {Promise<{ok: boolean, status?: number, latencyMs: number, message?: string}>}
 */
export async function probeVia(probeUrl, dispatcher, originalFetch) {
	const t0 = Date.now();
	try {
		const response = dispatcher
			? await undici.fetch(probeUrl, { dispatcher, signal: AbortSignal.timeout(15000) })
			: await originalFetch(probeUrl, { signal: AbortSignal.timeout(15000) });
		// 探测端点期望 204（gstatic generate_204）；其他 2xx/3xx 也算网络通
		const ok = response.status >= 200 && response.status < 400;
		try { response.body?.cancel?.(); } catch { /* ignore */ }
		return {
			ok,
			status: response.status,
			latencyMs: Date.now() - t0,
			message: ok ? undefined : `HTTP ${response.status}`,
		};
	} catch (error) {
		return { ok: false, latencyMs: Date.now() - t0, message: error?.cause?.message ?? error?.message ?? String(error) };
	}
}
