// dsh-proxy-routes —— 客户端构建：esbuild 打包 src/client/index.tsx 为
// DSH 前端模块形态 window.__ModuleLoader__.load({ id, factory: (require) => {...} })。
//
// 与官方 client 包（@deepseek-ai/dsh-client-*）及 dsh-llm-proxy 的 lib/client.js
// 同构：react / react/jsx-runtime 声明 external，运行时由 ModuleLoader 的
// require 提供；产物随包发布（files 含 lib/client.js），用户无需构建。
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
	'\t\treturn module.exports;',
	'\t}',
	'});',
	'',
].join('\n')

await esbuild.build({
	entryPoints: ['src/client/index.tsx'],
	outfile: 'lib/client.js',
	bundle: true,
	format: 'iife',
	jsx: 'automatic',
	external: ['react', 'react/jsx-runtime'],
	target: ['es2022'],
	minify: true,
	sourcemap: false,
	banner: { js: banner },
	footer: { js: footer },
	logLevel: 'info',
})

console.log('lib/client.js 已构建（window.__ModuleLoader__ 形态，react external）')
