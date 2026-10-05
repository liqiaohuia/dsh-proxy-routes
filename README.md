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
3. **默认走向**：未单独设置的账号（以及一切非 LLM 流量）走哪条路——建议 `direct`，让新流量默认不绕代理
4. 点「**保存**」，立即生效

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

## 兼容性

| DSH 版本 | 设置机制 | 卡片入口 |
|---|---|---|
| Desktop 2.0.14（dsh 0.1.7） | 从插件 Config schema 派生条目表单 | 设置 → 代理路由 + 插件页详情 |
| Desktop 2.0.13（dsh 0.1.5-rc.2） | settings 命名空间 | 设置 → 插件 → 代理路由 |
| 更老（< 0.1.0-rc.7） | 无设置机制 | 仅文件模式（见下文） |

传输层要求 DSH ≥ 0.1.3（自带 undici ≥ 7.10，含 Socks5ProxyAgent）。

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
分三层：① DSH 内置 `web_search` 是**服务端搜索**——由搜索端点（默认 DeepSeek）的服务器替你搜，用它们的网络，本机只发一个搜索 API 请求；该请求经本插件路由，但按**搜索密钥的归属**（通常是默认走向），与当前聊天用哪个模型**无关**。② 内置 `web_fetch` 抓取**不经过本插件**（见已知限制）。③ 若模型服务商自身带搜索能力（服务端工具），搜索同样在服务商的服务器上执行。

## 与官方出站代理的关系

| 能力 | 本插件 | 官方 dsh-http-proxy | @superfish058/dsh-llm-proxy |
|---|---|---|---|
| 配置方式 | 设置页卡片（文件模式可选） | 环境变量 / `.env` | 设置页卡片 |
| 默认语义 | **默认直连**，命中才代理 | 默认全代理，排除列表直连 | 默认直连，选中模型代理 |
| SOCKS5（含认证） | ✓ 原生 | ✗ 不支持 | ✓ |
| 多代理池、每规则选不同代理 | ✓ | ✗ 单一出口 | ✗ 单一出口 |
| 按提供商（账号）分流（同域多账号） | ✓（按密钥识别） | ✗ | ✗（域名粒度） |
| 与其他代理机制 | fetch 层拦截，互不抢占 | 替换全局 dispatcher | 复用官方全局 dispatcher |
| 覆盖范围 | 进程内 `globalThis.fetch`（模型 API、MCP 进程内请求…）；**不含 DSH 内置 web_fetch**（见已知限制） | 进程内全部流量（含 web_fetch）+ 子进程环境 | 同官方范围 |

