# dsh-proxy-routes —— DSH 代理路由：按提供商（账号）分流 + 代理池 + 设置页配置

给 DSH（DeepSeek Harness）装的 Cordis 插件：拦截本进程内所有 `fetch` 请求，按
**提供商（账号）**决定走**代理池中的哪个代理**还是**直连**。传输层复用
DSH 自带的 undici（零 npm 依赖），配置在 **DSH 设置页**图形化管理，保存即热生效。

解决什么问题：Anthropic / NVIDIA NIM 等海外 API 对中国大陆 IP 返回 403（DSH
界面误显示为 "API key is invalid"），而智谱/DeepSeek 等国内 API 又不该绕道代理；
手上往往还有不止一个代理（主备、不同出口）。本插件让每个**账号**各走各的路——
尤其是**同一服务商的多个账号**（免费额度走代理、主力付费账号直连）。
**v0.4.1 起按域名分流模块已整体移除**：路由只由「提供商显式走向 + 默认走向」决定，
旧配置里的 `routes` 字段直接忽略。

**兼容性**：DSH Desktop 2.0.14（dsh 0.1.7，settings 从插件 Config schema 派生）
与 2.0.13（dsh 0.1.5-rc.2，settings 命名空间）双代实测兼容。传输层要求
DSH ≥ 0.1.3（自带 undici ≥ 7.10，含 Socks5ProxyAgent）。

## v0.4 新特性

- **按提供商（账号）分流**：每个请求按其**API 密钥**识别属于哪个提供商——
  同一域名下的 claude1 / claude2 两个账号可各走各的代理或直连。密钥只在
  内存中匹配（经 credentials 服务 / 环境变量解析），绝不写日志
- **DSH 2.0.14（dsh 0.1.7）适配**：导出带 `volatile` 字段的 Config schema，
  官方设置机制从它派生条目表单；卡片保存走 `SettingsForms.mutate`（与官方
  同一 op 协议）；旧版「按模型」的 `modelRoutes` 自动迁移为按提供商
- **配置卡片**（双协议注册，两个桌面版代次都能找到）：
  - **DSH Desktop 2.0.14+**：侧栏 **插件页**详情 + **设置 → 代理路由** 独立页
  - **DSH Desktop 2.0.13**：设置 → 插件 → **代理路由**
  - 代理池增删改、按提供商选代理、默认走向、每行「测试连接」按钮（测试的是
    输入框/下拉框当前的**草稿值**，无需先保存）
- **代理池**：多个命名代理（`proxies`），每条规则按名字引用；SOCKS5 / HTTP
  CONNECT / 代理端 TLS（https://）三种协议混用
- **设置页为默认姿态**：安装即用设置页（设置 → 代理路由）配置，无需任何文件。
  插件**不再自动生成**配置文件；`$DSH_HOME/proxy-routes.jsonc` 仅在用户**手动
  创建**时生效（dsh web 命令行用户自管，改动热生效），此时卡片只读并显示一行
  说明（编辑该文件或删除它回到设置页）

## 安装

前置要求：DSH 已装（`npm i -g @deepseek-ai/dsh` 或 DSH Desktop）、插件管理
需要 pnpm、代理客户端（Clash/v2rayN/xray 等）在运行。插件**不会**替你启动代理客户端。

### 方式一：包安装（推荐，需要 pnpm）

```powershell
# 从 npm（发布后）：
dsh plugin --profile web add dsh-proxy-routes

# 或从本地目录 / git 仓库：
dsh plugin --profile web add D:\path\to\dsh-proxy-routes
dsh plugin --profile web add https://github.com/<you>/dsh-proxy-routes.git
```

- 命令行用户用 `--profile web`；**DSH Desktop 用户**不用带 `--profile`——桌面版
  的 `dsh` 会自动落到它管理的 `desktop` profile 上（`dsh plugin add ...` 即可）。
