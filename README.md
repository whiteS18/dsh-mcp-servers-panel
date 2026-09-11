# dsh-mcp-servers-panel

DSH (DeepSeek Harness) 的 MCP 服务器管理面板插件。

在 DSH 设置中提供原生的 **MCP Servers** 管理选项卡，方便用户直观地新增、查看、修改、删除和启停 MCP 服务器，并自动将发现的 MCP 工具注册为 DSH 原生工具供模型与会话直接调用。

---

## 功能特性

1. **设置面板无缝集成**：
   - 启动后自动在设置左侧菜单添加「MCP Servers」选项卡。
   - 遵循 DSH 官方原生 UI 规范设计，纯 SVG 矢量图标，**零 Emoji**。

2. **已安装 MCP 服务列表**：
   - 清晰展示当前已配置的 MCP 服务器名称、作用域（用户 / 项目）、运行状态指示灯（在线绿色 / 禁用灰色 / 错误红色）。
   - 右上角提供「刷新」、「Add MCP +」、「Open MCP Config」快捷操作。
   - 每个服务器支持点击展开查看已发现的工具列表与描述（如 `> 13 tools enabled`）。
   - 支持独立开关启停（实时加载/释放工具）及删除确认。

3. **新建与编辑 MCP 服务**：
   - 提供「表单」与「JSON」双模式切换编辑：
     - **表单模式**：直观输入服务名称、传输协议（stdio / streamable-http）、可执行命令、参数列表、环境变量键值对、端点 URL 与请求头。
     - **JSON 模式**：支持直接粘贴或编辑完整配置（智能兼容单个配置对象、`mcpServers` 包装对象以及 Cursor / Claude Code 常见格式）。
   - 支持自由切换「作用域」：
     - **用户（User）**：全局生效，保存于 `~/.dsh/mcp-servers.json`。
     - **项目（Workspace）**：仅当前项目生效，保存于 `<workspace>/.dsh/mcp.json`。

4. **DSH 原生对话调用**：
   - 自动维护 MCP 进程生命周期（stdio 管道或 HTTP 通信）。
   - 自动完成 MCP 2024-11-05 协议握手（`initialize` -> `notifications/initialized` -> `tools/list`）。
   - 自动将发现的工具以 `mcp__<serverName>__<toolName>` 稳定格式注册至 `ctx.tools`，在 DSH 对话中模型可直接调用并获取结果。

---

## 安装

npm：

```sh
dsh plugin --profile <name> add dsh-mcp-servers-panel
```

GitHub：

```sh
dsh plugin --profile <name> add github:whiteS18/dsh-mcp-panel
```

本地检出：

```sh
dsh plugin --profile <name> add /绝对路径/dsh-mcp-panel
```

> [!IMPORTANT]
> DSH 在进程**启动时**组合插件。先启动再安装时，必须完全退出并重新打开 DSH（不是刷新页面）。

启动 DSH Desktop 后，进入「设置」即可在侧边栏看到「MCP Servers」面板。

---

## 目录结构

```
dsh-mcp-panel/
├── cordis.patch.yml   # Cordis 自挂载补丁
├── package.json       # 插件包描述及平台声明
├── index.js           # 宿主进程端（配置读写、MCP 进程与生命周期、工具注册、RPC 通信）
├── client.js          # 前端渲染端（设置页 UI、列表展示、表单/JSON 编辑器、配置弹窗）
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
