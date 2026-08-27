# dsh-proxy-routes —— DSH 按域名分流的代理路由插件

给 DSH（DeepSeek Harness）装的 Cordis 插件：拦截本进程内所有 `fetch` 请求，
按**域名**决定走**代理**还是**直连**。零依赖（纯 Node 核心模块），配置保存后
自动热生效，无需重启 dsh。

解决什么问题：Anthropic 等海外 API 对中国大陆 IP 返回 403（DSH 界面误显示为
"API key is invalid"），而智谱/DeepSeek 等国内 API 又不该绕道代理。本插件让
两类流量各走各的路。

## 安装

前置要求：Node ≥ 22、DSH 已装（`npm i -g @deepseek-ai/dsh`）、代理客户端
（Clash/v2rayN/xray 等）在运行。插件**不会**替你启动代理客户端。

### 方式一：包安装（推荐，需要 pnpm）

```powershell
# 从 npm（发布后）：
dsh plugin --profile web add dsh-proxy-routes

# 或从本地目录 / git 仓库：
dsh plugin --profile web add D:\path\to\dsh-proxy-routes
dsh plugin --profile web add https://github.com/<you>/dsh-proxy-routes.git
```

本包在 `package.json` 里声明了 `dsh.bundle.patch`，`dsh plugin add` 装完会
**自动**把它登记为 profile 的 bundle 层——不需要手动编辑任何 YAML。升级用
`dsh plugin --profile web update dsh-proxy-routes`，卸载用
`dsh plugin --profile web remove dsh-proxy-routes`。

然后重启 profile（`dsh web`）即生效。首次启动会在 `$DSH_HOME/proxy-routes.jsonc`
自动生成带注释的配置模板，把其中的 `"proxy"` 改成你的代理地址保存即可（热生效，
不用再重启）。

### 方式二：手动文件复制（不需要 pnpm）

把本目录复制到 profile 下：

```
<DSH_HOME>/profiles/web/plugins/dsh-proxy-routes/index.mjs
```

然后在同一 profile 的 `cordis.patch.yml`（没有就新建）里加：

```yaml
- insert:
    - id: proxy-routes
      name: './plugins/dsh-proxy-routes/index.mjs'
```

重启该 profile 即生效。可选条目配置：

```yaml
- insert:
    - id: proxy-routes
      name: './plugins/dsh-proxy-routes/index.mjs'
      config:
        enabled: true                       # false = 禁用插件
        configFile: 'D:/anywhere/rules.jsonc'  # 自定义配置文件路径
```

> 两种方式不要同时用（同一 id 挂两次）。从方式二迁移到方式一时，先删掉
> cordis.patch.yml 里手动加的那行和 plugins 下的副本，再执行 `dsh plugin add`。

## 换新电脑

需要搬三样东西：

1. **插件本体**：仓库 clone 下来后 `dsh plugin --profile web add <目录>`，
   或直接 `dsh plugin --profile web add dsh-proxy-routes`（发布到 npm 后）
2. **分流配置**：复制旧的 `~/.dsh/proxy-routes.jsonc`；或不管它，首次启动
   自动生成模板后改一行 `"proxy"`
3. **DSH 自身的配置**（与本插件无关但同样要办）：复制 `~/.dsh/settings.yaml`
   （模型设置）与 `~/.dsh/.credentials.yaml`（API key，**绝不要**提交进仓库）。
   或者干脆不搬文件——在新电脑的 dsh web 界面「设置」里直接重新配置模型与
   API key，效果完全一样，不需要知道配置文件在哪。

## 发布（GitHub，可选加 npm）

公开分享有两条路线，任选其一（或都要）：

**路线 A —— 只用 GitHub（不需要 npm 账号）**：推上仓库后，用户直接从 git URL
安装（见上文「安装 · 方式一」）。`dsh plugin` 原生支持 git 托管包；本包零依赖、
无构建脚本，不会触发 pnpm 的构建放行提示。缺点：安装稍慢（要 clone）、没有
语义化版本号（`update` 拉的是分支最新代码）、npm 搜索里找不到。

