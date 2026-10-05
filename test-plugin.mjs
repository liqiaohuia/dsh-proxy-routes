// dsh-proxy-routes —— v0.4 测试脚本（无依赖，直接 node 运行）。
// 覆盖：require 兼容回归（防桌面版 invalid plugin 事故）/ 文件模式加载 /
// 双代理池路由 / 直连 / Config schema 导出（0.1.7 volatile 标记）/
// 0.1.7 settings 模式（无 register）+ 按提供商（密钥）分流——同域双账号
// 各走各路的端到端回归 / 密钥不落日志（安全规则）/ normalizeProxyUrl（单元）/
// dispatcher 池缓存（单元）/ 热重载 / 卸载还原。
//
// 运行：node test-plugin.mjs
// 前置：本机 50939 / 50018 两个 SOCKS5 代理在监听（xray）；未监听时网络用例报 FAIL。
// 独立运行（仓库内）需先 pnpm install（devDependencies 提供 undici）。

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

let pass = 0, fail = 0, skip = 0;
const check = (label, ok) => {
	if (ok === null) { skip++; console.log(`⏭ SKIP ${label}`); return; }
	ok ? (pass++, console.log(`✓ PASS ${label}`)) : (fail++, console.log(`✗ FAIL ${label}`));
};

// —— 用例 0：require 兼容回归（桌面版 loader 用 require 桥加载插件——
//    顶层 await 会让 require 抛 ERR_REQUIRE_ASYNC_MODULE，loader 收到空对象后
//    报 "invalid plugin" 并阻塞启动；v0.3.0 事故的直接回归测试）——
{
	const require_ = createRequire(import.meta.url);
	try {
		const plugin = require_('./index.mjs');
		check('require() 可加载插件且 exports.apply 是函数（桌面版 loader 形态）', plugin && typeof plugin.apply === 'function');
	} catch (error) {
		check('require() 可加载插件且 exports.apply 是函数（桌面版 loader 形态）', false);
		console.log('  ' + (error.code ?? '') + ' ' + String(error.message).split('\n')[0]);
	}
}

// —— 前置检查：undici 可用（devDependencies 已安装 / DSH 环境自带）——
try {
	await import('undici');
} catch {
	console.error('✗ 未找到 undici —— 请先在仓库内执行: pnpm install');
	process.exit(1);
}

const { apply } = await import('./index.mjs');
const { normalizeProxyUrl, DispatcherPool } = await import('./transport.mjs');

/* —— mock Cordis 上下文（无 inject → 文件模式直接生效）—— */
const logs = [];
let disposer = null;
const ctx = {
	effect: (fn) => { disposer = fn(); return disposer; },
	on: (event, cb) => { if (event === 'dispose') disposeCallback = cb; return () => {}; },
	logger: { info: (...a) => { logs.push(a.join(' ')); }, warn: (...a) => { logs.push(a.join(' ')); }, error: (...a) => { logs.push(a.join(' ')); } },
};
let disposeCallback = null;

/* —— 临时 DSH_HOME + 双代理配置—— */
const HOME = mkdtempSync(join(tmpdir(), 'dsh-proxy-test-'));
const CONFIG = join(HOME, 'proxy-routes.jsonc');
const configText = `{
	// 双代理池：main=50939（SOCKS5）backup=50018（SOCKS5）
	"proxies": {
		"main": "socks5://127.0.0.1:50939",
		"backup": "socks5://127.0.0.1:50018"
	},
	"default": "direct",
	"logRequests": true,
	"routes": [
		{ "domains": ["anthropic.com", "claude.ai"], "via": "main" },
		{ "domains": ["integrate.api.nvidia.com"], "via": "backup" },
		{ "domains": ["open.bigmodel.cn", "bigmodel.cn", "deepseek.com"], "via": "direct" }
	]
}`;
writeFileSync(CONFIG, configText, 'utf8');
process.env.DSH_HOME = HOME;

const assertLog = (substr) => logs.some((line) => line.includes(substr));

/* —— 1. 文件模式加载 —— */
const originalFetch = globalThis.fetch;
apply(ctx, {});
await delay(600);
check('fetch 已被补丁替换', globalThis.fetch !== originalFetch);
check('加载日志：配置已加载', assertLog('配置已加载'));
check('加载日志：代理池含 main 与 backup', assertLog('代理池=[main,backup]'));
check('加载日志：文件来源', assertLog('来源=配置文件'));

