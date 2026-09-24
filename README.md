# dsh-proxy-routes —— DSH 代理路由：按模型 / 按域名分流 + 代理池 + 设置页配置

给 DSH（DeepSeek Harness）装的 Cordis 插件：拦截本进程内所有 `fetch` 请求，按
**模型**或**域名**决定走**代理池中的哪个代理**还是**直连**。传输层复用 DSH
自带的 undici（零 npm 依赖），配置在 **DSH 设置页**图形化管理，保存即热生效。

解决什么问题：Anthropic / NVIDIA NIM 等海外 API 对中国大陆 IP 返回 403（DSH
界面误显示为 "API key is invalid"），而智谱/DeepSeek 等国内 API 又不该绕道代理；
手上往往还有不止一个代理（主备、不同出口）。本插件让每个模型、每类流量各走各的路。

**兼容性**：与 DSH 0.1.5-rc.2 / DSH Desktop 2.0.13 实测兼容（Cordis 4.0.2
函数式插件、`dsh plugin add` 自动登记 bundle 层、settings 命名空间与设置页
卡片机制均验证通过）。传输层要求 DSH ≥ 0.1.3（自带 undici ≥ 7.10，含
Socks5ProxyAgent）。

## v0.3 新特性

- **设置页卡片**：设置 → 插件 → **代理路由**——代理池增删改、按模型选代理、
  域名规则、默认走向、每行「测试连接」按钮，保存即热生效（官方 settings 机制，
  写入 settings.yaml 的 `proxy-routes` 命名空间）
- **代理池**：多个命名代理（`proxies`），每条规则按名字引用；SOCKS5 / HTTP
  CONNECT / 代理端 TLS（https://）三种协议混用
- **按模型设置**：`"providerId/modelId" → 代理`；模型列表自动读取 DSH 已配置的
  LLM provider（含官方 DeepSeek 与 pi-ai 内置目录兜底），按 provider 分组展示
- **文件模式兼容**：v0.2 的 `$DSH_HOME/proxy-routes.jsonc` 存在时继续生效，
  卡片显示「迁移到设置页」按钮一键搬家（原文件保留 `.bak`）

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

1. 重启 DSH 后打开 **设置 → 插件**：插件列表出现「代理路由」，点开卡片
2. **代理池**：给每个代理起名并填地址（例 `main` = `socks5://127.0.0.1:50939`），
   点「测试」确认可达（探测默认访问 `https://www.gstatic.com/generate_204`，
   可在「其他选项」里改）
3. **按模型设置**：模型列表按 provider 分组（数据来自 DSH 已配置的 LLM
   provider），每行下拉选择 直连 / 单代理 / 池中某个代理；点「测试」走该模型
   当前的真实路由探测
4. **默认走向**：没命中任何规则的域名走哪条路（建议 `direct`——新域名不绕代理）
5. **保存**：写入 settings.yaml，立即生效；真实 LLM 请求发生时在日志里可见
   `POST api.anthropic.com/v1/messages -> main:socks5://127.0.0.1:50939`

### 按模型 = 按 API 域名（诚实语义）

传输层只能看到请求 URL，因此「按模型」的实际生效粒度是**该模型 provider 的
API 域名**：同一域名下的模型共享同一路由（卡片按域名分组并提示，冲突时以最后
一行为准）。这正是 DSH 官方模型选择器解析模型的同一口径。

**变通**：需要「同一 API 服务、两个模型、不同出口」时——比如 10 个模型同在
`https://api.example.com`——把它建成**两个 provider 条目**，baseURL 一个写
`https://api.example.com`、另一个显式写 `https://api.example.com:443`（网络
等价），再把各自模型分到不同代理。本插件的域名规则匹配区分 `host:port`，
能同时容纳这两种写法。

## 配置

