import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProfilePatch } from '../../patch-store.js'

export const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

export async function makeTempProfile(prefix = 'mcp-panel-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const patchPath = join(dir, 'cordis.patch.yml')
  return { dir, patchPath }
}

export function toolMap(entries = []) {
  const map = new Map()
  for (const [name, description] of entries) {
    map.set(name, { description, parameters: { type: 'object' } })
  }
  return map
}

/**
 * Fake host services: a Loader whose entries are rebuilt from the patch file
 * on reconcile, a plugin manager over the same live rows, and a small tool
 * registry. Enough of DSH's seam to exercise the panel manager without Cordis.
 */
function withLoaderId(entry) {
  const patchId = String(entry.patchId || entry.options?.id || entry.id || '').replace(/^include:/, '')
  return {
    ...entry,
    id: 'include:' + patchId,
    options: { ...entry.options, id: patchId },
  }
}

export function makeHost({ profile, foreign = [], tools = new Map(), withHmr = true } = {}) {
  const state = {
    live: foreign.map(withLoaderId),
    calls: { reconcile: [], setPluginEnabled: [] },
    failNextReconcile: null,
  }
  const reloadFromPatch = async () => {
    if (!profile?.patchPath) return
    const text = await readFile(profile.patchPath, 'utf8')
    const patch = ProfilePatch.parse(text)
    const panel = patch.panelRows().map((row) => ({
      id: 'include:' + row.entryId,
      options: { id: row.entryId, name: MCP_CLIENT, config: row.config },
      disabled: !row.enabled,
      fiber: row.enabled ? { state: 2 } : undefined,
    }))
    state.live = [
      ...state.live.filter((entry) => !String(entry.id).startsWith('dsh-mcp-panel-')),
      ...panel,
    ]
  }
  const hmr = withHmr ? {
    async runExclusive(operation) {
      return await operation()
    },
    async reconcileProfile(requiredIds = []) {
      state.calls.reconcile.push([...requiredIds])
      if (state.failNextReconcile) {
        const error = state.failNextReconcile
        state.failNextReconcile = null
        throw error
      }
      await reloadFromPatch()
      return { warnings: [], pending: [] }
    },
  } : undefined

  const pluginManager = {
    async listPlugins() {
      return state.live.map((entry) => ({
        entryId: entry.id,
        moduleName: MCP_CLIENT,
        enabled: entry.disabled !== true,
        fiberPhase: entry.disabled === true ? null : 'active',
        patchId: entry.options?.id || String(entry.id).replace(/^include:/, ''),
        readOnlyReason: '',
      }))
    },
    async setPluginEnabled(entryId, enabled) {
      state.calls.setPluginEnabled.push([entryId, enabled])
      const entry = state.live.find((item) => item.id === entryId)
      if (entry) {
        entry.disabled = !enabled
        entry.fiber = enabled ? { state: 2 } : undefined
      }
    },
  }

  const ctx = {
    get(name) {
      if (name === 'profileContext') return profile
      if (name === 'hmr') return hmr
      if (name === 'loader') return { entries: () => state.live }
      if (name === 'pluginManager') return pluginManager
      if (name === 'tools') return { view: () => ({ visible: tools }) }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
  }

  return { ctx, state, hmr, pluginManager, tools }
}