/* —— 2~4. 网络路由（401/400 = 经代理抵达服务端；直连=401）—— */
try {
	const r1 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	check('anthropic 经 main(50939) -> 401（直连为 403）', r1.status === 401);
} catch (e) { check('anthropic 经 main(50939)', false); console.log('  ' + (e.cause?.message ?? e.message)); }
try {
	const r2 = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	check('nvidia 经 backup(50018) -> 400/401/404', [400, 401, 404].includes(r2.status));
} catch (e) { check('nvidia 经 backup(50018)', false); console.log('  ' + (e.cause?.message ?? e.message)); }
try {
	const r3 = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	check('bigmodel 直连 -> 401', r3.status === 401);
} catch (e) { check('bigmodel 直连', false); console.log('  ' + (e.cause?.message ?? e.message)); }
check('路由日志：anthropic -> main', logs.some((l) => l.includes('api.anthropic.com/v1/messages -> main:socks5://127.0.0.1:50939')));
check('路由日志：nvidia -> backup', logs.some((l) => l.includes('integrate.api.nvidia.com/v1/chat/completions -> backup:socks5://127.0.0.1:50018')));

/* —— 5. 热重载：把 anthropic 改走 backup —— */
logs.length = 0;
writeFileSync(CONFIG, configText.replace('"via": "main"', '"via": "backup"'), 'utf8');
await delay(1200);
check('热重载：新配置日志（无 announce）+ anthropic -> backup 路由日志', await (async () => {
	try {
		await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	} catch { /* ignore */ }
	return logs.some((l) => l.includes('api.anthropic.com/v1/messages -> backup:socks5://127.0.0.1:50018'));
})());

/* —— 6. 卸载还原 —— */
disposeCallback?.();
check('卸载后 fetch 还原', globalThis.fetch === originalFetch);

/* —— 7. 单元：normalizeProxyUrl —— */
try {
	const u1 = normalizeProxyUrl('socks5h://127.0.0.1:1080', 't');
	check('socks5h 归一化为 socks5', u1.protocol === 'socks5:');
	const u2 = normalizeProxyUrl('socks://u:p@127.0.0.1:1080', 't');
	check('socks:// 认证信息保留', u2.username === 'u' && u2.password === 'p');
} catch { check('normalizeProxyUrl', false); }
try {
	normalizeProxyUrl('ftp://127.0.0.1:21', 't');
	check('ftp:// 拒绝（协议不支持）', false);
} catch (e) {
	check('ftp:// 拒绝（协议不支持）', String(e.message).includes('协议不支持'));
}

/* —— 8. 单元：dispatcher 池 —— */
{
	const pool = new DispatcherPool();
	const url1 = normalizeProxyUrl('socks5://127.0.0.1:50939', 't');
	const wanted = new Map([[url1.href, url1]]);
	pool.rebuild(wanted);
	const d1 = pool.get(url1);
	pool.rebuild(new Map([[url1.href, url1]]));
	check('dispatcher 池：同 URL 复用（不重建）', pool.get(url1) === d1);
	pool.close();
}

/* —— 9. 单元：导出的 Config schema（0.1.7 从它派生条目表单；写入只接受 volatile 字段）—— */
{
	const require_ = createRequire(import.meta.url);
	const plugin = require_('./index.mjs');
	const schema = plugin.Config;
	check('Config schema 导出（0.1.7 settings 派生依赖）', Boolean(schema) && schema.type === 'object');
	check('Config schema：proxies / providerRoutes / routes 为 volatile dict/list',
		schema?.dict?.proxies?.meta?.volatile === true
		&& schema?.dict?.providerRoutes?.meta?.volatile === true
		&& schema?.dict?.routes?.meta?.volatile === true);
	check('Config schema：configFile / trustedOrigins 非 volatile（改它们应重挂载）',
		!schema?.dict?.configFile?.meta?.volatile && !schema?.dict?.trustedOrigins?.meta?.volatile);
}

