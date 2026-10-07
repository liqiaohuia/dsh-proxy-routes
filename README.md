# dsh-proxy-routes —— 让每个 AI 账号走自己的代理

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai)装的插件：**同一个模型服务商的多个账号，可以各自决定走哪个代理还是直连**。配置在 DSH 设置页图形化管理，保存即热生效，不需要手写任何文件。

## 它解决什么问题

- Anthropic / NVIDIA NIM 等海外 API 对中国大陆 IP 返回 403（DSH 界面误显示为 "API key is invalid"）
- 智谱 / DeepSeek 等国内 API 又不该绕道代理
- 最关键的场景：**同一服务商的多个账号**——免费额度号要走代理、付费主力号要直连，但它们打向**同一个 API 域名**，任何按域名的分流都无法区分

本插件按每个请求携带的 **API 密钥**识别它属于哪个账号，从而精确到账号级分流。

## 三步上手

### 第 1 步：安装

**DSH Desktop 用户**（不用带 `--profile`，桌面版自动管理 `desktop` profile）：

```powershell
dsh plugin add dsh-proxy-routes
```

**命令行（`dsh web`）用户**：

```powershell
dsh plugin --profile web add dsh-proxy-routes
```

前提：已装 DSH、有 pnpm、代理客户端（Clash / v2rayN / xray 等）在运行。**插件只负责分流，不会替你启动代理客户端。**

### 第 2 步：重启，打开卡片

完全退出 DSH（桌面版从托盘退出）再启动，然后打开 **设置 → 代理路由**。

> 卡片的三个入口（任选其一，内容相同）：
> - **设置 → 代理路由**（独立设置页，各版本都有，推荐）
> - DSH Desktop 2.0.14+：侧栏「插件」页 → dsh-proxy-routes → 详情
> - DSH Desktop 2.0.13：设置 → 插件 → 代理路由

### 第 3 步：配置并保存

1. **代理池**：给每个代理起名并填地址，例如 `main` = `socks5://127.0.0.1:50939`。填完直接点「测试」确认可达——测试的是输入框里**当前的草稿值**，不用先保存
2. **按提供商（账号）分流**：列表自动来自 DSH「模型」页配置的 LLM 账号（claude1、nvidia-01…），每行下拉选择 直连 / 池中某个代理；选「规则」（默认）表示不单独设置、按默认走向走
3. **默认走向**：未单独设置的账号（以及一切非 LLM 流量）走哪条路——建议 `direct`，让新流量默认不绕代理。其下方「**直连的行为**」默认**绝对直连**：被选为直连的请求由本插件强制直连，无视 DSH 全局代理与其他代理设置；想交回 DSH 原生策略可切换为「遵循全局代理」
4. **内置联网工具代理**（可选，v0.5.0）：想让 `web_fetch` 抓境外网页、MCP 子进程等未认领流量也走代理时勾选，填一个 **http:// 代理的 `host:port`**（如 `127.0.0.1:10000`，`http://` 前缀已固定）——保存即生效、无需重启，关闭或卸载插件时自动还原 DSH 原有全局设置
5. 点「**保存**」，立即生效

### 验证生效

随便给一个走代理的模型发条消息，然后在日志里找这一行（格式：`账号=>代理名:地址`）：

```
[proxy-routes] POST api.anthropic.com/v1/messages -> claude1=>main:socks5://127.0.0.1:50939
```

**日志在哪看**：

- DSH Desktop（Windows）：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`（Win+R 输入 `%APPDATA%\DSH Desktop\logs\host` 回车，打开今天日期的文件，搜 `[proxy-routes]`）
- `dsh web`：运行它的那个控制台窗口

直连的请求不打印；日志只含去向，**绝不包含 API 密钥**。关掉「其他选项 → 打印每次走代理的请求日志」可以静音。

## 卡片功能细节

### 代理池

- 三种协议混用，可带认证（`socks5://user:pass@host:port`）：
  - `socks5://127.0.0.1:1080` —— 域名解析交给代理端（等效 socks5h，防 DNS 污染）
  - `http://127.0.0.1:7890` —— HTTP CONNECT 隧道
  - `https://127.0.0.1:7891` —— 代理端 TLS
- **混合端口**（同一端口同时收 http 和 socks，如 xray 常见配置）两种写法都行，按你写的协议分发
- 「测试」探测的是「其他选项」里的 `probeUrl`。**默认 `https://www.gstatic.com/generate_204` 在大陆直连是被墙的**——建议改成墙内外都可达的地址（如 `https://www.baidu.com`），这样「直连」和「走代理」两边的测试结果才都真实
- 名称可以随时改（不会丢焦点），删除前先确认没有走向还在引用它——引用了不存在名字的规则会回退直连并在日志警告

