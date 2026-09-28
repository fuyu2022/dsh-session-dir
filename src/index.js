// dsh-session-dir — Host half of the virtual-directory session manager.
//
// Owns one workspace's durable directory tree and serves it to the browser half
// over a dedicated `/vdirs` Connection-RPC route whose endpoints are the
// `vdirs-*` method names.
//
// The tree lives in a CENTRAL store, not in the workspace: a plugin update or a
// remove/reinstall wipes `$DSH_HOME/profiles/<profile>/node_modules`, so nothing
// durable may live there. One file per workspace sits at
// `<DSH_HOME>/dsh-session-dir/config/<slug>-<hash>.json`, and a flat `index.json`
// beside it maps a normalized workspace path to its file, so a workspace renamed
// or moved away is still recognizable by hand. `$DSH_HOME` follows the official
// order: `DSH_HOME`, then `~/.dsh`.
//
// A `.dsh-vdirs.json` left in a workspace root by 1.x is still read when the
// central file is absent — that is the upgrade path, not a second store. It is
// never written again and never deleted, so downgrading stays possible.
//
// Blank sessions are deliberately absent from the durable tree and from every
// listing: a blank row is provisional, and only the browser half draws the single
// one it is currently creating. `showableIds()` drops them using the Host's own
// `blank` flag — the same value the shipped sidebar filters on, so an unfocused
// New Session row can never reappear under the root. That also converges a legacy
// file which still names one on the first read.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const inject = ['workspaceRegistry', 'sessionQuery', 'connection', 'webServer']

// The one directory this plugin owns under the harness home. Named after the
// package so a `$DSH_HOME` listing explains itself.
const STORE_DIR = 'dsh-session-dir'
// Bumped when the on-disk shape changes incompatibly; a file carrying another
// value is left untouched rather than silently rewritten.
const STORE_FORMAT = 1
// The 1.x per-workspace file, now read-only.
const LEGACY_FILE = '.dsh-vdirs.json'

// Central store root. `DSH_HOME` wins over `~/.dsh`, and a blank value counts as
// unset — the same precedence the shipped home-paths helper documents. A relative
// `DSH_HOME` is resolved against the process cwd instead of being inherited as-is,
// so the store cannot silently move with the invoking directory.
function storeRoot() {
  const configured = String(process.env.DSH_HOME || '').trim()
  return path.resolve(configured || path.join(homedir(), '.dsh'), STORE_DIR)
}

// Path identity: separators normalized and, on Windows, case-folded, because the
// same directory can arrive as `D:\a\b` or `d:/a/b`. Display keeps the raw path.
function normalizePath(value) {
  const text = String(value == null ? '' : value).trim().replace(/\\/g, '/')
  return process.platform === 'win32' ? text.toLowerCase() : text
}

