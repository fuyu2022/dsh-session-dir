// Headless verification of dsh-session-dir's Host half.
//
// Boots src/index.js against fake registry/query/fs services, then drives the
// real /vdirs route handler with wire-format requests and asserts the durable
// tree, its blank/archived pruning and the paging payloads.
// Scratch tooling: not part of the published package.
const files = new Map()
const KEY = 'D:/proj/.dsh-vdirs.json'

const ws = { id: 'w1', title: 'proj', path: 'D:/proj', sessionIds: ['s-old', 's-blank', 's-arch'] }
const registry = {
  list: () => [ws],
  get: (id) => (id === 'w1' ? ws : undefined),
  archivedSessionIds: ['s-arch']
}

const query = {
  async listSessions() {
    return [{ header: { id: 's-old', createdAt: 100 } }, { header: { id: 's-blank', createdAt: 200 } }]
  },
  async listEvents() { return [{ time: 500 }] },
  async readTitleSnapshots(ids) {
    return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: 'T-' + id, updatedAt: 1 } } }))
  }
}

let handler = null
let admission = {}
const ctx = {
  workspaceRegistry: registry,
  sessionQuery: query,
  get(name) {
    if (name === 'fs') {
      return {
        async resolve(path) { return path },
        async readText(target) {
          if (!files.has(target)) throw new Error('ENOENT: ' + target)
          return files.get(target)
        },
        async writeText(target, text) { files.set(target, text) }
      }
    }
    if (name === 'connection') return { admit: () => admission }
    // The official Host list: `blank` is the flag the shipped browser filters on,
    // and the only thing this plugin may use to hide provisional rows.
    if (name === 'sessionController') {
      return {
        list: async () => ({
          items: [
            { sessionId: 's-old', updatedAt: 300, blank: false },
            { sessionId: 's-blank', updatedAt: 200, blank: true }
          ]
        })
      }
    }
    return undefined
  },
  on() { return () => {} },
  inject(names, cb) {
    cb({
      effect(fn) { return fn() },
      webServer: { register(route) { handler = route.handler; return () => { handler = null } } }
    })
    return () => {}
  }
}

let failures = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '   -> ' + JSON.stringify(detail)))
  if (!ok) failures++
}

function request(endpoint, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload })
  const req = {
    method: 'POST',
    url: '/vdirs/' + endpoint,
    headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) }
  }
  const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(text) { this.body = text } }
  return handler(req, res).then(() => {
    try {
      const parsed = JSON.parse(res.body)
      return { code: res.code, result: parsed.result, rpcId: parsed.rpcId }
    } catch (e) {
      return { code: res.code, raw: res.body }
    }
  })
}

const main = async () => {
  const mod = await import('../src/index.js')
  check('host declares its inject set',
    Array.isArray(mod.inject) && mod.inject.join(',') === 'workspaceRegistry,sessionQuery,connection,webServer', mod.inject)
  mod.apply(ctx)
  check('registers the /vdirs prefix route', typeof handler === 'function')

  // ---- envelope + auth ---------------------------------------------------
  admission = { rejection: 401 }
  const denied = await request('vdirs-tree', { workspaceId: 'w1' })
  check('reuses connection.admit() for admission', denied.code === 401 && denied.raw === 'unauthorized', denied)
  admission = {}

  const unknown = await request('vdirs-nope', {})
  check('unknown endpoints report not-found', unknown.result && unknown.result.ok === false && unknown.result.error.code === 'not-found', unknown.result)

  // ---- legacy file convergence -------------------------------------------
  files.set(KEY, JSON.stringify({
    dirs: [{ id: 'd1', name: '设计', parentId: null, createdAt: 1 }],
    members: { d1: ['s-old', 's-blank', 's-arch', 's-gone'] }
  }))
  const tree = await request('vdirs-tree', { workspaceId: 'w1' })
  check('tree returns the directory, pruned to showable sessions',
    tree.result.ok && tree.result.value.total === 1 && tree.result.value.dirs[0].count === 1,
    tree.result.value)
  check('blank/archived/unknown members are reported as a single root count',
    tree.result.value.rootCount === 0, tree.result.value)
  const persisted = JSON.parse(files.get(KEY))
  check('legacy blank and archived members are dropped from the durable file',
    persisted.members.d1.join(',') === 's-old', persisted.members)

  // ---- paging ------------------------------------------------------------
  const page = await request('vdirs-sessions', { workspaceId: 'w1', dirId: 'd1', offset: 0, limit: 50 })
  const item = page.result.value.items[0]
  check('directory page returns the member with title and timestamps',
    page.result.value.total === 1 && item.sessionId === 's-old' && item.title === 'T-s-old' && item.createdAt === 100 && item.lastActiveAt === 500,
    page.result.value)
  check('blank sessions are never listed', page.result.value.items.every(i => i.sessionId !== 's-blank'), page.result.value.items)
  check('the tree payload carries no recent-sessions count', !('recentCount' in tree.result.value), Object.keys(tree.result.value))
  const rootPage = await request('vdirs-sessions', { workspaceId: 'w1', dirId: null, offset: 0, limit: 50 })
  check('an unfocused blank never lands in the root listing',
    rootPage.result.value.total === 0 && rootPage.result.value.items.every(i => i.sessionId !== 's-blank'),
    rootPage.result.value)
  const recentPage = await request('vdirs-sessions', { workspaceId: 'w1', dirId: 'recent', offset: 0, limit: 50 })
  check('the removed recent group degrades to an ordinary empty directory',
    recentPage.result.ok && recentPage.result.value.total === 0, recentPage.result.value)

  // ---- move + commit -----------------------------------------------------
  const moved = await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-old', dirId: 'd1' })
  check('move-session answers with the refreshed tree', moved.result.ok && moved.result.value.dirs[0].count === 1, moved.result.value)
  const back = await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-old', dirId: null })
  check('move-session to null empties the directory',
    back.result.value.dirs[0].count === 0 && back.result.value.rootCount === 1, back.result.value)

  // ---- directory CRUD ----------------------------------------------------
  const created = await request('vdirs-create-dir', { workspaceId: 'w1', parentId: null, name: '子目录' })
  check('create-dir appends a root directory', created.result.value.dirs.length === 2, created.result.value.dirs)
  const renamed = await request('vdirs-rename-dir', { workspaceId: 'w1', dirId: 'd1', name: '设计稿' })
  check('rename-dir renames in place', renamed.result.value.dirs[0].name === '设计稿', renamed.result.value.dirs)
  const reordered = await request('vdirs-reorder-dir', { workspaceId: 'w1', dirId: created.result.value.dirs[1].id, targetId: 'd1', place: 'before' })
  check('reorder-dir moves within siblings', reordered.result.value.dirs[1].id === 'd1', reordered.result.value.dirs)
  const bad = await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-old', dirId: 'nope' })
  check('unknown targets are rejected', bad.result.value.error === 'dir-not-found', bad.result.value)
  const noWs = await request('vdirs-tree', { workspaceId: 'zzz' })
  check('unknown workspaces are rejected', noWs.result.value.error === 'workspace-not-found', noWs.result.value)
  const gone = await request('vdirs-delete-dir', { workspaceId: 'w1', dirId: 'd1' })
  check('delete-dir removes it and reparents members', gone.result.value.dirs.length === 1 && gone.result.value.rootCount === 1, gone.result.value)

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })

