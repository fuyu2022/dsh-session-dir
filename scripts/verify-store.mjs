// Real-filesystem check of the central store.
//
// verify-host.mjs drives the RPC surface against fakes; this one drives the same
// plugin against the genuine filesystem to prove the property the store exists
// for: a workspace's directory tree survives the plugin being removed, replaced
// and brought back, and an unrelated workspace gets its own file.
// Scratch tooling: not part of the published package.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = await mkdtemp(path.join(tmpdir(), 'dsh-vdirs-store-'))
const HOME = path.join(BASE, 'home')
process.env.DSH_HOME = HOME
const STORE = path.join(HOME, 'dsh-session-dir')

const WS_A = path.join(BASE, 'alpha')
const WS_B = path.join(BASE, 'beta')
await mkdir(WS_A, { recursive: true })
await mkdir(WS_B, { recursive: true })

const legacyA = JSON.stringify({
  dirs: [
    { id: 'd1', name: '设计', parentId: null, createdAt: 1 },
    { id: 'd2', name: '子目录', parentId: 'd1', createdAt: 2 }
  ],
  members: { d1: ['s1'], d2: ['s2'] }
})
await writeFile(path.join(WS_A, '.dsh-vdirs.json'), legacyA, 'utf8')

const alpha = { id: 'wa', title: 'alpha', path: WS_A, sessionIds: ['s1', 's2', 's3'] }
const beta = { id: 'wb', title: 'beta', path: WS_B, sessionIds: ['s9'] }
const registry = {
  list: () => [alpha, beta],
  get: (id) => [alpha, beta].find(w => w.id === id),
  archivedSessionIds: []
}

const query = {
  async listSessions() {
    return ['s1', 's2', 's3', 's9'].map((id, n) => ({ header: { id, createdAt: n } }))
  },
  async listEvents() { return [] },
  async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: {} })) }
}

let handler = null
function boot() {
  handler = null
  const ctx = {
    workspaceRegistry: registry,
    sessionQuery: query,
    get(name) {
      if (name === 'connection') return { admit: () => ({}) }
      return undefined
    },
    on() { return () => {} },
    inject(names, cb) {
      cb({ effect(fn) { return fn() }, webServer: { register(route) { handler = route.handler; return () => {} } } })
      return () => {}
    }
  }
  return import('../src/index.js').then(mod => { mod.apply(ctx); return mod })
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
  return handler(req, res).then(() => JSON.parse(res.body).result)
}

let failures = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '   -> ' + JSON.stringify(detail)))
  if (!ok) failures++
}

const readJson = (target) => readFile(target, 'utf8').then(JSON.parse, () => null)

const main = async () => {
  // ---- first run: the 1.x file is imported into the central store ----------
  await boot()
  const tree = await request('vdirs-tree', { workspaceId: 'wa' })
  check('the 1.x workspace tree is served on first run', tree.ok && tree.value.total === 3 && tree.value.dirs.length === 2, tree.value)

  const infoA = await request('vdirs-store-info', { workspaceId: 'wa' })
  check('the store reports a real file under <DSH_HOME>/dsh-session-dir',
    infoA.value.configured && infoA.value.path.startsWith(path.join(STORE, 'config')), infoA.value)
  const storedA = await readJson(infoA.value.path)
  check('the central file holds both directories with their parent link',
    storedA && storedA.dirs.length === 2 && storedA.dirs[1].parentId === 'd1' && storedA.members.d2.join(',') === 's2',
    storedA)
  check('the import never rewrites the workspace file',
    await readFile(path.join(WS_A, '.dsh-vdirs.json'), 'utf8') === legacyA)

  // ---- a second workspace gets its own file -------------------------------
  await request('vdirs-create-dir', { workspaceId: 'wb', parentId: null, name: 'beta 目录' })
  const infoB = await request('vdirs-store-info', { workspaceId: 'wb' })
  check('a second workspace stores to a different file',
    infoB.value.configured && infoB.value.path !== infoA.value.path
      && path.basename(infoB.value.path).startsWith('beta-'), infoB.value.path)
  const files = await readdir(path.join(STORE, 'config'))
  check('the store holds exactly one file per workspace', files.length === 2, files)

  const index = await readJson(path.join(STORE, 'index.json'))
  check('the index registers both workspaces',
    Object.keys(index.workspaces).length === 2
      && index.workspaces[WS_A.replace(/\\/g, '/').toLowerCase()].file === path.basename(infoA.value.path), index.workspaces)

  // ---- the point of the whole exercise: uninstall, reinstall, reopen -------
  // Nothing in the workspace changed and the store was never touched, exactly as
  // after `dsh plugin remove` + `add`: a fresh boot reads both back by itself.
  await boot()
  const reopened = await request('vdirs-tree', { workspaceId: 'wa' })
  check('a fresh boot restores the tree from the central store',
    reopened.ok && reopened.value.dirs.length === 2 && reopened.value.dirs[0].name === '设计', reopened.value)
  const reopenedB = await request('vdirs-tree', { workspaceId: 'wb' })
  check('the unrelated workspace is restored from its own file',
    reopenedB.ok && reopenedB.value.dirs.length === 1 && reopenedB.value.dirs[0].name === 'beta 目录', reopenedB.value)

  // ---- a corrupt central file must not be silently replaced ---------------
  const corrupt = path.join(STORE, 'config', path.basename(infoB.value.path))
  await writeFile(corrupt, '{ not json', 'utf8')
  await boot()
  const afterCorrupt = await request('vdirs-tree', { workspaceId: 'wb' })
  check('a corrupt file degrades to an empty tree instead of throwing',
    afterCorrupt.ok && afterCorrupt.value.dirs.length === 0, afterCorrupt.value)
  check('the corrupt file is left on disk for inspection',
    await readFile(corrupt, 'utf8') === '{ not json')

  await rm(BASE, { recursive: true, force: true }).catch(() => {})
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