### 按提供商（账号）分流

- 提供商列表 = DSH「模型」页里的 LLM 账号，自动出现/更新，无需手动添加
- 下拉选项 = **直连 + 代理池里的每个名字**（池为空时只有直连）
- 「规则」= 不单独设置 → 走默认走向
- 每行的「测试」按该提供商**当前生效的路由**探测；没有单独设置的账号测的就是默认走向

### 它是怎么认出账号的（原理一瞥）

DSH 发出的每个 LLM 请求都带着该账号的 API 密钥头（`x-api-key` / `authorization: Bearer`）。插件在 fetch 层提取密钥、匹配「密钥 → 提供商」映射（启动时经 DSH settings + credentials 服务在**内存中**建立），即可判断这次请求属于哪个账号。密钥只在内存中匹配，**绝不写日志、绝不外发**。

路由优先级：**提供商显式走向 > 默认走向**。

### 直连的行为（v0.5.0）

默认走向与各提供商的「直连」都由这一对单选决定，**默认「绝对直连」**：

- **绝对直连**：直连请求由本插件用自建 dispatcher 发出，在传输层就绕开官方 dsh-http-proxy 安装的全局代理——不管系统设没设 `HTTP(S)_PROXY`、也不受其他代理插件干扰，「直连」就是字面意义的直连。调用国内模型飞快，不被任何全局代理拖累
- **遵循全局代理**：回到 v0.4 的语义——本插件对直连请求不干预，交回 DSH 原生出站策略（若设置了 `HTTP(S)_PROXY` 环境变量则随之走代理）
- 两种模式下，配了代理的提供商都走自己的代理，不受影响

「测试」按钮按同样语义探测：绝对直连时，直连测试走的就是插件自建 dispatcher，测出来的即真实路径。

### 内置联网工具代理（v0.5.0）

DSH 内置的 `web_fetch` 抓取、之后启动的 MCP 子进程、以及一切**未被本插件认领**的流量，默认不经过本插件——它们归官方全局出站策略管。勾选本模块即可在卡片里直接驱动该策略：

- 只支持 **http:// 代理**（官方 dsh-http-proxy 拒收 SOCKS URL），因此地址固定为 `http://` 前缀 + `host:port`（如 `127.0.0.1:10000`），输入框只填 `host:port`
- **保存即生效，无需重启 DSH**，也完全不需要设置系统环境变量——插件热装官方全局策略；关闭或卸载时自动原样还原，系统原有的 `HTTP(S)_PROXY` 配置不受破坏
- 典型场景：模型 API 走国内端点、被本插件认领为绝对直连——飞快；同时 `web_fetch` 抓境外网页走这里配的代理——不被墙。两者互不干扰，这就是「直连的行为」作为底层保证的意义
- 回环地址（localhost / 127.0.0.1）永远自动豁免，本地流量不会被送进代理

## 兼容性

| DSH 版本 | 设置机制 | 卡片入口 |
|---|---|---|
| Desktop 2.0.14（dsh 0.1.7） | 从插件 Config schema 派生条目表单 | 设置 → 代理路由 + 插件页详情 |
| Desktop 2.0.13（dsh 0.1.5-rc.2） | settings 命名空间 | 设置 → 插件 → 代理路由 |
| 更老（< 0.1.0-rc.7） | 无设置机制 | 仅文件模式（见下文） |

传输层要求 DSH ≥ 0.1.3（自带 undici ≥ 7.10，含 Socks5ProxyAgent）；「内置联网工具代理」的热装依赖宿主自带的 `@deepseek-ai/dsh-http-proxy`（同版本起均内置，无需额外安装）。

## 常见问题（排障）

**重装/升级时报 `ERR_PNPM_EPERM`（operation not permitted）**
Windows 文件锁：DSH 正在运行时无法替换插件目录。先**完全退出 DSH Desktop**（托盘 → 退出）再执行 `dsh plugin add`。如果之前是从本地目录链接安装、后来改从 npm 装，node_modules 里可能残留指向旧目录的 Junction，清理后再装（`rmdir` 只删链接本身，不碰真实文件）：

```powershell
cmd /c rmdir "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-proxy-routes"
cmd /c rmdir "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-proxy-routes_tmp_*"
dsh plugin add dsh-proxy-routes
```