- 本包声明了 `dsh.bundle.patch`，`dsh plugin add` 装完会**自动**把它登记为
  profile 的 bundle 层——不需要手动编辑任何 YAML。升级用
  `dsh plugin --profile web update dsh-proxy-routes`，卸载用
  `dsh plugin --profile web remove dsh-proxy-routes`。
- 重启 profile（`dsh web`，桌面版从托盘退出再启动）后，到 **设置 → 插件 →
  代理路由** 卡片里配置即可——无需手写任何文件。
- **注意**：客户端卡片要求 `lib/client.js` 随包存在（`files` 已含）。若从 git
  安装后设置页报 client bundle 相关错误，进仓库目录执行一次
  `pnpm install && pnpm build` 再重启。

### 方式二：手动文件复制（不需要 pnpm）

把本目录复制到 profile 下，然后在同一 profile 的 `cordis.patch.yml`（没有就新建）
里加：

```yaml
- insert:
    - id: proxy-routes
      name: './plugins/dsh-proxy-routes/index.mjs'
```

重启该 profile 即生效（卡片与设置页机制同样需要 `lib/client.js` 存在）。

> 两种方式不要同时用（同一 id 挂两次）。从方式二迁移到方式一时，先删掉
> cordis.patch.yml 里手动加的那行和 plugins 下的副本，再执行 `dsh plugin add`。

## 快速上手（设置页）

1. 重启 DSH 后打开插件配置页：**2.0.14+ 在侧栏「插件」页**找到 dsh-proxy-routes
   点开详情（配置区即完整卡片）；**2.0.13 在 设置 → 插件**：插件列表出现
   「代理路由」，点开卡片
2. **代理池**：给每个代理起名并填地址（例 `main` = `socks5://127.0.0.1:50939`），
   点「测试」确认可达——测试的是输入框里**当前草稿值**，不用先保存（探测默认访问
   `https://www.gstatic.com/generate_204`，可在「其他选项」里改）
3. **按提供商（账号）分流**：提供商列表自动来自 DSH「模型」页配置的 LLM 账号
   （claude1、claude2、nvidia-01…），每行下拉选择 直连 / 池中某个代理
   （「规则」= 未显式设置，按默认走向）；点「测试」走该提供商当前的真实路由探测
4. **默认走向**：未显式设置的提供商（以及一切非 LLM 流量）走哪条路
   （建议 `direct`——新域名不绕代理）
5. **保存**：立即生效；真实 LLM 请求发生时在日志里可见
   `POST api.anthropic.com/v1/messages -> claude1=>main:socks5://127.0.0.1:50939`

### 按提供商 = 按账号（为什么按域名做不到）

同一服务商的多个账号打向**同一个 API 域名**，传输层只看 URL 无法区分它们。
本插件利用的事实是：DSH（llm-pi-ai）发出的每个 LLM 请求都带着**该账号的 API
密钥头**（`x-api-key` / `authorization: Bearer`）——插件在 fetch 层提取密钥、
匹配「密钥 → 提供商」映射（启动时经 settings `describe` + credentials 服务
解析，密钥只进内存），即可精确判断这次请求属于哪个账号。典型用法：

- `claude1`（免费额度、限每分钟次数）→ 走代理
- `claude2`（付费主力）→ 显式 `direct`
- 未列出的账号 → 按默认走向

优先级：**提供商显式走向 > 默认走向**。提供商设为 `direct` 强制直连。
旧版 `modelRoutes`（`"providerId/modelId"` 前缀）读取时自动迁移为按提供商。

## 配置

**设置页是默认方式**（dsh 0.1.5+ / DSH Desktop）：安装后无需任何文件，卡片
保存即生效。**文件模式**仅在用户手动创建 `$DSH_HOME/proxy-routes.jsonc` 时
激活（面向 `dsh web` 命令行用户自管配置，改动热生效），此时卡片只读并显示
一行说明；删除该文件并重启即回到设置页。条目配置 `config.configFile` 可显式
指定其他文件路径。

### 设置页字段（与 jsonc 字段一一对应）

