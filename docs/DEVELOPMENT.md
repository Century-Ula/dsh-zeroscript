# 开发文档

面向想改这个插件的人。用户安装请回到 [README](../README.md)。

## 1. 它和 DSH 的契约

DSH 0.2 的第三方 **host 插件**有两种接法：

| 接法 | 做法 | 本项目 |
|---|---|---|
| **profile patch 条目**（本插件用的） | 在 `<profile>\cordis.patch.yml` 插入一个 loader 条目，`name` 可以是包名、绝对路径或 `file://` URL | ✅ 已实测 |
| **bundle 组合包** | 包声明 `dsh.bundle.patch`，装进 profile `package.json` 的 `dsh.profile.bundles` | 未采用；功能等价，但需要 pnpm 安装 + 重启 |

本插件为什么用 profile patch 条目：

- 插件不是 npm 包，不依赖安装步骤，改代码没有构建；
- 条目里的 `?m=N` 可以精确控制模块缓存，热重载时整个模块图一起换；
- bundle 需要 `pnpm add` 和组合包校验，对单机自用插件是多余的一层。

一个条目长这样（完整示例见 [`cordis.patch.example.yml`](../cordis.patch.example.yml)）：

```yaml
- insert:
    - id: zeroscript
      name: "file:///C:/Tools/dsh-zeroscript/lib/index.js?m=1"
      config:
        port: 17613
```

插件目录需要以 **junction** 出现在 `<profile>\node_modules\dsh-zeroscript`：
宿主加载走 `file://` 不依赖它，但 **GUI 客户端半（`client.js`）只有作为包出现在
客户端模块图里才会被送进浏览器**。`/zeroscript/api/host` 的 `clientModules.rows`
里能看到 `dsh-zeroscript` 条目，就说明侧栏面板的模块已进图。

### 模块缓存与热重载

`lib/index.js` 用 `import.meta.url` 的 query 拼所有兄弟模块的 specifier：

```js
const CACHE_BUST = new URL(import.meta.url).search
const { StudioDetector } = await import(`./detect.js${CACHE_BUST}`)
```

这样 `?m=N` +1 会让整个模块图原子重载，而不是只换入口。改完 `lib/` 后：
递增 `?m=N`，HMR 正常时立即生效。**HMR 队列偶尔会卡在旧实例释放上**（现象：改 patch
毫无反应、startup.log 不再新增），此时只有重启 DSH 能恢复。

## 2. 关键设计决策

### 2.1 为什么不依赖 `@deepseek-ai/schemastery`

旧版用 `export const Config = z.object({...})` 声明配置 schema。`schemastery` 是 DSH 内部包，
profile 里对它的链接一旦失效，**静态导入在模块第一行就抛错**，插件连 `startup.log` 都写不出来，
loader 条目却仍显示 `active`。现在配置默认值都在 `start()` 里用 `config?.x || 默认值` 归一化，
插件静态导入的只有 `node:fs / node:path / node:url`。

### 2.2 为什么复用 `bridge.py` 而不是自己连 StudioMCP

`bridge.py` 已经处理了：StudioMCP 的版本目录探测、僵尸版本目录、端口占用 reclaim、
Studio 掉线后重启 MCP 子进程、多个 MCP 服务器聚合与按工具名路由、每个调用都保证有回复。
重写这些只会更差。插件是纯 WebSocket 客户端（`lib/bridge.js`），协议：

| 方向 | 消息 |
|---|---|
| 插件 → bridge | `{type:'call_tool', id, name, arguments, timeout}`、`{type:'list_tools'}`、`{type:'get_status'}`、`{type:'restart_mcp', server}` |
| bridge → 插件 | `{type:'tool_result', id, ok, text, images, error?, kind?}`、`{type:'tools', tools}`、`{type:'studio_status', ...}`、`{type:'connected', ...}` |

注意：桥接层的 `ok` 只表示**传输成功**。Studio 工具自身报错是普通文本 + `ok: true`，
任何做「调用成功判定」的地方都必须看内容（见 2.3）。

### 2.3 Studio 检测阶梯（`lib/detect.js`）

| 层 | 探测 | 说明 |
|---|---|---|
| 1 | RobloxStudio 进程 | bridge 的 `probe_studio` |
| 2 | MCP 挂载 + 工具目录 | StudioMCP 是否发布工具 |
| 3 | place 是否加载 | `studio` 字段 |
| 4 | **真实调用** | 先 `list_roblox_studios`（不需要 studio_id），再带 `studio_id` 调 `get_studio_state`，要求返回里出现 `Studio Mode` |

第 4 层是刻意的：1–3 全绿而 StudioMCP 卡死的情况真实存在。早先版本直接调
`get_studio_state {}`，在多开 Studio 时拿到的是一句「missing studio_id」错误文本，
却被当成验证成功——现在改为「列表 + 带 id 调用 + 校验内容」，并在多实例时把数量写进 proof。

