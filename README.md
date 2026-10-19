# dsh-mcp-servers-panel

DSH（DeepSeek Harness）的 MCP 服务器管理面板插件。

自 0.2.0 起，面板的定位是 **管理平面（management plane）**：它只负责把官方 `@deepseek-ai/dsh-mcp-client` 的 Loader 行写入当前 profile 的 `cordis.patch.yml`、切换这些行的启停状态，并从 Loader 读取实时状态。

MCP 的 stdio / Streamable HTTP 传输、进程启动、协议握手、自动重连、工具注册、资源与清理，全部由官方客户端负责。面板不再自行启动 MCP 进程，也不再实现或转发 MCP JSON-RPC。

> [!WARNING]
> **0.2.0 是 breaking change。** 面板不再读取旧版 `~/.dsh/mcp.json` 与 `<workspace>/.dsh/mcp.json`，也**不会自动合并**它们；旧版面板管理的 MCP 不会随升级继续运行。面板检测到旧文件时会显示提示，可在「查看并导入」中**逐条选择**导入：默认写入禁用行，导入后是当前 profile 的全局配置（不再按工作区区分），同名条目会被标记并默认不可选。旧文件不会被修改或删除。

---

## 0.2.0 的职责边界

| 能力 | 本面板 | 官方 MCP 客户端 |
| --- | --- | --- |
| 配置存储 | 写入活动 profile 的 `cordis.patch.yml` | 读取并校验 Loader 行 |
| 启停 | 切换面板行的 `disabled` | 根据 Loader 状态启动或停止连接 |
| 传输与进程 | 不参与 | stdio / Streamable HTTP、进程生命周期 |
| 协议 | 不参与 | 握手、工具发现、工具调用、资源读取 |
| 工具注册 | 只读展示 | 以 `mcp__<serverName>__<tool>` 注册到 DSH 工具运行时 |
| 重连与清理 | 不参与 | 重连策略、资源提供者、连接与进程清理 |

面板是这些官方条目的管理器，而不是 MCP 客户端本身。工具名称、服务器指令、重连行为等以官方客户端为准。

---

## 存储模型

### 活动 profile

面板通过 DSH 启动器注入的 `profileContext` 服务定位活动 profile。该服务包含 `name`、`dir`、`patchPath` 等位置信息；面板只读写该 profile 的 `cordis.patch.yml`（即 `patchPath`）。

0.2.0 只管理当前活动 profile：

- 用户级 / 工作区级的作用域概念已移除，界面没有作用域选择器。
- 旧版的 `~/.dsh/mcp.json` 与 `<workspace>/.dsh/mcp.json` 不再被读取或写入；面板只在启动/刷新时为升级提示**只读**这些文件。
- 如需沿用旧配置：在升级横幅中点「查看并导入」，逐条勾选要迁移的服务器；也可以取消后在编辑器的 JSON 模式中手动粘贴。导入后写入当前 profile 的 `cordis.patch.yml`，默认禁用。

### 面板行

面板把每个服务器写成 profile patch 中的一条普通 Loader insert 行：

- 行 id：`dsh-mcp-panel-<serverName>`
- 模块名：`@deepseek-ai/dsh-mcp-client`
- 服务器配置：该行的 `config`
- 开关：服务器关闭时写入行级 `disabled: true`，启用时移除该字段

示例（面板只为非默认值写字段；未写出的字段由官方客户端使用默认值）：

```yaml
- insert:
    - id: dsh-mcp-panel-fast-context
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: fast-context
        transport: stdio
        command: npx
        args:
          - -y
          - '@sammysnake/fast-context-mcp'

    - id: dsh-mcp-panel-docs
      name: "@deepseek-ai/dsh-mcp-client"
      # 服务器关闭时由面板写入
      disabled: true
      config:
        serverName: docs
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
```

`env`、`cwd`、`headers`、`toolCallTimeoutMs`、`reconnect`、`failOnStartupError`、`maxInstructionBytes` 等字段只在显式设置且不同于默认值时出现；默认值见下表。

