// 插件单元测试：mock Cordis ctx，验证 fetch 补丁、分流、SSE 流式、热重载、卸载还原
import { apply } from './index.mjs';
import { readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 路径全部相对本文件解析 —— 目录整体搬到任何位置测试都能跑
const HERE = fileURLToPath(new URL('./', import.meta.url));
const TEST_HOME = HERE + '.test-home';
const SRC = HERE + 'proxy-routes.jsonc';
const CFG = TEST_HOME + '/proxy-routes.jsonc';
const key = readFileSync(`${homedir()}/.dsh/.credentials.yaml`, 'utf8').match(/ANTHROPIC_API_KEY:\s*(\S+)/)[1];

const logs = [];
const disposers = [];
const ctx = {
	effect: (fn) => { const d = fn(); disposers.push(d); return d; },
	logger: {
		// 只负责捕获（断言用）；控制台输出由插件自身的 makeLogger 直接打印
		info: (...a) => { logs.push(a.join(' ')); },
		warn: (...a) => { logs.push(a.join(' ')); },
		error: (...a) => { logs.push(a.join(' ')); },
	},
};

rmSync(TEST_HOME, { recursive: true, force: true });
const { mkdirSync } = await import('node:fs');
mkdirSync(TEST_HOME, { recursive: true });
copyFileSync(SRC, CFG);
process.env.DSH_HOME = TEST_HOME;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok) => { console.log(`${ok ? '✅' : '❌'} ${label}`); ok ? pass++ : fail++; };

console.log('=== 1. apply + 初始加载 ===');
apply(ctx, {});
await sleep(800);
check('配置已加载日志', logs.some((l) => l.includes('配置已加载')));
check('fetch 已被打补丁', typeof globalThis.fetch === 'function' && globalThis.fetch.name === 'dshProxyRoutedFetch');

console.log('=== 2. 直连请求（智谱，走原始 fetch） ===');
try {
	const r = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'glm-4.7', messages: [{ role: 'user', content: 'hi' }] }),
	});
	check(`直连请求到达智谱（期望 401，实际 ${r.status}）`, r.status === 401);
} catch (e) {
	check(`直连请求到达智谱（异常: ${e.message}）`, false);
}

console.log('=== 3. 代理请求（Anthropic SSE 流式） ===');
try {
	const r = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
			accept: 'text/event-stream',
		},
		body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 24, stream: true, messages: [{ role: 'user', content: 'Reply with exactly: PROXY-OK' }] }),
	});
	check(`代理请求状态 200（实际 ${r.status}）`, r.status === 200);
	check('响应体是可读流', typeof r.body?.getReader === 'function');
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let text = '', chunks = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks++;
		text += dec.decode(value, { stream: true });
	}
	check(`SSE 多块接收（${chunks} 块）`, chunks > 1);
	check('包含 message_start 事件', text.includes('message_start'));
	check('代理请求日志出现', logs.some((l) => l.includes('api.anthropic.com')));
} catch (e) {
	check(`代理请求失败: ${e.message}`, false);
}

console.log('=== 4. AbortSignal 中止 ===');
try {
	const ctrl = new AbortController();
	const p = fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		signal: ctrl.signal,
		headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
	});
	setTimeout(() => ctrl.abort(), 30);
	await p;
	check('中止后不应 resolve', false);
} catch (e) {
	check(`中止抛 AbortError（实际 ${e.name}）`, e.name === 'AbortError');
}

console.log('=== 5. keep-alive 连接复用（第二次请求更快） ===');
try {
	const t0 = Date.now();
	const r2 = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
		body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
	});
	const elapsed = Date.now() - t0;
	check(`复用连接请求成功（${r2.status}，${elapsed}ms）`, r2.status === 200);
} catch (e) {
	check(`复用连接失败: ${e.message}`, false);
}

console.log('=== 6. 配置热重载 ===');
logs.length = 0;
writeFileSync(CFG, JSON.stringify({
	proxy: 'socks5://127.0.0.1:50018',
	default: 'direct',
	routes: [{ domains: ['anthropic.com'], via: 'direct' }],
}));
await sleep(1200);
try {
	const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'GET' });
	// 直连 anthropic 期望被 403（地区封锁）
	check(`规则热更新后 anthropic 直连（期望 403，实际 ${r.status}）`, r.status === 403);
} catch (e) {
	check(`规则热更新后 anthropic 直连（异常: ${e.message}）`, false);
}
// 恢复代理规则
writeFileSync(CFG, readFileSync(SRC, 'utf8'));
await sleep(1200);

console.log('=== 7. 坏配置回退 ===');
logs.length = 0;
// 先切到 anthropic 直连规则，再写坏配置 —— 期望保留「直连」这份最后的好配置
writeFileSync(CFG, JSON.stringify({
	proxy: 'socks5://127.0.0.1:50018',
	default: 'direct',
	routes: [{ domains: ['anthropic.com'], via: 'direct' }],
}));
await sleep(1200);
writeFileSync(CFG, '{ 这不是 JSON');
await sleep(1200);
check('坏配置报错且保留上一份', logs.some((l) => l.includes('语法错误') || l.includes('校验失败')));
try {
	const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'GET' });
	// 上一份（直连 anthropic 规则）仍生效
	check(`坏配置后仍用旧规则（期望 403，实际 ${r.status}）`, r.status === 403);
} catch (e) {
	check(`坏配置后仍用旧规则（异常: ${e.message}）`, false);
}
// https://（代理端 TLS）应被明确拒绝，同样保留上一份
// 注意 routes 必须含 via:"proxy" 的规则，校验才会检查 proxy 字段
writeFileSync(CFG, JSON.stringify({ proxy: 'https://127.0.0.1:50018', default: 'direct', routes: [{ domains: ['anthropic.com'], via: 'proxy' }] }));
await sleep(1200);
check('https 代理被明确拒绝', logs.some((l) => l.includes('https')));
try {
	const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'GET' });
	check(`https 拒绝后仍用旧规则（期望 403，实际 ${r.status}）`, r.status === 403);
} catch (e) {
	check(`https 拒绝后仍用旧规则（异常: ${e.message}）`, false);
}
writeFileSync(CFG, readFileSync(SRC, 'utf8'));
await sleep(1200);

console.log('=== 8. 卸载还原 ===');
for (const d of disposers.splice(0)) { try { d(); } catch (e) { console.log('  disposer error:', e.message); } }
await sleep(200);
check('fetch 已还原', globalThis.fetch.name !== 'dshProxyRoutedFetch');
try {
	const r = await fetch('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', { method: 'POST' });
	check(`还原后直连仍正常（期望 401，实际 ${r.status}）`, r.status === 401);
} catch (e) {
	check(`还原后直连（异常: ${e.message}）`, false);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* Windows 文件偶发占用时的良性残留 */ }
process.exit(fail > 0 ? 1 : 0);
