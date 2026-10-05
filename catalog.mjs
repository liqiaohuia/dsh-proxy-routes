// dsh-proxy-routes — 模型目录：列出各提供商（账号）与其模型。
//
// DSH 的 LLM 流量最终落到 globalThis.fetch；v0.4 起路由按「提供商（账号）」
// 分流——每个请求的密钥头在 fetch 层识别提供商，因此这里只需要给出
// providerId → host 的目录事实（供设置页展示与测试按钮使用）。
//
// 目录来源（与官方模型选择器对齐）：
//   1. settings 的 `llm-pi-ai.providers.<id>`：baseURL + 显式 models
//      （dsh 0.1.7 起条目 id 可能不同——按 providers 形态识别，不硬编码 ns）
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
 * 列出全部可选模型（设置页卡片的提供商/模型列表）。
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
			// pi-ai 形态：providers 字典。0.1.5 的 ns 固定为 'llm-pi-ai'；0.1.7
			// 起为条目 id（可能不同）——按 profile 形态识别，避免硬编码。
			if (typeof value.providers === 'object' && value.providers !== null && !Array.isArray(value.providers)) {
				const profiles = Object.entries(value.providers).filter(([, profile]) =>
					profile !== null && typeof profile === 'object'
					&& (typeof profile.baseURL === 'string' || Array.isArray(profile.models)
						|| typeof profile.apiKeyEnv === 'string' || typeof profile.apiKey === 'string'));
				if (profiles.length === 0) continue;
				for (const [providerId, profile] of profiles) {
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
			} else if (ns.includes('deepseek') && typeof value.models === 'object' && value.models !== null) {
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