面板使用 `yaml` 包的 Document API 读写 patch，只增加、更新或删除 id 以 `dsh-mcp-panel-` 开头的 insert 行；无关条目的注释与 `!!js` 标签会被保留。

### 配置字段

以下字段对应官方客户端的 `Config`；`disabled` 是 Loader 行字段，不属于 `config`。

| 字段 | 适用传输 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `serverName` | 必填 | — | 服务器命名空间，`^[A-Za-z0-9_-]{1,32}$`，加载作用域内唯一 |
| `transport` | 必填 | — | `stdio` 或 `streamable-http` |
| `command` | stdio | 必填 | 可执行文件 |
| `args` | stdio | `[]` | 参数数组 |
| `env` | stdio | `{}` | 在清理凭据类变量和 `DSH_*` 变量后的环境之上合并 |
| `cwd` | stdio | `''` | 工作目录 |
| `url` | streamable-http | 必填 | MCP 端点 URL |
| `headers` | streamable-http | `{}` | 额外请求头 |
| `toolCallTimeoutMs` | 两者 | `60000` | 单次 `tools/call` 或资源请求的超时 |
| `reconnect.enabled` | 两者 | `true` | 连接丢失后自动重连 |
| `reconnect.initialDelayMs` | 两者 | `500` | 首次重连延迟；连续失败后逐次翻倍 |
| `reconnect.maxDelayMs` | 两者 | `30000` | 退避上限，也是重置尝试预算的连接稳定时长 |
| `reconnect.maxAttempts` | 两者 | `10` | 单次中断的连续失败上限；耗尽后移除工具并停止重连，直到重载配置或重启 |
| `failOnStartupError` | 两者 | `false` | 初始连接或工具同步失败时，是否让插件激活失败 |
| `maxInstructionBytes` | 两者 | `32768` | 服务器指令的 UTF-8 字节上限（含归属行），超限拒绝连接 |
| `disabled` | 两者 | `false` | Loader 行字段；关闭服务器时由面板写入 |

### 来源与只读行

列表中的每一行来自以下三种来源之一：

- **面板**：id 以 `dsh-mcp-panel-` 开头、由本面板管理的行。
- **Magpie**：插件清单条目 id（Loader 的 `options.id`）以 `magpie-mcp-` 开头的 `@deepseek-ai/dsh-mcp-client` 行。
- **插件清单**：其他来源写入的 `@deepseek-ai/dsh-mcp-client` 行。

面板行可以新增、编辑、删除和启停。Magpie 与插件清单行只读：不能编辑或删除，只能通过开关启停；启停由 DSH 插件管理器（`pluginManager.setPluginEnabled`）处理。若插件管理器不可用或该行不可控，开关会被禁用并显示原因。

面板不会修改或删除其他来源的行。删除面板行时，只移除对应的一条 insert 行。

### 重名规则

`serverName` 是官方客户端的命名空间，在加载作用域内必须唯一；面板行属于 profile 级全局条目，因此面板按全局唯一校验。官方客户端在加载时拒绝重复项（后加载的一条会报错并失败）。

面板在保存前会同时检查自己的行和 Loader 中所有（含已禁用）的 `@deepseek-ai/dsh-mcp-client` 行；发现重名时拒绝写入并给出错误。非面板行不能被同名的面板配置接管；停用只写入行级 `disabled`，不会释放 `serverName`，要释放名字需移除对应行。

需要改名时，在 JSON 模式中给服务器一个不同的名字，面板会以 `replaceName` 提交替换。新名称必须唯一：把 A 改名为已存在的另一条面板服务器 B 会被拒绝，不会覆盖 B。

---

## 生效路径

面板的所有写操作在管理器内串行执行。