两者同时启用不冲突：本插件在 fetch 函数层先拦截，命中的走自己的 dispatcher，未命中的才落到全局 dispatcher。

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
  // 打印每次走代理的请求（默认 true）
  "logRequests": true,
  // 「测试」按钮的探测地址
  "probeUrl": "https://www.baidu.com"
}
```

## 从旧版本升级

- **v0.4.1 起按域名分流（`routes`）整体移除**：路由只由「提供商走向 + 默认走向」决定，旧配置里的 `routes` 字段被直接忽略
- 旧版 `modelRoutes`（`"providerId/modelId"`）读取时自动迁移为按提供商（取前缀）
- v0.4.5 起安装即设置页模式，不再自动生成配置文件，「迁移」按钮已移除
- 升级后如果 `update` 拉不到（见常见问题），用 remove + add

## 工作原理（技术细节）

1. **配置**：dsh 0.1.7（Desktop 2.0.14）从插件导出的 **Config schema**（volatile 字段）派生条目配置，官方设置表单与卡片保存（`SettingsForms.mutate`，同一 op 协议）都落到条目配置；dsh 0.1.5（2.0.13）注册 `proxy-routes` 命名空间。手动创建 jsonc 文件时文件模式生效（优先于设置页）
2. **密钥 → 提供商映射**：settings `describe` 读各提供商的凭据引用，经 credentials 服务（或环境变量）解析成密钥，在内存建立映射；provider 配置变化时自动重建；映射无变化时不重复打日志
3. **fetch 拦截**：替换 `globalThis.fetch`：每个请求提取密钥头 → 命中提供商 → 该账号的显式走向；未命中走默认走向。路由判断抛错时兜底直连，插件自身绝不导致请求失败
4. **传输**：命中代理的请求交给 DSH 自带的 undici（`Socks5ProxyAgent` / `ProxyAgent` per-request dispatcher，按代理 URL 池化复用）——SOCKS5 隧道、HTTP CONNECT、TLS、压缩、重定向、SSE 流式都是 undici 原生实现；**不触碰 undici 全局 dispatcher**
5. **卡片桥接**：本机回环同源桥接（`/api/dsh-proxy-routes/settings/*`，loopback + 同源 + Host 校验，4 条路由）读写配置、列提供商、跑测试——第三方 namespace 不在 DSH apiproxy 白名单里，此桥接为官方机制的标准补位（dshmarket / dsh-llm-proxy 同模式）

技术性备忘：宿主侧唯一的 npm 运行时依赖是 `@deepseek-ai/schemastery`（`~3.18.4`，Config schema 需要，与官方插件一致）；**有意不声明** undici——声明会在 pnpm 布局下装出第二份 undici，导致 dispatcher 与 DSH 主进程不一致。

其他已知限制：

- undici 的 SOCKS5 支持标记为 experimental：首次使用打印一条 `ExperimentalWarning`，无害
- 走代理的请求跟随 3xx 重定向、HTTP/1.1（undici 默认不开 HTTP/2）；HTTP(S) 代理侧禁用空闲连接复用以规避代理客户端静默关闭空闲隧道导致的挂起（Clash 实测问题）
- 工作线程（workflow / code-runtime worker thread）里自建的 fetch 不经过本补丁
- **DSH 内置 `web_fetch` 工具不经过本插件**：它直接 `import("undici")` 并按官方 dsh-http-proxy 的策略选 dispatcher（直连时还自带 DNS 钉扎）——想让 `web_fetch` 走代理只能配置官方出站代理插件。**内置 `web_search` 则是服务端搜索**：搜索由搜索端点（默认 `https://api.deepseek.com/anthropic/v1`）的服务器执行，用服务端的网络；只有搜索 API 请求本身经过本插件（按其密钥归属路由，未匹配则默认走向），与当前聊天用哪个模型无关

## 开发与维护

```powershell
git clone https://github.com/liqiaohuia/dsh-proxy-routes.git
cd dsh-proxy-routes
pnpm install          # devDependencies：undici/react/esbuild/typescript
node test-plugin.mjs  # 40 项测试（网络用例需本机 50939/50018 两个 SOCKS5 代理在运行）
```

- **开发机用 link 安装**：`dsh plugin add <本目录>` 放的是指向本目录的 `link:` 依赖——改 host 侧代码（`index.mjs` / `transport.mjs` / `catalog.mjs`）后重启即生效；改客户端（`src/client/`）后要 `pnpm build` 重建 `lib/client.js` 再重启
- 开发机**重装前先完全退出 DSH Desktop**（见常见问题的 EPERM 条目）
- **发布到 npm**：`npm login`（2FA 用 passkey / Windows Hello）→ `npm publish`；发布物为 8 个文件（`npm pack` 可预览，含 `lib/client.js`）
- **上架 dshmarket**：向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR（在 plugins.json 里加一条本插件的 npm 包信息），合并后约一天内出现在市场
- **安装方式二（免 pnpm）**：把仓库复制到 profile 下，在 `cordis.patch.yml` 里加：

  ```yaml
  - insert:
      - id: proxy-routes
        name: './plugins/dsh-proxy-routes/index.mjs'
  ```

  与 `dsh plugin add` 不要同时用（同一 id 挂两次）

## License

MIT
