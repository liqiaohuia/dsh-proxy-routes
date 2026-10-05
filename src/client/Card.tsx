// dsh-proxy-routes —— 设置页卡片：代理池 / 按提供商（账号）路由 / 测试连接。
//
// 数据面：卡片不直接读写 settings 传输，而是走本插件 host 侧的同源回环桥
// /api/dsh-proxy-routes/settings/*（describe / mutate / test / migrate）。
// 文件模式（$DSH_HOME/proxy-routes.jsonc 存在）下卡片只读（控件置灰），提供一键迁移。
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

export interface ProviderRow {
	id: string
	host: string
	hasKey: boolean
	via: string
}

export interface DescribeValue {
	mode: 'file' | 'settings'
	configFile: string | null
	settingsAvailable: boolean
	proxies: Record<string, string>
	singleProxy: string | null
	default: string
	providerRoutes: Record<string, string>
	logRequests: boolean
	probeUrl: string
	rows: ModelRow[]
	providers: ProviderRow[]
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
	/** 只读（文件模式）时的禁用态外观：内联样式会盖掉浏览器默认置灰，必须显式标出。 */
	disabled: { opacity: 0.55, cursor: 'not-allowed' } as const,
}

/** 测试结果（key = 代理名或模型 key）。 */
type TestMap = Record<string, { pending?: boolean } & Partial<TestOutcome>>

/** 渲染形态：summary = 官方插件详情页的一行简介（父容器是 <p>，只能内联文本）；page/缺省 = 完整配置卡。 */
type CardView = 'summary' | 'page' | undefined

/** 代理池编辑行：uid 是稳定的行标识——**绝不能用名字当 React key**，
 * 否则改名时每敲一个字符 key 都会变，React 卸载重挂输入框导致焦点丢失。 */
interface ProxyRowDraft {
	uid: string
	name: string
	url: string
}