/* —— 9b. 集成：0.1.7 settings 模式（seam 无 register）+ 按提供商（密钥）分流 ——
   同一 api.anthropic.com 的两个账号：claude1 走 main(50939) 得 401，claude2 显式
   direct 得 403，无密钥请求落默认走向——「同域多账号各走各路」的端到端回归；
   并断言密钥绝不落日志（安全规则回归）。 */
{
	const KEY1 = 'sk-test-claude1-dpr', KEY2 = 'sk-test-claude2-dpr';
	process.env.DPR_TEST_K1 = KEY1;
	process.env.DPR_TEST_K2 = KEY2;
	const HOME2 = mkdtempSync(join(tmpdir(), 'dsh-proxy-test2-'));
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = HOME2; // 无配置文件 → settings 模式

	const webRoutes = [];
	const settingsRows = () => ([
		{
			ns: 'proxy-routes',
			value: {
				proxies: { main: 'socks5://127.0.0.1:50939' },
				providerRoutes: { claude1: 'main', claude2: 'direct' },
				default: 'direct',
				logRequests: true,
			},
		},
		{
			ns: 'llm-pi-ai',
			value: {
				providers: {
					claude1: { apiKeyEnv: 'DPR_TEST_K1', baseURL: 'https://api.anthropic.com', displayName: 'Claude #1', models: [{ id: 'claude-x', name: 'Claude X' }] },
					claude2: { apiKeyEnv: 'DPR_TEST_K2', baseURL: 'https://api.anthropic.com', displayName: 'Claude #2', models: [{ id: 'claude-y', name: 'Claude Y' }] },
				},
			},
		},
	]);
	const fakeSeam = { describe: () => settingsRows(), mutate: async () => { throw new Error('test seam: mutate not expected'); } };
	const dispose2 = [];
	const ctx2 = {
		effect: (fn) => { const d = fn(); dispose2.push(d); return d; },
		on: () => () => {},
		get: () => undefined, // credentials 服务不可用 → process.env 兜底
		inject: (deps, cb) => {
			const child = {
				effect: (fn) => { const d = fn(); dispose2.push(d); return d; },
				settings: fakeSeam,
				webServer: { register: (route) => { webRoutes.push(route); return () => {}; } },
			};
			cb(child);
			return child;
		},
		logger: ctx.logger,
	};

	await apply(ctx2, {});
	await delay(300); // rebuildKeyRoutes 异步完成
	check('0.1.7 settings（无 register）：桥接 5 条路由已挂载', webRoutes.filter((r) => r.kind === 'exact').length === 5);

	let r1 = null, r2 = null, r3 = null;
	try { r1 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY1, 'content-type': 'application/json' }, body: '{}' }); }
	catch (e) { console.log('  claude1: ' + (e.cause?.message ?? e.message)); }
	check('同域双账号：claude1 经 main(50939) -> 401', r1 !== null && r1.status === 401);
	try { r2 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY2, 'content-type': 'application/json' }, body: '{}' }); }
	catch (e) { console.log('  claude2: ' + (e.cause?.message ?? e.message)); }
	check('同域双账号：claude2 显式直连 -> 403（同一 URL 仅密钥不同）', r2 !== null && r2.status === 403);
	try { r3 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); }
	catch (e) { console.log('  nokey: ' + (e.cause?.message ?? e.message)); }
	check('无密钥请求：未命中提供商 → 默认直连 403', r3 !== null && r3.status === 403);
	check('路由日志：claude1=>main（提供商名入日志）', logs.some((l) => l.includes('claude1=>main:socks5://127.0.0.1:50939')));
	check('安全回归：密钥值绝不落日志', !logs.some((l) => l.includes(KEY1) || l.includes(KEY2)));

	// bridge describe：providers 行（hasKey + host），且不含密钥本体
	const describeRoute = webRoutes.find((r) => r.path.endsWith('/describe'));
	if (describeRoute) {
		const resMock = { statusCode: null, body: '', writeHead(code) { this.statusCode = code; }, end(b) { this.body = String(b); } };
		await describeRoute.handler(
			{ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:43120' }, on: () => {} },
			resMock,
		);
		let described = null;
		try { described = JSON.parse(resMock.body); } catch { /* ignore */ }
		const providers = described?.value?.providers ?? [];
		check('bridge describe：providers 含 claude1/claude2（hasKey + host）',
			providers.length === 2
			&& providers.every((p) => p.hasKey === true && p.host === 'api.anthropic.com' && typeof p.id === 'string'));
		check('bridge describe：不含密钥本体', !resMock.body.includes(KEY1) && !resMock.body.includes(KEY2));
		check('bridge describe：settingsAvailable 标记', described?.value?.settingsAvailable === true);
	} else {
		check('bridge describe 路由存在', false);
	}

	for (const d of dispose2.splice(0)) { try { d?.(); } catch { /* ignore */ } }
	delete process.env.DPR_TEST_K1;
	delete process.env.DPR_TEST_K2;
	process.env.DSH_HOME = previousHome;
	rmSync(HOME2, { recursive: true, force: true });
}

