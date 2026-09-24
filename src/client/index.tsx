// dsh-proxy-routes —— 浏览器侧入口：把「代理路由」配置页注册进 DSH 前端。
//
// 三个挂载点（多协议，兼容两个桌面版代次 + 保底入口）：
//  1. `settings.section`：设置页里的独立导航项「代理路由」（官方「常规」
//     /「内置插件」/ dshmarket「插件市场」同款协议）——不依赖插件页的
//     form 机制，任何版本都渲染完整卡片，是保底配置入口。
//  2. DSH Desktop 2.0.14（dsh 0.1.5+）`plugins.item`：官方插件页（侧栏
//     Plugins / 插件详情）消费，形态见 dsh-cordis-client-runner 内置示例
//     （slots.register({ name:'plugins.item', id, order, label, locale }, C)）。
//     详情页会以 view:"summary"（简介行）与 view:"page"（配置区）渲染。
//  3. DSH Desktop 2.0.13（dsh 0.1.5-rc.2）`settings.plugin.item`：设置 →
//     插件 的 keyed slot（dsh-llm-proxy 同款形态）。
// 多余注册无人消费时静默，无害。
//
// 数据面见 Card.tsx：卡片走本插件 host 侧的同源回环桥，不依赖官方
// settings 传输对第三方命名空间的透出（rc.6 apiproxy 白名单不含它）。
import { ProxyRoutesCard, ProxyRoutesSettingsSection } from './Card.tsx'
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

interface RegisterOptions {
	name: string
	id?: string
	key?: string
	order?: number
	locale?: string
	label?: () => string
	inject?: () => unknown
}

interface SlotsCtx {
	inject(slot: string, gen: () => Generator | (() => unknown)): () => void
	register(item: RegisterOptions, component: unknown): () => void
}

interface ClientContext {
	effect(fn: () => () => void, label?: string): () => void
	locale: LocaleCtx
	slots: SlotsCtx
}

/**
 * 注册配置页。locale 注册双语文案；slots.inject 在对应 slot 声明落地后
 * 把卡片挂进去（两个协议各注册一份，见文件头注释）。
 */
export function apply(ctx: ClientContext): void {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-proxy-routes: copy dictionaries')

	const t = ctx.locale.bind(NS)

	// 独立设置页（保底入口）：设置 → 代理路由。官方「常规 / 内置插件」与
	// dshmarket「插件市场」同款 settings.section 协议；渲染时 props 收到
	// { ...inject() 结果, close }（官方 ui-settings 的 renderSlot 形态）。
	ctx.slots.inject('settings.section', () => ctx.slots.register({
		name: 'settings.section',
		id: 'proxy-routes',
		order: 16,
		locale: NS,
		label: () => t('title'),
		inject: () => ({ t }),
	}, ProxyRoutesSettingsSection))

	// 2.0.14+：官方插件页的配置卡。回调直接返回 disposer（官方 companion
	// 同款形态）；label 是函数，由宿主在渲染列表/详情标题时求值。
	ctx.slots.inject('plugins.item', () => ctx.slots.register({
		name: 'plugins.item',
		id: 'proxy-routes',
		order: 100,
		locale: NS,
		label: () => t('title'),
		inject: () => ({ t }),
	}, ProxyRoutesCard))

	// 2.0.13（-rc.2）：设置 → 插件 的 keyed slot（generator 形态）。
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
