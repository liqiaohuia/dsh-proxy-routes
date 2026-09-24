// dsh-proxy-routes —— v0.3 测试脚本（无依赖，直接 node 运行）。
// 覆盖：require 兼容回归（防桌面版 invalid plugin 事故）/ 文件模式加载 /
// 双代理池路由 / 直连 / 模型路由编译（单元）/ normalizeProxyUrl 归一化（单元）/
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
const { compileModelRoutes } = await import('./catalog.mjs');

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

/* —— 9. 单元：compileModelRoutes —— */
{
	const rows = [
		{ key: 'p1/m1', host: 'a.example.com' },
		{ key: 'p1/m2', host: 'a.example.com' },
		{ key: 'p2/m1', host: 'b.example.com' },
	];
	const { hostRoutes, conflicts } = compileModelRoutes(rows, { 'p1/m1': 'main', 'p1/m2': 'backup', 'p2/m1': 'direct', 'p9/m9': 'x' });
	check('模型路由：同 host 冲突时后者胜出', hostRoutes.get('a.example.com') === 'backup');
	check('模型路由：direct 显式生效', hostRoutes.get('b.example.com') === 'direct');
	check('模型路由：未知 key 记入 conflicts', conflicts.some((c) => c.includes('p9/m9')));
	check('模型路由：host 冲突记入 conflicts', conflicts.some((c) => c.includes('同域名')));
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