- **HMR 可用时**：在 `hmr.runExclusive` 事务中先原子写入 patch 文件，再调用 `hmr.reconcileProfile(requiredIds)` 让 Loader 立即应用。新增、编辑、启用传入该面板行的 id；禁用、删除传入空列表。若 reconcile 失败，面板恢复写入前的文件内容并再次 reconcile，然后向界面抛出错误，避免留下半应用状态。
- **没有 HMR 时**：只写入 patch 文件，并返回 `application: 'restart-required'`；界面显示警告横幅，需要重启 DSH 才能加载新配置。
- 保存、删除、启停的结果都会带上 `application`：`applied` 表示无需重启（可能已经生效），`restart-required` 表示需要重启。插件清单条目的启停若被更高优先级的配置覆盖，仍返回 `applied`，但会附带提示，实际状态可能未改变。

常规 DSH Desktop / Web 的 profile 启动会提供 HMR；headless、SDK、ACP 等组合默认禁用 HMR，在配置中关闭 HMR 时同样会退回到重启生效。

---

## profileContext 要求

面板依赖 DSH 启动器提供的 `profileContext`：

- 存在时：界面在副标题与每行徽标中显示当前 Profile 名称，可以读写该 profile 的 patch。
- 不存在时：面板会显示缺少 profile 的提示，`canManage` 为 false，保存、删除等写入 profile patch 的操作不可用；插件清单行的启停仍取决于 DSH 是否提供插件管理器。面板不会回退到用户级或工作区级配置文件。

`profileContext` 由 DSH 宿主提供，不是插件配置项。没有 profile 上下文说明当前启动方式不提供可管理的 profile，此时面板只能展示提示，不能写入 profile patch。

---

## 功能特性

1. **设置页无缝集成**
   - 启动后自动在设置左侧菜单添加「MCP 服务器」选项卡。
   - 遵循 DSH 原生界面规范，纯 SVG 图标，无 Emoji，界面文案为中文。
   - 头部显示标题与副标题（副标题带 Profile 名称或缺少 profile 的提示）、来源筛选、新增按钮和刷新按钮；按钮顺序保持 0.1.7 的「筛选 → 新增 → 刷新」。

2. **服务器列表**
   - 显示服务器名称、状态点、Profile 徽标、来源徽标（面板 / Magpie / 插件清单）和传输徽标（stdio / streamable-http）。
   - 头部可按来源筛选：全部来源 / 面板 / Magpie / 插件清单。
   - 面板行按 patch 文件顺序排列在前，其他来源行按名称排列在后。
   - 状态副文本按以下顺序取第一个匹配项：已禁用；加载失败；正在加载...；已启用，{n} 个工具可用；已启用，暂无可用工具。
   - 有警告时显示提示标记。

3. **展开详情**
   - 展开后可查看错误信息、警告、实际生效的配置（transport、command、args、cwd、url、toolCallTimeoutMs、reconnect 等）、对应的 patch 行 id、profile 的 patch 路径，以及官方客户端已发现的工具（名称与描述）。

4. **新增与编辑**
   - 提供「表单」与「JSON」双模式，编辑时目标是当前 profile 的 patch；编辑器顶部显示当前 Profile，并在其下方以只读方式显示目标 patch 路径。
   - **表单模式**：输入名称（编辑时禁用）、传输方式、stdio 的命令 / 参数 / 环境变量，或 streamable-http 的 URL / 请求头。
   - **JSON 模式**：兼容完整 `{mcpServers: {...}}`、`{servers: {...}}`、顶层数组、裸映射，以及单个官方 `@deepseek-ai/dsh-mcp-client` 配置对象，可一次粘贴批量导入；未知字段会被忽略；`enabled: false` 映射为一条禁用行。
   - `cwd`、`toolCallTimeoutMs`、`reconnect`、`failOnStartupError`、`maxInstructionBytes` 等进阶字段在 JSON 模式中编辑。
   - 编辑时保留服务器名称，除非 JSON 中指定了不同的名称；后者以 `replaceName` 提交，且新名称必须唯一（不能覆盖另一条面板服务器）。

5. **启停与删除**
   - 面板行可直接启停，写入或移除该行的 `disabled`。
   - 非面板行只读，但可以在可控时通过开关交由 DSH 插件管理器启停。
   - 删除面板行只移除对应的 insert 行，不影响其他来源的行。

