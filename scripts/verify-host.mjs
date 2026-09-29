// Headless verification of dsh-session-dir's Host half.
//
// Boots src/index.js against fake registry/query services, then drives the real
// /vdirs route handler with wire-format requests and asserts the durable tree,
// its blank/archived pruning, the paging payloads, and where the tree is stored:
// one central file per workspace under <DSH_HOME>/dsh-session-dir, with a flat
// index beside it, and a 1.x `.dsh-vdirs.json` still usable as the import path.
// Scratch tooling: not part of the published package.
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The store resolves $DSH_HOME lazily per instance, but pin it before the first
// request anyway so every assertion knows the exact root. The harness home and
// the workspace are siblings on purpose: nesting the store inside the workspace
// would make the "workspace root is untouched" assertion vacuous.
const BASE = await mkdtemp(path.join(tmpdir(), 'dsh-vdirs-'))
const HOME = path.join(BASE, 'home')
process.env.DSH_HOME = HOME
const STORE = path.join(HOME, 'dsh-session-dir')
await mkdir(HOME, { recursive: true })

const WS_PATH = path.join(BASE, 'proj')
const LEGACY = path.join(WS_PATH, '.dsh-vdirs.json')
const legacyText = JSON.stringify({
  dirs: [{ id: 'd1', name: '设计', parentId: null, createdAt: 1 }],
  members: { d1: ['s-old', 's-blank', 's-arch', 's-gone'] }
})
await mkdir(WS_PATH, { recursive: true })
await writeFile(LEGACY, legacyText, 'utf8')

const ws = { id: 'w1', title: 'proj', path: WS_PATH, sessionIds: ['s-old', 's-blank', 's-arch', 's-fresh'] }
const registry = {
  list: () => [ws],
  get: (id) => (id === 'w1' ? ws : undefined),
  archivedSessionIds: ['s-arch']
}

const query = {
  async listSessions() {
    return [
      { header: { id: 's-old', createdAt: 100 } },
      { header: { id: 's-blank', createdAt: 200 } },
      { header: { id: 's-fresh', createdAt: 300 } }
    ]
  },
  async listEvents(id) {
    if (id === 's-old') return [{ time: 100 }, { time: 500, text: '帮我把原型图改一改' }]
    return [{ time: 100 }]
  },
  async readTitleSnapshots(ids) {
    return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'T-' + sessionId, updatedAt: 1 } } }))
  }
}

