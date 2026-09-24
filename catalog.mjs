// dsh-proxy-routes — 模型目录：把「按模型设置代理」的意图编译成 host 级路由。
//
// DSH 的 LLM 流量最终落到 globalThis.fetch，fetch 层只能看到目标 URL——因此
// 「模型 → 代理」在传输层的实现语义是「模型 → 其 provider 的 baseURL host → 代理」。
// 同一 host 下的所有模型共享同一路由（与官方模型选择器的 host 解析一致，也是
// dsh-llm-proxy 的既有语义）；编译时发现冲突（同 host 的模型被分到不同代理）会
// 返回冲突清单，由设置页卡片按 host 分组展示并提示。
//
// 目录来源（与官方模型选择器对齐）：
//   1. settings 的 `llm-pi-ai.providers.<id>`：baseURL + 显式 models
//   2. provider 未写 models 时回退 pi-ai 内置目录（@earendil-works/pi-ai）
//   3. `llm-deepseek` 官方命名空间（https://api.deepseek.com）

/** pi-ai 内置目录（懒加载后的读面）。 */
let loaded = null;
let loading = null;

/** 同步读一个 provider 的内置模型目录；未加载完成时返回 null。 */
export function catalogBuiltinModels(providerId) {
	if (loaded === null) return null;
	try {
		return loaded.getBuiltinModels(providerId);
	} catch {
		return [];
	}
}

/** 确保内置目录已加载（幂等、永不 reject；不可用时目录读为空）。 */
export async function ensurePiAiCatalog() {
	if (loaded !== null || loading !== null) return loading ?? loaded;
	loading = import('@earendil-works/pi-ai/providers/all')
		.then((mod) => {
			loaded = { getBuiltinModels: mod.getBuiltinModels };
			return loaded;
		})
		.catch(() => {
			loaded = { getBuiltinModels: () => [] };
			return loaded;
		})
		.finally(() => {
			loading = null;
		});
	return loading;
}

/** 测试钩子：替换内置目录读面。 */
export function __setCatalogForTest(getBuiltinModels) {
	loaded = getBuiltinModels == null ? { getBuiltinModels: () => [] } : { getBuiltinModels };
	loading = null;
}

/** baseURL 的 hostname；解析失败返回 ''。 */
function hostOf(baseURL) {
	try {
		return new URL(baseURL).hostname.toLowerCase();
	} catch {
		return '';
	}
}

/**
 * 列出全部可选模型（设置页卡片的模型列表）。
 * @param {import('@deepseek-ai/dsh-settings').Settings} settings host settings seam
 * @returns {{key: string, providerId: string, modelId: string, name: string,
 *            providerLabel: string, host: string}[]} 按 provider 分组的模型行
 */
export function listModels(settings) {
	const rows = [];
	try {
		const descriptors = settings.describe({ redactSecrets: true });
		for (const descriptor of descriptors) {
			const ns = String(descriptor.ns);
			const value = descriptor.value;
			if (typeof value !== 'object' || value === null) continue;
			if (ns === 'llm-pi-ai' && typeof value.providers === 'object' && value.providers !== null) {
				for (const [providerId, profile] of Object.entries(value.providers)) {
					if (typeof profile !== 'object' || profile === null) continue;
					const host = hostOf(typeof profile.baseURL === 'string' ? profile.baseURL : '');
					const providerLabel = typeof profile.displayName === 'string' && profile.displayName.length > 0
						? profile.displayName
						: providerId;
					const models = Array.isArray(profile.models) ? profile.models : [];
					const explicitIds = models.length > 0 ? models.map((m) => m?.id).filter(Boolean) : [];
					const catalog = explicitIds.length > 0 ? null : catalogBuiltinModels(providerId);
					const catalogRows = Array.isArray(catalog) && catalog.length > 0 ? catalog : [];
					const listed = explicitIds.length > 0
						? models.filter((m) => typeof m?.id === 'string' && m.id.length > 0)
						: catalogRows.filter((m) => typeof m?.id === 'string' && m.id.length > 0);
					for (const model of listed) {
						rows.push({
							key: `${providerId}/${model.id}`,
							providerId,
							modelId: model.id,
							name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
							providerLabel,
							host,
						});
					}
				}
			} else if (ns === 'llm-deepseek' && typeof value.models === 'object' && value.models !== null) {
				// 官方 DeepSeek：host 固定 api.deepseek.com；models 是对象还是数组
				// 取决于版本，两种都容忍
				const models = Array.isArray(value.models) ? value.models : Object.values(value.models);
				const listed = models.filter((m) => typeof m?.id === 'string' && m.id.length > 0);
				if (listed.length === 0) continue;
				for (const model of listed) {
					rows.push({
						key: `deepseek-official/${model.id}`,
						providerId: 'deepseek-official',
						modelId: model.id,
						name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
						providerLabel: 'DeepSeek',
						host: 'api.deepseek.com',
					});
				}
			}
		}
	} catch { /* settings 不可用时返回已收集的部分 */ }
	return rows;
}

/**
 * 把 `modelRoutes`（modelKey → via）编译成 host → via 的路由表。
 * 同一 host 的模型必须共享同一路由：冲突时后配置的胜出，并把冲突写进返回的
 * conflicts 列表（设置页据此提示用户「同域名模型共享路由」）。
 * @param {ReturnType<typeof listModels>} rows listModels 的输出
 * @param {Record<string, string>} modelRoutes modelKey → via（'direct' | 代理名 | 'proxy'）
 * @returns {{hostRoutes: Map<string, string>, conflicts: string[]}}
 */
export function compileModelRoutes(rows, modelRoutes) {
	const selected = new Map(Object.entries(modelRoutes ?? {}));
	const hostRoutes = new Map();
	const conflicts = [];
	const owner = new Map(); // host -> 首个赋予它路由的模型 key
	for (const row of rows) {
		const via = selected.get(row.key);
		if (via === undefined) continue;
		const priorVia = hostRoutes.get(row.host);
		if (priorVia === undefined) {
			hostRoutes.set(row.host, via);
			owner.set(row.host, row.key);
		} else if (priorVia !== via) {
			conflicts.push(`${row.key} 与 ${owner.get(row.host)} 同域名 ${row.host}，路由取 ${via}`);
			hostRoutes.set(row.host, via);
		}
	}
	// 未知模型 key（目录里没有）：忽略但记录
	for (const key of selected.keys()) {
		if (!rows.some((row) => row.key === key)) conflicts.push(`${key} 不在当前模型目录中，已忽略`);
	}
	return { hostRoutes, conflicts };
}