```jsonc
{
  // 命名代理池：名字 → 地址。三种协议、可带认证（user:pass@host:port）
  "proxies": {
    "main": "socks5://127.0.0.1:50939",     // 域名解析交给代理端（等效 socks5h，防 DNS 污染）
    "backup": "http://127.0.0.1:7890",       // HTTP CONNECT 隧道
    "secure": "https://127.0.0.1:7891"      // 代理端 TLS
  },
  // 单代理（v0.2 兼容），等价于池里名为 "default" 的一项；via 可写 "proxy" 引用它
  "singleProxy": "",
  // 默认走向："direct" | "proxy" | 代理名
  "default": "direct",
  // 按提供商（账号）："providerId" → "direct" | "proxy" | 代理名。
  // 提供商 id 即 DSH「模型」页里各账号的提供商 ID；按请求密钥识别，同域可分流
  "providerRoutes": {
    "claude1": "main",
    "claude2": "direct",
    "nvidia-01": "backup"
  },
  // 打印每次走代理的请求（默认 true）
  "logRequests": true,
  // 「测试连接」按钮的探测地址
  "probeUrl": "https://www.gstatic.com/generate_204"
}
```

- v0.4.1 起 `routes`（按域名分流）已删除：旧配置里的该字段直接忽略
- 提供商显式走向优先于 `default`；提供商设为 `direct` 强制直连
- 代理名不存在时该规则回退直连并在日志警告；语法/结构错误时保留上一份配置

## 工作原理

1. **配置**：dsh 0.1.7（Desktop 2.0.14）从插件导出的 **Config schema**（volatile
   字段）派生条目配置，官方设置表单与卡片保存（`SettingsForms.mutate`，同一
   op 协议）都落到条目配置；dsh 0.1.5（2.0.13）则注册 `proxy-routes` 命名空间。
   用户手动创建 `$DSH_HOME/proxy-routes.jsonc` 时文件模式生效（优先于设置页）
2. **密钥 → 提供商映射**：settings `describe`（未脱敏，仅内存）读到各提供商的
   `apiKeyEnv` 凭据引用，经 credentials 服务（或环境变量）解析成密钥，建立
   密钥 → 提供商映射；provider 配置变化时自动重建。**密钥绝不写日志**
3. **fetch 拦截**：替换 `globalThis.fetch`：每个请求提取 `x-api-key` /
   `authorization: Bearer` 密钥 → 命中提供商 → 该账号的显式走向；未命中走
   默认走向
4. 命中代理的请求交给 DSH 自带的 undici（`undici.fetch` + 按代理协议构建的
   `Socks5ProxyAgent` / `ProxyAgent` per-request dispatcher，按代理 URL 池化
   复用）——SOCKS5 隧道、HTTP CONNECT、TLS、压缩、重定向跟随、SSE 流式都是
   undici 原生实现；**不触碰 undici 全局 dispatcher**
5. 设置页卡片经本机回环同源桥接（`/api/dsh-proxy-routes/settings/*`，
   loopback + 同源 + Host 校验）读写配置、列提供商、跑测试——第三方 namespace
   不在 DSH apiproxy 的白名单里，此桥接为官方机制的标准补位
   （dshmarket / dsh-llm-proxy 同模式）
6. 路由判断抛错时兜底直连，插件自身绝不导致请求失败

### 与官方出站代理（`dsh-http-proxy`）及 dsh-llm-proxy 的关系

| 能力 | 本插件 | 官方 dsh-http-proxy | @superfish058/dsh-llm-proxy |
|---|---|---|---|
| 配置方式 | 设置页卡片 + jsonc 文件双入口 | 环境变量 / `.env` | 设置页卡片 |
| 默认语义 | **默认直连**，命中才代理 | 默认全代理，排除列表直连 | 默认直连，选中模型代理 |
| SOCKS5（含认证） | ✓ 原生 | ✗ 明确拒绝 | ✓（有官方包时复用其传输层） |
| 多代理池、每规则选不同代理 | ✓（v0.3） | ✗ 单一出口 | ✗ 单一出口 |
| 按提供商（账号）分流（同域多账号） | ✓（v0.4，按密钥） | ✗ | ✗（host 粒度） |
| 覆盖范围 | 进程内全部 fetch（模型、web fetch、MCP…） | 进程内全部流量 + 子进程环境 | 同官方范围 |
| 与其他代理机制 | fetch 层拦截，互不抢占 | 替换全局 dispatcher | 复用官方全局 dispatcher |