**路线 B —— GitHub + npm（推荐）**：npm 提供短包名安装、版本号管理与回滚、
npm 搜索可发现性。需要在 [npmjs.com](https://www.npmjs.com) 注册一个免费账号：

```powershell
npm login                 # 会打开浏览器完成验证
npm pack                  # （可选）本地检查将要发布的文件清单
npm publish               # 开了 2FA 会要求输入一次性验证码
```

本目录已具备发包条件（`package.json` 含 `dsh.bundle.patch` 声明、`files`
字段、MIT LICENSE）：

源码推 GitHub（`repository` 字段记得改成你的地址）：

```powershell
git init
git add .
git commit -m "dsh-proxy-routes v0.1.0"
git branch -M main
git remote add origin https://github.com/<you>/dsh-proxy-routes.git
git push -u origin main
```

发布后其他用户的完整安装就是两条命令 + 改一行配置：

```powershell
dsh plugin --profile web add dsh-proxy-routes
dsh web    # 重启后按控制台提示改 ~/.dsh/proxy-routes.jsonc 的 proxy 地址
```

## 开发迭代

本目录是**源码**。两种部署方式下，改代码的生效路径不同：

- **包安装（link 方式，推荐）**：`dsh plugin add <本目录>` 会在 profile 的
  `node_modules` 里放一个**指向本目录的符号链接**（pnpm 的 `link:` 依赖），
  dsh 加载的就是本目录的文件本体。改 `index.mjs` 后**重启 `dsh web` 即生效**——
  不需要复制文件、不需要重新执行任何命令、也不需要任何 git 操作。
  之所以要重启：`fetch` 补丁是启动时打的，正在运行的进程不会重新加载插件代码。
- **手动复制方式**：改完要重新复制到
  `<DSH_HOME>/profiles/web/plugins/dsh-proxy-routes/` 再重启。

配置文件 `proxy-routes.jsonc` 两种方式下都不受此限制——保存即热生效。
在本目录运行 `node test-plugin.mjs` 可做全套自测（会真实调用一次 Anthropic 与
智谱端点，需代理在运行、`~/.dsh/.credentials.yaml` 里有 ANTHROPIC_API_KEY）。

## 多台电脑开发（家里 / 公司）

**不需要为源码另建私有仓库**——本插件没有构建步骤，**源码即发布物**
（`npm publish` 打包的就是仓库里这几个文件）。一个公开仓库同时承担源码之家、
issue 跟踪和（可选的）git 直装来源三个角色：

```powershell
# 新电脑接入（一次性）：
git clone https://github.com/<你>/dsh-proxy-routes.git
dsh plugin --profile web add D:\path\to\dsh-proxy-routes   # link 指向本地 clone

# 日常迭代（每台电脑都一样）：
#   改 index.mjs → 重启 dsh web 验证 → node test-plugin.mjs 自测
git add . ; git commit -m "..." ; git push

# 另一台电脑同步：git pull

# 版本稳定后发新版（任意一台电脑；每台电脑首次发布前先 npm login）：
#   package.json 里把 version 加一位 → npm publish
```

每台电脑的个人环境互不干扰、也永不进仓库：API key 在 `~/.dsh/.credentials.yaml`
（或直接在 dsh web 界面配置），代理分流规则在 `~/.dsh/proxy-routes.jsonc`
（首次启动自动生成模板，各机器各一份）。

## 配置文件

默认读取 `<DSH_HOME>/proxy-routes.jsonc`（`~/.dsh/proxy-routes.jsonc`），
JSON 语法 + 支持 `//` 与 `/* */` 注释：

```jsonc
{
  "proxy": "socks5://127.0.0.1:50018",   // 或 "http://127.0.0.1:7890"
  "default": "direct",                    // 未命中规则的域名默认直连
  "routes": [
    { "domains": ["anthropic.com", "claude.ai"], "via": "proxy" },
    { "domains": ["open.bigmodel.cn", "deepseek.com"], "via": "direct" }
  ]
}
```

- `domains` 写域名自动覆盖其所有子域名（`anthropic.com` 匹配 `api.anthropic.com`）
- 规则从上到下匹配，首条命中生效
- `socks5://` 的域名解析在代理端完成（等效 socks5h），可绕开本地 DNS 污染
- 保存文件后约 0.3 秒自动生效；语法错误时保留上一份配置并在控制台报错
- 走代理的请求复用 keep-alive 连接（同一域名后续请求不再重新握手）

## 工作原理

DSH 的 LLM 适配器（pi-ai → 各官方 SDK → 全局 `fetch`）没有代理支持。本插件
在 Cordis 启动时替换 `globalThis.fetch`：

1. 每个请求先查路由表：命中 `proxy` → 走第 2 步；否则原样交给原始 fetch（直连）
2. 代理请求经 SOCKS5 / HTTP CONNECT 建立隧道，在其上完成 TLS 与 HTTP/1.1，
   包装成标准 `Response`（支持 SSE 流式读取，Anthropic SDK 可正常消费）
3. 路由判断抛错时兜底直连，插件自身绝不导致请求失败

## 日志与启动时机

- **插件随 `dsh web` 启动即生效**——启动时读配置、替换 fetch，不需要先发消息。
  但到代理的 TCP 隧道是**惰性**的：第一次访问命中代理的域名（例如给 Claude
  Opus 5 发第一条消息）时才建立，之后同域名 keep-alive 复用。
- 本插件**不会启动你的代理客户端**——请确保它已在配置写的地址上运行
  （例如 `socks5://127.0.0.1:50018` 对应的 xray/Clash 已开着）。
- 日志直接打印到**运行 `dsh web` 的那个控制台**（DSH 的 Cordis logger 只写
  内存缓冲、不外显，所以插件自己打印）。启动时会看到一行：

  ```
  [proxy-routes] 配置已加载 C:\Users\...\.dsh\proxy-routes.jsonc（代理=socks5://127.0.0.1:50018，默认=直连，规则[anthropic.com,claude.ai=>代理；open.bigmodel.cn,bigmodel.cn,deepseek.com=>直连]）
  ```

  每个走代理的请求再打一行（`logRequests: false` 可关闭）：

  ```
  [proxy-routes] POST api.anthropic.com/v1/messages -> socks5://127.0.0.1:50018
  ```

## 已知限制

- 支持的代理协议：`socks5://`（`socks5h://`/`socks://` 写法等价，域名解析在
  代理端完成）与 `http://`（HTTP CONNECT，支持 `http://user:pass@host:port`
  的 Basic 认证）；**不支持**代理端 TLS（`https://` 代理——写进配置会得到明确报错）
- SOCKS5 不支持用户名/密码认证（免认证的本地代理客户端都不受影响）
- 走代理的请求不跟随 3xx 重定向、仅 HTTP/1.1
- 工作线程（workflow worker thread）里若有人自建 fetch 发请求，不经过本补丁
- `~/.dsh/profiles/<profile>/settings.yml` 不是 DSH 的有效配置文件，
  里面写代理规则没有作用（DSH 只读 `~/.dsh/settings.yaml` 与 cordis 补丁层）

## 排障

- 界面仍报 "API key is invalid"：看控制台有没有 `[proxy-routes]` 的请求日志；
  没有 = 规则没命中或插件没加载（检查 `cordis.patch.yml`）；有 = 代理端问题
- `连接 SOCKS5 代理超时`：代理客户端没开，或端口不对
- `SOCKS5 CONNECT 失败（code=…）`：代理端规则拦截了目标域名