6. **重启提示**
   - 当 DSH 返回 `restart-required` 时，界面显示警告横幅，并保留到下一次刷新。

7. **安全**
   - 管理接口只接受回环地址（`127.0.0.0/8`、`::1`、IPv4 映射的 `::ffff:127.x`），其他来源拒绝。
   - HTTP 请求体上限为 256 KB，响应使用 `Cache-Control: no-store`。
   - 前端通过 loopback RPC 调用管理接口；宿主也在同一前缀提供 loopback HTTP 端点（`list` / `legacy` / `import` / `save` / `delete` / `toggle` / `reload`）。
   - HTTP 入口仍受 DSH Web 服务自身的访问控制（未携带会话凭据的请求会被拒绝）；仍不要在不可信的多用户环境暴露管理接口。

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
> DSH 在进程启动时组合插件。先启动再安装插件时，必须完全退出并重新打开 DSH（不是刷新页面）。

启动 DSH Desktop 后，进入「设置」即可在侧边栏看到「MCP 服务器」面板。

要求 Node.js >= 20。运行时依赖 `yaml@^2.9.1`。

---

## 0.2.0 的行为变化

- 面板由「自己启动并托管 MCP 进程」改为「管理 profile patch 中的官方客户端行」。
- 移除自建的 stdio / HTTP 传输、MCP 握手、工具注册与注销、重连和进程树清理。
- 移除 Windows `spawn` 包装与 PATH 探测补全；stdio 命令的解析和启动由官方客户端及其 MCP SDK 负责。
- 移除用户 / 工作区作用域，只管理当前活动 profile。
- 不再读取或写入旧版 `mcp.json`；只读检测旧文件，并在界面上提供**逐条选择**的迁移导入（`legacy` / `import` 接口）。不会自动合并，导入默认禁用且为 profile 全局配置。
- 新增对 profile patch 的 YAML Document 读写、对非面板行的只读展示、重名校验，以及重启提示横幅。

---

## 从 0.1.x 迁移

1. 升级并完全重启 DSH。旧面板管理的 MCP 不会继续运行，这是 0.2.0 的预期行为。
2. 打开 设置 → MCP 服务器。如果存在旧配置，顶部会出现「检测到旧版 MCP 配置」横幅。
3. 点「查看并导入」，勾选要迁移的服务器；不会自动合并。与既有面板行、插件清单行或其他旧配置重名的条目会标记「重名」且默认不可选，需要先删除/改名，或手动在 JSON 模式中改名导入。
4. 「导入后立即启用」默认关闭：导入先写成 `disabled: true` 的行，确认无误后在列表中逐条启用。导入后是当前 profile 的全局配置，不再保留原工作区区别。
5. 旧文件（`~/.dsh/mcp.json`、`<workspace>/.dsh/mcp.json`）不会被修改或删除；确认迁移完成后可自行备份/清理。
6. 也可以直接取消，在「新增 MCP」的 JSON 模式中手动粘贴配置。

> 迁移是**逐条、可取消**的，不会把多个工作区的配置自动合并到一起。

---

## 修复与变更记录

### 0.2.1

- **新增旧版配置选择性迁移**：面板只读检测 `~/.dsh/mcp.json`、`<workspace>/.dsh/mcp.json`（以及旧版 `mcp-servers.json` 回退）；检测到非空配置时显示升级横幅，点「查看并导入」逐条勾选。`legacy` 接口返回完整配置，`import` 接口按选择写入 profile patch。
- 迁移**不自动合并**：默认不勾选重名项（与既有面板行、插件清单行或其他旧配置重名）；导入默认 `disabled: true`，可勾选「导入后立即启用」；旧文件只读，从不修改或删除。
- 新增测试：旧配置检测、摘要脱敏、选择性导入、默认禁用、重名拒绝、旧文件保持不变。

### 0.2.0