两者同时启用时：本插件在 fetch 函数层先拦截，命中规则的请求走自己的
dispatcher，未命中的才落到全局 dispatcher（官方策略）。

## 日志与启动时机

- 插件随 `dsh web` / 桌面版启动即生效；到代理的 TCP 连接是**惰性**的（首次
  命中该代理的请求时建立，之后复用）
- 日志直接打印到运行 `dsh web` 的控制台；**DSH Desktop** 场景在
  `%APPDATA%/DSH Desktop/logs/host/dsh-<日期>.log`（Windows）。启动时一行：

  ```
  [proxy-routes] 配置已加载 设置页(proxy-routes)（代理池=[main,backup]，默认=直连，提供商路由[claude1=>代理,claude2=>直连]，来源=设置页）
  [proxy-routes] 密钥→提供商映射已建立：2 条（提供商 claude1, claude2）
  [proxy-routes] 设置桥接已挂载 /api/dsh-proxy-routes/settings（5 条路由）
  ```

  每个走代理的请求再打一行（`logRequests: false` 可关闭；提供商命中的行带
  账号名，**绝不含密钥**）：

  ```
  [proxy-routes] POST api.anthropic.com/v1/messages -> claude1=>main:socks5://127.0.0.1:50939
  ```

- 提供商目录与密钥映射的冷启动时序：`llm-pi-ai` 等条目注册晚于本插件，插件会
  带退避重试直到密钥映射与模型目录可解析；provider 配置变化（如改 baseURL /
  换账号密钥）也会自动触发重建

## 发布与上架市场

公开分享有三条路线（可叠加）：

**路线 A —— GitHub**：推上仓库后，用户 `dsh plugin add <git-url>` 直装。
本包宿主侧零 npm 依赖；客户端产物 `lib/client.js` 随仓库分发（改 `src/client`
后运行 `pnpm install && pnpm build` 重新构建并提交）。

**路线 B —— npm**：提供短名安装、版本管理、npm 搜索可发现性。

> **重要（2026-08 实测）**：npm 强制要求发布前启用 2FA（否则 `npm publish`
> 报 403）。2FA 只支持 passkey（TOTP 已下架）：Windows 上用 **Windows Hello
> （PIN 即可）**，或手机扫码存 passkey。若通行密钥弹窗只出现 "USB 密钥"：
> 先在 Windows 设置 → 帐户 → 登录选项给账户**添加一个 PIN**（本地账户即可），
> Windows Hello 选项即会出现。

```powershell
npm login                 # 打开浏览器完成验证
npm pack                   # （可选）检查将要发布的文件清单（应含 lib/client.js）
npm publish                 # passkey 验证后发布
```

**路线 C —— 上架 dshmarket（DSH 插件市场）**：dshmarket 的插件列表来自
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
精选清单——**上架 = 向该仓库提一个 PR**（在 plugins.json 里加一条本插件的
npm 包/仓库信息），合并后约一天内自动出现在市场的浏览/搜索里。步骤：

1. 先走路线 B 把包发到 npm（市场安装优先用 npm 包，速度最快）
2. fork awesome-dsh-plugin 仓库，按其 README 的条目格式提交 PR
3. 合并后用户即可在 DSH 设置 → 插件市场（dshmarket）里一键安装；没有装
   dshmarket 的用户仍可用 `dsh plugin add dsh-proxy-routes`

发布前记得把 `package.json` 的 `repository` / `bugs` 改成你的真实仓库地址。

## 开发迭代

