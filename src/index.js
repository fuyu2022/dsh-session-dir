// dsh-session-dir — Host half of the virtual-directory session manager.
//
// Owns one workspace's durable directory tree (`.dsh-vdirs.json`) and serves it
// to the browser half over a dedicated `/vdirs` Connection-RPC route whose
// endpoints are the `vdirs-*` method names.
//
// Blank sessions are deliberately absent from the durable tree and from every
// listing: a blank row is provisional, and only the browser half draws the single
// one it is currently creating. `showableIds()` drops them using the Host's own
// `blank` flag — the same value the shipped sidebar filters on, so an unfocused
// New Session row can never reappear under the root. That also converges a legacy
// file which still names one on the first read.
export const inject = ['workspaceRegistry', 'sessionQuery', 'connection', 'webServer']

export function apply(ctx) {
    const registry = ctx.workspaceRegistry
    const query = ctx.sessionQuery

    const KEY = '/.dsh-vdirs.json'
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
    function wsState(ws) {
      let s = state.get(ws.id)
      if (!s) {
        s = { dirs: [], byId: new Map(), members: new Map(), loaded: false, catalog: { at: 0, ids: [], created: new Map() } }
        state.set(ws.id, s)
      }
      return s
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
        if (row && row.sessionId && row.blank) blanks.add(String(row.sessionId))
      }
      const out = new Set()
      for (const id of ws.sessionIds || []) {
        if (archived.has(id) || blanks.has(id)) continue
        out.add(id)
      }
      return out
    }

    async function ensure(ws) {
      const s = wsState(ws)
      if (s.loaded) return s
      s.loaded = true
      const fsSvc = ctx.get('fs')
      if (!fsSvc) return s
      try {
        const target = await fsSvc.resolve(ws.path + KEY, { cwd: ws.path })
        const data = JSON.parse(await fsSvc.readText(target))
        if (data && Array.isArray(data.dirs)) {
          for (const d of data.dirs) {
            if (!d || typeof d.id !== 'string' || typeof d.name !== 'string') continue
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
        }
      } catch (e) { /* file absent or unreadable: start empty */ }
      return s
    }

    function save(ws, s) {
      const fsSvc = ctx.get('fs')
      if (!fsSvc) return
      const payload = {
        dirs: s.dirs.map(d => ({ id: d.id, name: d.name, parentId: d.parentId, createdAt: d.createdAt })),
        members: Object.fromEntries(s.members)
      }
      fsSvc.resolve(ws.path + KEY, { cwd: ws.path })
        .then(target => fsSvc.writeText(target, JSON.stringify(payload)))
        .catch(e => console.error('[vdirs] persist failed:', e && e.message))
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
      if (changed) save(ws, s)
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
        if (kept.length !== list.length) { s.members.set(dirKey, kept); save(ws, s) }
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
      return error ? { error } : treeView(ws, s)
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
      save(ws, s)
      return treeView(ws, s)
    })

    handle('rename-dir', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const dir = s.byId.get(String(args.dirId))
      if (!dir) return { error: 'dir-not-found' }
      const name = String(args.name == null ? '' : args.name).trim().slice(0, 80)
      if (name) { dir.name = name; save(ws, s) }
      return treeView(ws, s)
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
      save(ws, s)
      return treeView(ws, s)
    })

    handle('move-session', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const target = args.dirId ? String(args.dirId) : null
      if (target && !s.byId.has(target)) return { error: 'dir-not-found' }
      assignSession(s, String(args.sessionId), target)
      save(ws, s)
      return treeView(ws, s)
    })

    handle('reorder-dir', async (args) => {
      const { ws, s, error } = await scopeOf(args)
      if (error) return { error }
      const dir = s.byId.get(String(args.dirId))
      if (!dir) return { error: 'dir-not-found' }
      const targetId = args.targetId ? String(args.targetId) : null
      if (targetId === dir.id) return treeView(ws, s)
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
      save(ws, s)
      return treeView(ws, s)
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