- **重构为管理平面**：面板不再启动 MCP 进程、不再实现 MCP 协议，只读写活动 profile 的 `cordis.patch.yml` 并读取 Loader 状态；传输、重连、工具注册、资源和清理交给官方 `@deepseek-ai/dsh-mcp-client`。
- **新增 `patch-store.js`**：通过 `yaml` 的 Document API 维护 id 为 `dsh-mcp-panel-<serverName>` 的 insert 行，保留无关条目的注释和 `!!js` 标签。
- **新的存储格式**：每个服务器对应一条官方客户端 Loader 行，配置字段为 `serverName`、`transport`、`command`、`args`、`env`、`cwd`、`url`、`headers`、`toolCallTimeoutMs`、`reconnect`、`failOnStartupError`、`maxInstructionBytes`；关闭时写入行级 `disabled: true`。
- **新增 profile 依赖**：通过 `profileContext` 定位活动 profile 的 patch；缺失时显示提示并禁用管理操作。界面新增 Profile 徽标。
- **新增 HMR 生效路径**：在 `hmr.runExclusive` 事务中写入并 `reconcileProfile`，失败时恢复旧文本；没有 HMR 时返回 `restart-required` 并显示警告横幅。
- **新增非面板行处理**：识别 Magpie（`magpie-mcp-*`）与其他插件清单写入的 `@deepseek-ai/dsh-mcp-client` 行，只读展示，启停交由 `pluginManager.setPluginEnabled`。
- **新增重名校验**：保存前同时检查面板行和所有 `@deepseek-ai/dsh-mcp-client` 行（含已禁用行）；`serverName` 规则为 `^[A-Za-z0-9_-]{1,32}$`；重命名到另一条面板服务器会拒绝，避免覆盖。
- **新增旧版配置迁移**：只读检测 `~/.dsh/mcp.json`、`<workspace>/.dsh/mcp.json`（以及旧版 `mcp-servers.json` 回退），列表响应带 `legacyConfigs` 摘要；`legacy` 返回完整配置，`import` 按用户勾选逐条写入 profile patch。默认禁用、不覆盖既有行、不修改旧文件、不自动合并。
- **移除**：自建进程与传输、MCP JSON-RPC 握手与工具桥接、工具注册与注销、自建重连和进程树清理、Windows spawn 包装与 PATH 探测、用户 / 工作区作用域、旧版 `mcp.json` 读写。
- **测试更新**：`npm test` 覆盖 patch 文档读写、管理器操作与重名、Loader 行来源与外来行、安全校验，以及 `client.js` 的静态检查。

> 以下 0.1.x 条目是历史版本的行为记录；其中进程托管、用户 / 工作区作用域、`mcp.json` 存储等能力已在 0.2.0 移除。

### 0.1.7

- **面板条目优先展示**：当同一服务器既在面板配置中、又出现在 DSH 插件清单中时，列表以面板条目为主（徽标「面板」），并使用面板配置的命令/参数/URL、作用域和开关状态。同名的插件清单条目改为在展开详情的「同名插件清单条目」中显示，不再顶替该行的来源徽标。
- 开关、状态、工具数仍代表实际运行状态；若面板开关与插件清单条目的状态不一致，会显示提示。
- 更新回归测试：同名同参数时行来源仍为「面板」，插件清单条目作为附注存在。

### 0.1.6

- **更正术语**：不再把插件清单中的 MCP 条目称为「DSH 原生」。`@deepseek-ai/dsh-mcp-client` 是 DSH 自带插件，但具体条目可能由 Magpie 等第三方工具写入。列表现在按来源显示「面板」/「Magpie」/「插件清单」，展开详情会显示清单条目 id。
- **修正删除语义**：删除面板配置只移除 `mcp.json` 条目，不再顺带停用同名插件清单条目。删除后列表会显示该插件清单条目（如 Magpie）及其真实启停状态，需要停用时用手动开关。删除面板配置时若有同名插件清单条目，确认框会提示这一点。
- 新增/更新回归测试：来源识别（`magpie-mcp-*` 识别为 Magpie）、删除面板配置后插件条目保持启用、同名不同参数时面板接管。