/* —— 10. 浏览器端 client 模块形态回归（v0.3.1.1 事故）——
   esbuild iife 丢弃 ESM 导出 → factory 产出空 module.exports → 浏览器 loader
   报 "invalid plugin" 并在 DSH 启动页弹错（host 半边正常，极易误判）。这里
   完整模拟浏览器 ModuleLoader：执行 bundle 注册、真实 materialize factory、
   断言导出形态。react 走工作区 devDependency。 */
let registration = null;
try {
	const bundle = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8');
	const queue = [];
	globalThis.window = globalThis;
	globalThis.__ModuleLoader__ = { mode: 'queue', pendingQueue: queue, load: (reg) => { queue.push(reg); } };
	// 执行 bundle（只注册 factory，不运行模块体）
	new Function(bundle)();
	registration = queue.find((r) => r && r.id === 'dsh-proxy-routes');
	check('client bundle：注册到 __ModuleLoader__（id=dsh-proxy-routes）', Boolean(registration));
} catch (error) {
	check('client bundle：注册到 __ModuleLoader__（id=dsh-proxy-routes）', false);
	console.log('  ' + (error.code ?? '') + ' ' + String(error.message).split('\n')[0]);
}

/* —— 11. client apply 协议冒烟（2.0.14 卡片不显示事故）——
   2.0.13 的挂载点是 settings.plugin.item（keyed），2.0.14 改为 plugins.item
   （官方插件页，id/order/label + view:summary|page）。错配协议 = 卡片注册进
   无人消费的 slot，UI 上"插件已装但配置不出现"。这里 mock 客户端 ctx 执行
   真实 apply，断言两代协议的注册形态。 */
if (registration) {
	try {
		const realRequire = createRequire(new URL('./node_modules/react/package.json', import.meta.url));
		const exports = registration.factory((spec) => realRequire(spec));
		const registered = []; // slots.register 捕获：[options, component]
		const dict = { title: '代理路由', description: 'desc' };
		const t = (key) => dict[key] ?? key;
		const runInject = (gen) => {
			const result = typeof gen === 'function' ? gen() : gen;
			if (result && typeof result[Symbol.iterator] === 'function') {
				// generator 形态（2.0.13）：register 在 yield 求值时已被下面的 mock 捕获
				for (const _ of result) { void _; }
			}
		};
		const ctx = {
			effect: (fn) => () => { fn(); },
			locale: { register: () => () => {}, bind: () => t },
			slots: {
				inject: (slot, gen) => { runInject(gen); return () => {}; },
				register: (options, component) => { registered.push([options, component]); return () => {}; },
			},
		};
		exports.apply(ctx);
		check('client bundle：factory 导出 apply 函数与 inject 服务数组', typeof exports.apply === 'function' && JSON.stringify(exports.inject) === JSON.stringify(['slots', 'locale']));
		const modern = registered.find(([o]) => o.name === 'plugins.item');
		check('client apply：注册 plugins.item 且带 id/order/label（2.0.14 官方插件页形态）',
			Boolean(modern) && modern[0].id === 'proxy-routes' && typeof modern[0].order === 'number' && typeof modern[0].label === 'function' && typeof modern[0].label() === 'string');
		const section = registered.find(([o]) => o.name === 'settings.section');
		check('client apply：注册 settings.section 独立设置页（保底入口，带 id/label）',
			Boolean(section) && section[0].id === 'proxy-routes' && typeof section[0].label === 'function' && typeof section[0].label() === 'string');
		const legacy = registered.find(([o]) => o.name === 'settings.plugin.item');
		check('client apply：注册 settings.plugin.item 且带 key（2.0.13 keyed slot 形态）',
			Boolean(legacy) && legacy[0].key === 'proxy-routes');
		check('client apply：组件支持 view:summary/page 渲染分支', typeof modern?.[1] === 'function');
	} catch (error) {
		check('client apply 协议冒烟', false);
		console.log('  ' + (error.code ?? '') + ' ' + String(error.message).split('\n')[0]);
	}
}

/* —— 清理 —— */
try { disposer?.(); } catch { /* ignore */ }
rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败, ${skip} 跳过`);
process.exit(fail > 0 ? 1 : 0);
