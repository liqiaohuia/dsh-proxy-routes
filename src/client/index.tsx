// dsh-proxy-routes —— 浏览器侧入口：把「代理路由」卡片注册进
// 设置 → 插件 → 可配置插件（settings.plugin.item slot，由
// @deepseek-ai/dsh-client-ui-settings-plugins 运行时声明）。
//
// 数据面见 Card.tsx：卡片走本插件 host 侧的同源回环桥，不依赖官方
// settings 传输对第三方命名空间的透出（rc.6 apiproxy 白名单不含它）。
import { ProxyRoutesCard } from './Card.tsx'
import { en, zh } from './locales.ts'

export type { Translate } from './Card.tsx'

/** 文案命名空间（locale 服务注册/绑定用）。 */
const NS = 'settings.proxy-routes'

/** 需要的客户端服务（与 package.json 的 dsh.client.inject 一致）。 */
export const inject = ['slots', 'locale']

interface LocaleCtx {
	register(ns: string, dict: Record<string, unknown>): () => void
	bind(ns: string): (key: string, values?: Record<string, string | number>) => string
}

interface SlotsCtx {
	inject(slot: string, gen: () => Generator): () => void
	register(item: { name: string; key: string; locale: string; inject: () => unknown }, component: unknown): () => void
}

interface ClientContext {
	effect(fn: () => () => void, label?: string): () => void
	locale: LocaleCtx
	slots: SlotsCtx
}

/**
 * 注册卡片。ctx 结构与 dsh-llm-proxy 的客户端入口一致：locale 注册双语
 * 文案，slots.inject 在 `settings.plugin.item` 声明上落后把卡片挂进去。
 */
export function apply(ctx: ClientContext): void {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-proxy-routes: copy dictionaries')

	const t = ctx.locale.bind(NS)
	ctx.slots.inject('settings.plugin.item', function* () {
		yield ctx.slots.register({
			name: 'settings.plugin.item',
			key: 'proxy-routes',
			// rc.7 起 keyed slot 按 namespace key 派发；locale 供宿主渲染标题。
			locale: NS,
			inject: () => ({ t }),
		}, ProxyRoutesCard)
	})
}