### 0.1.5

- **修复更新 DSH 时 `graceful deadline exceeded` 报错**：插件的 *reconcile* 与宿主关闭存在竞态。关闭时若有一次 reconcile 还在读取配置/握手，它会在 `dispose()` 之后继续创建 MCP 子进程，这些子进程让事件循环无法退出，桌面端只能等到超时后用 SIGTERM 杀掉宿主。现在：
  - 所有 reconcile 串行执行，并在每次 `await` 之后检查 `disposed`/代次，关闭后不再创建或重启任何 runner；
  - `dispose()` 会等待进行中的 reconcile 结束，并异步等待所有子进程退出；
  - Windows 下改用 `taskkill /T /F` 终止整棵进程树（只杀 `cmd.exe` 包装进程会遗留真正的 MCP 服务进程），所有等待定时器都 `unref`，无法阻止宿主退出；
  - 插件返回的 disposer 现在是异步的，Cordis 会在宿主关闭时等待清理完成。
- **修复禁用 MCP 后工具仍被注入上下文**：
  - 刚启动/切换工作区时并发触发的多次 reconcile 不再可能用旧配置把已禁用服务器重新拉起；
  - 工具注册前会再次检查 runner 是否已被停止，停止时同步注销全部工具；
  - 自动接管插件清单中的同名 `dsh-mcp-client` 条目，面板禁用会同时禁用该条目，工具因此真正从上下文中移除。
- 新增 `native-mcp.js`（插件清单 MCP 条目桥接）与两组回归测试：`test/mcp-lifecycle.test.js` 覆盖关闭/竞态/进程回收，`test/native-mcp.test.js` 覆盖清单条目接管与启停同步。

---

## 目录结构

```
dsh-mcp-servers-panel/
├── cordis.patch.yml   # Cordis 自挂载补丁
├── package.json       # 包描述、依赖与平台声明
├── index.js           # 宿主进程端（profile patch 管理、McpManager、RPC/HTTP）
├── native-mcp.js      # 宿主进程端（Loader 行读取、来源识别、非面板行启停）
├── patch-store.js     # 宿主进程端（yaml Document 读写与 insert 行增删改）
├── client.js          # 前端渲染端（设置页 UI、列表、表单/JSON 编辑器）
├── test/              # 单元测试（patch、manager、native-mcp、security、client 静态检查）
├── README.md          # 插件说明文档
└── LICENSE            # MIT 开源许可证
```

---

## 测试

从插件目录运行：

```sh
cd dsh-mcp-servers-panel
npm test
```

测试覆盖：

- patch 文档的读取、插入、更新与删除，以及无关条目的注释和 `!!js` 标签保留；
- 管理器的新增、编辑、启停、删除、重名拒绝，以及写失败时的恢复；
- Loader 行的来源识别、非面板行只读与启停、官方客户端行重复名称；
- 旧版 `mcp.json` 的只读检测、摘要脱敏、选择性导入、默认禁用、重名拒绝，以及旧文件保持不变；
- 回环访问等安全校验；
- `client.js` 的静态检查：语法、旧作用域标识已移除、新的 API 字段与迁移流程存在。

---

## 已知限制

- 面板需要 `profileContext`；没有该上下文时只能显示提示，不能管理配置。
- 没有 HMR 的宿主中，修改需要重启 DSH 才能生效；面板会显示重启提示。
- 面板只管理当前活动 profile，不修改其他 profile；旧版 `mcp.json` 只读用于升级提示和选择性导入，从不修改或删除。
- 非面板行只能启停，不能编辑或删除；这些条目应在写入它们的工具或 DSH 插件设置中维护。
- `serverName` 必须在面板管理的 profile 内唯一（`^[A-Za-z0-9_-]{1,32}$`）；官方客户端会拒绝重复项。
- 面板不包装命令、不探测或补全 PATH；stdio 启动失败由官方客户端报告，面板只展示 Loader 状态与错误。

---

## 许可证

MIT License
