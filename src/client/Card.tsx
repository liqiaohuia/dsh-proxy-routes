// dsh-proxy-routes —— 设置页卡片：代理池 / 按模型路由 / 域名规则 / 测试连接。
//
// 数据面：卡片不直接读写 settings 传输，而是走本插件 host 侧的同源回环桥
// /api/dsh-proxy-routes/settings/*（describe / mutate / test / migrate）。
// 文件模式（$DSH_HOME/proxy-routes.jsonc 存在）下卡片只读，提供一键迁移。
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

const BRIDGE = '/api/dsh-proxy-routes/settings'

export interface ModelRow {
	key: string
	providerId: string
	modelId: string
	name: string
	providerLabel: string
	host: string
}

export interface DomainRule {
	domains: string[]
	via: string
}

export interface DescribeValue {
	mode: 'file' | 'settings'
	configFile: string | null
	proxies: Record<string, string>
	singleProxy: string | null
	default: string
	modelRoutes: Record<string, string>
	routes: DomainRule[]
	logRequests: boolean
	probeUrl: string
	rows: ModelRow[]
}

export interface TestOutcome {
	ok: boolean
	key: string
	message?: string
	status?: number
	latencyMs?: number
	via?: string
}

type Translate = (key: string, values?: Record<string, string | number>) => string
export type { Translate }

async function postJson<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${BRIDGE}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const payload = await response.json().catch(() => ({ ok: false, code: 'bad-json' }))
	return payload as T
}

/* —— 内联样式（DSH 设计令牌 + 兜底）—— */
const S = {
	card: {
		border: '1px solid var(--dsw-alias-border-l2,#d0d7de)',
		background: 'var(--dsw-alias-bg-layer-3,#fff)',
		borderRadius: '12px',
		transition: 'border-color .16s,background .16s',
		overflow: 'hidden',
	} as const,
	body: {
		borderTop: '1px solid var(--dsw-alias-border-l2,#d0d7de)',
		display: 'flex',
		flexDirection: 'column' as const,
		gap: '14px',
		margin: '0 16px',
		padding: '14px 0 16px',
	},
	section: {
		display: 'flex',
		flexDirection: 'column' as const,
		gap: '6px',
	},
	sectionTitle: {
		fontSize: '13px',
		fontWeight: 600,
		color: 'var(--dsw-alias-label-primary,#1f2329)',
	},
	hint: {
		fontSize: '12px',
		color: 'var(--dsw-alias-label-tertiary,#6b7280)',
		lineHeight: 1.45,
	},
	warn: {
		fontSize: '12px',
		color: 'var(--dsw-alias-label-warning,#9a6700)',
		lineHeight: 1.45,
	},
	row: {
		display: 'flex',
		gap: '8px',
		alignItems: 'center' as const,
	},
	input: {
		boxSizing: 'border-box' as const,
		border: '1px solid var(--dsw-alias-border-l2,#d0d7de)',
		background: 'var(--dsw-alias-bg-layer-2,#f6f8fa)',
		width: '100%',
		color: 'var(--dsw-alias-label-primary,#1f2329)',
		borderRadius: '6px',
		padding: '6px 8px',
		fontSize: '13px',
		minWidth: 0,
	},
	inputNarrow: { flex: '0 0 110px' } as const,
	button: {
		flex: 'none',
		border: '1px solid var(--dsw-alias-border-l2,#d0d7de)',
		background: 'var(--dsw-alias-bg-layer-2,#f6f8fa)',
		color: 'var(--dsw-alias-label-primary,#1f2329)',
		borderRadius: '6px',
		padding: '5px 10px',
		fontSize: '12px',
		cursor: 'pointer',
	} as const,
	buttonPrimary: {
		flex: 'none',
		border: 'none',
		background: 'var(--dsw-alias-state-business-primary,#4f8cff)',
		color: '#fff',
		borderRadius: '6px',
		padding: '6px 14px',
		fontSize: '13px',
		cursor: 'pointer',
	} as const,
	badge: {
		flex: 'none',
		fontSize: '11px',
		color: 'var(--dsw-alias-label-tertiary,#6b7280)',
		border: '1px solid var(--dsw-alias-border-l2,#d0d7de)',
		borderRadius: '999px',
		padding: '1px 8px',
		whiteSpace: 'nowrap' as const,
	} as const,
	label: {
		fontSize: '13px',
		color: 'var(--dsw-alias-label-secondary,#57606a)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
		flex: 1,
		minWidth: 0,
	} as const,
	groupHead: {
		fontSize: '12px',
		color: 'var(--dsw-alias-label-tertiary,#6b7280)',
		marginTop: '4px',
	},
	statusOk: { color: 'var(--dsw-alias-label-success,#1a7f37)', fontSize: '12px', whiteSpace: 'nowrap' as const },
	statusBad: { color: 'var(--dsw-alias-label-danger,#cf222e)', fontSize: '12px', whiteSpace: 'nowrap' as const },
}

