/**
 * dsh-mcp-servers-panel — Client half (Web / Renderer).
 *
 * Renders the "MCP 服务器" section in DSH Settings:
 * - Tab/Title: "MCP 服务器"
 * - Profile-backed management plane: rows are official
 *   @deepseek-ai/dsh-mcp-client entries in the active profile's
 *   cordis.patch.yml. The official client owns connection, reconnect,
 *   tool registration and teardown.
 * - Add/Edit view with "表单" (Form) and "JSON" tabs; JSON keeps the old
 *   wrapper acceptance so users can still batch-import.
 * - No user/segment selector: the active profile is the only target.
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

    const RPC_CHANNEL = '/dsh-mcp-servers-panel'
    const WEB_API_PREFIX = '/api/dsh-mcp-servers-panel'
    const LOCALE_NS = 'settings.dsh-mcp-servers-panel'

    const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
    const EMPTY_JSON_TEMPLATE = '{\n  "mcpServers": {\n  }\n}'

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
      if (document.querySelector('style[data-plugin-css="dsh-mcp-servers-panel-select"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-mcp-servers-panel'
      tag.dataset.pluginCss = 'dsh-mcp-servers-panel-select'
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
      Alert: (props) =>
        h('svg', { width: props.size || 14, height: props.size || 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }),
          h('line', { x1: 12, y1: 9, x2: 12, y2: 13 }),
          h('line', { x1: 12, y1: 17, x2: 12.01, y2: 17 })
        ),
    }

    const dictZh = {
      nav: 'MCP 服务器',
      title: 'MCP 服务器',
      subtitle: '管理当前 Profile 的 MCP 服务器，工具将自动挂载至对话中。',
      addMcp: '新增 MCP',
      refresh: '刷新',
      sourceFilter: '来源',
      sourceAll: '全部来源',
      profileLabel: 'Profile',
      profileBadge: 'Profile: {name}',
      profileMissing: '未检测到活动 profile',
      profileMissingDetail: '未检测到活动 profile，MCP 配置无法写入；请通过 profile 启动 DSH 后重试。',
      manageHint: '当前环境无法管理 profile patch，新增、编辑与删除已禁用。',
      nativeControlUnavailable: '当前环境不支持通过插件管理器启停外部条目。',
      restartRequiredTitle: '配置已写入，需要重启 DSH',
      restartRequiredBody: '当前 profile 未启用 HMR，需要重启 DSH 后配置才会生效。',
      restartRequiredOverridden: '该条目的启停被更高优先级的配置覆盖，实际状态可能未改变；请检查 DSH 插件设置或更高层配置。',
      restartRequiredNoProfile: '当前运行环境没有 profileContext，配置未生效。',
      toolsEnabled: '已启用，{count} 个工具可用',
      noTools: '已启用，暂无可用工具',
      connecting: '正在加载...',
      error: '加载失败',
      disabled: '已禁用',
      errorDetailTitle: '错误详情',
      warningTitle: '提示',
      warningsTitle: '环境提示',
      warningMarker: '提示',
      configTitle: '启动配置',
      toolsTitle: '工具',
      patchEntryLabel: '补丁条目 ID',
      entryLabel: '运行时条目 ID',
      profilePathLabel: 'profile patch 路径',
      sourcePanel: '面板',
      sourceMagpie: 'Magpie',
      sourcePluginEntry: '插件清单',
      sourcePanelHint: '该服务器由本面板管理，配置保存在当前 profile 的 cordis.patch.yml。',
      foreignHint: '该服务器来自 {origin}，不是面板配置，面板以只读方式展示。',
      readonlyPluginHint: '该服务器来自其他来源，面板不能编辑或删除；只有可控制时才能在列表中启停。',
      toggleDisabledHint: '该服务器不由面板控制，无法在列表中启停。',
      edit: '编辑',
      delete: '删除',
      confirmDelete: '确定要删除 MCP 服务 "{name}" 吗？该条目将从当前 profile 的 patch 中移除。',
      newServer: '新建 MCP 服务器',
      editServer: '编辑 MCP 服务器',
      newServerDesc: '填写 MCP 配置，保存后写入当前 profile 的 patch。',
      formTab: '表单',
      jsonTab: 'JSON',
      targetPatch: '目标 patch',
      targetPatchMissing: '未检测到 profile',
      fullConfig: '完整配置',
      jsonHint: '支持粘贴 {"server-name": {...}}、{"mcpServers": {...}}、{"servers": {...}}、数组或单个官方配置对象，可批量导入。',
      serverName: '服务名称',
      serverNameHint: '仅允许字母、数字、下划线和连字符，长度 1-32。',
      transport: '传输方式',
      command: '执行命令',
      args: '启动参数',
      env: '环境变量',
      url: '服务端点 URL',
      headers: '请求头',
      save: '保存',
      cancel: '取消',
      saving: '保存中...',
      emptyList: '当前 profile 的 patch 中暂无 MCP 服务，点击右上角「新增 MCP」添加。',
      noProfileEmpty: '未检测到活动 profile，暂时无法管理 MCP 服务。',
      invalidJson: 'JSON 格式不正确，请检查语法',
      nameRequired: '请输入服务名称',
      nameInvalid: '服务名称只能包含字母、数字、下划线或连字符，长度 1-32。',
      commandRequired: 'stdio 传输方式必须指定执行命令',
      urlRequired: 'streamable-http 传输方式必须指定 URL',
      nameUnresolved: '无法确定服务名称，请使用 {"服务名": {...}} 形式，或提供 serverName。',
      loadFailed: '加载 MCP 服务器失败',
      actionFailed: '操作失败',
      legacyTitle: '检测到旧版 MCP 配置',
      legacyBody: '0.2.0 不再读取旧版 mcp.json（{files} 个文件，共 {count} 个服务器）：{paths}。可以逐条选择导入，不会自动合并；导入后为当前 profile 的全局配置，默认禁用。',
      legacyOpen: '查看并导入',
      legacyDismiss: '忽略',
      legacyImportTitle: '导入旧版 MCP 配置',
      legacyImportSubtitle: '0.2.0 不再读取旧版 mcp.json。勾选要导入的服务器；导入后写入当前 profile 的 patch，默认禁用，可稍后在列表中启用。',
      legacySourceUser: '全局 (用户)',
      legacySourceProject: '工作区',
      legacyImportEnable: '导入后立即启用',
      legacyImportConfirm: '导入选中的 {count} 项',
      legacyImportNone: '请至少勾选一个服务器',
      legacyImportEmpty: '没有可导入的服务器',
      legacyConflict: '重名',
      legacyConflictHint: '重名：请先在面板中删除同名条目，或改名后手动导入；也可以取消勾选。',
      legacyFileError: '读取失败：{message}',
      legacyImported: '已导入 {count} 个 MCP 服务器（{state}）。旧配置文件未删除，可自行备份或清理。',
      legacyImportedDisabled: '默认禁用，可在列表中逐条启用',
      legacyImportedEnabled: '已启用',
      legacyIgnored: '已忽略旧版配置提示。',
      legacyManualHint: '也可以取消导入，在 JSON 模式中手动粘贴配置。',
      legacyLoading: '正在读取旧版配置...',
    }

    function translate(key, params) {
      let text = dictZh[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) {
        text = String(text).replaceAll(`{${name}}`, String(value))
      }
      return text
    }

    // Prefer the current Connection RPC. Fall back to the exact loopback
    // route only when the RPC transport itself is unavailable.
    async function apiCall(rpc, endpoint, payload) {
      if (rpc?.call) {
        let result
        try {
          result = await rpc.call(RPC_CHANNEL, endpoint, payload)
        } catch (err) {
          const message = String(err?.message || err)
          if (!/transport failure|HTTP \d+|network|failed to fetch/i.test(message)) throw err
          result = null
        }
        if (result) {
          if (result.ok) return result.value
          throw new Error(result.error?.message || result.error?.code || 'RPC 调用失败')
        }
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
      profileBadge: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-tertiary)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        flexShrink: 0,
        maxWidth: 220,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
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
      sourceBadge: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-state-info-bg, rgba(59, 130, 246, 0.1))',
        color: 'var(--dsw-alias-state-info-primary, #3b82f6)',
        border: '0.5px solid var(--dsw-alias-state-info-border, rgba(59, 130, 246, 0.35))',
        flexShrink: 0,
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
            : status === 'connecting'
            ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
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
        alignItems: 'flex-start',
        gap: 6,
        fontSize: 13,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'pointer',
        userSelect: 'none',
      },
      subRowText: {
        minWidth: 0,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      warningMarker: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.08))',
        color: 'var(--dsw-alias-state-warn-label, #b45309)',
        border: '0.5px solid var(--dsw-alias-state-warn-secondary, rgba(245, 158, 11, 0.35))',
        flexShrink: 0,
      },
      toolsList: {
        marginTop: 6,
        paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      banner: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      bannerWarning: {
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.08))',
        border: '1px solid var(--dsw-alias-state-warn-secondary, rgba(245, 158, 11, 0.35))',
      },
      bannerError: {
        background: 'var(--dsw-alias-state-error-bg, rgba(239, 68, 68, 0.08))',
        border: '1px solid var(--dsw-alias-state-error-border, rgba(239, 68, 68, 0.35))',
      },
      bannerInfo: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      bannerIcon: {
        display: 'inline-flex',
        marginTop: 2,
        flexShrink: 0,
      },
      bannerBody: {
        flex: 1,
        minWidth: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      bannerTitle: {
        fontWeight: 600,
        marginBottom: 2,
      },
      warningBox: {
        marginTop: 6,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.08))',
        border: '1px solid var(--dsw-alias-state-warn-secondary, rgba(245, 158, 11, 0.35))',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      errorBox: {
        marginTop: 6,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-state-error-bg, rgba(239, 68, 68, 0.08))',
        border: '1px solid var(--dsw-alias-state-error-border, rgba(239, 68, 68, 0.35))',
        color: 'var(--dsw-alias-state-error-primary, #ef4444)',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
      },
      configList: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: '18px',
      },
      configKey: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        marginRight: 6,
      },
      configVal: {
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
      },
      detailTitle: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
        marginBottom: 4,
      },
      detailHint: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
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
      editorMeta: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      editorMetaRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
      },
      profileField: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        height: 32,
        padding: '0 12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: '20px',
        maxWidth: '60%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      patchLine: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        minWidth: 0,
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      patchPath: {
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
        flex: 1,
        minWidth: 0,
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
      legacyFile: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-module-platform))',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      legacyFileHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      },
      legacyFilePath: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
        wordBreak: 'break-all',
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
      },
      legacyServer: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      legacyServerMain: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      },
      legacyServerName: {
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      legacyServerMeta: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      legacyCheckbox: {
        width: 16,
        height: 16,
        marginTop: 2,
        flexShrink: 0,
        accentColor: 'var(--dsw-alias-brand-primary)',
      },
      legacyConflict: {
        display: 'inline-flex',
        alignItems: 'center',
        marginTop: 2,
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 4,
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(245, 158, 11, 0.08))',
        color: 'var(--dsw-alias-state-warn-label, #b45309)',
        border: '0.5px solid var(--dsw-alias-state-warn-secondary, rgba(245, 158, 11, 0.35))',
      },
      legacyHint: {
        margin: 0,
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      legacyActions: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        paddingTop: 4,
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

    // ---- JSON wrapper analysis (kept compatible with the old import shapes) ----

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function looksLikeOfficialConfig(value) {
      if (!isPlainObject(value)) return false
      return typeof value.transport === 'string' || typeof value.command === 'string' || typeof value.url === 'string'
    }

    function entryName(item) {
      if (!isPlainObject(item)) return ''
      if (typeof item.name === 'string' && item.name) return item.name
      if (typeof item.serverName === 'string' && item.serverName) return item.serverName
      return ''
    }

    function extractJsonEntries(parsed) {
      if (Array.isArray(parsed)) {
        return parsed.map((item) => ({ name: entryName(item) })).filter((entry) => entry.name)
      }
      if (!isPlainObject(parsed)) return []

      if (isPlainObject(parsed.mcpServers)) {
        return Object.keys(parsed.mcpServers).map((name) => ({ name }))
      }
      if (Array.isArray(parsed.servers)) {
        return parsed.servers.map((item) => ({ name: entryName(item) })).filter((entry) => entry.name)
      }
      if (isPlainObject(parsed.servers)) {
        return Object.keys(parsed.servers).map((name) => ({ name }))
      }
      if (looksLikeOfficialConfig(parsed)) {
        const name = entryName(parsed)
        return name ? [{ name }] : []
      }

      // Bare map: { "server-name": { ... } }
      return Object.entries(parsed)
        .filter(([, value]) => isPlainObject(value))
        .map(([name]) => ({ name }))
    }

    function analyzeJson(text) {
      if (!text || !text.trim()) return { valid: false, message: '请输入 JSON 配置' }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        return { valid: false, message: 'JSON 语法错误: ' + (err?.message || String(err)) }
      }
      if (!parsed || typeof parsed !== 'object') {
        return { valid: false, message: 'JSON 根元素必须为对象或数组' }
      }

      const names = extractJsonEntries(parsed).map((entry) => entry.name)
      const count = names.length
      if (!count) return { valid: false, count: 0, names, message: translate('nameUnresolved') }

      const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? '...' : '')
      return {
        valid: true,
        count,
        names,
        message: `有效配置: 检测到 ${count} 个服务 (${preview})`,
      }
    }

    // Official @deepseek-ai/dsh-mcp-client config for one server, used to seed
    // the JSON editor from the current row.
    function serverToJsonEntry(server) {
      const entry = { transport: server.transport || 'stdio' }
      if (entry.transport === 'stdio') {
        if (server.command) entry.command = server.command
        if (Array.isArray(server.args) && server.args.length > 0) entry.args = server.args
        if (server.env && Object.keys(server.env).length > 0) entry.env = server.env
        if (server.cwd) entry.cwd = server.cwd
      } else {
        if (server.url) entry.url = server.url
        if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers
      }
      if (typeof server.toolCallTimeoutMs === 'number' && server.toolCallTimeoutMs > 0) {
        entry.toolCallTimeoutMs = server.toolCallTimeoutMs
      }
      if (server.reconnect && typeof server.reconnect === 'object') entry.reconnect = server.reconnect
      if (typeof server.failOnStartupError === 'boolean') entry.failOnStartupError = server.failOnStartupError
      if (typeof server.maxInstructionBytes === 'number') entry.maxInstructionBytes = server.maxInstructionBytes
      entry.enabled = Boolean(server.enabled)
      return entry
    }

    function sourceBadgeText(server) {
      if (server.source === 'panel' || server.origin === 'panel') return translate('sourcePanel')
      if (server.origin === 'magpie') return translate('sourceMagpie')
      return translate('sourcePluginEntry')
    }

    function sourceBadgeHint(server) {
      if (server.source === 'panel' || server.origin === 'panel') return translate('sourcePanelHint')
      return translate('foreignHint', { origin: server.originLabel || sourceBadgeText(server) })
    }

    function formatReconnect(reconnect) {
      if (!isPlainObject(reconnect)) return ''
      const parts = [reconnect.enabled === false ? '已停用' : '已启用']
      if (typeof reconnect.initialDelayMs === 'number') parts.push(`初始 ${reconnect.initialDelayMs}ms`)
      if (typeof reconnect.maxDelayMs === 'number') parts.push(`上限 ${reconnect.maxDelayMs}ms`)
      if (typeof reconnect.maxAttempts === 'number') parts.push(`最多 ${reconnect.maxAttempts} 次`)
      return parts.join('，')
    }

    function subRowLabel(server, count) {
      if (!server.enabled || server.status === 'disabled') return translate('disabled')
      if (server.error) return translate('error')
      if (server.status === 'connecting') return translate('connecting')
      if (count > 0) return translate('toolsEnabled', { count })
      return translate('noTools')
    }

    function configRow(label, value) {
      return h('div', { key: label },
        h('span', { style: css.configKey }, label),
        h('span', { style: css.configVal }, value)
      )
    }

    function restartNoticeText(reason) {
      if (!reason || reason === 'no-hmr') return translate('restartRequiredBody')
      if (reason === 'overridden') return translate('restartRequiredOverridden')
      if (reason === 'no-profile') return translate('restartRequiredNoProfile')
      return translate('restartRequiredBody') + '（原因: ' + reason + '）'
    }

    function renderBanner(kind, title, body) {
      const style = kind === 'error'
        ? { ...css.banner, ...css.bannerError }
        : kind === 'info'
        ? { ...css.banner, ...css.bannerInfo }
        : { ...css.banner, ...css.bannerWarning }
      return h('div', { style },
        h('span', { style: css.bannerIcon }, h(Icons.Alert, { size: 14 })),
        h('div', { style: css.bannerBody },
          title ? h('div', { style: css.bannerTitle }, title) : null,
          body ? h('div', null, body) : null
        )
      )
    }

    // Add / Edit Server Component
    function ServerEditor(props) {
      const { initialServer, targetPath, profile, onSave, onCancel } = props
      const isEditing = Boolean(initialServer)

      const [mode, setMode] = useState(isEditing ? 'form' : 'json')
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
          return JSON.stringify({ [initialServer.name]: serverToJsonEntry(initialServer) }, null, 2)
        }
        return EMPTY_JSON_TEMPLATE
      })
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const jsonAnalysis = useMemo(() => analyzeJson(jsonText), [jsonText])

      async function handleSave() {
        setError('')
        setBusy(true)

        try {
          if (mode === 'json') {
            if (!jsonAnalysis.valid) {
              throw new Error(jsonAnalysis.message || translate('invalidJson'))
            }
            const badNames = jsonAnalysis.names.filter((serverName) => !SERVER_NAME_RE.test(serverName))
            if (badNames.length > 0) {
              throw new Error(translate('nameInvalid') + ' (' + badNames.slice(0, 3).join(', ') + ')')
            }

            const payload = { rawJson: jsonText, createOnly: !isEditing }
            if (isEditing && jsonAnalysis.names.length > 0 && !jsonAnalysis.names.includes(initialServer.name)) {
              payload.replaceName = initialServer.name
            }
            await onSave(payload)
            return
          }

          const finalName = name.trim()
          if (!finalName) throw new Error(translate('nameRequired'))
          if (!SERVER_NAME_RE.test(finalName)) throw new Error(translate('nameInvalid'))

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
            enabled: isEditing ? Boolean(initialServer.enabled) : true,
          }

          // Preserve advanced official-config fields the form does not edit.
          if (isEditing) {
            if (initialServer.cwd) serverPayload.cwd = initialServer.cwd
            if (typeof initialServer.toolCallTimeoutMs === 'number' && initialServer.toolCallTimeoutMs > 0) {
              serverPayload.toolCallTimeoutMs = initialServer.toolCallTimeoutMs
            }
            if (initialServer.reconnect && typeof initialServer.reconnect === 'object') {
              serverPayload.reconnect = initialServer.reconnect
            }
            if (typeof initialServer.failOnStartupError === 'boolean') {
              serverPayload.failOnStartupError = initialServer.failOnStartupError
            }
            if (typeof initialServer.maxInstructionBytes === 'number') {
              serverPayload.maxInstructionBytes = initialServer.maxInstructionBytes
            }
          }

          await onSave({ name: finalName, server: serverPayload, createOnly: !isEditing })
        } catch (err) {
          setError(err?.message || '保存失败')
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
          // Profile row mirrors the original first row; the patch path stays
          // available as a read-only hint underneath it.
          h('div', { style: css.editorMeta },
            h('div', { style: css.editorMetaRow },
              h('span', { style: css.label }, translate('profileLabel')),
              h('span', { style: css.profileField, title: targetPath || '' },
                profile?.name || translate('targetPatchMissing'))
            ),
            h('div', { style: css.patchLine, title: targetPath || '' },
              h('span', null, translate('targetPatch')),
              h('span', { style: css.patchPath }, targetPath || translate('targetPatchMissing'))
            )
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
                  color: jsonAnalysis.valid
                    ? 'var(--dsw-alias-state-success-primary, #22c55e)'
                    : 'var(--dsw-alias-label-tertiary)',
                  marginTop: 4,
                },
              }, jsonAnalysis.valid ? jsonAnalysis.message : translate('jsonHint'))
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

    const LEGACY_DISMISS_KEY = 'dsh-mcp-servers-panel:legacy-dismissed'

    function readLegacyDismissed() {
      try {
        if (typeof localStorage === 'undefined') return new Set()
        const parsed = JSON.parse(localStorage.getItem(LEGACY_DISMISS_KEY) || '[]')
        return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
      } catch {
        return new Set()
      }
    }

    function writeLegacyDismissed(paths) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(LEGACY_DISMISS_KEY, JSON.stringify([...paths]))
      } catch {}
    }

    function legacyServerMeta(config) {
      if (!config || typeof config !== 'object') return ''
      if (config.transport === 'streamable-http') {
        return 'streamable-http · ' + String(config.url || '')
      }
      const args = Array.isArray(config.args) ? config.args.join(' ') : ''
      return 'stdio · ' + [config.command, args].filter(Boolean).join(' ')
    }

    /**
     * Selective migration of 0.1.x mcp.json files. Nothing is imported until
     * the user checks entries and confirms; rows are written disabled by
     * default and legacy files are never modified or deleted.
     */
    function LegacyImportView(props) {
      const { connection, existingNames, onCancel, onImported } = props
      const rpc = connection?.rpc
      const [configs, setConfigs] = useState([])
      const [selected, setSelected] = useState(new Set())
      const [enable, setEnable] = useState(false)
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const response = await apiCall(rpc, 'legacy', {})
            if (cancelled) return
            const next = Array.isArray(response?.configs) ? response.configs : []
            setConfigs(next)
            const counts = new Map()
            for (const config of next) {
              for (const server of config.servers || []) {
                counts.set(server.name, (counts.get(server.name) || 0) + 1)
              }
            }
            const preselected = new Set()
            for (const config of next) {
              for (const server of config.servers || []) {
                if (existingNames.has(server.name) || (counts.get(server.name) || 0) > 1) continue
                preselected.add(config.path + '::' + server.name)
              }
            }
            setSelected(preselected)
          } catch (err) {
            if (!cancelled) setLoadError(err?.message || String(err))
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
        return () => { cancelled = true }
      }, [rpc, existingNames])

      if (loading) {
        return h('div', { style: css.container },
          h('div', { style: css.emptyBox }, translate('legacyLoading')))
      }

      const counts = new Map()
      for (const config of configs) {
        for (const server of config.servers || []) counts.set(server.name, (counts.get(server.name) || 0) + 1)
      }
      const rows = []
      for (const config of configs) {
        for (const server of config.servers || []) rows.push({ config, server, key: config.path + '::' + server.name })
      }
      const selectedRows = rows.filter((row) => selected.has(row.key))
      const fullySelected = configs
        .filter((config) => (config.servers || []).length > 0 && (config.servers || []).every((server) => selected.has(config.path + '::' + server.name)))
        .map((config) => config.path)

      function toggle(key) {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      async function handleImport() {
        if (selectedRows.length === 0) {
          setError(translate('legacyImportNone'))
          return
        }
        setBusy(true)
        setError('')
        try {
          await apiCall(rpc, 'import', {
            enable,
            items: selectedRows.map((row) => ({ name: row.server.name, server: row.server.config })),
          })
          if (onImported) onImported({ count: selectedRows.length, enable, paths: fullySelected })
        } catch (err) {
          setError(err?.message || String(err))
          setBusy(false)
        }
      }

      return h('div', { style: css.container },
        h('div', { style: css.header },
          h('div', null,
            h('h2', { style: css.title }, translate('legacyImportTitle')),
            h('p', { style: css.subtitle }, translate('legacyImportSubtitle'))
          )
        ),
        loadError ? h('div', { style: css.errorBox }, loadError) : null,
        error ? h('div', { style: css.errorBox }, error) : null,
        configs.length === 0
          ? h('div', { style: css.emptyBox }, translate('legacyImportEmpty'))
          : configs.map((config) => h('div', { key: config.path, style: css.legacyFile },
              h('div', { style: css.legacyFileHead },
                h('span', { style: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
                  (config.kind === 'user' ? translate('legacySourceUser') : (config.title || translate('legacySourceProject')))
                  + ' · ' + (config.servers || []).length)
              ),
              h('div', { style: css.legacyFilePath }, config.path),
              config.error
                ? h('div', { style: css.errorText }, translate('legacyFileError', { message: config.error }))
                : null,
              (config.servers || []).map((server) => {
                const key = config.path + '::' + server.name
                const conflict = existingNames.has(server.name) || (counts.get(server.name) || 0) > 1
                return h('label', { key, style: css.legacyServer },
                  h('input', {
                    type: 'checkbox',
                    style: css.legacyCheckbox,
                    checked: selected.has(key),
                    disabled: busy || conflict,
                    onChange: () => toggle(key),
                  }),
                  h('div', { style: css.legacyServerMain },
                    h('span', { style: css.legacyServerName }, server.name),
                    h('span', { style: css.legacyServerMeta }, legacyServerMeta(server.config)),
                    conflict
                      ? h('span', { style: css.legacyConflict, title: translate('legacyConflictHint') }, translate('legacyConflict'))
                      : null
                  )
                )
              })
            ))
        ,
        h('p', { style: css.legacyHint }, translate('legacyManualHint')),
        h('div', { style: css.legacyActions },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, marginRight: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('input', {
              type: 'checkbox',
              checked: enable,
              disabled: busy,
              onChange: (e) => setEnable(e.target.checked),
            }),
            translate('legacyImportEnable')
          ),
          h('button', {
            type: 'button',
            style: css.btnSecondary,
            onClick: onCancel,
            disabled: busy,
          }, translate('cancel')),
          h('button', {
            type: 'button',
            style: css.btnPrimary,
            onClick: handleImport,
            disabled: busy || selectedRows.length === 0,
          }, busy ? translate('saving') : translate('legacyImportConfirm', { count: selectedRows.length }))
        )
      )
    }

    // Main Section View
    function McpServersSection(props) {
      ensureSelectCss()
      const rpc = props.connection?.rpc

      const [servers, setServers] = useState([])
      const [profile, setProfile] = useState(null)
      const [canManage, setCanManage] = useState(false)
      const [nativeControlAvailable, setNativeControlAvailable] = useState(false)
      const [listWarnings, setListWarnings] = useState([])
      const [loading, setLoading] = useState(true)
      const [view, setView] = useState('list') // 'list' | 'add' | 'edit' | 'import'
      const [editingServer, setEditingServer] = useState(null)
      const [editorNonce, setEditorNonce] = useState(0)
      const [expanded, setExpanded] = useState(new Set())
      const [sourceFilter, setSourceFilter] = useState('all')
      const [legacy, setLegacy] = useState([])
      const [legacyDismissed, setLegacyDismissed] = useState(() => readLegacyDismissed())
      const [legacyNotice, setLegacyNotice] = useState('')
      const [actionBusy, setActionBusy] = useState(false)
      const [restartNotice, setRestartNotice] = useState('')
      const [listError, setListError] = useState(null)

      const profileAvailable = Boolean(profile?.available)

      const sourceFilterOptions = [
        { id: 'all', label: translate('sourceAll') },
        { id: 'panel', label: translate('sourcePanel') },
        { id: 'magpie', label: translate('sourceMagpie') },
        { id: 'plugin', label: translate('sourcePluginEntry') },
      ]

      const visibleServers = useMemo(() => {
        if (sourceFilter === 'all') return servers
        return servers.filter((server) => {
          const isPanel = server.source === 'panel' || server.origin === 'panel'
          const isMagpie = server.origin === 'magpie'
          if (sourceFilter === 'panel') return isPanel
          if (sourceFilter === 'magpie') return isMagpie
          return !isPanel && !isMagpie
        })
      }, [servers, sourceFilter])

      const existingNames = useMemo(() => new Set(servers.map((server) => server.name)), [servers])

      const visibleLegacy = useMemo(() => {
        return (legacy || []).filter((item) => {
          if (legacyDismissed.has(item.path)) return false
          const names = Array.isArray(item.names) ? item.names : []
          if (names.length > 0 && names.every((name) => existingNames.has(name))) return false
          return true
        })
      }, [legacy, legacyDismissed, existingNames])

      const dismissLegacy = useCallback((paths) => {
        setLegacyDismissed((prev) => {
          const next = new Set(prev)
          for (const path of paths || []) next.add(path)
          writeLegacyDismissed(next)
          return next
        })
      }, [])

      const applyResponse = useCallback((response) => {
        if (!response || typeof response !== 'object') return
        if (Array.isArray(response.servers)) setServers(response.servers)
        if (Array.isArray(response.legacyConfigs)) setLegacy(response.legacyConfigs)
        if (response.profile && typeof response.profile === 'object') setProfile(response.profile)
        if (typeof response.canManage === 'boolean') setCanManage(response.canManage)
        if (typeof response.nativeControlAvailable === 'boolean') {
          setNativeControlAvailable(response.nativeControlAvailable)
        }
        setListWarnings(Array.isArray(response.warnings) ? response.warnings : [])
      }, [])

      const refresh = useCallback(async () => {
        setLoading(true)
        setListError('')
        try {
          const response = await apiCall(rpc, 'list', {})
          applyResponse(response)
          // The restart warning belongs to the mutation that caused it; an
          // explicit refresh re-reads live state and clears it.
          setRestartNotice('')
        } catch (err) {
          setListError({ title: translate('loadFailed'), message: err?.message || String(err) })
        } finally {
          setLoading(false)
        }
      }, [rpc, applyResponse])

      useEffect(() => {
        refresh()
      }, [refresh])

      async function applyMutationResult(response) {
        if (response && Array.isArray(response.servers)) {
          applyResponse(response)
        } else {
          await refresh()
        }
        if (response && response.application === 'restart-required') {
          setRestartNotice(restartNoticeText(response.restartReason))
        }
      }

      function toggleExpanded(uniqueKey) {
        setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(uniqueKey)) next.delete(uniqueKey)
          else next.add(uniqueKey)
          return next
        })
      }

      async function handleToggleEnabled(server) {
        setActionBusy(true)
        setListError('')
        try {
          const response = await apiCall(rpc, 'toggle', { name: server.name, enabled: !server.enabled })
          await applyMutationResult(response)
        } catch (err) {
          setListError({ title: translate('actionFailed'), message: err?.message || String(err) })
        } finally {
          setActionBusy(false)
        }
      }

      async function handleDelete(server) {
        if (!confirm(translate('confirmDelete', { name: server.name }))) return
        setActionBusy(true)
        setListError('')
        try {
          const response = await apiCall(rpc, 'delete', { name: server.name })
          await applyMutationResult(response)
        } catch (err) {
          setListError({ title: translate('actionFailed'), message: err?.message || String(err) })
        } finally {
          setActionBusy(false)
        }
      }

      async function handleSaveServer(payload) {
        setActionBusy(true)
        setListError('')
        try {
          const response = await apiCall(rpc, 'save', payload)
          await applyMutationResult(response)
          setView('list')
          setEditingServer(null)
          return response
        } catch (err) {
          // The editor renders the failure inline; keep the list banner clean.
          throw err
        } finally {
          setActionBusy(false)
        }
      }

      if (view === 'import') {
        return h(LegacyImportView, {
          connection: props.connection,
          existingNames,
          onCancel: () => setView('list'),
          onImported: (result) => {
            if (result?.paths?.length) dismissLegacy(result.paths)
            setLegacyNotice(translate('legacyImported', {
              count: result?.count ?? 0,
              state: result?.enable
                ? translate('legacyImportedEnabled')
                : translate('legacyImportedDisabled'),
            }))
            setView('list')
            refresh()
          },
        })
      }

      if (view === 'add' || view === 'edit') {
        return h(ServerEditor, {
          key: view === 'edit'
            ? 'edit:' + (editingServer?.entryId || editingServer?.patchEntryId || editingServer?.name)
            : 'add:' + editorNonce,
          initialServer: editingServer,
          targetPath: profile?.path || '',
          profile,
          onSave: handleSaveServer,
          onCancel: () => {
            setView('list')
            setEditingServer(null)
          },
        })
      }

      const banners = []
      if (restartNotice) {
        banners.push(h('div', { key: 'restart' },
          renderBanner('warning', translate('restartRequiredTitle'), restartNotice)
        ))
      }
      if (profile && !profileAvailable) {
        banners.push(h('div', { key: 'profile' },
          renderBanner('warning', translate('profileMissing'), translate('profileMissingDetail'))
        ))
      }
      if (listWarnings.length > 0) {
        banners.push(h('div', { key: 'warnings' },
          renderBanner('info', translate('warningsTitle'), listWarnings.join('\n'))
        ))
      }
      if (listError) {
        banners.push(h('div', { key: 'error' },
          renderBanner('error', listError.title, listError.message)
        ))
      }

      const legacyServerCount = visibleLegacy.reduce((sum, item) => sum + (item.count || 0), 0)
      const legacyPaths = visibleLegacy.slice(0, 2).map((item) => item.path).join('、')
        + (visibleLegacy.length > 2 ? ' 等 ' + visibleLegacy.length + ' 个文件' : '')
      const legacyBanner = visibleLegacy.length > 0
        ? h('div', { style: { ...css.banner, ...css.bannerWarning } },
            h('span', { style: css.bannerIcon }, h(Icons.Alert, { size: 14 })),
            h('div', { style: css.bannerBody },
              h('div', { style: css.bannerTitle }, translate('legacyTitle')),
              h('div', null, translate('legacyBody', {
                files: visibleLegacy.length,
                count: legacyServerCount,
                paths: legacyPaths,
              })),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  style: css.btnSecondary,
                  onClick: () => setView('import'),
                }, translate('legacyOpen')),
                h('button', {
                  type: 'button',
                  style: css.btnSecondary,
                  onClick: () => {
                    dismissLegacy(visibleLegacy.map((item) => item.path))
                    setLegacyNotice(translate('legacyIgnored'))
                  },
                }, translate('legacyDismiss'))
              )
            )
          )
        : null

      return h('div', { style: css.container },
        // Top Header Bar — same layout as 0.1.7: title block, then the
        // filter control, then Add, then Refresh.
        h('div', { style: css.header },
          h('div', { style: { minWidth: 0 } },
            h('h2', { style: css.title }, translate('title')),
            h('p', { style: css.subtitle },
              translate('subtitle')
              + (profile
                ? ' · ' + (profileAvailable
                  ? translate('profileBadge', { name: profile.name })
                  : translate('profileMissing'))
                : ''))
          ),
          h('div', { style: css.headerActions },
            h(NativeSelect, {
              value: sourceFilter,
              options: sourceFilterOptions,
              onChange: (value) => setSourceFilter(value),
              label: translate('sourceFilter'),
              disabled: loading || actionBusy,
            }),
            h('button', {
              type: 'button',
              style: css.btnPrimary,
              onClick: () => {
                if (!canManage) return
                setEditingServer(null)
                setEditorNonce((n) => n + 1)
                setView('add')
              },
              title: canManage ? translate('addMcp') : translate('manageHint'),
              disabled: loading || actionBusy || !canManage,
            },
              h(Icons.Plus, { size: 14 }),
              translate('addMcp')
            ),
            h('button', {
              type: 'button',
              style: css.iconBtn,
              onClick: refresh,
              title: translate('refresh'),
              disabled: loading || actionBusy,
            }, h(Icons.Refresh, { size: 16 }))
          )
        ),

        legacyBanner,
        legacyNotice
          ? renderBanner('info', translate('warningsTitle'), legacyNotice)
          : null,
        banners.length > 0 ? banners : null,

        // Server List
        visibleServers.length === 0 && !loading ? (
          h('div', { style: css.emptyBox },
            profileAvailable ? translate('emptyList') : translate('noProfileEmpty'))
        ) : (
          visibleServers.map((server) => {
            const uniqueKey = (server.source || 'panel') + ':' + (server.entryId || server.patchEntryId || server.name)
            const isExpanded = expanded.has(uniqueKey)
            const count = typeof server.toolCount === 'number' ? server.toolCount : (server.tools || []).length
            const warnings = Array.isArray(server.warnings) ? server.warnings : []
            const tools = Array.isArray(server.tools) ? server.tools : []
            const controllable = server.controllable !== false
            const sourceLabel = sourceBadgeText(server)
            const sourceHint = sourceBadgeHint(server)

            const editTitle = !canManage
              ? translate('manageHint')
              : server.readonly
              ? translate('readonlyPluginHint')
              : translate('edit')
            const deleteTitle = !canManage
              ? translate('manageHint')
              : server.readonly
              ? translate('readonlyPluginHint')
              : translate('delete')
            const toggleTitle = !controllable
              ? (nativeControlAvailable ? translate('toggleDisabledHint') : translate('nativeControlUnavailable'))
              : (server.enabled ? '停用' : '启用')

            return h('div', { key: uniqueKey, style: css.serverCard },
              // Main row
              h('div', { style: css.cardMainRow },
                h('div', { style: css.serverTitleArea },
                  h('span', { style: css.serverName, title: server.name }, server.name),
                  h('span', { style: css.statusDot(server.status) }),
                  profile && profileAvailable
                    ? h('span', {
                        style: css.profileBadge,
                        title: translate('profileBadge', { name: profile.name }),
                      }, profile.name)
                    : null,
                  h('span', { style: css.sourceBadge, title: sourceHint }, sourceLabel),
                  server.transport ? h('span', { style: css.transportBadge }, server.transport) : null
                ),
                h('div', { style: css.cardControls },
                  // Edit (read-only rows are owned by their source)
                  h('button', {
                    type: 'button',
                    style: { ...css.iconBtn, border: 'none', width: 28, height: 28, opacity: (canManage && !server.readonly) ? 1 : 0.45 },
                    onClick: () => {
                      if (!canManage || server.readonly) return
                      setEditingServer(server)
                      setView('edit')
                    },
                    title: editTitle,
                    disabled: actionBusy || !canManage || Boolean(server.readonly),
                  }, h(Icons.Edit, { size: 15 })),
                  // Trash
                  h('button', {
                    type: 'button',
                    style: { ...css.iconBtn, border: 'none', width: 28, height: 28, opacity: (canManage && !server.readonly) ? 1 : 0.45 },
                    onClick: () => handleDelete(server),
                    title: deleteTitle,
                    disabled: actionBusy || !canManage || Boolean(server.readonly),
                  }, h(Icons.Trash, { size: 15 })),
                  // Switch
                  h('button', {
                    type: 'button',
                    role: 'switch',
                    'aria-checked': Boolean(server.enabled),
                    title: toggleTitle,
                    style: { ...css.switch(server.enabled), opacity: controllable ? 1 : 0.45 },
                    onClick: () => handleToggleEnabled(server),
                    disabled: actionBusy || !controllable,
                  }, h('span', { style: css.switchKnob(server.enabled) }))
                )
              ),

              // Sub-row: status text plus the warning marker
              h('div', {
                style: css.subRow,
                onClick: () => toggleExpanded(uniqueKey),
                title: server.error || (warnings.length > 0 ? warnings.join('\n') : undefined),
              },
                h('span', { style: { display: 'inline-flex', marginTop: 2, flexShrink: 0 } },
                  isExpanded ? h(Icons.ChevronDown, { size: 14 }) : h(Icons.ChevronRight, { size: 14 })
                ),
                h('span', { style: css.subRowText }, subRowLabel(server, count)),
                warnings.length > 0
                  ? h('span', { style: css.warningMarker, title: warnings.join('\n') }, translate('warningMarker'))
                  : null
              ),

              isExpanded ? (
                h('div', { style: css.toolsList },
                  server.error
                    ? h('div', null,
                        h('div', { style: css.detailTitle }, translate('errorDetailTitle')),
                        h('div', { style: css.errorBox }, server.error)
                      )
                    : null,
                  warnings.length > 0
                    ? h('div', null,
                        h('div', { style: css.detailTitle }, translate('warningTitle')),
                        h('div', { style: css.warningBox }, warnings.join('\n'))
                      )
                    : null,
                  h('div', null,
                    h('div', { style: css.detailTitle }, translate('configTitle')),
                    h('div', { style: css.configList },
                      configRow('transport', server.transport || 'stdio'),
                      server.command ? configRow('command', server.command) : null,
                      Array.isArray(server.args) && server.args.length > 0
                        ? configRow('args', server.args.join(' '))
                        : null,
                      server.cwd ? configRow('cwd', server.cwd) : null,
                      server.url ? configRow('url', server.url) : null,
                      typeof server.toolCallTimeoutMs === 'number' && server.toolCallTimeoutMs > 0
                        ? configRow('toolCallTimeoutMs', String(server.toolCallTimeoutMs))
                        : null,
                      server.reconnect ? configRow('reconnect', formatReconnect(server.reconnect)) : null,
                      typeof server.failOnStartupError === 'boolean'
                        ? configRow('failOnStartupError', String(server.failOnStartupError))
                        : null,
                      typeof server.maxInstructionBytes === 'number'
                        ? configRow('maxInstructionBytes', String(server.maxInstructionBytes))
                        : null,
                      configRow(translate('patchEntryLabel'), server.patchEntryId || '—'),
                      server.entryId && server.entryId !== server.patchEntryId
                        ? configRow(translate('entryLabel'), server.entryId)
                        : null,
                      configRow(translate('profilePathLabel'), profile?.path || '—')
                    )
                  ),
                  server.readonly
                    ? h('div', { style: css.detailHint }, translate('readonlyPluginHint'))
                    : null,
                  h('div', null,
                    h('div', { style: css.detailTitle }, translate('toolsTitle')),
                    tools.length > 0
                      ? tools.map((tool) =>
                          h('div', { key: tool.rawName || tool.name, style: css.toolItem },
                            h('span', { style: css.toolName }, tool.rawName || tool.name),
                            tool.description ? h('span', { style: css.toolDesc }, tool.description) : null
                          )
                        )
                      : h('div', { style: css.toolDesc },
                          !server.enabled || server.status === 'disabled'
                            ? translate('disabled')
                            : !server.error && server.status !== 'connecting'
                            ? translate('noTools')
                            : '—'
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
