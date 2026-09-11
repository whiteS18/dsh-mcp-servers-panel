/**
 * dsh-mcp-servers-panel — Client half (Web / Renderer).
 *
 * Renders the "MCP 服务器" section in DSH Settings:
 * - Tab/Title: "MCP 服务器"
 * - Scope & Workspace Filter Dropdown (原生 DSH 风格):
 *   - "全局 (用户)"
 *   - 工作区列表 (展示 DSH 中已打开/已配置的工作区目录)
 * - Add/Edit MCP Server view with "表单" (Form) and "JSON" tabs
 * - Scope selector: "全局 (用户)" vs 具体工作区 (用户可选择生效的目标工作区)
 * - Zero emoji, native DSH styling & primitives
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-servers-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback, useMemo, createElement: h } = React

    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch {}

    const Menu = primitives.Menu

    const RPC_CHANNEL = '/dsh-mcp-panel'
    const WEB_API_PREFIX = '/api/dsh-mcp-panel'
    const LOCALE_NS = 'settings.dsh-mcp-panel'

    // Inject native select styles if Menu isn't fully active
    const SELECT_CSS = `
.dsh-mcp-select {
  box-sizing: border-box;
  background: var(--dsw-alias-bg-module-platform);
  height: 32px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  font-size: 13px;
  line-height: 20px;
  display: inline-flex;
  max-width: 100%;
  user-select: none;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.dsh-mcp-select:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  border-color: var(--dsw-alias-border-l3);
}
.dsh-mcp-select:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-mcp-select-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

    function ensureSelectCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-mcp-panel-select"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-mcp-servers-panel'
      tag.dataset.pluginCss = 'dsh-mcp-panel-select'
      tag.textContent = SELECT_CSS
      document.head.appendChild(tag)
    }

    // Clean inline SVG Icons (NO EMOJI)
    const Icons = {
      Refresh: (props) =>
        h('svg', { width: props.size || 16, height: props.size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67' })
        ),
      Plus: (props) =>
        h('svg', { width: props.size || 16, height: props.size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('line', { x1: 12, y1: 5, x2: 12, y2: 19 }),
          h('line', { x1: 5, y1: 12, x2: 19, y2: 12 })
        ),
      Trash: (props) =>
        h('svg', { width: props.size || 16, height: props.size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('polyline', { points: '3 6 5 6 21 6' }),
          h('path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' })
        ),
      Edit: (props) =>
        h('svg', { width: props.size || 16, height: props.size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }),
          h('path', { d: 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' })
        ),
      ChevronRight: (props) =>
        h('svg', { width: props.size || 14, height: props.size || 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('polyline', { points: '9 18 15 12 9 6' })
        ),
      ChevronDown: (props) =>
        h('svg', { width: props.size || 14, height: props.size || 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('polyline', { points: '6 9 12 15 18 9' })
        ),
      Close: (props) =>
        h('svg', { width: props.size || 16, height: props.size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('line', { x1: 18, y1: 6, x2: 6, y2: 18 }),
          h('line', { x1: 6, y1: 6, x2: 18, y2: 18 })
        ),
    }

    const dictZh = {
      nav: 'MCP 服务器',
      title: 'MCP 服务器',
      subtitle: '管理全局与各工作区连接的 MCP 服务器，工具将自动挂载至对话中。',
      addMcp: '新增 MCP',
      refresh: '刷新',
      toolsEnabled: '{count} 个工具可用',
      noTools: '未发现可用工具',
      connecting: '正在连接...',
      error: '连接错误',
      disabled: '已禁用',
      edit: '编辑',
      delete: '删除',
      confirmDelete: '确定要删除 MCP 服务 "{name}" 吗？',
      newServer: '新建 MCP 服务器',
      editServer: '编辑 MCP 服务器',
      newServerDesc: '填写新的 MCP 配置，保存后返回列表。',
      formTab: '表单',
      jsonTab: 'JSON',
      scope: '作用域',
      scopeUser: '全局 (用户)',
      scopeWorkspacePrefix: '工作区: ',
      fullConfig: '完整配置',
      jsonHint: '支持直接粘贴 {"server-name": {...}} 或 {"mcpServers": {"server-name": {...}}}。',
      serverName: '服务名称',
      transport: '传输方式',
      command: '执行命令',
      args: '启动参数',
      env: '环境变量',
      cwd: '工作目录',
      url: '服务端点 URL',
      headers: '请求头',
      save: '保存',
      cancel: '取消',
      saving: '保存中...',
      emptyList: '当前视图下暂无已配置的 MCP 服务，点击右上角「新增 MCP」添加。',
      invalidJson: 'JSON 格式不正确，请检查语法',
      nameRequired: '请输入服务名称',
      commandRequired: 'stdio 传输方式必须指定执行命令',
      urlRequired: 'streamable-http 传输方式必须指定 URL',
    }

    function translate(key, params) {
      let text = dictZh[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) {
        text = String(text).replaceAll(`{${name}}`, String(value))
      }
      return text
    }

    // Call RPC or fallback to Loopback WebServer HTTP
    async function apiCall(rpc, endpoint, payload) {
      if (rpc?.call) {
        try {
          const result = await rpc.call(RPC_CHANNEL, endpoint, payload)
          if (result && result.ok) return result.value
          if (result && result.error) throw new Error(result.error.message)
        } catch {}
      }

      const response = await fetch(`${WEB_API_PREFIX}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      const json = await response.json()
      if (json && json.ok) return json.value
      throw new Error(json?.error?.message || `HTTP ${response.status}`)
    }

    // Native DSH Select / Dropdown Component (matching dsh-image-generation / primitives)
    function optionId(value) {
      if (value && typeof value === 'object') return value.id || ''
      return typeof value === 'string' ? value : ''
    }

    function parseScopeKey(scopeKey) {
      const key = optionId(scopeKey)
      if (key.startsWith('ws:')) {
        const workspacePath = key.slice(3)
        if (workspacePath) return { scope: 'workspace', workspacePath, key }
      }
      return { scope: 'user', workspacePath: '', key: 'user' }
    }

    function NativeSelect(props) {
      const { value, options, onChange, label, disabled, style } = props
      const [open, setOpen] = useState(false)
      const selected = optionId(value)
      const current = options.find((o) => o.id === selected) || options[0] || { label: '' }

      if (typeof Menu === 'function') {
        return h(Menu, {
          open,
          onClose: () => setOpen(false),
          items: options,
          selectedId: selected,
          onSelect: (id) => {
            setOpen(false)
            onChange(optionId(id))
          },
          align: 'start',
          portal: true,
          dense: true,
          anchor: h('button', {
            type: 'button',
            className: 'dsh-mcp-select',
            disabled,
            style,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-label': label,
            onClick: () => setOpen((prev) => !prev),
          },
            h('span', { className: 'dsh-mcp-select-label' }, current.label),
            h(Icons.ChevronDown, { size: 13 })
          ),
        })
      }

      // Fallback to stylized native select
      return h('select', {
        className: 'dsh-mcp-select',
        value: selected,
        disabled,
        style,
        onChange: (e) => onChange(e.target.value),
      },
        options.map((opt) => h('option', { key: opt.id, value: opt.id }, opt.label))
      )
    }

    // Native DSH CSS Styles
    const css = {
      container: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxWidth: 760,
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        paddingBottom: 4,
      },
      title: {
        margin: 0,
        fontSize: 18,
        fontWeight: 600,
        lineHeight: '26px',
        color: 'var(--dsw-alias-label-primary)',
      },
      subtitle: {
        margin: '2px 0 0 0',
        fontSize: 13,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      headerActions: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      },
      btnSecondary: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-module-platform))',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        userSelect: 'none',
      },
      btnPrimary: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        border: 'none',
        background: 'var(--dsw-alias-brand-primary, #007acc)',
        color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        userSelect: 'none',
      },
      iconBtn: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        padding: 0,
      },
      serverCard: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform))',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      cardMainRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      },
      serverTitleArea: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: 1,
        minWidth: 0,
      },
      serverName: {
        fontSize: 15,
        fontWeight: 600,
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        maxWidth: '60%',
      },
      scopeBadge: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-tertiary)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        flexShrink: 0,
      },
      transportBadge: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        flexShrink: 0,
        fontFamily: 'monospace',
      },
      statusDot: (status) => ({
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        backgroundColor:
          status === 'connected'
            ? 'var(--dsw-alias-state-success-primary, #22c55e)'
            : status === 'disabled'
            ? 'var(--dsw-alias-border-l3, #94a3b8)'
            : 'var(--dsw-alias-state-error-primary, #ef4444)',
      }),
      cardControls: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      },
      switch: (checked) => ({
        width: 38,
        height: 22,
        borderRadius: 11,
        background: checked
          ? 'var(--dsw-alias-brand-primary, #007acc)'
          : 'var(--dsw-alias-border-l3, #cbd5e1)',
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        padding: 2,
        boxSizing: 'border-box',
        transition: 'background-color 0.2s',
      }),
      switchKnob: (checked) => ({
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#ffffff',
        display: 'block',
        transform: checked ? 'translateX(16px)' : 'translateX(0)',
        transition: 'transform 0.2s',
      }),
      subRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer',
        userSelect: 'none',
      },
      toolsList: {
        marginTop: 6,
        paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      toolItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontSize: 12,
      },
      toolName: {
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-brand-primary, #3b82f6)',
      },
      toolDesc: {
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: '18px',
      },
      segmentedControl: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: 3,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      segmentedBtn: (active) => ({
        padding: '3px 12px',
        borderRadius: 6,
        border: 'none',
        background: active ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        fontWeight: active ? 600 : 400,
        fontSize: 12,
        cursor: 'pointer',
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
      }),
      formCard: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-3)',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      },
      field: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      label: {
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-primary)',
      },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 34,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1))',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        outline: 'none',
      },
      codeArea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 220,
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        resize: 'vertical',
        outline: 'none',
      },
      errorText: {
        margin: 0,
        fontSize: 12,
        color: 'var(--dsw-alias-state-error-primary, #ef4444)',
      },
      emptyBox: {
        padding: '32px 16px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary)',
        border: '1px dashed var(--dsw-alias-border-l2)',
        borderRadius: 12,
        fontSize: 14,
      },
    }

    // Add / Edit Server Component
    const EMPTY_JSON_TEMPLATE = '{\n  "mcpServers": {\n  }\n}'

    function ServerEditor(props) {
      const { initialServer, workspaces, onSave, onCancel, defaultWorkspace, defaultScopeKey } = props
      const isEditing = Boolean(initialServer)

      const [mode, setMode] = useState(isEditing ? 'form' : 'json')

      // Scope Options: User (Global) + Each individual workspace
      const scopeOptions = useMemo(() => {
        const list = [
          { id: 'user', label: translate('scopeUser') },
        ]
        for (const ws of workspaces) {
          list.push({
            id: `ws:${ws.path}`,
            label: `${translate('scopeWorkspacePrefix')}${ws.title || ws.path}`,
          })
        }
        return list
      }, [workspaces])

      const initialScopeValue = useMemo(() => {
        if (initialServer?.scope === 'user') return 'user'
        if (initialServer?.workspacePath) return `ws:${initialServer.workspacePath}`
        if (defaultScopeKey === 'user') return 'user'
        if (typeof defaultScopeKey === 'string' && defaultScopeKey.startsWith('ws:')) return defaultScopeKey
        if (defaultWorkspace) return `ws:${defaultWorkspace}`
        return 'user'
      }, [initialServer, defaultWorkspace, defaultScopeKey])

      const [selectedScope, setSelectedScope] = useState(initialScopeValue)
      const [name, setName] = useState(initialServer?.name || '')
      const [transport, setTransport] = useState(initialServer?.transport || 'stdio')
      const [command, setCommand] = useState(initialServer?.command || '')
      const [argsStr, setArgsStr] = useState((initialServer?.args || []).join(' '))
      const [envList, setEnvList] = useState(
        Object.entries(initialServer?.env || {}).map(([k, v]) => ({ key: k, val: v }))
      )
      const [url, setUrl] = useState(initialServer?.url || '')
      const [headersList, setHeadersList] = useState(
        Object.entries(initialServer?.headers || {}).map(([k, v]) => ({ key: k, val: v }))
      )

      const [jsonText, setJsonText] = useState(() => {
        if (initialServer) {
          const s = { ...initialServer }
          const sName = s.name
          delete s.name
          delete s.scope
          delete s.workspacePath
          delete s.status
          delete s.error
          delete s.toolCount
          delete s.tools
          return JSON.stringify({ [sName]: s }, null, 2)
        }
        return EMPTY_JSON_TEMPLATE
      })

      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const jsonValidation = useMemo(() => {
        if (!jsonText.trim()) return { valid: false, message: '请输入 JSON 配置' }
        try {
          const parsed = JSON.parse(jsonText)
          if (!parsed || typeof parsed !== 'object') return { valid: false, message: 'JSON 根元素必须为对象或数组' }

          let count = 0
          const names = []
          if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
            for (const k of Object.keys(parsed.mcpServers)) {
              count++
              names.push(k)
            }
          } else if (Array.isArray(parsed.servers)) {
            for (const s of parsed.servers) {
              if (s?.name) { count++; names.push(s.name) }
            }
          } else if (Array.isArray(parsed)) {
            for (const s of parsed) {
              if (s?.name) { count++; names.push(s.name) }
            }
          } else if (parsed.servers && typeof parsed.servers === 'object') {
            for (const k of Object.keys(parsed.servers)) {
              count++
              names.push(k)
            }
          } else {
            const keys = Object.keys(parsed)
            if (keys.length > 0) {
              count = keys.length
              names.push(...keys.slice(0, 3))
            }
          }

          return {
            valid: true,
            count,
            message: count > 0
              ? `有效配置: 检测到 ${count} 个服务 (${names.slice(0, 3).join(', ')}${names.length > 3 ? '...' : ''})`
              : '未检测到明确的服务名称',
          }
        } catch (e) {
          return { valid: false, message: 'JSON 语法错误: ' + e.message }
        }
      }, [jsonText])

      async function handleSave() {
        setError('')
        setBusy(true)

        try {
          const selected = parseScopeKey(selectedScope)
          const targetScope = selected.scope
          const targetWs = selected.workspacePath

          if (mode === 'json') {
            if (!jsonValidation.valid || !jsonValidation.count) {
              throw new Error(jsonValidation.message || translate('invalidJson'))
            }
            await onSave({
              rawJson: jsonText,
              scope: targetScope,
              workspacePath: targetWs,
              replaceName: isEditing ? initialServer.name : undefined,
              createOnly: !isEditing,
            })
          } else {
            const finalName = name.trim()
            if (!finalName) throw new Error(translate('nameRequired'))

            const envObj = {}
            for (const item of envList) {
              if (item.key.trim()) envObj[item.key.trim()] = item.val
            }
            const headersObj = {}
            for (const item of headersList) {
              if (item.key.trim()) headersObj[item.key.trim()] = item.val
            }

            if (transport === 'stdio' && !command.trim()) {
              throw new Error(translate('commandRequired'))
            }
            if (transport === 'streamable-http' && !url.trim()) {
              throw new Error(translate('urlRequired'))
            }

            const serverPayload = {
              transport,
              command: command.trim(),
              args: argsStr.trim() ? argsStr.trim().split(/\s+/) : [],
              env: envObj,
              url: url.trim(),
              headers: headersObj,
              enabled: true,
            }

            await onSave({
              name: finalName,
              server: serverPayload,
              scope: targetScope,
              workspacePath: targetWs,
              createOnly: !isEditing,
            })
          }
        } catch (err) {
          setError(err.message || '保存失败')
          setBusy(false)
        }
      }

      return h('div', { style: css.container },
        // Header
        h('div', { style: css.header },
          h('div', null,
            h('h2', { style: css.title }, isEditing ? translate('editServer') : translate('newServer')),
            h('p', { style: css.subtitle }, translate('newServerDesc'))
          ),
          h('div', { style: css.headerActions },
            // Segmented switch: 表单 | JSON
            h('div', { style: css.segmentedControl },
              h('button', {
                type: 'button',
                style: css.segmentedBtn(mode === 'form'),
                onClick: () => setMode('form'),
              }, translate('formTab')),
              h('button', {
                type: 'button',
                style: css.segmentedBtn(mode === 'json'),
                onClick: () => setMode('json'),
              }, translate('jsonTab'))
            )
          )
        ),

        // Body card
        h('div', { style: css.formCard },
          // Scope row with native dropdown
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 } },
            h('span', { style: css.label }, translate('scope')),
            h(NativeSelect, {
              value: selectedScope,
              options: scopeOptions,
              onChange: setSelectedScope,
              label: translate('scope'),
              disabled: isEditing,
            })
          ),

          // JSON Mode
          mode === 'json' ? h(React.Fragment, null,
            h('div', { style: css.field },
              h('label', { style: css.label }, translate('fullConfig')),
              h('textarea', {
                style: css.codeArea,
                value: jsonText,
                onChange: (e) => setJsonText(e.target.value),
                spellCheck: false,
              }),
              h('span', {
                style: {
                  fontSize: 12,
                  color: jsonValidation.valid
                    ? 'var(--dsw-alias-state-success-primary, #22c55e)'
                    : 'var(--dsw-alias-label-tertiary)',
                  marginTop: 4,
                },
              }, jsonValidation.valid ? jsonValidation.message : translate('jsonHint'))
            )
          ) : (
            // Form Mode
            h(React.Fragment, null,
              h('div', { style: css.field },
                h('label', { style: css.label }, translate('serverName')),
                h('input', {
                  style: css.input,
                  value: name,
                  placeholder: 'fast-context',
                  onChange: (e) => setName(e.target.value),
                  disabled: isEditing,
                })
              ),

              h('div', { style: css.field },
                h('label', { style: css.label }, translate('transport')),
                h(NativeSelect, {
                  value: transport,
                  options: [
                    { id: 'stdio', label: 'stdio (本地可执行程序)' },
                    { id: 'streamable-http', label: 'streamable-http (HTTP / SSE)' },
                  ],
                  onChange: setTransport,
                  label: translate('transport'),
                })
              ),

              transport === 'stdio' ? h(React.Fragment, null,
                h('div', { style: css.field },
                  h('label', { style: css.label }, translate('command')),
                  h('input', {
                    style: css.input,
                    value: command,
                    placeholder: 'npx / uvx / node / python',
                    onChange: (e) => setCommand(e.target.value),
                  })
                ),
                h('div', { style: css.field },
                  h('label', { style: css.label }, translate('args')),
                  h('input', {
                    style: css.input,
                    value: argsStr,
                    placeholder: '-y --prefer-online @sammysnake/fast-context-mcp@next',
                    onChange: (e) => setArgsStr(e.target.value),
                  })
                ),
                h('div', { style: css.field },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('label', { style: css.label }, translate('env')),
                    h('button', {
                      type: 'button',
                      style: { ...css.btnSecondary, height: 24, fontSize: 11, padding: '0 8px' },
                      onClick: () => setEnvList([...envList, { key: '', val: '' }]),
                    }, '+ 添加变量')
                  ),
                  envList.map((row, idx) =>
                    h('div', { key: idx, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      h('input', {
                        style: { ...css.input, flex: 1 },
                        placeholder: 'KEY',
                        value: row.key,
                        onChange: (e) => {
                          const next = [...envList]
                          next[idx].key = e.target.value
                          setEnvList(next)
                        },
                      }),
                      h('input', {
                        style: { ...css.input, flex: 2 },
                        placeholder: 'VALUE',
                        value: row.val,
                        onChange: (e) => {
                          const next = [...envList]
                          next[idx].val = e.target.value
                          setEnvList(next)
                        },
                      }),
                      h('button', {
                        type: 'button',
                        style: css.iconBtn,
                        onClick: () => setEnvList(envList.filter((_, i) => i !== idx)),
                      }, h(Icons.Trash, { size: 14 }))
                    )
                  )
                )
              ) : (
                // HTTP mode
                h(React.Fragment, null,
                  h('div', { style: css.field },
                    h('label', { style: css.label }, translate('url')),
                    h('input', {
                      style: css.input,
                      value: url,
                      placeholder: 'http://localhost:3000/mcp',
                      onChange: (e) => setUrl(e.target.value),
                    })
                  ),
                  h('div', { style: css.field },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                      h('label', { style: css.label }, translate('headers')),
                      h('button', {
                        type: 'button',
                        style: { ...css.btnSecondary, height: 24, fontSize: 11, padding: '0 8px' },
                        onClick: () => setHeadersList([...headersList, { key: '', val: '' }]),
                      }, '+ 添加请求头')
                    ),
                    headersList.map((row, idx) =>
                      h('div', { key: idx, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                        h('input', {
                          style: { ...css.input, flex: 1 },
                          placeholder: 'Header',
                          value: row.key,
                          onChange: (e) => {
                            const next = [...headersList]
                            next[idx].key = e.target.value
                            setHeadersList(next)
                          },
                        }),
                        h('input', {
                          style: { ...css.input, flex: 2 },
                          placeholder: 'Value',
                          value: row.val,
                          onChange: (e) => {
                            const next = [...headersList]
                            next[idx].val = e.target.value
                            setHeadersList(next)
                          },
                        }),
                        h('button', {
                          type: 'button',
                          style: css.iconBtn,
                          onClick: () => setHeadersList(headersList.filter((_, i) => i !== idx)),
                        }, h(Icons.Trash, { size: 14 }))
                      )
                    )
                  )
                )
              )
            )
          ),

          error ? h('p', { style: css.errorText }, error) : null,

          // Bottom actions
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 } },
            h('button', {
              type: 'button',
              style: css.btnSecondary,
              onClick: onCancel,
              disabled: busy,
            }, translate('cancel')),
            h('button', {
              type: 'button',
              style: css.btnPrimary,
              onClick: handleSave,
              disabled: busy,
            }, busy ? translate('saving') : translate('save'))
          )
        )
      )
    }

    // Main Section View
    function McpServersSection(props) {
      ensureSelectCss()
      const rpc = props.connection?.rpc

      const [servers, setServers] = useState([])
      const [workspaces, setWorkspaces] = useState([])
      const [activeWorkspace, setActiveWorkspace] = useState('')
      const [filterScope, setFilterScope] = useState('user') // 'user' | 'ws:<path>'
      const [loading, setLoading] = useState(true)
      const [view, setView] = useState('list') // 'list' | 'add' | 'edit'
      const [editingServer, setEditingServer] = useState(null)
      const [editorNonce, setEditorNonce] = useState(0)
      const [expandedTools, setExpandedTools] = useState(new Set())
      const [actionBusy, setActionBusy] = useState(false)

      const filterOptions = useMemo(() => {
        const list = [
          { id: 'user', label: translate('scopeUser') },
        ]
        for (const ws of workspaces) {
          list.push({
            id: `ws:${ws.path}`,
            label: `${translate('scopeWorkspacePrefix')}${ws.title || ws.path}`,
          })
        }
        return list
      }, [workspaces])

      const refresh = useCallback(async (scopeKey = filterScope) => {
        setLoading(true)
        try {
          const view = parseScopeKey(scopeKey)
          const res = await apiCall(rpc, 'list', {
            scope: view.scope,
            workspacePath: view.workspacePath,
          })
          const incoming = res?.servers || []
          setServers(
            incoming.filter((server) => (
              view.scope === 'user' ? server.scope === 'user' : server.scope === 'workspace'
            ))
          )
          if (res?.workspaces) setWorkspaces(res.workspaces)
          if (res?.activeWorkspace) setActiveWorkspace(res.activeWorkspace)
        } catch {}
        finally {
          setLoading(false)
        }
      }, [rpc, filterScope])

      useEffect(() => {
        refresh(filterScope)
      }, [filterScope])

      function toggleTools(uniqueKey) {
        setExpandedTools((prev) => {
          const next = new Set(prev)
          if (next.has(uniqueKey)) next.delete(uniqueKey)
          else next.add(uniqueKey)
          return next
        })
      }

      async function handleToggleEnabled(server) {
        setActionBusy(true)
        try {
          const view = parseScopeKey(filterScope)
          await apiCall(rpc, 'toggle', {
            name: server.name,
            scope: view.scope,
            workspacePath: view.workspacePath,
            enabled: !server.enabled,
          })
          await refresh(filterScope)
        } catch (err) {
          alert(`更新失败: ${err.message}`)
        } finally {
          setActionBusy(false)
        }
      }

      async function handleDelete(server) {
        if (!confirm(translate('confirmDelete', { name: server.name }))) return
        setActionBusy(true)
        try {
          const view = parseScopeKey(filterScope)
          await apiCall(rpc, 'delete', {
            name: server.name,
            scope: view.scope,
            workspacePath: view.workspacePath,
          })
          await refresh(filterScope)
        } catch (err) {
          alert(`删除失败: ${err.message}`)
        } finally {
          setActionBusy(false)
        }
      }

      async function handleSaveServer(payload) {
        await apiCall(rpc, 'save', payload)
        const nextFilter = payload.scope === 'user' || !payload.workspacePath
          ? 'user'
          : `ws:${payload.workspacePath}`
        setView('list')
        setEditingServer(null)
        if (nextFilter === filterScope) {
          await refresh(nextFilter)
        } else {
          setFilterScope(nextFilter)
        }
      }

      if (view === 'add' || view === 'edit') {
        return h(ServerEditor, {
          key: view === 'edit'
            ? `edit:${editingServer?.scope}:${editingServer?.workspacePath || ''}:${editingServer?.name}`
            : `add:${editorNonce}`,
          initialServer: editingServer,
          workspaces,
          defaultWorkspace: activeWorkspace,
          defaultScopeKey: filterScope,
          onSave: handleSaveServer,
          onCancel: () => {
            setView('list')
            setEditingServer(null)
          },
        })
      }

      return h('div', { style: css.container },
        // Top Header Bar
        h('div', { style: css.header },
          h('div', null,
            h('h2', { style: css.title }, translate('title')),
            h('p', { style: css.subtitle }, translate('subtitle'))
          ),
          h('div', { style: css.headerActions },
            // Scope / Workspace switcher dropdown (Native DSH Select)
            h(NativeSelect, {
              value: filterScope,
              options: filterOptions,
              onChange: (val) => setFilterScope(val),
              label: translate('scope'),
              disabled: loading || actionBusy,
            }),
            h('button', {
              type: 'button',
              style: css.btnPrimary,
              onClick: () => {
                setEditingServer(null)
                setEditorNonce((n) => n + 1)
                setView('add')
              },
            },
              h(Icons.Plus, { size: 14 }),
              translate('addMcp')
            ),
            h('button', {
              type: 'button',
              style: css.iconBtn,
              onClick: () => refresh(filterScope),
              title: translate('refresh'),
              disabled: loading || actionBusy,
            }, h(Icons.Refresh, { size: 16 }))
          )
        ),

        // Server List
        servers.length === 0 && !loading ? (
          h('div', { style: css.emptyBox }, translate('emptyList'))
        ) : (
          servers.map((server) => {
            // Unique key for each instance: scope:workspacePath:name
            const uniqueKey = `${server.scope}:${server.workspacePath || ''}:${server.name}`
            const isExpanded = expandedTools.has(uniqueKey)
            const count = server.toolCount || (server.tools ? server.tools.length : 0)

            const scopeLabel = server.scope === 'user'
              ? translate('scopeUser')
              : `${translate('scopeWorkspacePrefix')}${workspaces.find((w) => w.path === server.workspacePath)?.title || server.workspacePath || '当前项目'}`

            return h('div', { key: uniqueKey, style: css.serverCard },
              // Main row
              h('div', { style: css.cardMainRow },
                h('div', { style: css.serverTitleArea },
                  h('span', { style: css.serverName, title: server.name }, server.name),
                  h('span', { style: css.statusDot(server.status) }),
                  h('span', { style: css.scopeBadge }, scopeLabel),
                  server.transport ? h('span', { style: css.transportBadge }, server.transport) : null
                ),
                h('div', { style: css.cardControls },
                  // Edit
                  h('button', {
                    type: 'button',
                    style: { ...css.iconBtn, border: 'none', width: 28, height: 28 },
                    onClick: () => {
                      setEditingServer(server)
                      setView('edit')
                    },
                    title: translate('edit'),
                  }, h(Icons.Edit, { size: 15 })),
                  // Trash
                  h('button', {
                    type: 'button',
                    style: { ...css.iconBtn, border: 'none', width: 28, height: 28 },
                    onClick: () => handleDelete(server),
                    title: translate('delete'),
                    disabled: actionBusy,
                  }, h(Icons.Trash, { size: 15 })),
                  // Switch
                  h('button', {
                    type: 'button',
                    role: 'switch',
                    'aria-checked': server.enabled,
                    style: css.switch(server.enabled),
                    onClick: () => handleToggleEnabled(server),
                    disabled: actionBusy,
                  }, h('span', { style: css.switchKnob(server.enabled) }))
                )
              ),

              // Sub-row (> N tools enabled)
              h('div', { style: css.subRow, onClick: () => toggleTools(uniqueKey) },
                isExpanded ? h(Icons.ChevronDown, { size: 14 }) : h(Icons.ChevronRight, { size: 14 }),
                h('span', null,
                  server.error
                    ? `${translate('error')}: ${server.error}`
                    : server.status === 'connecting'
                    ? translate('connecting')
                    : count > 0
                    ? translate('toolsEnabled', { count })
                    : translate('noTools')
                )
              ),

              // Expanded tools
              isExpanded && (server.tools || []).length > 0 ? (
                h('div', { style: css.toolsList },
                  server.tools.map((tool) =>
                    h('div', { key: tool.name, style: css.toolItem },
                      h('span', { style: css.toolName }, tool.rawName || tool.name),
                      tool.description ? h('span', { style: css.toolDesc }, tool.description) : null
                    )
                  )
                )
              ) : null
            )
          })
        )
      )
    }

    const inject = ['slots', 'locale', 'connection']

    function apply(ctx) {
      ctx.effect(() => {
        ctx.locale?.register?.(LOCALE_NS, { zh: dictZh, en: dictZh })
      }, 'dsh-mcp-servers-panel: register locale')

      const connection = ctx.get('connection')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp-servers',
            order: 82,
            label: () => translate('nav'),
            locale: LOCALE_NS,
            inject: () => ({ connection }),
          },
          McpServersSection
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
