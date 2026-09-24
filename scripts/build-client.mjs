// dsh-proxy-routes —— 客户端构建：esbuild 打包 src/client/index.tsx 为
// DSH 前端模块形态 window.__ModuleLoader__.load({ id, factory: (require) => {...} })。
//
// 与官方 client 包（@deepseek-ai/dsh-client-*）及 dsh-llm-proxy 的 lib/client.js
// 同构：react / react/jsx-runtime 声明 external，运行时由 ModuleLoader 的
// require 提供；产物随包发布（files 含 lib/client.js），用户无需构建。
//
// **导出桥**：esbuild 的 iife 模式会直接丢弃 ESM 导出（v0.3.0 的产物因此
// module.exports 为空对象，浏览器端 loader 报 "invalid plugin, received
// object" 并在 DSH 启动页持续弹错）。用 globalName 让 esbuild 生成完整的
// exports 对象，再在 footer 里把它桥回 module.exports。
import esbuild from 'esbuild'

const banner = [
	'window.__ModuleLoader__.load({',
	'\tid: "dsh-proxy-routes",',
	'\tfactory: (require) => {',
	'\t\tvar module = { exports: {} };',
	'\t\tvar exports = module.exports;',
	'\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
].join('\n')

const footer = [
	'',
	'\t\tmodule.exports = dshProxyRoutesClient;',
	'\t\treturn module.exports;',
	'\t}',
	'});',
	'',
].join('\n')

const result = await esbuild.build({
	entryPoints: ['src/client/index.tsx'],
	outfile: 'lib/client.js',
	bundle: true,
	format: 'iife',
	globalName: 'dshProxyRoutesClient',
	jsx: 'automatic',
	external: ['react', 'react/jsx-runtime'],
	target: ['es2022'],
	minify: true,
	sourcemap: false,
	banner: { js: banner },
	footer: { js: footer },
	logLevel: 'info',
	write: true,
})

// 静态断言：产物必须真的把导出桥回 module.exports（否则浏览器 loader 会拿到空对象）
const { readFileSync } = await import('node:fs')
const text = readFileSync('lib/client.js', 'utf8')
const hasWrapper = text.startsWith('window.__ModuleLoader__.load({')
const hasExportAssignment = /exports\.apply\s*=|dshProxyRoutesClient\s*=/.test(text)
if (!hasWrapper || !hasExportAssignment) {
	console.error(`lib/client.js 构建自检失败：wrapper=${hasWrapper} exports桥=${hasExportAssignment}`)
	process.exit(1)
}
console.log('lib/client.js 已构建（window.__ModuleLoader__ 形态，导出桥自检通过）')