**`dsh plugin update` 拉不到新版本**
早期安装记录的是 `^0.1.0` 之类的窄范围，永远看不到 0.4.x。解决：`dsh plugin remove dsh-proxy-routes` 再 `dsh plugin add dsh-proxy-routes`（remove + add，不要只 update）。

**「直连」测试显示不通，但代理其实是好的**
默认探测地址 gstatic 在大陆直连被墙。把「其他选项 → 测试连接使用的探测地址」改成 `https://www.baidu.com` 即可。

**界面仍报 "API key is invalid"**
看日志里有没有 `[proxy-routes]` 请求记录：没有 = 路由没命中或插件没加载（确认插件已装、DSH 重启过）；有记录但报错 = 代理出口本身的问题。

**日志里出现 `session-title-service ... maxOutputTokens` 警告**
那是 DSH 自带的「会话自动起标题」功能的模型输出超限，与本插件无关（请求已被正常路由）。

**卡片显示「读取配置失败」**
host 桥接没挂上或不是本机访问。确认 DSH ≥ 0.1.0-rc.7 且重启过；**从局域网其他设备访问 `dsh web` 时**，桥接的回环校验会拒绝——需要在本插件条目配置里加 `trustedOrigins: ["http://<访问地址:端口>"]` 放行。

**`连接 SOCKS5 代理超时 / UND_ERR_SOCKS_AUTH_FAILED`**
代理客户端没开、端口不对、认证信息错误。

**模型联网搜索时，搜索流量走哪条路？和模型的代理设置有关吗？**
分三层：① DSH 内置 `web_search` 是**服务端搜索**——由搜索端点（默认 DeepSeek）的服务器替你搜，用它们的网络，本机只发一个搜索 API 请求；该请求经本插件路由，但按**搜索密钥的归属**（通常是默认走向），与当前聊天用哪个模型**无关**。每次搜索是一次真实的模型调用（默认 `deepseek-v4-flash` 挂服务端搜索工具），**要扣费**：当前会话跑 DeepSeek 账号模型时用 DSH 登录账号额度，跑其他模型（含第三方）时用配置的 `DEEPSEEK_API_KEY`（凭据服务 / 环境变量 / 搜索配置字面量），两者都拿不到则直接报错、不做搜索。给这把 key 配的代理只影响「本机 ↔ 搜索端点」这段**传输**，搜索本身仍在服务端完成，代理设不设不改变搜索性质。② 内置 `web_fetch` 抓取**不经过本插件**（见已知限制）。③ 若模型服务商自身带搜索能力（服务端工具），搜索同样在服务商的服务器上执行。

**设置了 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量后，与本插件的分流谁说了算？**
DSH 启动时由官方 dsh-http-proxy 读取这三个环境变量，装一个进程级全局 dispatcher，对本 profile 所有会话、所有模型生效（**仅支持 http:// 代理，SOCKS URL 会被拒绝、该协议保持直连**；改完要彻底重启 DSH，桌面版与 `dsh web` 是两个进程、各读各的环境）。与本插件的关系是一条认领链：

- 密钥命中且该提供商配了**代理** → 本插件绝对优先，全局代理够不着
- 密钥命中但配的是**直连** → v0.5.0 起**默认「绝对直连」**：本插件强制直连，全局代理同样够不着；切换为「遵循全局代理」时才落回全局 dispatcher、随之走代理
- `web_fetch`、不带密钥的请求 → 只由全局策略决定（v0.5.0 起也可在卡片「内置联网工具代理」里直接配置并热装，保存即生效，无需重启）

子进程（MCP 等）会继承这些环境变量、自己的流量同样过全局代理；想豁免个别域名用 `NO_PROXY`（回环地址永远豁免）。实用部署顺序：**先设全局环境变量并重启，再按需配提供商分流**——已配代理的提供商不受全局影响，原先「直连」的提供商会自然落到全局代理上。

## 与官方出站代理的关系

| 能力 | 本插件 | 官方 dsh-http-proxy |
|---|---|---|
| 配置方式 | 设置页卡片（文件模式可选） | 环境变量 / `.env` |
| 默认语义 | **默认直连**，命中才代理 | 默认全代理，排除列表直连 |
| SOCKS5（含认证） | ✓ 原生 | ✗ 不支持 |
| 多代理池、每规则选不同代理 | ✓ | ✗ 单一出口 |
| 按提供商（账号）分流（同域多账号） | ✓（按密钥识别） | ✗ |
| 与其他代理机制 | fetch 层拦截，互不抢占 | 替换全局 dispatcher |
| 覆盖范围 | 进程内 `globalThis.fetch`（模型 API、MCP 进程内请求…）；**不含 DSH 内置 web_fetch**（v0.5.0 起可经卡片「内置联网工具代理」热装官方策略补上） | 进程内全部流量（含 web_fetch）+ 子进程环境 |

