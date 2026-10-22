# ZeroScript for DeepSeek Harness

> 把 [ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free) 的本地 Bridge 接进 **DeepSeek Harness（DSH）**：
> DSH 里的 Agent 直接读写脚本、执行 Luau、操作你的 Roblox Studio。
> **没有浏览器扩展、没有聊天网页、没有需要一直开着的黑窗口。**

> 仓库：<https://github.com/Century-Ula/mspd-ms> ·
> 下载（Release ZIP）：<https://github.com/Century-Ula/mspd-ms/releases/latest> ·
> 问题反馈：<https://github.com/Century-Ula/mspd-ms/issues>

![ZeroScript 控制台](docs/console-live.png)

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-6f42c1.svg">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078d4.svg">
  <img alt="python" src="https://img.shields.io/badge/python-3.9%2B-3776ab.svg">
</p>

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能特性](#功能特性)
- [架构](#架构)
- [前置要求](#前置要求)
- [安装教程](#安装教程)
- [使用](#使用)
- [配置](#配置)
- [工具清单](#工具清单)
- [控制台与面板](#控制台与面板)
- [自动启动与自我修复](#自动启动与自我修复)
- [多开 Studio](#多开-studio)
- [排错](#排错)
- [安全与信任模型](#安全与信任模型)
- [已验证环境](#已验证环境)
- [开发](#开发)
- [FAQ](#faq)
- [致谢与许可](#致谢与许可)

---

## 它解决什么问题

ZeroScript 原本的链路是：

```
AI 聊天网页（ChatGPT / DeepSeek / Gemini …）
   └─ 浏览器扩展：把 AI 回复里的命令抠出来
        └─ 本地 Bridge（bridge.py，WebSocket 127.0.0.1:17613）
             └─ Roblox Studio MCP（StudioMCP.exe）
                  └─ Roblox Studio
```

浏览器扩展和聊天网页存在的唯一理由，是**让一个外部聊天机器人够得着 Studio**。
在 DSH 里模型就是 Agent，这一层完全是多余的；真正有价值的是 **Bridge** ——
一个稳定的本地 WebSocket 服务，已经把 Roblox 官方的 Studio MCP 工具聚合成一份干净的目录。

所以本插件是同一个 Bridge 的**第二个客户端**：

```
DSH Agent ──▶ 本插件 ──ws://127.0.0.1:17613──▶ bridge.py ──▶ Studio MCP ──▶ Roblox Studio
                │
                ├─ 28+ 个 Studio 能力注册为 DSH 工具
                ├─ /zeroscript        独立控制台网页
                └─ 侧栏图标 + 主面板    DSH GUI 内
```

**ZeroScript 原目录一个字节都没有改动**，插件只通过本地 socket 连它
（插件 MIT，ZeroScript 本体 GPL-3.0，两者是独立程序）。

---

## 功能特性

| 能力 | 说明 |
|---|---|
| **28+ 个 Studio 工具** | 读写脚本、执行 Luau、搜索场景树、检查实例、启停 Play、截图、搜索/插入资产、生成网格/材质…… 全部以 `roblox_*` 注册为 DSH 工具 |
| **3 个常驻工具** | `roblox_status`（连通性诊断）、`roblox_list_tools`、`roblox_call`（按原始名调用任意 Studio 工具，逃生舱） |
| **控制台网页** | `http://127.0.0.1:19387/zeroscript`：状态灯、工具目录、参数表单、调用记录、截图内联显示 |
| **DSH 侧栏面板** | 同一套 API 的 GUI 面板，刷新页面后出现在左侧栏 |
| **隐藏启动** | Bridge 由插件自动拉起，**无任何可见控制台窗口** |
| **崩溃自愈** | Bridge 掉线约 15 秒后自动重启，实测 33 秒恢复并重连 Studio |
| **四层 Studio 检测** | 进程 → MCP 挂载 → place 加载 → **真实工具调用**，给出唯一结论与下一步 |
| **多 Studio 感知** | 同时开多个 Studio 时提示必须带 `studio_id`，不再误报「已连接」 |
| **多 MCP 服务器聚合** | 往 `config.json` 加一个条目就能把 Blender / 3ds Max 等 MCP 服务器一起接进来，工具自动出现 |
| **无头建模（可选）** | 直接驱动 Blender / 3ds Max 建模、导出、渲染预览；配好 Open Cloud 还能一键上传成 Roblox 资产 |
| **截图进上下文** | `screen_capture` 的截图以附件形式回到模型，Agent 能「看见」自己的结果 |
| **零 DSH 内部依赖** | 插件只静态导入 Node 内建模块，DSH 升级不会因为内部包改名而崩 |

---

## 架构

```
lib/
├─ index.js        # 宿主半入口：注册工具、路由、生命周期
├─ bridge.js       # Bridge WebSocket 客户端（重连 / 状态 / 请求关联）
├─ launcher.js     # 隐藏窗口拉起 bridge.py、崩溃后重启
├─ detect.js       # Studio 四层检测阶梯
├─ tools.js        # Studio 工具 → DSH 工具定义（schema 归一化）
├─ routes.js       # 控制台 HTTP API（纯 WHATWG，可独立测试）
├─ adapt.js        # Node (req,res) ↔ WHATWG 适配
├─ dcc.js          # Blender / 3ds Max 无头驱动
├─ robloxUpload.js # Open Cloud 资产上传
├─ client.js       # GUI 客户端半（侧栏图标 + 主面板）
└─ web/            # 控制台网页（裸 HTML/CSS/JS，无构建步骤）
```

设计要点：

- **复用 Bridge，不重写。** `bridge.py` 已经处理了 StudioMCP 版本目录探测、
  僵尸进程清理、端口占用、Studio 掉线重启、多 MCP 服务器聚合。插件是纯客户端。
- **`studio_id` 可选。** Roblox 在多数工具上把 `studio_id` 标成必填，但服务端在
  单实例时会自动用当前聚焦的 Studio；插件把这条约束放宽，避免每次动作前先列一遍实例。
  多实例时仍需显式传（见[多开 Studio](#多开-studio)）。
- **schema 归一化。** DSH 只接受 JSON Schema 的一个子集，插件的 `narrowSchema()`
  会递归裁剪 Studio 广告出来的 schema，裁完还不行就降级成宽松对象 schema ——
  宁可少校验，也不能注册失败。
- **无构建步骤。** 控制台网页是裸 HTML/CSS/JS；GUI 面板是手写模块包装，
  不需要 vite / rollup / tsc。

---

## 前置要求

| 依赖 | 要求 |
|---|---|
| 操作系统 | **Windows 10 / 11**（无窗口启动依赖 `wscript`，其它系统未验证） |
| DeepSeek Harness | **0.2.0-rc.2** 或更新（桌面版；插件通过 profile patch 装载） |
| ZeroScript-Free | **1.5.5**（需要其中的 `bridge.py`；[Releases 下载](https://github.com/sebattfg/ZeroScript-Free/releases)） |
| Python | **3.9+**，并已安装 `websockets`（`start.bat` 会自动装，也可 `pip install --user websockets`） |
| Roblox Studio | 自带 MCP；首次需在 Studio 里启用 |

> 只有 Studio、不需要浏览器扩展；Edge/Chrome 里以前装的 ZeroScript 扩展可以保留也可以删掉。

---

## 安装教程

### 0. 取得两样东西

1. **本插件**：`git clone` 或下载 ZIP 解压，例如 `C:\Tools\dsh-zeroscript`。
2. **ZeroScript-Free 1.5.5**：从 Releases 下载 ZIP 解压，例如 `D:\下载\文件\ZeroScript-Free-1.5.5`。
   插件会自动搜索并选用版本最新的那份（`~/Downloads`、`~/Desktop`、`D:\下载\文件` 等），
   找不到时也可以手动指定 `bridgeDir`。

### 1. 安装插件

在插件目录里打开 **PowerShell**，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会做两件事（都是 DSH 官方支持的第三方插件接法）：

1. 把插件目录以 junction 链接到
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-zeroscript`
   （GUI 侧栏面板靠它进入客户端模块图）；
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里插入 loader 条目，
   让宿主加载 `lib\index.js`。

脚本是**幂等**的：重复运行只会把条目的缓存串 `?m=N` 递增（用于热重载），
不会重复插入，也不会改动你已有的 `config`（Open Cloud key 等）；改动 patch 前会备份。

常用参数：

```powershell
.\install.ps1 -DryRun              # 只打印将要改什么，不写文件
.\install.ps1 -Profile desktop     # 指定 profile（默认 desktop）
.\install.ps1 -SkipLink            # 只改 patch，不建 node_modules 链接
```

### 2. 重启 DSH

loader 只在启动时装载插件（patch 变更在部分 profile 里可热应用，但不保证）。
**重启 DeepSeek Harness**，然后回到 DSH 页面按一次 **F5** 刷新。

重启后不需要再双击任何 `start.bat`：Bridge 由插件在后台以隐藏窗口方式拉起。

### 3. 验证

```powershell
# 插件是否加载（应返回 JSON，含 startupError: null）
curl http://127.0.0.1:19387/zeroscript-version

# Bridge / Studio 状态（应返回 health：mcpAlive / studio 均为 true）
curl http://127.0.0.1:19387/zeroscript/api/status
```

控制台网页：**<http://127.0.0.1:19387/zeroscript>** —— 三个状态灯全绿即可用。
也可以在对话里让 Agent 调一次 `roblox_status` 自检。

### 手动安装（不想跑脚本）

1. 建 junction：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-zeroscript" `
     -Target "C:\Tools\dsh-zeroscript"
   ```

2. 把 [`cordis.patch.example.yml`](cordis.patch.example.yml) 里那一段追加到
   `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（顶层数组的一项），
   路径改成你的插件目录。
3. 重启 DSH。

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

删除 patch 条目和 node_modules 链接（有备份），**不会**删除插件目录，也**不会**动 ZeroScript 本体。
之后重启 DSH 即不再加载。

---

## 使用

### 让 Agent 直接干活（主用法）

重启 DSH 后，直接对 Agent 说需求即可，例如：

> 在 Workspace 里放一个 10×1×10 的 Part，用红色塑料材质

> 读一下 ServerScriptService 里的主脚本，把玩家跳跃高度改成 60

> 打开 Play 模式，帮我看看控制台有没有报错

> 给这个模型截个图，看看光照是否合适

Agent 会自己选择 `roblox_execute_luau`、`roblox_script_read`、`roblox_screen_capture` 等工具，
链路是 **Agent → 插件 → bridge.py → StudioMCP → 你的 Studio**，全程不经过任何聊天网页。

### Studio 侧一次性设置

1. 打开 Roblox Studio 并加载一个 place；
2. 顶部 **Assistant AI** → 右上 **…** → **Manage MCP Servers** → **Enable Studio as MCP Server**。

只做一次；之后 Studio 每次启动、插件会自动连上。

### 独立控制台网页

浏览器打开 **<http://127.0.0.1:19387/zeroscript>**：

- 顶部状态灯：Bridge / Studio / MCP，右侧显示工具数量；
- 左侧 28+ 个工具（带中文说明）+ 搜索；
- 中间按 schema 自动生成参数表单，或切 `JSON` 手写参数，`Ctrl/⌘+Enter` 执行；
- 右侧调用记录；截图会直接内联显示；
- 顶部还有 `检测 Studio`、`刷新工具`、`启动 Bridge`、`重连` 等诊断按钮。

### DSH 侧栏面板

刷新 DSH 页面后，左侧栏底部出现 **ZeroScript** 图标，点开是同一套状态灯、工具列表和执行台。
两条 UI 走同一套 HTTP API，结果永远一致。

---

## 配置

配置写在 profile patch 条目的 `config:` 下（见 `cordis.patch.example.yml`），也可以直接用默认值。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `17613` | Bridge 端口，对应 ZeroScript 的 `ZS_BRIDGE_PORT` |
| `bridgeDir` | `""` | 含 `bridge.py` 的目录；留空按版本号自动挑选最新安装 |
| `autoLaunch` | `true` | Bridge 没在跑时自动以隐藏窗口拉起 |
| `exposeTools` | `all` | `all` = 每个 Studio 工具一个 DSH 工具；`generic` = 只留 3 个常驻工具（省 token） |
| `toolPrefix` | `roblox_` | 工具名前缀 |
| `toolCallTimeoutMs` | `120000` | 单次工具调用超时 |
| `statusPollMs` | `5000` | 状态轮询间隔 |
| `blender` / `max` / `zbrush` | `""` | 显式指定建模软件路径；留空自动探测 |
| `openCloudKey` | `""` | Roblox Open Cloud API key（上传资产用）。**建议改用环境变量** |
| `creatorUserId` / `creatorGroupId` | `""` | 上传资产归属的用户 / 小组 |

环境变量（更安全，避免密钥进配置文件）：

```powershell
setx ROBLOX_OPEN_CLOUD_KEY "你的 key"
setx ROBLOX_CREATOR_USER_ID  "你的用户 ID"
```

> Open Cloud key 需要 `assets` 权限的 Read + Write；上传的是 **package（含 MeshPart）**，
> 单次 ≤ 20 MB，且会经过审核。

---

## 工具清单

### 常驻（3）

`roblox_status` · `roblox_list_tools` · `roblox_call`

### Studio 能力（28–30，随 Studio/MCP 版本略有差异）

```
execute_luau            script_read / multi_edit / script_grep / script_search
search_game_tree        inspect_instance      get_studio_state
get_console_output      start_stop_play       screen_capture
capture_plugin_gui      list_plugin_guis      search_asset / insert_asset
store_image             upload_image          generate_mesh / generate_texture
generate_material       generate_procedural_model  segment_mesh
character_navigation    user_mouse_input / user_keyboard_input
wait_job_finished       http_get              skill / subagent
list_roblox_studios
```

### 建模（可选，`dcc_*`）

`dcc_status` · `dcc_blender` · `dcc_max` · `dcc_upload_to_roblox`

Blender / 3ds Max 各自自带脚本宿主，插件直接无头驱动（不需要 MCP 服务端）：

```
Blender    blender.exe --background --python script.py
3ds Max    3dsmaxbatch.exe script.ms
```

每次运行有独立工作目录，产物路径随结果返回，PNG/JPEG 会作为图片附在结果里 ——
Agent 能看见自己建的东西并自己修正。

---

## 自动启动与自我修复

| 时机 | 行为 |
|---|---|
| 插件加载时 Bridge 没在跑 | 后台打开 `bridge.py`，**不显示任何窗口** |
| 运行中 Bridge 掉线 ≥ 15 秒 | 自动重新拉起（最多每分钟一次） |
| Bridge 恢复 | WebSocket 自动重连，通常 1 秒内 |
| Studio 后开 / 打开 place | Bridge 自动 attach，检测阶梯转为 `connected`，工具目录自动刷新 |

**为什么没有黑窗口**：Windows 对控制台子进程的规则是「父有控制台就共享，父没有就新建一个」。
直接 `spawn({windowsHide:true})` 会让 `bridge.py` 拉起的 `StudioMCP.exe` 被分配新控制台
（Windows 11 会渲染成一个空白 Windows Terminal 窗口）；而 `detached` 又会让 Bridge 随父进程消失。
插件改用 `WScript.Shell.Run(..., 0, False)`：控制台**存在但不可见**，子进程继承它，
wscript 立即退出，所以既无窗口又不与 DSH 生命周期绑定。

> 自动拉起的 Bridge 是独立进程，**关掉 DSH 后它仍在运行**，这样重载插件/重启 DSH 不会打断 Studio 连接。
> 想停它就在任务管理器结束那个 `python.exe`，或直接关机。

---

## 多开 Studio

Roblox 的 MCP 在**只连一个** Studio 时会自动使用它；连了多个时，每次调用必须带 `studio_id`，
否则返回：

```
This call is missing the required `studio_id` argument. Call `list_roblox_studios` ...
```

插件的行为：

- `roblox_list_roblox_studios` 列出全部实例（id + 名称/placeId）；
- `roblox_status` 的验证会用 `list_roblox_studios` + 带 id 的真实调用，并在 proof 里写明
  「N 个 Studio 已连接，调用工具时必须带 studio_id」；
- 对 Agent 来说：多开时先列实例、再带 `studio_id` 调用即可。

> 日常只开一个 Studio 最省事；多个同时开时注意别改错工程。

---

## 排错

### 第一站：`logs\startup.log`

DSH 的 Loader 条目显示 `active` **并不代表插件跑起来了**。插件在模块加载阶段
就往 `logs\startup.log` 写文件，这个通道在每个失败模式下都存活：

```
--- module load: url=file:///.../lib/index.js?m=5
--- sibling modules imported
--- apply() entered
route ok: exact /zeroscript-version
route ok: prefix /zeroscript
--- start() completed, routes={"version":true,"console":true}
```

- 只有第一行 → 兄弟模块导入失败（看 Node 报错）
- 没有 `apply() entered` → 模块加载成功但插件没被激活
- 有 `route FAILED` → 旧实例占着路由，重启 DSH
- 有 `start() FAILED` → 后面跟着堆栈，那就是根因

### 自检接口

```powershell
curl http://127.0.0.1:19387/zeroscript-version   # 版本、pid、startupError、已注册路由
curl http://127.0.0.1:19387/zeroscript/api/host  # 已挂载服务 + 客户端模块图
node tools\verify-detect.mjs 17613                # 不经 DSH，直接对 Bridge 跑检测
```

`verify-detect.mjs` 会打印 verdict / verified / proof，是排查「状态面板与 Agent 结论不一致」最快的入口。

### 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 工具列表里没有 `roblox_*` | 插件没被装载：看 `logs\startup.log`；确认 patch 条目存在且路径正确；重启 DSH |
| 控制台/网页 404 | 插件当时没在服务；看 `startup.log`，再查 `/zeroscript-version` |
| `roblox_status` 说 bridge 离线 | 点控制台「启动 Bridge」，或看 `logs\bridge_debug.log`；确认 Python 可用 |
| 状态黄、工具能列出但调用失败 | Studio 没加载 place，或 MCP 开关没打开；点「检测 Studio」看结论 |
| 面板出现但一直转圈 | 刷新页面；再不行看 `/zeroscript/api/status` 是否 200 |
| 多开 Studio 时调用报缺 `studio_id` | 先 `roblox_list_roblox_studios`，再带 `studio_id` |
| 改了插件代码没生效 | patch 条目 `?m=N` 递增；HMR 队列卡住时重启 DSH |

> 关于 HMR：DSH 的 HMR 队列**偶尔会卡在旧实例释放**上，表现为改 patch 后毫无反应。
> 重启 DSH 必定恢复；这也是本项目文档一直建议「改完 lib 就重启」的原因。

---

## 安全与信任模型

- 控制台 API **只绑定回环地址**（127.0.0.1），没有鉴权 —— 不要把这个端口暴露到局域网/公网。
- 它可以在你的 Studio 里**执行任意 Luau**，等价于你本人在 Studio 里写脚本；这是 ZeroScript 原有的信任模型。
- Bridge 只接受本机 WebSocket 连接；插件不向任何远程服务发送数据。
- Open Cloud key 只在上传资产时使用；优先用环境变量，不要把密钥提交进仓库（`.gitignore` 已覆盖）。
- 本插件不修改、不再分发 ZeroScript 本体，只通过本地 socket 通信。

---

## 已验证环境

| 项目 | 值 |
|---|---|
| 系统 | Windows 11 (10.0.26200) |
| DSH | 0.2.0-rc.2（Electron 桌面版，profile `desktop`） |
| Node（DSH 内置） | v24.18.1 |
| ZeroScript-Free | 1.5.5 |
| Python | 3.11.0 + websockets 17.0.1 |
| Roblox Studio | 内置 MCP，28 个工具 |
| 实测 | 真实调用 `get_studio_state` / `list_roblox_studios` / `execute_luau`；隐藏启动 + 33 秒自愈；3–5 个 Studio 同开 |

---

## 开发

```powershell
npm test             # 离线测试：detect / client / multiserver / robloxUpload / launcher
npm run test:live    # 需要真实 Bridge + Studio：bridge / routes
npm run verify:detect
```

测试不会修改你的 place（只读调用）。

### 目录结构

```
.
├─ lib/                     # 宿主 + 客户端 + 控制台网页
├─ tests/                   # 测试（离线 + live）
├─ tools/                   # 开发探针与自检脚本
├─ docs/                    # 截图与开发文档
├─ install.ps1 / uninstall.ps1
├─ cordis.patch.example.yml
└─ package.json
```

更多实现细节见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

---

## FAQ

**Q：还需要浏览器扩展吗？**
不需要。DSH 里的 Agent 直接驱动 Studio；扩展那条链路只服务于「在聊天网页里让 AI 发命令」。

**Q：还需要开 `start.bat` 吗？**
不需要。插件自动以隐藏方式拉起 Bridge，并负责崩溃重启。

**Q：为什么不用官方 `dsh-mcp-client` 直接连 StudioMCP？**
`bridge.py` 已经解决了 StudioMCP 的版本目录探测、僵尸进程、端口占用、Studio 掉线重启、
多 MCP 服务器聚合等一堆脏活；插件复用它，稳定性比重新实现更好。

**Q：支持 macOS / Linux？**
桥接和 WebSocket 部分跨平台，但无窗口自动启动依赖 Windows 的 `wscript`，
目前只验证了 Windows。macOS 可手动跑 `MacOS_Start.command`，插件连接部分应当可用（未实测）。

**Q：会拖慢 DSH 吗？**
`exposeTools: all` 的工具 schema 每轮约几千 token；嫌贵可改 `generic`
（只保留 3 个常驻工具，先 `roblox_list_tools` 再 `roblox_call`）。

---

## 致谢与许可

- **ZeroScript-Free** —— 本地 Bridge 与工具目录的上游项目，作者 [sebattfg](https://github.com/sebattfg)，
  以 GPL-3.0-or-later 发布。本项目只通过本地 WebSocket 与它通信，不复制/修改/再分发其代码。
- **DSH（DeepSeek Harness）** —— 插件宿主。
- Roblox Studio MCP —— 官方提供的 Studio 自动化接口。

本插件以 **MIT** 许可发布，见 [LICENSE](LICENSE)。