### 2.4 无窗口启动的四条路（`lib/launcher.js`）

Windows 决定控制台子进程窗口的规则：父有控制台就共享，父没有就新建。`bridge.py` 用普通
`subprocess.Popen` 拉起 `launch_studio_mcp.py` → `StudioMCP.exe`，所以：

| 方式 | 结果 |
|---|---|
| `spawn(..., {windowsHide:true})` | 父进程无控制台 → 孙进程拿到新控制台 → **弹出空白 Windows Terminal 窗口** |
| `spawn(..., {detached:true})` | 同上，并且 Bridge 脱离父进程但窗口依旧 |
| 共享父控制台 | 无窗口，但启动它的 shell 一关 Bridge 就被杀 |
| **`WScript.Shell.Run(cmd, 0, False)`**（采用） | 控制台存在但被 `SW_HIDE`，孙进程继承隐藏控制台，wscript 立即退出 → 无窗口且不随父进程死亡 |

### 2.5 schema 归一化

DSH 只接受 JSON Schema 的子集（`type / oneOf / properties / required /
additionalProperties / items / enum / const` + 注解）。`lib/tools.js` 的 `narrowSchema()`
递归裁剪 Studio 广告的 schema，裁完仍不合格就降级为宽松对象 schema —— 宁可少校验，也不能注册失败。
`@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` 是 try/catch 的可选增强，不是依赖。

## 3. 测试

```powershell
npm test             # 离线：detect / client / multiserver / robloxUpload / launcher
npm run test:live    # 需要真实 Bridge + 真实 Studio：bridge / routes
npm run verify:detect  # 直接对 Bridge 跑一遍检测阶梯
```

- `tests/fixture/bridge.py` 是 launcher 测试用的最小 Bridge（只监听端口），不会碰 Studio。
- live 测试只做只读调用；多开 Studio 时会先解析一个 `studio_id` 再调用（否则 MCP 会拒绝）。
- `tests/routes.test.mjs` 通过 HTTP 打**正在运行的 DSH** 的插件路由，所以跑之前要先装好插件。

## 4. 目录与文件职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 入口：`name` / `inject` / `apply`；注册路由与工具、启动检测与自愈 |
| `lib/bridge.js` | WebSocket 客户端：重连、请求 id 关联、状态缓存、工具目录 |
| `lib/launcher.js` | 找 `bridge.py` / Python、隐藏拉起、等待端口、版本排序 |
| `lib/detect.js` | 检测阶梯、状态订阅、proof 生成 |
| `lib/tools.js` | 把 MCP 工具转成 DSH ToolDefinition；3 个常驻工具 |
| `lib/routes.js` / `adapt.js` | 控制台 HTTP API（纯 WHATWG，可离线测） |
| `lib/dcc.js` / `robloxUpload.js` | 可选：无头建模与 Open Cloud 上传 |
| `lib/client.js` / `lib/web/` | 客户端面板与控制台网页 |

## 5. 发布流程（维护者）

仓库已发布：<https://github.com/Century-Ula/dsh-zeroscript>
（首次发布是用 GitHub Git Data API 直接写入的：blobs → tree → commit → `refs/heads/main`，
因为发布机上没有 git 且 GitHub 只经透明代理可达；效果与一次 `git push` 相同。）

本机装好 git 之后，日常更新用标准流程：

```powershell
git clone https://github.com/Century-Ula/dsh-zeroscript.git
# 改代码 / 文档 ...
git add .
git commit -m "fix: ..."
git push
```

或者继续用 API 方式（适合无 git 环境）：上传改动的 blob → 新建 tree →
带 parent 创建 commit → `PATCH /git/refs/heads/main`。

发版时：

1. 更新 `package.json` 版本与 `CHANGELOG.md`；
2. 重新打包（发布包只包含仓库里已有的文件，`node_modules/`、`logs/`、`dcc-output/` 除外）；
3. `POST /repos/<owner>/<repo>/releases`，`tag_name=vX.Y.Z`；
4. 把 zip 传到 release asset（`uploads.github.com`），并确认下载链接可用。

发布前检查：

1. 不应出现 `node_modules/`、`logs/`、`dcc-output/`、`*.bak-*`；
2. 全仓搜索 `openCloudKey` / `ROBLOX_OPEN_CLOUD_KEY`，确认没有把真实密钥带进来；
3. 版本号与 `CHANGELOG.md` 对齐；
4. 在干净机器上按 README 走一遍安装（`.\install.ps1 -DryRun` → 真装 → 重启 DSH → `roblox_status`）。

建议的仓库信息（v1.1.0 发布时已设置）：

- About：`Drive Roblox Studio from DeepSeek Harness — ZeroScript bridge as a DSH plugin`
- Topics：`dsh`, `deepseek-harness`, `roblox`, `roblox-studio`, `mcp`, `ai-agent`, `luau`
- Release：tag `v1.1.0`，附件 `dsh-zeroscript-1.1.0.zip`