两者同时启用不冲突：本插件在 fetch 函数层先拦截，配了代理的提供商走自己的 dispatcher；未命中的请求落到全局 dispatcher；配了「直连」的提供商按「直连的行为」决定——默认绝对直连（本插件强制，全局代理够不着），切换为「遵循全局代理」时才回落全局。优先级细节见上方常见问题「设置了 HTTP_PROXY…」。

## 多机器 / 多 profile 说明

- **配置存在各自的 DSH profile 里**：`desktop` 和 `web` 是两个 profile、两份配置；换机器也是新的——每台机器（每个 profile）都要在卡片里配一遍代理池和提供商走向
- 代理地址是**本机**的——`127.0.0.1:端口` 指的是运行 DSH 的那台机器上监听的代理客户端
- `dsh web` 里 UI 设置页与桌面版完全相同（同一个 Web 应用）：`dsh web` 启动后用 `http://127.0.0.1:<端口>` 打开即可

## 文件模式（可选，命令行用户）

设置页是默认方式。如果你更喜欢纯文本自管配置，手动创建 `$DSH_HOME/proxy-routes.jsonc`（JSONC 语法，保存约 0.3 秒热生效）即进入文件模式——卡片变为只读并显示一行说明；删除该文件并重启即回到设置页。条目配置 `configFile` 可指定其他路径。

```jsonc
{
  // 命名代理池：名字 → 地址（协议与认证写法同上）
  "proxies": { "main": "socks5://127.0.0.1:50939" },
  // 单代理（可选），等价于池里名为 "default" 的一项
  "singleProxy": "",
  // 默认走向："direct" | "proxy"（单代理）| 代理名
  "default": "direct",
  // 按提供商（账号）：提供商 id（DSH「模型」页里的账号 ID）→ 走向
  "providerRoutes": { "claude1": "main", "claude2": "direct" },
  // 直连的语义（v0.5.0）："enforce"=绝对直连（默认，无视 DSH 全局代理）| "passthrough"=不干预、遵循 DSH 全局代理
  "directMode": "enforce",
  // 内置联网工具代理（v0.5.0）：web_fetch / MCP 子进程 / 未认领流量的 http:// 代理（host:port，不带前缀）
  "webToolsEnabled": false,
  "webToolsProxy": "127.0.0.1:10000",
  // 打印每次走代理的请求（默认 true）
  "logRequests": true,
  // 「测试」按钮的探测地址
  "probeUrl": "https://www.baidu.com"
}
```

## 从旧版本升级

- **v0.5.0 起「直连」默认为绝对直连**：被本插件认领的直连请求不再回落 DSH 全局代理（v0.4 语义为不干预、会跟随 `HTTP(S)_PROXY`）。如果你设了系统环境变量代理且希望直连请求也走它，把卡片「直连的行为」切换为「遵循全局代理」即可，行为与 v0.4 完全一致
- **v0.4.1 起按域名分流（`routes`）整体移除**：路由只由「提供商走向 + 默认走向」决定，旧配置里的 `routes` 字段被直接忽略
- 旧版 `modelRoutes`（`"providerId/modelId"`）读取时自动迁移为按提供商（取前缀）
- v0.4.5 起安装即设置页模式，不再自动生成配置文件，「迁移」按钮已移除
- 升级后如果 `update` 拉不到（见常见问题），用 remove + add

## 工作原理（技术细节）