/** 测试结果（key = 代理名或模型 key）。 */
type TestMap = Record<string, { pending?: boolean } & Partial<TestOutcome>>

/** 渲染形态：summary = 官方插件详情页的一行简介（父容器是 <p>，只能内联文本）；page/缺省 = 完整配置卡。 */
type CardView = 'summary' | 'page' | undefined

/**
 * 卡片入口。本身不含 hooks，可按 view 提前分支（React Hook 规则）。
 * 官方插件页（plugins.item）的详情里 summary 父容器是 <p>——必须内联文本。
 */
export function ProxyRoutesCard({ t, view }: { t: Translate; view?: CardView }): ReactNode {
	if (view === 'summary') return t('description')
	return <ProxyRoutesEditor t={t} />
}

/**
 * 独立设置页（settings.section，保底入口）：设置 → 代理路由。
 * 自身不含 hooks；完整编辑器在 ProxyRoutesEditor 里。
 */
export function ProxyRoutesSettingsSection({ t }: { t: Translate }): ReactNode {
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--dsw-alias-label-primary)' }}>
			<p style={{ margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' }}>{t('description')}</p>
			<ProxyRoutesEditor t={t} />
		</div>
	)
}

function ProxyRoutesEditor({ t }: { t: Translate }): ReactNode {
	const [value, setValue] = useState<DescribeValue | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [draft, setDraft] = useState<DescribeValue | null>(null)
	const [saving, setSaving] = useState(false)
	const [saveMsg, setSaveMsg] = useState<string | null>(null)
	const [tests, setTests] = useState<TestMap>({})
	const [migrating, setMigrating] = useState(false)

	const load = useCallback(async () => {
		try {
			const payload = await postJson<{ ok: boolean; value?: DescribeValue; message?: string }>('/describe')
			if (payload.ok && payload.value) {
				setValue(payload.value)
				setDraft(payload.value)
				setError(null)
			} else {
				setError(payload.message ?? t('loadFailed'))
			}
		} catch {
			setError(t('loadFailed'))
		}
	}, [t])

	useEffect(() => { void load() }, [load])

	if (draft === null || value === null) {
		return <div style={S.hint}>{error ?? t('loading')}</div>
	}

	const readOnly = value.mode === 'file'
	const proxyNames = Object.keys(draft.proxies)
	// 走向下拉的全部选项：直连、单代理（配了才出现）、池中的每个名字
	const viaOptions: string[] = ['direct']
	if (draft.singleProxy || draft.proxies.default) viaOptions.push('proxy')
	for (const name of proxyNames) if (name !== 'default') viaOptions.push(name)
	const viaLabel = (via: string): string =>
		via === 'direct' ? t('direct') : via === 'proxy' ? t('proxy') : via

	const patch = (part: Partial<DescribeValue>) => setDraft({ ...draft, ...part })

	const setProxyName = (oldName: string, newName: string) => {
		const proxies = { ...draft.proxies }
		const entries = Object.entries(proxies).map(([n, u]) => [n === oldName ? newName : n, u] as const)
		const rebuilt: Record<string, string> = {}
		for (const [n, u] of entries) rebuilt[n] = u
		patch({ proxies: rebuilt })
	}
	const setProxyUrl = (name: string, url: string) => patch({ proxies: { ...draft.proxies, [name]: url } })
	const removeProxy = (name: string) => {
		const proxies = { ...draft.proxies }
		delete proxies[name]
		patch({ proxies })
	}
	const addProxy = () => {
		let i = 1
		while (draft.proxies[`proxy${i}`]) i += 1
		patch({ proxies: { ...draft.proxies, [`proxy${i}`]: '' } })
	}

	const setModelVia = (key: string, via: string) => patch({ modelRoutes: { ...draft.modelRoutes, [key]: via } })

	const setRule = (index: number, rule: Partial<DomainRule>) => {
		const routes = draft.routes.map((r, i) => (i === index ? { ...r, ...rule } : r))
		patch({ routes })
	}
	const addRule = () => patch({ routes: [...draft.routes, { domains: [''], via: 'direct' }] })
	const removeRule = (index: number) => patch({ routes: draft.routes.filter((_, i) => i !== index) })

	const runTest = async (kind: 'proxy' | 'model', key: string) => {
		setTests((prev) => ({ ...prev, [key]: { pending: true } }))
		const outcome = await postJson<TestOutcome & { ok: boolean }>('/test', { kind, name: key, key }).catch(() => ({ ok: false, key, message: 'network error' }))
		setTests((prev) => ({ ...prev, [key]: { ...outcome, pending: false } }))
	}

	const testBadge = (entry?: { pending?: boolean } & Partial<TestOutcome>): ReactNode => {
		if (!entry) return null
		if (entry.pending) return <span style={S.hint}>{t('testing')}</span>
		if (entry.ok) return <span style={S.statusOk}>{`${t('testOk')} · ${entry.latencyMs ?? '?'}ms${entry.via ? ' · ' + entry.via : ''}`}</span>
		return <span style={S.statusBad}>{`${t('testFail')} · ${entry.message ?? ''}`}</span>
	}

	const migrate = async () => {
		setMigrating(true)
		const result = await postJson<{ ok: boolean; message?: string }>('/migrate', {}).catch(() => ({ ok: false }))
		setMigrating(false)
		if (result.ok) {
			setSaveMsg(t('migrateDone'))
			await load()
		} else {
			setSaveMsg(result.message ?? t('saveFailed'))
		}
	}

	const save = async () => {
		if (readOnly) return
		setSaving(true)
		setSaveMsg(null)
		const cleanedProxies: Record<string, string> = {}
		for (const [name, url] of Object.entries(draft.proxies)) {
			if (name.trim() && url.trim()) cleanedProxies[name.trim()] = url.trim()
		}
		const cleanedRoutes = draft.routes
			.map((r) => ({ domains: r.domains.flatMap((d) => String(d).split(',')).map((d) => d.trim()).filter(Boolean), via: r.via }))
			.filter((r) => r.domains.length > 0)
		const cleanedModelRoutes: Record<string, string> = {}
		for (const [key, via] of Object.entries(draft.modelRoutes)) {
			if (via !== undefined && via !== null) cleanedModelRoutes[key] = via
		}
		const ops = [
			{ op: 'set', path: ['proxies'], value: cleanedProxies },
			{ op: 'set', path: ['proxy'], value: draft.singleProxy?.trim() ?? '' },
			{ op: 'set', path: ['default'], value: draft.default },
			{ op: 'set', path: ['modelRoutes'], value: cleanedModelRoutes },
			{ op: 'set', path: ['routes'], value: cleanedRoutes },
			{ op: 'set', path: ['logRequests'], value: draft.logRequests !== false },
			{ op: 'set', path: ['probeUrl'], value: draft.probeUrl },
		]
		const result = await postJson<{ ok: boolean; message?: string }>('/mutate', { ops }).catch(() => ({ ok: false, message: 'network error' }))
		setSaving(false)
		setSaveMsg(result.ok ? t('saved') : result.message ?? t('saveFailed'))
		if (result.ok) await load()
	}

	// 模型按 host 分组（host 语义的诚实呈现：同 host 组内只保留最后一个 via）
	const groups = new Map<string, ModelRow[]>()
	for (const row of draft.rows) {
		const list = groups.get(row.host) ?? []
		list.push(row)
		groups.set(row.host, list)
	}
	const hostConflicts = new Set<string>()
	for (const [host, rows] of groups) {
		const vias = new Set(rows.map((r) => draft.modelRoutes[r.key]).filter((v) => v !== undefined && v !== null))
		if (vias.size > 1) hostConflicts.add(host)
	}

	return (
		<div style={S.body}>
			{readOnly && (
				<div style={S.section}>
					<span style={S.warn}>{t('fileMode')}{value.configFile ? `：${value.configFile}` : ''}</span>
					<div style={S.row}>
						<button style={S.button} disabled={migrating} onClick={() => void migrate()}>
							{migrating ? t('saving') : t('migrate')}
						</button>
					</div>
				</div>
			)}

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('proxies')}</span>
				{Object.entries(draft.proxies).map(([name, url]) => (
					<div key={name} style={S.row}>
						<input style={{ ...S.input, ...S.inputNarrow }} value={name} disabled={readOnly}
							onChange={(e) => setProxyName(name, e.target.value)} aria-label={t('proxyName')} />
						<input style={S.input} value={url} disabled={readOnly}
							onChange={(e) => setProxyUrl(name, e.target.value)} aria-label={t('proxyUrl')} placeholder="socks5://127.0.0.1:1080" />
						<button style={S.button} onClick={() => void runTest('proxy', name)}>{t('test')}</button>
						<button style={S.button} disabled={readOnly} onClick={() => removeProxy(name)}>{t('remove')}</button>
						{testBadge(tests[name])}
					</div>
				))}
				<div style={S.row}>
					<input style={{ ...S.input, ...S.inputNarrow }} value={draft.singleProxy ?? ''} disabled={readOnly}
						onChange={(e) => patch({ singleProxy: e.target.value })} placeholder={t('singleProxy')} />
					{draft.singleProxy ? (
						<>
							<button style={S.button} onClick={() => void runTest('proxy', '(default)')}>{t('test')}</button>
							{testBadge(tests['(default)'])}
						</>
					) : null}
				</div>
				<div style={S.row}>
					<button style={S.button} disabled={readOnly} onClick={addProxy}>{t('addProxy')}</button>
				</div>
			</div>

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('defaultRoute')}</span>
				<select style={{ ...S.input, maxWidth: '260px' }} value={draft.default} disabled={readOnly}
					onChange={(e) => patch({ default: e.target.value })}>
					{viaOptions.map((via) => <option key={via} value={via}>{viaLabel(via)}</option>)}
				</select>
			</div>

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('domainRules')}</span>
				{draft.routes.map((rule, index) => (
					<div key={index} style={S.row}>
						<input style={S.input} value={rule.domains.join(',')} disabled={readOnly}
							onChange={(e) => setRule(index, { domains: e.target.value.split(',') })}
							aria-label={t('domains')} placeholder="anthropic.com, claude.ai" />
						<select style={{ ...S.input, ...S.inputNarrow }} value={rule.via} disabled={readOnly}
							onChange={(e) => setRule(index, { via: e.target.value })} aria-label={t('via')}>
							{viaOptions.map((via) => <option key={via} value={via}>{viaLabel(via)}</option>)}
						</select>
						<button style={S.button} disabled={readOnly} onClick={() => removeRule(index)}>{t('remove')}</button>
					</div>
				))}
				<div style={S.row}>
					<button style={S.button} disabled={readOnly} onClick={addRule}>{t('addRule')}</button>
				</div>
			</div>

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('modelRoutes')}</span>
				<span style={S.hint}>{t('modelHint')}</span>
				{draft.rows.length === 0 && <span style={S.hint}>{t('emptyModels')}</span>}
				{[...groups.entries()].map(([host, rows]) => (
					<div key={host} style={S.section}>
						<div style={S.groupHead}>
							{host}
							{hostConflicts.has(host) ? ` — ${t('conflictHint')}` : ''}
						</div>
						{rows.map((row) => (
							<div key={row.key} style={S.row}>
								<span style={S.label} title={`${row.key} · ${row.host}`}>
									{`${row.providerLabel} / ${row.name}`}
								</span>
								<button style={S.button} onClick={() => void runTest('model', row.key)}>{t('test')}</button>
								<select style={{ ...S.input, ...S.inputNarrow }}
									value={draft.modelRoutes[row.key] ?? ''}
									disabled={readOnly}
									onChange={(e) => setModelVia(row.key, e.target.value)}
									aria-label={t('via')}>
									<option value="">{t('none')}</option>
									{viaOptions.map((via) => <option key={via} value={via}>{viaLabel(via)}</option>)}
								</select>
								{testBadge(tests[row.key])}
							</div>
						))}
					</div>
				))}
			</div>

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('options')}</span>
				<label style={S.row}>
					<input type="checkbox" checked={draft.logRequests !== false} disabled={readOnly}
						onChange={(e) => patch({ logRequests: e.target.checked })} />
					<span style={S.hint}>{t('logRequests')}</span>
				</label>
				<div style={S.row}>
					<input style={S.input} value={draft.probeUrl} disabled={readOnly}
						onChange={(e) => patch({ probeUrl: e.target.value })}
						placeholder="https://www.gstatic.com/generate_204" aria-label={t('probeUrl')} />
				</div>
			</div>

			<div style={S.row}>
				<button style={S.buttonPrimary} disabled={readOnly || saving} onClick={() => void save()}>
					{saving ? t('saving') : t('save')}
				</button>
				{saveMsg && <span style={saveMsg === t('saved') || saveMsg === t('migrateDone') ? S.statusOk : S.statusBad}>{saveMsg}</span>}
			</div>
		</div>
	)
}