function hash8(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function slugOf(value) {
  const slug = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return slug || 'workspace'
}

const normalized = (ws) => normalizePath(ws && ws.path)

// A readable stem plus a digest of the normalized path: the stem answers "which
// workspace is this file?" in a directory listing, the digest keeps two
// same-named workspaces apart.
function fileNameFor(ws) {
  const key = normalized(ws)
  return `${slugOf(ws.title || path.basename(key))}-${hash8(key)}.json`
}

const indexFile = (root) => path.join(root, 'index.json')
const configFile = (root, fileName) => path.join(root, 'config', fileName)

// Writes land in a sibling temp file and are renamed into place, so a crash or a
// concurrent reader never observes a half-written config. Rename replaces the
// destination on both POSIX and Windows.
async function atomicWrite(target, text) {
  await mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function readJson(target) {
  try {
    return { text: await readFile(target, 'utf8') }
  } catch (error) {
    return { error }
  }
}

// The central store. Every mutation of one workspace goes through `queue`, so two
// drags arriving together cannot land out of order and lose the first.
function createStore(onError) {
  const root = storeRoot()
  const queues = new Map()
  const fail = (message, error) => {
    if (typeof onError === 'function') onError(message, error)
  }

  async function readIndex() {
    const { text, error } = await readJson(indexFile(root))
    if (error) return {}
    try {
      const data = JSON.parse(text)
      return data && typeof data.workspaces === 'object' && data.workspaces ? data.workspaces : {}
    } catch (parseError) {
      // Never overwrite an unreadable index: it may be the only pointer to files
      // whose names the hash cannot be recomputed from.
      fail('index unreadable, keeping it as-is', parseError)
      return {}
    }
  }

  // The derived name is authoritative for a registered workspace; the index only
  // has to agree with it. A digest collision is rejected by the recorded path.
  function parseOwned(text, ws) {
    try {
      const data = JSON.parse(text)
      if (data && typeof data === 'object' && data.workspace && normalizePath(data.workspace.path) === normalized(ws)) {
        return data
      }
    } catch { /* reported by the caller, which knows the file name */ }
    return null
  }

  async function readConfig(ws) {
    const fileName = fileNameFor(ws)
    const registered = (await readIndex())[normalized(ws)]
    // The index wins over the derived name. Sharing one workspace out of two
    // harness homes, or editing the index by hand, would otherwise move the data
    // to a new file and strand the old one.
    if (registered && registered.file) {
      const pointed = await readJson(configFile(root, registered.file))
      if (!pointed.error) {
        const data = parseOwned(pointed.text, ws)
        if (data) return { data, file: registered.file }
        fail(`${registered.file} is listed for this workspace but does not match it`)
      }
    }
    if (fileName === (registered && registered.file)) return null
    const direct = await readJson(configFile(root, fileName))
    if (!direct.error) {
      const data = parseOwned(direct.text, ws)
      if (data) return { data, file: fileName }
      fail(`${fileName} does not belong to this workspace, ignoring it`)
    }
    // Last resort for a hand-renamed or hand-copied file: scan the config
    // directory, match on the recorded path, and adopt the match under the name
    // mainline writes use.
    let names = []
    try {
      names = await readdir(path.join(root, 'config'))
    } catch { /* no store yet */ }
    for (const name of names) {
      if (!name.endsWith('.json') || name === fileName) continue
      const candidate = await readJson(configFile(root, name))
      if (candidate.error) continue
      const data = parseOwned(candidate.text, ws)
      if (!data) continue
      try {
        await atomicWrite(configFile(root, fileName), JSON.stringify(data, null, 2))
        await syncIndex(ws, fileName)
        return { data, file: fileName }
      } catch (error) {
        fail(`adopting ${name} under ${fileName} failed`, error)
        return { data, file: name }
      }
    }
    return null
  }

  // Register this workspace in the flat index. Read-modify-write, so two
  // workspaces saving at once cannot drop each other's entry.
  async function syncIndex(ws, fileName) {
    const workspaces = await readIndex()
    workspaces[normalized(ws)] = {
      title: ws.title == null ? null : String(ws.title),
      path: String(ws.path == null ? '' : ws.path),
      file: fileName,
      updatedAt: Date.now()
    }
    await atomicWrite(indexFile(root), JSON.stringify({ format: STORE_FORMAT, workspaces }, null, 2))
  }

  function enqueue(ws, task) {
    const key = normalized(ws)
    const run = (queues.get(key) || Promise.resolve()).then(task, task)
    queues.set(key, run.then(() => {}, () => {}))
    return run
  }

  return {
    root,
    // Persist one workspace: the config file, then the index entry that points at
    // it. Both writes are ordered by `enqueue`, so a burst of edits from one
    // workspace lands in the order it happened.
    save(ws, payload) {
      const fileName = fileNameFor(ws)
      return enqueue(ws, async () => {
        const body = {
          format: STORE_FORMAT,
          id: ws.id == null ? null : String(ws.id),
          workspace: { path: String(ws.path == null ? '' : ws.path), title: ws.title == null ? null : String(ws.title) },
          savedAt: Date.now(),
          dirs: payload.dirs,
          members: payload.members
        }
        await atomicWrite(configFile(root, fileName), JSON.stringify(body, null, 2))
        await syncIndex(ws, fileName)
        return configFile(root, fileName)
      })
    },
    read: readConfig,
    pathFor: (ws) => configFile(root, fileNameFor(ws)),
    async info(ws) {
      const found = await readConfig(ws)
      if (!found) {
        return { root, index: indexFile(root), configured: false, path: null, savedAt: null }
      }
      const target = configFile(root, found.file)
      let savedAt = Number.isFinite(found.data.savedAt) ? found.data.savedAt : null
      if (savedAt === null) {
        const stats = await stat(target).catch(() => null)
        savedAt = stats ? stats.mtimeMs : null
      }
      return { root, index: indexFile(root), configured: true, path: target, savedAt }
    }
  }
}

export function apply(ctx) {
    const registry = ctx.workspaceRegistry
    const query = ctx.sessionQuery

    const uid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

    // workspaceId -> { dirs, byId, members, loaded, catalog }
    const state = new Map()

    // ---- last-active signals ------------------------------------------------
    // A row's 最后活跃 is the newest of: the exact last event time (the only source
    // that sees model output), the two realtime Host events below, and the
    // official list updatedAt. The event overlay carries what the list cannot.
    const activity = new Map()
    const touch = (sessionId, at) => {
      try { activity.set(String(sessionId), Number(at) || Date.now()) } catch (e) { /* ignore */ }
    }
    ctx.on('api-session/activity', touch)
    // A finished model turn also counts: capture the running -> idle edge.
    ctx.on('api-session/status', (sessionId, running) => { if (!running) touch(sessionId) })

    // One official Host list read (`sessionController.list`) serves both the
    // activity timestamps and the authoritative `blank` flag the shipped browser
    // filters on, cached for 30s.
    let hostList = { at: 0, rows: [] }
    async function listRows() {
      if (Date.now() - hostList.at > 30000) {
        let rows = []
        try {
          const ctl = ctx.get('sessionController')
          if (ctl && typeof ctl.list === 'function') {
            const value = await ctl.list({}, undefined)
            rows = value && Array.isArray(value.items) ? value.items : (Array.isArray(value) ? value : [])
          }
        } catch (e) { /* keep the realtime overlay as the only signal */ }
        hostList = { at: Date.now(), rows }
      }
      return hostList.rows
    }

    async function activeNow() {
      const map = new Map()
      for (const row of await listRows()) {
        if (row && row.sessionId) map.set(String(row.sessionId), Number(row.updatedAt) || 0)
      }
      for (const [id, t] of activity) {
        const current = map.get(id)
        if (!current || t > current) map.set(id, t)
      }
      return map
    }

    // Exact last-event time per session, queried only for the ids actually shown
    // and cached for 60s. Failures are pinned to 0 so they are not retried hot.
    let eventTimes = { at: 0, map: new Map() }
    async function eventTimeMap(ids) {
      const map = Date.now() - eventTimes.at < 60000 ? eventTimes.map : new Map()
      const missing = ids.filter(id => !map.has(id))
      if (!missing.length) return map
      let i = 0
      await Promise.all(Array.from({ length: Math.min(8, missing.length) }, async () => {
        while (i < missing.length) {
          const id = missing[i++]
          try {
            const records = await query.listEvents(id)
            const last = records && records.length ? records[records.length - 1] : null
            map.set(id, last && typeof last.time === 'number' ? last.time : 0)
          } catch (e) { map.set(id, 0) }
        }
      }))
      eventTimes = { at: Date.now(), map }
      return map
    }

    // ---- durable directory state -------------------------------------------
    // The store is built on first use, so `$DSH_HOME` is read from the live
    // process and a failure here can never stop the plugin from loading.
    let store = null
    function storeOf() {
      if (!store) {
        store = createStore((message, error) => console.error(`[vdirs] ${message}:`, (error && error.message) || error))
      }
      return store
    }

    function wsState(ws) {
      let s = state.get(ws.id)
      if (!s) {
        s = {
          dirs: [], byId: new Map(), members: new Map(), loaded: false, storePath: null,
          catalog: { at: 0, ids: [], created: new Map() }
        }
        state.set(ws.id, s)
      }
      return s
    }

    // One persisted shape in, one working state out. A directory is dropped unless
    // it carries both an id and a name; members are kept only for directories that
    // survived that filter.
    function adopt(s, data) {
      if (!data || !Array.isArray(data.dirs)) return false
      for (const d of data.dirs) {
        if (!d || typeof d.id !== 'string' || typeof d.name !== 'string') continue
        if (s.byId.has(d.id)) continue
        const dir = {
          id: d.id,
          name: d.name,
          parentId: d.parentId ? String(d.parentId) : null,
          createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now()
        }
        s.dirs.push(dir)
        s.byId.set(dir.id, dir)
      }
      const members = data.members && typeof data.members === 'object' ? data.members : {}
      for (const key of Object.keys(members)) {
        if (s.byId.has(key) && Array.isArray(members[key])) {
          s.members.set(key, members[key].filter(id => typeof id === 'string'))
        }
      }
      return true
    }

    // `.dsh-vdirs.json` left in the workspace root by 1.x. Read once, imported into
    // the central store, then left alone: it is the upgrade path and a downgrade
    // fallback, not a second source of truth.
    async function readLegacy(ws) {
      try {
        return JSON.parse(await readFile(path.join(ws.path, LEGACY_FILE), 'utf8'))
      } catch {
        return null
      }
    }

    async function ensure(ws) {
      const s = wsState(ws)
      if (s.loaded) return s
      s.loaded = true
      try {
        const found = await storeOf().read(ws)
        if (found) {
          s.storePath = storeOf().pathFor(ws)
          adopt(s, found.data)
          return s
        }
        // No central file: adopt a 1.x workspace file and import it, so the tree
        // survives the upgrade and later reads come from the central store.
        const legacy = await readLegacy(ws)
        if (legacy && adopt(s, legacy)) await await save(ws, s)
      } catch (e) {
        // A missing store is the normal first-run state, not an error worth
        // interrupting a read for.
        console.error('[vdirs] load failed:', (e && e.message) || e)
      }
      return s
    }

    function payloadOf(s) {
      return {
        dirs: s.dirs.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, createdAt: d.createdAt })),
        members: Object.fromEntries(s.members)
      }
    }

    // Fire-and-forget on purpose: callers are RPC handlers that already answered
    // with the in-memory tree, and a slow disk must not hold a drag-and-drop.
    function save(ws, s) {
      return storeOf().save(ws, payloadOf(s))
        .then(target => { s.storePath = target; return target })
        .catch(e => { console.error('[vdirs] persist failed:', (e && e.message) || e); return null })
    }

    // Move one session into a directory (or back to root when dirId is null),
    // removing it from every directory's member list first.
    function assignSession(s, sessionId, dirId) {
      for (const [key, list] of s.members) {
        const next = list.filter(id => id !== sessionId)
        if (next.length !== list.length) s.members.set(key, next)
      }
      if (!dirId) return
      const list = s.members.get(dirId) || []
      if (!list.includes(sessionId)) { list.push(sessionId); s.members.set(dirId, list) }
    }

    // Sessions hidden from every grouping surface. The archive set is
    // registry-global and keeps its sessionIds slots, so it is filtered here.
    const archivedSet = () => new Set(Array.from((registry && registry.archivedSessionIds) || []))

    // Ids one workspace may show: its own members, minus archived ids and minus
    // blank sessions. `blank` is the Host's own flag — the same value the shipped
    // sidebar hides unfocused New Session rows with, so a provisional row can
    // never reach a listing or a count. Blank rows are the client half's to draw
    // (only the one it is currently creating), and because the old model persisted
    // them, dropping them here also converges a legacy .dsh-vdirs.json on read.
    async function showableIds(ws) {
      const archived = archivedSet()
      const blanks = new Set()
      for (const row of await listRows()) {
        if (row && row.sessionId == null) continue
        // No `sessionController` means no blank flag: a listing that still has to
        // show something may only drop rows it is certain about (archived ones),
        // because eagerly hiding unproven rows would eat real sessions.
        if (row && row.blank) blanks.add(String(row.sessionId))
      }
      const out = new Set()
      for (const id of ws.sessionIds || []) {
        if (archived.has(id) || blanks.has(id)) continue
        out.add(id)
      }
      return out
    }

    // Host list order plus createdAt for this workspace's members, one read and
    // one 30s cache shared by ordering, paging and the "recent" ranking.
    async function catalog(ws, s) {
      if (Date.now() - s.catalog.at < 30000) return s.catalog
      const ids = []
      const created = new Map()
      try {
        const records = await query.listSessions()
        const wanted = new Set(ws.sessionIds || [])
        for (const record of records) {
          const id = record.header.id
          if (!wanted.has(id)) continue
          ids.push(id)
          created.set(id, record.header.createdAt)
        }
      } catch (e) {
        for (const id of ws.sessionIds || []) { ids.push(id); created.set(id, 0) }
      }
      s.catalog = { at: Date.now(), ids, created }
      return s.catalog
    }

    // Display order: the Host list order for known ids, newest-discovered last.
    function orderedIds(catalogued, ids) {
      const ordered = catalogued.ids.filter(id => ids.has(id))
      const seen = new Set(ordered)
      for (const id of ids) if (!seen.has(id)) ordered.push(id)
      return ordered
    }

    function rankOf(ordered) {
      const rank = new Map()
      ordered.forEach((id, i) => rank.set(id, i))
      return rank
    }

    // Prunes members against the sessions this workspace may show. Awaiting the
    // save keeps a response ordered after its own write, so two edits in flight
    // cannot answer out of the order they were applied in.
    async function treeView(ws, s) {
      const ids = await showableIds(ws)
      let changed = false
      const dirs = s.dirs.map(d => {
        const list = s.members.get(d.id) || []
        const kept = list.filter(id => ids.has(id))
        if (kept.length !== list.length) { s.members.set(d.id, kept); changed = true }
        return { id: d.id, name: d.name, parentId: d.parentId, count: kept.length }
      })
      const assigned = new Set()
      for (const list of s.members.values()) for (const id of list) assigned.add(id)
      let rootCount = 0
      for (const id of ids) if (!assigned.has(id)) rootCount++
      if (changed) await await save(ws, s)
      return { dirs, rootCount, total: ids.size }
    }

    async function sessionsPage(ws, s, dirKey, offset, limit) {
      const ids = await showableIds(ws)
      const catalogued = await catalog(ws, s)
      const rank = rankOf(orderedIds(catalogued, ids))
      let selected
      if (dirKey) {
        const list = s.members.get(dirKey) || []
        const kept = list.filter(id => ids.has(id))
        if (kept.length !== list.length) { s.members.set(dirKey, kept); await save(ws, s) }
        selected = kept
      } else {
        const assigned = new Set()
        for (const list of s.members.values()) for (const id of list) assigned.add(id)
        selected = Array.from(ids).filter(id => !assigned.has(id))
      }
      selected.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9))

      const created = catalogued.created
      const active = await activeNow()
      const total = selected.length
      const pageIds = selected.slice(offset, offset + limit)
      const events = pageIds.length ? await eventTimeMap(pageIds) : new Map()
      const titles = {}
      if (pageIds.length) {
        try {
          for (const result of (await query.readTitleSnapshots(pageIds)) || []) {
            if (!result) continue
            const title = result.status === 'fulfilled' && result.value && result.value.title
            titles[result.sessionId] = title ? title.title : result.sessionId
          }
        } catch (e) { /* fall back to the session id per row */ }
      }
      const items = pageIds.map(sessionId => {
        const lastActiveAt = Math.max(events.get(sessionId) || 0, active.get(sessionId) || 0) || null
        return {
          sessionId,
          title: titles[sessionId] || sessionId,
          createdAt: created.get(sessionId) || null,
          lastActiveAt
        }
      })
      return { items, total, hasMore: offset + pageIds.length < total }
    }

    // ---- endpoints ---------------------------------------------------------
    const handlers = new Map()
    const handle = (name, fn) => handlers.set('vdirs-' + name, fn)

    // Resolve the workspace and its loaded state, or the wire error for either.
    async function scopeOf(args) {
      const ws = args && registry.get(String(args.workspaceId))
      if (!ws) return { error: 'workspace-not-found' }
      return { ws, s: await ensure(ws) }
    }

    handle('workspaces', async () => ({
      workspaces: registry.list().map(w => ({ id: w.id, title: w.title, path: w.path }))
    }))

    handle('tree', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      return error ? { error } : await treeView(ws, s)
    })

    // Where this workspace's tree actually lives on disk, and when it was last
    // written. Answers "my directories disappeared" without reading code.
    handle('store-info', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const info = await storeOf().info(ws)
      return { ...info, storePath: s.storePath, dirCount: s.dirs.length }
    })

    // Read-only dump of the durable tree, for a manual backup or a bug report.
    handle('export', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const info = await storeOf().info(ws)
      return {
        exportedAt: Date.now(),
        workspace: { id: ws.id, title: ws.title, path: ws.path },
        path: info.path,
        storePath: s.storePath,
        format: STORE_FORMAT,
        dirs: s.dirs.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, createdAt: d.createdAt })),
        members: Object.fromEntries(s.members)
      }
    })

    handle('sessions', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50))
      return sessionsPage(ws, s, args.dirId ? String(args.dirId) : null, offset, limit)
    })

    handle('create-dir', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const parentId = args.parentId ? String(args.parentId) : null
      if (parentId && !s.byId.has(parentId)) return { error: 'parent-not-found' }
      let name = String(args.name == null ? '' : args.name).trim().slice(0, 80)
      if (!name) name = '未命名目录'
      const dir = { id: uid(), name, parentId, createdAt: Date.now() }
      s.dirs.push(dir)
      s.byId.set(dir.id, dir)
      s.members.set(dir.id, [])
      await save(ws, s)
      return await treeView(ws, s)
    })

    handle('rename-dir', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const dir = s.byId.get(String(args.dirId))
      if (!dir) return { error: 'dir-not-found' }
      const name = String(args.name == null ? '' : args.name).trim().slice(0, 80)
      if (name) { dir.name = name; await save(ws, s) }
      return await treeView(ws, s)
    })

    handle('delete-dir', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const root = s.byId.get(String(args.dirId))
      if (!root) return { error: 'dir-not-found' }
      const parentId = root.parentId
      const doomed = new Set([root.id])
      let grew = true
      while (grew) {
        grew = false
        for (const d of s.dirs) if (doomed.has(d.parentId) && !doomed.has(d.id)) { doomed.add(d.id); grew = true }
      }
      const orphans = []
      for (const dirId of doomed) {
        const list = s.members.get(dirId)
        if (list) { for (const id of list) orphans.push(id); s.members.delete(dirId) }
        s.byId.delete(dirId)
      }
      s.dirs = s.dirs.filter(d => !doomed.has(d.id))
      if (orphans.length && parentId && s.byId.has(parentId)) {
        const list = s.members.get(parentId) || []
        for (const id of orphans) if (!list.includes(id)) list.push(id)
        s.members.set(parentId, list)
      }
      await save(ws, s)
      return await treeView(ws, s)
    })

    handle('move-session', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const target = args.dirId ? String(args.dirId) : null
      if (target && !s.byId.has(target)) return { error: 'dir-not-found' }
      assignSession(s, String(args.sessionId), target)
      await save(ws, s)
      return await treeView(ws, s)
    })

    handle('reorder-dir', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const dir = s.byId.get(String(args.dirId))
      if (!dir) return { error: 'dir-not-found' }
      const targetId = args.targetId ? String(args.targetId) : null
      if (targetId === dir.id) return await treeView(ws, s)
      if (targetId) {
        const target = s.byId.get(targetId)
        if (!target) return { error: 'target-not-found' }
        if ((target.parentId || null) !== (dir.parentId || null)) return { error: 'cross-parent-reorder-unsupported' }
      }
      const index = s.dirs.indexOf(dir)
      if (index >= 0) s.dirs.splice(index, 1)
      if (targetId) {
        const at = s.dirs.findIndex(x => x.id === targetId)
        s.dirs.splice(args.place === 'after' ? at + 1 : at, 0, dir)
      } else {
        s.dirs.push(dir)
      }
      await save(ws, s)
      return await treeView(ws, s)
    })

    // ---- static RPC registration -------------------------------------------
    // The route is hosted through ctx.webServer with connection.admit() reused for
    // the same Host/Origin + signed-cookie admission /api uses. connection.rpc
    // .handle() is not usable here: it binds the route on the connection service's
    // own context, which does not inject webServer.
    //
    // Wire format, matching connection.rpc.call('/vdirs', endpoint, payload):
    //   POST /vdirs/<endpoint>
    //   { type: 'client-request', rpcId, method: endpoint, payload }
    //   -> { type: 'server-response', rpcId, result: { ok, value } | { ok: false, error } }
    const conn = ctx.get('connection')
    const PREFIX = '/vdirs'
    async function vdirsHandler(req, res) {
      if (!conn) {
        res.writeHead(503)
        res.end('vdirs: connection service unavailable')
        return
      }
      let url
      try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      } catch {
        res.writeHead(400)
        res.end('vdirs: bad url')
        return
      }
      const admission = conn.admit(new Request(url, { method: req.method, headers: req.headers }))
      if ('rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length + 1) : void 0
      if (req.method !== 'POST' || endpoint === void 0) {
        res.writeHead(404)
        res.end('vdirs: not found')
        return
      }
      const chunks = []
      try {
        for await (const chunk of req) chunks.push(chunk)
      } catch {
        res.writeHead(400)
        res.end('vdirs: body read failed')
        return
      }
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('vdirs: invalid json')
        return
      }
      if (message.type !== 'client-request' || message.method !== endpoint) {
        res.writeHead(400)
        res.end('vdirs: bad envelope')
        return
      }
      const fn = handlers.get(endpoint)
      let result
      if (!fn) {
        result = { ok: false, error: { code: 'not-found', message: 'unknown vdirs endpoint: ' + endpoint, details: {} } }
      } else {
        try {
          result = { ok: true, value: await fn(message.payload) }
        } catch (e) {
          result = { ok: false, error: { code: 'handler-error', message: (e && e.message) || String(e), details: {} } }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
    }
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        return webCtx.webServer.register({ kind: 'prefix', path: PREFIX, handler: vdirsHandler })
      }, 'dsh-session-dir: /vdirs rpc route')
    })
}
