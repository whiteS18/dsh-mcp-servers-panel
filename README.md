# dsh-mcp-servers-panel

DSH (DeepSeek Harness) 的 MCP 服务器管理面板插件。

在 DSH 设置中提供原生的 **MCP Servers** 管理选项卡，方便用户直观地新增、查看、修改、删除和启停 MCP 服务器，并自动将发现的 MCP 工具注册为 DSH 原生工具供模型与会话直接调用。

---

## 功能特性

1. **设置面板无缝集成**：
   - 启动后自动在设置左侧菜单添加「MCP 服务器」选项卡。
   - 遵循 DSH 官方原生 UI 规范设计，纯 SVG 矢量图标，**零 Emoji**；界面文案为中文。

2. **已安装 MCP 服务列表**：
   - 清晰展示当前已配置的 MCP 服务器名称、作用域徽标（全局 (用户) / 工作区）、传输协议徽标、运行状态指示灯（在线绿色 / 禁用灰色 / 连接中与错误红色）。
   - 头部提供作用域筛选下拉、「新增 MCP」、「刷新」快捷操作。
   - 每个服务器支持点击展开查看已发现的工具列表与描述（如 `13 个工具可用`）。
   - 支持独立开关启停（实时加载/释放工具）及删除确认。

3. **新建与编辑 MCP 服务**：
   - 提供「表单」与「JSON」双模式切换编辑（新建默认 JSON 模式，编辑默认表单模式）：
     - **表单模式**：直观输入服务名称（`^[A-Za-z0-9_-]{1,64}$`）、传输协议（stdio / streamable-http）、可执行命令、参数列表、环境变量键值对、端点 URL 与请求头。编辑已有服务时名称与作用域不可改。
     - **JSON 模式**：支持直接粘贴或编辑完整配置（智能兼容单个配置对象、`servers` / `mcpServers` 包装对象、顶层数组以及 Cursor / Claude Code 常见格式），可一次粘贴多个服务器**批量导入**；JSON 模式下可改名（等价于删除旧名 + 新建）；`cwd`、`toolCallTimeoutMs`（默认 60000）等进阶字段仅 JSON 模式可设。
   - 重名保护：同一作用域内重名拒绝保存；同名可跨作用域共存（用户 / 工作区互相隔离）。
   - 支持自由切换「作用域」：
     - **用户（User）**：全局生效，保存于 `~/.dsh/mcp.json`（仅当该文件不存在且 `~/.dsh/mcp-servers.json` 存在时，才兼容读取后者）。
     - **项目（Workspace）**：仅当前项目生效，保存于 `<workspace>/.dsh/mcp.json`。
   - 注意：保存时统一重写为规范格式 `{version: 1, servers: [...]}`，会改变原有文件结构（读取则兼容 5 种常见格式）。

4. **DSH 原生对话调用**：
   - 自动维护 MCP 进程生命周期（stdio 管道或 HTTP 通信）。
   - 自动完成 MCP 2024-11-05 协议握手（`initialize` -> `notifications/initialized` -> `tools/list`）。
   - 自动将发现的工具以 `mcp__<serverName>__<toolName>` 注册至 `ctx.tools`。名称超过 64 字符或含非法字符时，按当前 DSH 规则截断并附加哈希。
   - 传输协议支持 `stdio` 与 `streamable-http`（`sse` / `http` 别名自动归一为 streamable-http；缺省时按有无 `url` 推断）。

5. **跨平台与 Windows 原生兼容**：
   - **Windows stdio 增强**：针对 Windows 上 `spawn` 无法直接运行无扩展名脚本或 `.cmd`/`.bat`（例如 `npx`、`uvx`）的问题，自动通过 `PATHEXT` 探测可执行目标并封装 `cmd.exe /d /s /c` 转义执行，彻底解决 `ENOENT`。
   - **环境 PATH 智能探测补齐**：自动嗅探并补充常见全局环境路径（Node.js 安装目录、`npm` 全局目录、`pnpm`、`yarn`、`scoop`、`mise`、`nvm`、`fnm`、`volta`、`homebrew`、`cargo`、`.local/bin` 等），避免从桌面图标启动 DSH 缺失 login-shell PATH 的问题。

6. **诊断排查与可视化**：
   - 点击展开服务器卡片，不仅可查看可用工具，还能直接展开查阅底层启动配置（传输类型、启动命令、参数、工作目录、URL）。
   - 连接异常时直接展示错误详情提示框。streamable-http 握手有 8 秒超时保护，避免卡在「正在连接」；stdio 握手与工具调用使用 `toolCallTimeoutMs`（默认 60 秒）。

7. **安全模型**：
   - 所有管理接口仅允许本地回环访问（127.0.0.1 / ::1，否则 403）；HTTP 请求体上限 256KB；响应 `Cache-Control: no-store`。
   - 前端与宿主双通道通信：优先 loopback RPC，失败时回退 loopback HTTP（`list` / `save` / `delete` / `toggle` / `reload`）。
   - 注意：由于只校验回环地址，**本机上任何进程都可以调用管理接口**——不要在不可信的多用户环境暴露。

---

## 安装

npm：

```sh
dsh plugin --profile <name> add dsh-mcp-servers-panel
```

GitHub：

```sh
dsh plugin --profile <name> add github:whiteS18/dsh-mcp-servers-panel
```

本地检出：

```sh
dsh plugin --profile <name> add /绝对路径/dsh-mcp-servers-panel
```

> [!IMPORTANT]
> DSH 在进程**启动时**组合插件。先启动再安装时，必须完全退出并重新打开 DSH（不是刷新页面）。

启动 DSH Desktop 后，进入「设置」即可在侧边栏看到「MCP 服务器」面板。

要求 Node.js >= 20。

---

## 目录结构

```
dsh-mcp-servers-panel/
├── cordis.patch.yml   # Cordis 自挂载补丁
├── package.json       # 插件包描述及平台声明
├── index.js           # 宿主进程端（配置读写、MCP 进程与生命周期、工具注册、RPC 通信）
├── client.js          # 前端渲染端（设置页 UI、列表展示、表单/JSON 编辑器、配置弹窗）
├── test/              # 单元测试（生命周期、参数解析、安全校验、Windows 调度）
├── README.md          # 插件说明文档
└── LICENSE            # MIT 开源许可证
```

---

## 测试

```sh
npm test
```

---

## 许可证

MIT License