- **包安装（link 方式）**：`dsh plugin add <本目录>` 放的是指向本目录的
  `link:` 依赖，改 host 侧代码（`index.mjs` / `transport.mjs` / `catalog.mjs`）
  后重启 `dsh web` 即生效；改客户端（`src/client/`）后要 `pnpm build` 重建
  `lib/client.js` 再重启（改的是发布物，不是源码——链接目录里 dsh 读的就是
  lib/client.js）
- 配置文件与设置页的修改不受重启限制——保存即热生效
- 自测：`pnpm install` 后 `node test-plugin.mjs`（30+ 项：双代理池路由、同域
  双账号分流、0.1.7 settings 集成、/test 草稿测试、归一化、dispatcher 复用、
  热重载、卸载还原；网络用例需要本机 50939/50018 两个 SOCKS5 代理在运行，
  缺哪个哪项失败，其余照常）

## 已知限制

- 传输层依赖 DSH 自带的 undici ≥ 7.10（DSH ≥ 0.1.3）；插件不声明 npm 依赖——
  声明反而会在 pnpm 布局下装出第二份 undici
- undici 的 SOCKS5 支持标记为 experimental：进程首次使用会打印一条
  `ExperimentalWarning`，无害
- **「测试连接」探测的是 `probeUrl`（默认 `https://www.gstatic.com/generate_204`），
  而非提供商的真实 API**：中国大陆网络下「直连」探测 gstatic 会不通（被墙），
  这是探测地址的属性而非路由故障——把「其他选项」里的探测地址改成墙内外都
  可达的（如 `https://www.baidu.com`）即可让直连/代理两边都能真实测试
- 设置页卡片要求 DSH ≥ 0.1.0-rc.7（settings.plugin.item slot 与 settings
  namespace 机制）；更老版本上插件不加载配置——需手动创建
  `$DSH_HOME/proxy-routes.jsonc` 文件方可使用（`configFile` 条目配置可改路径）
- 走代理的请求跟随 3xx 重定向（undici 默认）、HTTP/1.1（undici 默认不开
  HTTP/2）；HTTP(S) 代理侧禁用空闲连接复用以规避代理客户端静默关闭空闲隧道
  导致的挂起（Clash 实测问题）
- 工作线程（workflow / code-runtime worker thread）里若有人自建 fetch 发
  请求，不经过本补丁
- 设置桥接只监听本机回环（loopback + 同源 + Host 校验；反向代理部署需要
  在条目配置 `trustedOrigins` 放行公共源）

## 排障

- 界面仍报 "API key is invalid"：看日志里有没有 `[proxy-routes]` 请求记录；
  没有 = 规则没命中或插件没加载（`dsh --profile <name> --dump-config` 查
  组合树是否有 `proxy-routes`）；有 = 代理端问题
- 设置页卡片显示「读取配置失败」：host 桥接没挂上——确认 DSH ≥ 0.1.0-rc.7
  且重启过；看启动日志有没有「设置桥接已挂载」
- 卡片保存后规则没生效：看日志里的「未知代理」警告（走向引用了池里不存在的
  名字）与保存回执；0.1.7 下保存成功会触发「配置已加载」日志
- 新添加的代理「测试」不通：确认代理地址协议正确（SOCKS 端口写
  `socks5://`，混合端口 http/socks 两种写法都支持）；测试探测的 `probeUrl`
  若从该代理出口不可达也会显示不通（见「已知限制」的探测地址说明）
- `连接 SOCKS5 代理超时 / UND_ERR_SOCKS5_AUTH_FAILED`：代理客户端没开、
  端口不对、认证信息错误
- dsh-llm-proxy 用户注意：它把代理一律按 `http://` 处理——纯 SOCKS 端口
  （如 xray 的 50939）会「网络不通」；本插件按 URL 协议分发，SOCKS 端口写
  `socks5://` 即可
- Desktop 场景看不到日志：打开 `%APPDATA%/DSH Desktop/logs/host/dsh-<日期>.log`