let handler = null
let admission = {}
// A live Host would serve `fs`, and 1.x persisted through it. Counting its writes
// proves the central store replaced that path instead of sitting beside it.
const fsWrites = []
const services = {
  connection: { admit: () => admission },
  fs: {
    async resolve(p) { return p },
    async readText() { throw new Error('ENOENT') },
    async writeText(target, text) { fsWrites.push(target) }
  },
  // The official Host list: `blank` is the flag the shipped browser filters on,
  // and the only thing this plugin may use to hide provisional rows.
  sessionController: {
    async list() {
      return {
        items: [
          { sessionId: 's-old', updatedAt: 300, blank: false },
          { sessionId: 's-blank', updatedAt: 200, blank: true }
        ]
      }
    }
  }
}
const ctx = {
  workspaceRegistry: registry,
  sessionQuery: query,
  get(name) { return services[name] },
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

async function readJson(target, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      return JSON.parse(await readFile(target, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      await new Promise(r => setTimeout(r, 25))
    }
  }
  return null
}

const exists = (target) => stat(target).then(() => true, () => false)

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

  // ---- 1.x workspace file: read, import, never rewritten ------------------
  const tree = await request('vdirs-tree', { workspaceId: 'w1' })
  check('tree returns the directory, pruned to showable sessions',
    tree.result.ok && tree.result.value.total === 2 && tree.result.value.dirs[0].count === 1,
    tree.result.value)
  check('blank/archived/unknown members are reported as a single root count',
    tree.result.value.rootCount === 1, tree.result.value)
  check('the legacy workspace file is left exactly as it was',
    await readFile(LEGACY, 'utf8') === legacyText)

  const info = await request('vdirs-store-info', { workspaceId: 'w1' })
  const stored = info.result.value
  check('the tree is reported as living in the central store',
    stored && stored.configured === true && typeof stored.path === 'string' && stored.path.startsWith(path.join(STORE, 'config')),
    stored)
  check('the central store is pinned to <DSH_HOME>/dsh-session-dir',
    stored.root === STORE && stored.index === path.join(STORE, 'index.json'), stored)
  check('the imported tree answers with a write timestamp', Number.isFinite(stored.savedAt), stored)

  const persisted = await readJson(stored.path)
  check('legacy blank and archived members are dropped from the durable file',
    persisted && persisted.members.d1.join(',') === 's-old', persisted && persisted.members)
  check('the durable file records the workspace it belongs to',
    persisted && persisted.format === 1 && persisted.workspace.path === WS_PATH && persisted.workspace.title === 'proj', persisted && persisted.workspace)
  check('the file name carries a readable workspace stem',
    path.basename(stored.path).startsWith('proj-') && stored.path.endsWith('.json'), path.basename(stored.path))

  // The index is keyed by normalized path: separators unified, case folded on
  // Windows — the same identity rule the store uses.
  const normalizedPath = WS_PATH.replace(/\\/g, '/').toLowerCase()
  const index = await readJson(path.join(STORE, 'index.json'))
  const entry = index && index.workspaces && index.workspaces[normalizedPath]
  check('index.json maps the normalized workspace path to its file',
    entry && entry.file === path.basename(stored.path) && entry.path === WS_PATH,
    { entry, keys: index && index.workspaces && Object.keys(index.workspaces) })
  const configDir = await readdir(path.join(STORE, 'config'))
  check('no temporary write files are left behind',
    configDir.every(n => !n.endsWith('.tmp')), configDir)

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
    rootPage.result.value.total === 1 && rootPage.result.value.items.every(i => i.sessionId !== 's-blank'),
    rootPage.result.value)
  const recentPage = await request('vdirs-sessions', { workspaceId: 'w1', dirId: 'recent', offset: 0, limit: 50 })
  check('the removed recent group degrades to an ordinary empty directory',
    recentPage.result.ok && recentPage.result.value.total === 0, recentPage.result.value)

  // ---- session search ----------------------------------------------------
  const titleHit = await request('vdirs-search', { workspaceId: 'w1', q: 'old', mode: 'title' })
  check('title search finds the member with its directory and title',
    titleHit.result.ok && titleHit.result.value.items.length === 1
      && titleHit.result.value.items[0].sessionId === 's-old'
      && titleHit.result.value.items[0].title === 'T-s-old'
      && titleHit.result.value.items[0].dirId === 'd1'
      && titleHit.result.value.items[0].dirName === '设计'
      && titleHit.result.value.items[0].workspaceId === 'w1',
    titleHit.result.value)
  const bodyHit = await request('vdirs-search', { workspaceId: 'w1', q: '原型图', mode: 'full' })
  check('full search finds the session by event body text',
    bodyHit.result.ok && bodyHit.result.value.items.length === 1
      && bodyHit.result.value.items[0].sessionId === 's-old',
    bodyHit.result.value)
  const blankHit = await request('vdirs-search', { workspaceId: 'w1', q: 's-blank', mode: 'full' })
  check('blank sessions stay out of search results',
    blankHit.result.ok && blankHit.result.value.items.length === 0, blankHit.result.value)
  const noHit = await request('vdirs-search', { workspaceId: 'w1', q: '不存在xyz', mode: 'title' })
  check('a no-match search answers with an empty result',
    noHit.result.ok && noHit.result.value.items.length === 0 && noHit.result.value.total === 0, noHit.result.value)

  // ---- a missing optional service degrades, it does not hide sessions ------
  // Dropping `sessionController` mid-run does not change the cached list, and the
  // plugin may not prove a row is blank without it. What must hold either way is
  // that the request still answers with the sessions it can prove.
  const controller = services.sessionController
  services.sessionController = undefined
  const degraded = await request('vdirs-sessions', { workspaceId: 'w1', dirId: 'd1', offset: 0, limit: 50 })
  check('without sessionController the listing degrades but still answers',
    degraded.result.ok && degraded.result.value.items.some(i => i.sessionId === 's-old'), degraded.result.value)
  services.sessionController = controller

  // ---- move + commit -----------------------------------------------------
  const moved = await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-old', dirId: 'd1' })
  check('move-session answers with the refreshed tree', moved.result.ok && moved.result.value.dirs[0].count === 1, moved.result.value)
  const back = await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-old', dirId: null })
  check('move-session to null empties the directory',
    back.result.value.dirs[0].count === 0 && back.result.value.rootCount === 2, back.result.value)

  // ---- session ordering --------------------------------------------------
  // Put two showable sessions into d1 so we can assert both directory and root
  // ordering. Members and rootOrder are persisted order lists; reorder-session
  // rewrites them inside one container.
  await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-old', dirId: 'd1' })
  await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-fresh', dirId: 'd1' })
  const order1 = await request('vdirs-sessions', { workspaceId: 'w1', dirId: 'd1', offset: 0, limit: 50 })
  check('directory pages follow the persisted member order',
    order1.result.value.items.map(i => i.sessionId).join(',') === 's-old,s-fresh', order1.result.value.items)
  const sessReordered = await request('vdirs-reorder-session', { workspaceId: 'w1', sessionId: 's-fresh', dirId: 'd1', targetId: 's-old', place: 'before' })
  check('reorder-session moves a session before its sibling',
    sessReordered.result.ok && sessReordered.result.value.dirs[0].count === 2, sessReordered.result.value)
  const order2 = await request('vdirs-sessions', { workspaceId: 'w1', dirId: 'd1', offset: 0, limit: 50 })
  check('the new order is served immediately',
    order2.result.value.items.map(i => i.sessionId).join(',') === 's-fresh,s-old', order2.result.value.items)
  const orderFile = await readJson(stored.path, 80)
  check('the directory order persists to the central file',
    orderFile && orderFile.members.d1.join(',') === 's-fresh,s-old', orderFile && orderFile.members)
  const badReorder = await request('vdirs-reorder-session', { workspaceId: 'w1', sessionId: 's-fresh', dirId: 'd1', targetId: 's-not-here', place: 'before' })
  check('reorder-session rejects unknown targets',
    badReorder.result.value.error === 'target-not-in-container', badReorder.result.value)
  // Root ordering uses the same endpoint with dirId omitted.
  await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-old', dirId: null })
  await request('vdirs-move-session', { workspaceId: 'w1', sessionId: 's-fresh', dirId: null })
  const rootReorder = await request('vdirs-reorder-session', { workspaceId: 'w1', sessionId: 's-old', targetId: 's-fresh', place: 'after' })
  check('root sessions reorder through the same endpoint',
    rootReorder.result.ok && rootReorder.result.value.rootCount === 2, rootReorder.result.value)
  const rootOrdered = await request('vdirs-sessions', { workspaceId: 'w1', dirId: null, offset: 0, limit: 50 })
  check('the root page follows the persisted root order',
    rootOrdered.result.value.items.map(i => i.sessionId).join(',') === 's-fresh,s-old', rootOrdered.result.value.items)
  const rootOrderFile = await readJson(stored.path)
  check('the root order persists as a rootOrder list',
    rootOrderFile && Array.isArray(rootOrderFile.rootOrder) && rootOrderFile.rootOrder.join(',') === 's-fresh,s-old', { rootOrder: rootOrderFile && rootOrderFile.rootOrder })
  const crossReorder = await request('vdirs-reorder-session', { workspaceId: 'w1', sessionId: 's-old', dirId: 'd1', targetId: 's-fresh', place: 'after' })
  check('cross-container reorder is rejected once the session left that container',
    crossReorder.result.value.error === 'session-not-in-container', crossReorder.result.value)

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

  // ---- writes land in the central store ----------------------------------
  const afterCrud = await readJson(stored.path, 80)
  check('every mutation rewrites the central file',
    afterCrud && afterCrud.dirs.length === 2 && afterCrud.dirs.some(d => d.name === '设计稿'), afterCrud && afterCrud.dirs)

  const dump = await request('vdirs-export', { workspaceId: 'w1' })
  check('export dumps the durable tree without touching the store',
    dump.result.ok && dump.result.value.dirs.length === 2 && dump.result.value.workspace.path === WS_PATH, dump.result.value)

  const gone = await request('vdirs-delete-dir', { workspaceId: 'w1', dirId: 'd1' })
  check('delete-dir removes it and reparents members', gone.result.value.dirs.length === 1 && gone.result.value.rootCount === 2, gone.result.value)

  // ---- reload: the store, not the workspace file, is the source of truth ---
  handler = null
  ctx.workspaceRegistry.archivedSessionIds = []
  mod.apply(ctx)
  const reloaded = await request('vdirs-tree', { workspaceId: 'w1' })
  check('a reload reads the central store instead of re-importing the 1.x file',
    reloaded.result.ok && reloaded.result.value.dirs.length === 1 && reloaded.result.value.dirs[0].name === '子目录',
    reloaded.result.value)
  const noWorkspaceFile = LEGACY
  check('the workspace root is never written back',
    await readFile(noWorkspaceFile, 'utf8') === legacyText && await exists(path.join(WS_PATH, '.dsh-vdirs.json.tmp')) === false)
  check('persistence never goes through the workspace file service', fsWrites.length === 0, fsWrites)

  await rm(HOME, { recursive: true, force: true }).catch(() => {})
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