**优先级**：`$DSH_HOME/proxy-routes.jsonc` 存在时**文件优先**（v0.2 兼容），
卡片变为只读并显示迁移按钮；文件不存在时用设置页（settings.yaml 的
`proxy-routes` 命名空间）。条目配置 `config.configFile` 可显式指定其他文件。

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
  "proxy": "",
  // 默认走向："direct" | "proxy" | 代理名
  "default": "direct",
  // 按模型："providerId/modelId" → "direct" | "proxy" | 代理名（按 provider 的 API 域名生效）
  "modelRoutes": {
    "nvidia-01/z-ai/glm-5.3": "main",
    "deepseek-official/deepseek-chat": "direct"
  },
  // 按域名（含所有子域名），从上到下第一条命中生效
  "routes": [
    { "domains": ["anthropic.com", "claude.ai"], "via": "main" },
    { "domains": ["open.bigmodel.cn", "deepseek.com"], "via": "direct" }
  ],
  // 打印每次走代理的请求（默认 true）
  "logRequests": true,
  // 「测试连接」按钮的探测地址
  "probeUrl": "https://www.gstatic.com/generate_204"
}
```

- 域名写裸域名自动覆盖子域名（`anthropic.com` 匹配 `api.anthropic.com`）；
  写 `host:443` 则精确匹配该端口（见上文「变通」）
- 模型路由优先于域名规则：`modelRoutes` 编译出的 host 规则先匹配，其次
  `routes`，最后 `default`
- 代理名不存在时该规则回退直连并在日志警告；语法/结构错误时保留上一份配置

## 工作原理

1. 启动时通过 DSH settings 机制注册 `proxy-routes` 命名空间（`applies: 'live'`，
   官方 schema 校验/持久化/热生效），并从 `llm-pi-ai` / `llm-deepseek` 命名空间
   读取模型目录（provider 未写 models 时回退 pi-ai 内置目录——与官方模型
   选择器同源）
2. 把 `modelRoutes`（模型 → 代理）编译成 host 级路由表；替换
   `globalThis.fetch`：每个请求查表（模型 host 规则 → 域名规则 → default）
3. 命中代理的请求交给 DSH 自带的 undici（`undici.fetch` + 按代理协议构建的
   `Socks5ProxyAgent` / `ProxyAgent` per-request dispatcher，按代理 URL 池化
   复用）——SOCKS5 隧道、HTTP CONNECT、TLS、压缩、重定向跟随、SSE 流式都是
   undici 原生实现；**不触碰 undici 全局 dispatcher**
4. 设置页卡片经本机回环同源桥接（`/api/dsh-proxy-routes/settings/*`，
   loopback + 同源 + Host 校验）读写命名空间、列模型、跑测试——第三方
   namespace 不在 DSH apiproxy 的白名单里，此桥接为官方机制的标准补位
   （dshmarket / dsh-llm-proxy 同模式）
5. 路由判断抛错时兜底直连，插件自身绝不导致请求失败

### 与官方出站代理（`dsh-http-proxy`）及 dsh-llm-proxy 的关系

| 能力 | 本插件 | 官方 dsh-http-proxy | @superfish058/dsh-llm-proxy |
|---|---|---|---|
| 配置方式 | 设置页卡片 + jsonc 文件双入口 | 环境变量 / `.env` | 设置页卡片 |
| 默认语义 | **默认直连**，命中才代理 | 默认全代理，排除列表直连 | 默认直连，选中模型代理 |
| SOCKS5（含认证） | ✓ 原生 | ✗ 明确拒绝 | ✓（有官方包时复用其传输层） |
| 多代理池、每规则选不同代理 | ✓（v0.3） | ✗ 单一出口 | ✗ 单一出口 |
| 按模型选择 | ✓（host 粒度） | ✗ | ✓（host 粒度） |
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
  [proxy-routes] 配置已加载 设置页(proxy-routes)（代理池=[main,backup]，默认=直连，域名规则[anthropic.com,claude.ai=>main；…]，模型路由 2 条，来源=设置页）
  [proxy-routes] settings 命名空间 "proxy-routes" 已注册 —— 设置 → 插件 → 代理路由 实时生效
  [proxy-routes] 设置桥接已挂载 /api/dsh-proxy-routes/settings（5 条路由）
  ```

  每个走代理的请求再打一行（`logRequests: false` 可关闭）：

  ```
  [proxy-routes] POST api.anthropic.com/v1/messages -> main:socks5://127.0.0.1:50939
  ```

- 模型目录冷启动时序：`llm-pi-ai` / `llm-deepseek` 注册晚于本插件，插件会带
  退避重试直到模型目录可解析，provider 配置变化（如改 baseURL）也会触发重编译

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
- 自测：`pnpm install` 后 `node test-plugin.mjs`（19 项：双代理池路由、模型
  路由编译、归一化、dispatcher 复用、热重载、卸载还原；网络用例需要本机
  50939/50018 两个 SOCKS5 代理在运行，缺哪个哪项失败，其余照常）

## 已知限制

- 传输层依赖 DSH 自带的 undici ≥ 7.10（DSH ≥ 0.1.3）；插件不声明 npm 依赖——
  声明反而会在 pnpm 布局下装出第二份 undici
- undici 的 SOCKS5 支持标记为 experimental：进程首次使用会打印一条
  `ExperimentalWarning`，无害
- **同一 API 域名下的模型共享同一路由**（fetch 层只见 URL；变通方案见上文）
- 设置页卡片要求 DSH ≥ 0.1.0-rc.7（settings.plugin.item slot 与 settings
  namespace 机制）；更老版本上插件自动降级为纯文件模式（`enabled`/`configFile`
  条目配置仍可用）
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
- 卡片保存后规则没生效：看启动日志的「模型路由」冲突警告（同域名模型被
  分别设置）与「未知代理」警告
- `连接 SOCKS5 代理超时 / UND_ERR_SOCKS5_AUTH_FAILED`：代理客户端没开、
  端口不对、认证信息错误
- dsh-llm-proxy 用户注意：它把代理一律按 `http://` 处理——纯 SOCKS 端口
  （如 xray 的 50939）会「网络不通」；本插件按 URL 协议分发，SOCKS 端口写
  `socks5://` 即可
- Desktop 场景看不到日志：打开 `%APPDATA%/DSH Desktop/logs/host/dsh-<日期>.log`