1. **配置**：dsh 0.1.7（Desktop 2.0.14）从插件导出的 **Config schema**（volatile 字段）派生条目配置，官方设置表单与卡片保存（`SettingsForms.mutate`，同一 op 协议）都落到条目配置；dsh 0.1.5（2.0.13）注册 `proxy-routes` 命名空间。手动创建 jsonc 文件时文件模式生效（优先于设置页）
2. **密钥 → 提供商映射**：settings `describe` 读各提供商的凭据引用，经 credentials 服务（或环境变量）解析成密钥，在内存建立映射；provider 配置变化时自动重建；映射无变化时不重复打日志
3. **fetch 拦截**：替换 `globalThis.fetch`：每个请求提取密钥头 → 命中提供商 → 该账号的显式走向；未命中走默认走向。`directMode: enforce`（默认）时直连请求用自建 dispatcher 强制直连（全局代理被彻底旁路）；`passthrough` 时直连请求交回原始 fetch（回落 DSH 全局策略）。路由判断抛错时兜底直连，插件自身绝不导致请求失败
4. **传输**：命中代理的请求交给 DSH 自带的 undici（`Socks5ProxyAgent` / `ProxyAgent` per-request dispatcher，按代理 URL 池化复用）——SOCKS5 隧道、HTTP CONNECT、TLS、压缩、重定向、SSE 流式都是 undici 原生实现；**不触碰 undici 全局 dispatcher**。**内置联网工具代理**则热装官方 dsh-http-proxy 的全局策略（同一模块实例，web_fetch 立即可见），持有其 disposer 在关闭/卸载时还原
5. **卡片桥接**：本机回环同源桥接（`/api/dsh-proxy-routes/settings/*`，loopback + 同源 + Host 校验，4 条路由）读写配置、列提供商、跑测试——第三方 namespace 不在 DSH apiproxy 白名单里，此桥接为官方机制的标准补位（dshmarket / dsh-llm-proxy 同模式）

技术性备忘：宿主侧唯一的 npm 运行时依赖是 `@deepseek-ai/schemastery`（`~3.18.4`，Config schema 需要，与官方插件一致）；**有意不声明** undici——声明会在 pnpm 布局下装出第二份 undici，导致 dispatcher 与 DSH 主进程不一致。

其他已知限制：

- undici 的 SOCKS5 支持标记为 experimental：首次使用打印一条 `ExperimentalWarning`，无害
- 走代理的请求跟随 3xx 重定向、HTTP/1.1（undici 默认不开 HTTP/2）；HTTP(S) 代理侧禁用空闲连接复用以规避代理客户端静默关闭空闲隧道导致的挂起（Clash 实测问题）
- 工作线程（workflow / code-runtime worker thread）里自建的 fetch 不经过本补丁
- **DSH 内置 `web_fetch` 工具不经过本插件**：它直接 `import("undici")` 并按官方 dsh-http-proxy 的策略选 dispatcher（直连时还自带 DNS 钉扎）。想让 `web_fetch` 走代理：v0.5.0 起在卡片勾选「内置联网工具代理」即可热装官方全局策略（保存即生效）；或照旧配置 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 环境变量（启动时读取，需重启，同样仅支持 http:// 代理）。**内置 `web_search` 则是服务端搜索**：搜索由搜索端点（默认 `https://api.deepseek.com/anthropic/v1`）的服务器执行，用服务端的网络；只有搜索 API 请求本身经过本插件（按其密钥归属路由，未匹配则默认走向），与当前聊天用哪个模型无关（扣费凭据规则见常见问题）

## 开发与维护

```powershell
git clone https://github.com/liqiaohuia/dsh-proxy-routes.git
cd dsh-proxy-routes
pnpm install          # devDependencies：undici/react/esbuild/typescript
node test-plugin.mjs  # 47 项测试（网络用例需本机 50939/50018 两个 SOCKS5 代理在运行）
```

- **开发机用 link 安装**：`dsh plugin add <本目录>` 放的是指向本目录的 `link:` 依赖——改 host 侧代码（`index.mjs` / `transport.mjs` / `catalog.mjs`）后重启即生效；改客户端（`src/client/`）后要 `pnpm build` 重建 `lib/client.js` 再重启
- 开发机**重装前先完全退出 DSH Desktop**（见常见问题的 EPERM 条目）
- **发布到 npm**：`npm login`（2FA 用 passkey / Windows Hello）→ `npm publish`；发布物为 8 个文件（`npm pack` 可预览，含 `lib/client.js`）
- **上架 dshmarket / awesome 列表**：向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR，在 `data/plugins/` 下新建一个独立 YAML 文件（如 `liqiaohuia__dsh-proxy-routes.yml`），字段为 `url`（仓库地址）、`name`（owner/repo）、`category`（合法值见其 contributing.md）、`description`（en 必填、zh 可选），可选 `tarball:` 指向 GitHub Release 的 `.tgz`；两个 README 与市场页面由条目文件自动生成，勿手改。npm 包经 `repository` 字段自动关联并显示下载量；仓库需打上 `dsh-plugin` topic
- **安装方式二（免 pnpm）**：把仓库复制到 profile 下，在 `cordis.patch.yml` 里加：

  ```yaml
  - insert:
      - id: proxy-routes
        name: './plugins/dsh-proxy-routes/index.mjs'
  ```

  与 `dsh plugin add` 不要同时用（同一 id 挂两次）

## License

MIT