const newUid = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
	? crypto.randomUUID()
	: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)

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
	// 代理池行：独立于 draft 的行数组（uid 稳定，改名不重挂）；保存时才汇成 Record
	const [proxyRows, setProxyRows] = useState<ProxyRowDraft[]>([])

	const load = useCallback(async () => {
		try {
			const payload = await postJson<{ ok: boolean; value?: DescribeValue; message?: string }>('/describe')
			if (payload.ok && payload.value) {
				setValue(payload.value)
				setDraft(payload.value)
				// 名字没变的行沿用原 uid（避免保存回读后不必要重挂）
				setProxyRows((prev) => Object.entries(payload.value.proxies).map(([n, u]) => {
					const hit = prev.find((r) => r.name === n)
					return hit ? { uid: hit.uid, name: n, url: u } : { uid: newUid(), name: n, url: u }
				}))
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
	// 走向下拉的全部选项：直连、单代理（配了才出现）、池中的每个名字（去重，空名跳过）
	const poolNames = [...new Set(proxyRows.map((r) => r.name.trim()).filter(Boolean))]
	const viaOptions: string[] = ['direct']
	if (draft.singleProxy || poolNames.includes('default')) viaOptions.push('proxy')
	for (const name of poolNames) if (name !== 'default') viaOptions.push(name)
	const viaLabel = (via: string): string =>
		via === 'direct' ? t('direct') : via === 'proxy' ? t('proxy') : via

	const patch = (part: Partial<DescribeValue>) => setDraft({ ...draft, ...part })

	// 代理池行编辑（按 uid 定位行——见 ProxyRowDraft 注释）
	const patchProxyRow = (uid: string, part: Partial<ProxyRowDraft>) =>
		setProxyRows((rows) => rows.map((r) => (r.uid === uid ? { ...r, ...part } : r)))
	const removeProxyRow = (uid: string) => setProxyRows((rows) => rows.filter((r) => r.uid !== uid))
	const addProxyRow = () => {
		const names = new Set(proxyRows.map((r) => r.name))
		let i = 1
		while (names.has(`proxy${i}`)) i += 1
		setProxyRows((rows) => [...rows, { uid: newUid(), name: `proxy${i}`, url: '' }])
	}

	const setProviderVia = (pid: string, via: string) => patch({ providerRoutes: { ...draft.providerRoutes, [pid]: via } })

	const runTest = async (kind: 'proxy' | 'provider', key: string) => {
		setTests((prev) => ({ ...prev, [key]: { pending: true } }))
		const body: Record<string, unknown> = { kind, key, name: key }
		if (kind === 'proxy') {
			// 传**草稿地址**：新添加、尚未保存的代理也能立即测试
			body.url = key === '(default)' ? draft.singleProxy ?? '' : proxyRows.find((r) => r.name === key)?.url ?? ''
		}
		const outcome = await postJson<TestOutcome & { ok: boolean }>('/test', body).catch(() => ({ ok: false, key, message: 'network error' }))
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
		// 池行汇成 Record：空名/空地址的行跳过（同名后行覆盖前行）
		const cleanedProxies: Record<string, string> = {}
		for (const row of proxyRows) {
			const n = row.name.trim()
			const u = row.url.trim()
			if (n && u) cleanedProxies[n] = u
		}
		const cleanedProviderRoutes: Record<string, string> = {}
		for (const [pid, via] of Object.entries(draft.providerRoutes)) {
			if (via !== undefined && via !== null && via !== '') cleanedProviderRoutes[pid] = via
		}
		const ops = [
			{ op: 'set', path: ['proxies'], value: cleanedProxies },
			{ op: 'set', path: ['singleProxy'], value: draft.singleProxy?.trim() ?? '' },
			{ op: 'set', path: ['default'], value: draft.default },
			{ op: 'set', path: ['providerRoutes'], value: cleanedProviderRoutes },
			{ op: 'set', path: ['logRequests'], value: draft.logRequests !== false },
			{ op: 'set', path: ['probeUrl'], value: draft.probeUrl },
		]
		const result = await postJson<{ ok: boolean; message?: string }>('/mutate', { ops }).catch(() => ({ ok: false, message: 'network error' }))
		setSaving(false)
		setSaveMsg(result.ok ? t('saved') : result.message ?? t('saveFailed'))
		if (result.ok) await load()
	}

	return (
		<div style={S.body}>
			{readOnly && (
				<div style={S.section}>
					<span style={S.warn}>{t('fileMode')}{value.configFile ? `：${value.configFile}` : ''}</span>
					<span style={S.hint}>{t('fileLocked')}</span>
					{value.settingsAvailable !== false && (
						<div style={S.row}>
							<button style={S.button} disabled={migrating} onClick={() => void migrate()}>
								{migrating ? t('saving') : t('migrate')}
							</button>
						</div>
					)}
				</div>
			)}

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('proxies')}</span>
				{proxyRows.map((row) => (
					<div key={row.uid} style={S.row}>
						<input style={{ ...S.input, ...S.inputNarrow, ...(readOnly ? S.disabled : {}) }} value={row.name} disabled={readOnly}
							onChange={(e) => patchProxyRow(row.uid, { name: e.target.value })} aria-label={t('proxyName')} />
						<input style={{ ...S.input, ...(readOnly ? S.disabled : {}) }} value={row.url} disabled={readOnly}
							onChange={(e) => patchProxyRow(row.uid, { url: e.target.value })} aria-label={t('proxyUrl')} placeholder="socks5://127.0.0.1:1080" />
						<button style={S.button} onClick={() => void runTest('proxy', row.name)}>{t('test')}</button>
						<button style={{ ...S.button, ...(readOnly ? S.disabled : {}) }} disabled={readOnly} onClick={() => removeProxyRow(row.uid)}>{t('remove')}</button>
						{testBadge(tests[row.name])}
					</div>
				))}
				<div style={S.row}>
					<input style={{ ...S.input, ...S.inputNarrow, ...(readOnly ? S.disabled : {}) }} value={draft.singleProxy ?? ''} disabled={readOnly}
						onChange={(e) => patch({ singleProxy: e.target.value })} placeholder={t('singleProxy')} />
					{draft.singleProxy ? (
						<>
							<button style={S.button} onClick={() => void runTest('proxy', '(default)')}>{t('test')}</button>
							{testBadge(tests['(default)'])}
						</>
					) : null}
				</div>
				<div style={S.row}>
					<button style={{ ...S.button, ...(readOnly ? S.disabled : {}) }} disabled={readOnly} onClick={addProxyRow}>{t('addProxy')}</button>
				</div>
			</div>

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('defaultRoute')}</span>
				<select style={{ ...S.input, maxWidth: '260px', ...(readOnly ? S.disabled : {}) }} value={draft.default} disabled={readOnly}
					onChange={(e) => patch({ default: e.target.value })}>
					{viaOptions.map((via) => <option key={via} value={via}>{viaLabel(via)}</option>)}
				</select>
			</div>

			<div style={S.section}>
				<span style={S.sectionTitle}>{t('providerRoutes')}</span>
				<span style={S.hint}>{t('providerHint')}</span>
				{draft.providers.length === 0 && <span style={S.hint}>{t('emptyProviders')}</span>}
				{draft.providers.map((provider) => (
					<div key={provider.id} style={S.row}>
						<span style={S.label} title={provider.host ? `${provider.id} · ${provider.host}` : provider.id}>
							{provider.id}
						</span>
						{provider.host && <span style={S.badge}>{provider.host}</span>}
						<button style={S.button} onClick={() => void runTest('provider', provider.id)}>{t('test')}</button>
						<select style={{ ...S.input, ...S.inputNarrow, ...(readOnly ? S.disabled : {}) }}
							value={draft.providerRoutes[provider.id] ?? ''}
							disabled={readOnly}
							onChange={(e) => setProviderVia(provider.id, e.target.value)}
							aria-label={t('via')}>
							<option value="">{t('rule')}</option>
							{viaOptions.map((via) => <option key={via} value={via}>{viaLabel(via)}</option>)}
						</select>
						{testBadge(tests[provider.id])}
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
					<input style={{ ...S.input, ...(readOnly ? S.disabled : {}) }} value={draft.probeUrl} disabled={readOnly}
						onChange={(e) => patch({ probeUrl: e.target.value })}
						placeholder="https://www.gstatic.com/generate_204" aria-label={t('probeUrl')} />
				</div>
			</div>

			<div style={S.row}>
				<button style={{ ...S.buttonPrimary, ...((readOnly || saving) ? S.disabled : {}) }} disabled={readOnly || saving} onClick={() => void save()}>
					{saving ? t('saving') : t('save')}
				</button>
				{saveMsg && <span style={saveMsg === t('saved') || saveMsg === t('migrateDone') ? S.statusOk : S.statusBad}>{saveMsg}</span>}
			</div>
		</div>
	)
}
