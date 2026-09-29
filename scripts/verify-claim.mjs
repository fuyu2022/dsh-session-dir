// Headless verification of dsh-session-dir's client half.
//
// Loads src/client.js under a fake window.__ModuleLoader__, a minimal React hook
// runtime and fake Host/Client services, then drives the "new session in a
// virtual directory" flow the way a user would and asserts the observable result.
// Scratch tooling: not part of the published package.
let captured = null
globalThis.window = { __ModuleLoader__: { load(def) { captured = def } } }

// ---------------- fake timer service ----------------
const timers = []
let timerSeq = 0
const timerService = {
  timeout(cb, delay) {
    const id = ++timerSeq
    timers.push({ id, at: now + (delay || 0), cb })
    return () => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) }
  },
  interval() { return () => {} }
}
let now = 0
function advance(ms) {
  const target = now + ms
  for (;;) {
    const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    timers.splice(timers.indexOf(due), 1)
    now = due.at
    due.cb()
  }
  now = target
}

// ---------------- minimal React ----------------
function makeHookRuntime(onChange) {
  const hooks = []
  let cursor = 0
  return {
    begin() { cursor = 0 },
    useState(init) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
      const set = (v) => {
        const next = typeof v === 'function' ? v(hooks[i]) : v
        if (next === hooks[i]) return
        hooks[i] = next
        onChange()
      }
      return [hooks[i], set]
    },
    useRef(init) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = { current: init }
      return hooks[i]
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = hooks[i]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
      if (!changed) return
      if (prev && prev.cleanup) prev.cleanup()
      const cleanup = fn()
      hooks[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    },
    useSyncExternalStore(sub, get) {
      const i = cursor++
      if (!hooks[i]) hooks[i] = { unsub: sub(() => onChange()) }
      return get()
    }
  }
}

const React = {
  createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: Object.assign({}, props || {}, kids === undefined ? {} : { children: kids }) }
  },
  useState: (...a) => runtime.useState(...a),
  useRef: (...a) => runtime.useRef(...a),
  useEffect: (...a) => runtime.useEffect(...a),
  useSyncExternalStore: (...a) => runtime.useSyncExternalStore(...a)
}

// ---------------- fake sessions store ----------------
const listStore = {
  state: { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} },
  listeners: new Set(),
  getSnapshot() { return this.state },
  subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } },
  publish(rows) {
    const byId = {}
    const ids = []
    for (const r of rows) {
      ids.push(r.id)
      byId[r.id] = {
        id: r.id,
        displayTitle: r.title || r.id,
        cwd: r.cwd,
        running: !!r.running,
        blank: !!r.blank,
        retainedBy: { mainView: r.main ? 1 : 0 },
        updatedAt: 0
      }
    }
    this.state = { ids, byId, phase: 'ready', projectionsBySession: {} }
    for (const fn of [...this.listeners]) fn()
  }
}

// ---------------- harness state ----------------
let runtime = null
let tree = null
let registered = null
let rerenderPending = false
const rpcCalls = []
const startSessionCalls = []
const openSessionCalls = []
// Mirrors the Host: the committed session becomes a member of d1.
let treeState = { dirs: [{ id: 'd1', name: '设计', parentId: null, count: 2 }], rootCount: 0, total: 2 }
// The Host page for one directory key, so the root listing can be made to still
// serve a blank row (the reported regression). Two real sessions live in d1 so
// the drag-reorder flow has siblings to reorder between.
let pages = {
  d1: {
    items: [
      { sessionId: 's-a', title: '会话甲', createdAt: 1, lastActiveAt: 1 },
      { sessionId: 's-b', title: '会话乙', createdAt: 2, lastActiveAt: 2 }
    ],
    total: 2, hasMore: false
  }
}
const pageFor = (dirId) => pages[dirId || 'root'] || { items: [], total: 0, hasMore: false }

function boot() {
  const ctx = {
    slots: {
      inject(key, cb) { cb(); return () => {} },
      register(options, render) { registered = { options, render }; return () => {} }
    },
    get(name) {
      if (name === 'sessions') return { list: listStore, using: async () => ({ ok: true, value: {} }) }
      if (name === 'uiWorkspace') {
        return {
          startSession(wsId) { startSessionCalls.push(wsId) },
          openSession(sessionId) { openSessionCalls.push(sessionId) },
          archiveSession: async () => {},
          pickDirectory: async () => null
        }
      }
      if (name === 'workspaces') return { create: async () => ({}), rename: async () => ({}), delete: async () => {} }
      if (name === 'timer') return timerService
      if (name === 'connection') {
        return {
          rpc: {
            call(channel, method, payload) {
              rpcCalls.push({ method, payload })
              if (method === 'vdirs-workspaces') {
                return Promise.resolve({ ok: true, value: { workspaces: [{ id: 'w1', title: 'proj', path: 'D:/proj' }] } })
              }
              if (method === 'vdirs-tree') {
                return Promise.resolve({ ok: true, value: treeState })
              }
              if (method === 'vdirs-sessions') {
                const page = pageFor(payload.dirId)
                return Promise.resolve({ ok: true, value: page })
              }
              if (method === 'vdirs-move-session') {
                treeState = { dirs: [{ id: 'd1', name: '设计', parentId: null, count: 1 }], rootCount: 0, total: 1 }
                return Promise.resolve({ ok: true, value: treeState })
              }
              if (method === 'vdirs-reorder-session') {
                treeState = { dirs: [{ id: 'd1', name: '设计', parentId: null, count: 2 }], rootCount: 0, total: 2 }
                return Promise.resolve({ ok: true, value: treeState })
              }
              if (method === 'vdirs-search') {
                const needle = String(payload.q || '').toLowerCase()
                const mode = payload.mode === 'full' ? 'full' : 'title'
                // The second row is discoverable only by body text in full mode.
                const rows = [
                  { workspaceId: 'w1', workspaceTitle: 'proj', sessionId: 's-other', title: '既有会话 proj', dirId: 'd1', dirName: '设计', createdAt: 1, lastActiveAt: 3 },
                  { workspaceId: 'w1', workspaceTitle: 'proj', sessionId: 's-old', title: '旧会话', dirId: null, dirName: null, createdAt: 2, lastActiveAt: 5 }
                ]
                const items = rows.filter(it => it.title.toLowerCase().includes(needle) || (mode === 'full' && it.sessionId === 's-old'))
                return Promise.resolve({ ok: true, value: { query: payload.q, mode, items, total: items.length } })
              }
              return Promise.resolve({ ok: true, value: {} })
            }
          }
        }
      }
      return undefined
    },
    on() { return () => {} }
  }
  const plugin = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  plugin.apply(ctx)
}

// ---------------- tiny renderer ----------------
function renderToTree(node) {
  if (Array.isArray(node)) return node.map(renderToTree)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    runtime.begin()
    return renderToTree(node.type(node.props))
  }
  const props = Object.assign({}, node.props)
  if ('children' in props) props.children = renderToTree(props.children)
  return { type: node.type, props }
}

function paint() {
  tree = renderToTree(registered.render({ wide: true, expandSidebar: () => {} }))
}

function rerender() {
  if (rerenderPending) return
  rerenderPending = true
  queueMicrotask(() => { rerenderPending = false; paint() })
}

function walk(node, visit) {
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (!node || typeof node !== 'object') return
  visit(node)
  if (node.props) walk(node.props.children, visit)
}

function walkPath(node, visit, chain) {
  chain = chain || []
  if (Array.isArray(node)) { for (const n of node) walkPath(n, visit, chain); return }
  if (!node || typeof node !== 'object') return
  visit(node, chain)
  if (node.props) walkPath(node.props.children, visit, chain.concat([node]))
}

function collect(pred) {
  const out = []
  walk(tree, (n) => { if (typeof n.type === 'string' && pred(n)) out.push(n) })
  return out
}

function textOf(node) {
  let out = ''
  walk(node, (n) => { if (typeof n.props.children === 'string') out += n.props.children })
  return out
}

const hasClass = (n, cls) => String(n.props.className || '').split(' ').includes(cls)
const buttons = (title, cls) => collect(n => n.type === 'button' && n.props.title === title && (!cls || hasClass(n, cls)))
const actions = (title, cls) => collect(n => n.props.title === title && (!cls || hasClass(n, cls)))
const blankRows = () => {
  const out = []
  walkPath(tree, (n, chain) => { if (typeof n.type === 'string' && hasClass(n, 'vds-blank')) out.push({ node: n, chain }) })
  return out
}
const inside = (chain, cls) => chain.some(a => String(a.props.className || '').includes(cls))
const blankRow = () => blankRows()[0]
const sessionTitles = () => collect(n => hasClass(n, 'vds-sess-title')).map(n => textOf(n))
const moveCalls = () => rpcCalls.filter(c => c.method === 'vdirs-move-session')

// ---------------- assertions ----------------
let failures = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : '   -> ' + JSON.stringify(detail)))
  if (!ok) failures++
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

const main = async () => {
  await import('../src/client.js')
  runtime = makeHookRuntime(rerender)
  boot()
  paint()
  await flush(); paint()

  check('sidebar region registers on sidebar.workspaces at a shadowing priority',
    registered && registered.options.name === 'sidebar.workspaces' && registered.options.priority === -1e2,
    registered && registered.options)

  // ---- 1. create a session in virtual directory d1 ------------------------
  const plus = buttons('新建会话', 'vds-act')
  check('directory row exposes a new-session button', plus.length === 1, plus.length)
  plus[0].props.onClick({ stopPropagation() {} })
  check('delegates creation to the official uiWorkspace.startSession', startSessionCalls.length === 1 && startSessionCalls[0] === 'w1', startSessionCalls)
  check('no provisional row before a blank session is current', !blankRow())

  listStore.publish([{ id: 's-new', blank: true, main: true, cwd: 'D:\\proj', title: '新会话' }])
  await flush(); paint()
  const row = blankRow()
  check('current blank renders inside the target directory', !!row && inside(row.chain, 'vds-tree-wrap'), row && row.chain.map(a => a.props.className))
  check('provisional row is labelled and non-draggable', !!row && textOf(row.node).includes('新会话') && !row.node.props.draggable, row && textOf(row.node))

  // ---- 2. it loses focus while still blank: removed and hidden ------------
  // The Host is made to keep serving that row in its root page and to count it
  // under 根目录 — the reported regression, where an unfocused blank reappeared
  // at the root. The client half owns this rule, so it must stay invisible.
  treeState = { dirs: [{ id: 'd1', name: '设计', parentId: null, count: 0 }], rootCount: 1, total: 1 }
  pages.root = { items: [{ sessionId: 's-new', title: '新会话', createdAt: 1, lastActiveAt: 1 }], total: 1, hasMore: false }
  listStore.publish([
    { id: 's-new', blank: true, main: false, cwd: 'D:\\proj' },
    { id: 's-other', blank: false, main: true, cwd: 'D:\\proj', title: '既有会话' }
  ])
  await flush(); paint()
  check('row is not dropped on the very first blurred snapshot', !!blankRow())
  advance(200); await flush(); await flush(); await flush(); paint()
  check('blurred blank is removed from the directory and hidden', !blankRow())
  check('blurred blank does not reappear in the root listing even when the Host serves it',
    !sessionTitles().includes('新会话'), sessionTitles())
  check('a blurred blank is never persisted to the directory', moveCalls().length === 0, moveCalls())

  // ---- 3. clicking again reuses that same blank session ------------------
  startSessionCalls.length = 0
  buttons('新建会话', 'vds-act')[0].props.onClick({ stopPropagation() {} })
  check('re-click reuses the official flow instead of minting a session', startSessionCalls.length === 1, startSessionCalls)
  // startSession navigates back to the same, still-blank session
  listStore.publish([{ id: 's-new', blank: true, main: true, cwd: 'D:\\proj' }])
  await flush(); paint()
  check('the same single blank row reappears in the directory', !!blankRow() && textOf(blankRow().node).includes('新会话'))
  check('still exactly one blank row in the whole tree', blankRows().length === 1, blankRows().length)

  // ---- 4. first prompt commits it to that directory ----------------------
  moveCalls().length = 0
  listStore.publish([{ id: 's-new', blank: false, main: true, cwd: 'D:\\proj', title: '写个方案' }])
  await flush(); paint()
  check('used blank stops being provisional', !blankRow())
  check('used blank is committed to the directory it was created in',
    moveCalls().length === 1 && moveCalls()[0].payload.sessionId === 's-new' && moveCalls()[0].payload.dirId === 'd1',
    moveCalls())

  // ---- 5. the workspace-header button claims the root, not a directory ---
  moveCalls().length = 0
  actions('新建会话', 'vds-mini')[0].props.onClick({ stopPropagation() {} })
  check('header button also drives the official flow', startSessionCalls.length === 2, startSessionCalls)
  listStore.publish([{ id: 's-new2', blank: true, main: true, cwd: 'D:\\proj' }])
  await flush(); paint()
  const rootRow = blankRow()
  check('root-claimed blank renders in the root zone, not in a directory',
    !!rootRow && inside(rootRow.chain, 'vds-rootzone') && !inside(rootRow.chain, 'vds-tree-wrap'),
    rootRow && rootRow.chain.map(a => a.props.className))

  // ---- 6. a blank of another workspace is never claimed ------------------
  actions('新建会话', 'vds-mini')[0].props.onClick({ stopPropagation() {} })
  listStore.publish([{ id: 's-foreign', blank: true, main: true, cwd: 'D:\\elsewhere' }])
  await flush(); paint()
  advance(400); await flush(); paint()
  check('a blank targeting another workspace is left alone', !blankRow())

  // ---- 7. the workspace row wears the shipped glyphs ---------------------
  const folder = collect(n => hasClass(n, 'vds-folder'))
  check('workspace header renders the shipped folder glyph',
    folder.length === 1 && folder[0].props.children && folder[0].props.children.type === 'svg'
      && folder[0].props.children.props.viewBox === '0 0 16 16',
    folder.length)
  const chevrons = collect(n => hasClass(n, 'vds-chev'))
  check('every disclosure uses the shipped triangle glyph instead of a text arrow',
    chevrons.length >= 2 && chevrons.every(c => c.props.children && c.props.children.type === 'svg'),
    chevrons.map(c => typeof c.props.children === 'string' ? c.props.children : c.props.children && c.props.children.type))

  // ---- 8. virtual directories wear their own minimal line mark -----------
  const glyphs = collect(n => hasClass(n, 'vds-dir-glyph'))
  const glyph = glyphs[0] && glyphs[0].props.children
  check('virtual directory renders a line glyph with no fill or background',
    glyphs.length === 1 && glyph && glyph.type === 'svg' && glyph.props.viewBox === '0 0 16 16'
      && glyph.props.fill === 'none',
    glyphs.length)
  check('the virtual directory mark is a dashed contour, not the shipped solid folder',
    !!glyph && glyph.props.children.props.strokeDasharray !== undefined && glyph.props.children.props.stroke === 'currentColor',
    glyph && glyph.props.children.props)
  check('the directory name no longer carries the folder emoji',
    collect(n => hasClass(n, 'vds-dir-name')).every(n => !textOf(n).includes('📁')),
    collect(n => hasClass(n, 'vds-dir-name')).map(textOf))

  // ---- 9. session search: ghost icon, modal, debounce, mode switch --------
  const searchButtons = () => actions('搜索会话', 'vds-btn-ghost')
  const searchCalls = () => rpcCalls.filter(c => c.method === 'vdirs-search')
  const hits = () => collect(n => hasClass(n, 'vds-search-hit-title')).map(n => textOf(n))
  const iconTree = renderToTree(searchButtons()[0].props.children)
  check('the ＋工作区 row wears a transparent line-only search glyph at its end',
    searchButtons().length === 1 && iconTree && iconTree.type === 'svg'
      && iconTree.props.viewBox === '0 0 24 24'
      && iconTree.props.fill === 'none'
      && iconTree.props.stroke === 'currentColor',
    searchButtons().length)
  searchButtons()[0].props.onClick()
  await flush(); paint()
  check('the icon opens a centered modal with one input and two mode pills',
    collect(n => hasClass(n, 'vds-search-overlay')).length === 1
      && collect(n => hasClass(n, 'vds-search-modal')).length === 1
      && collect(n => hasClass(n, 'vds-search-input')).length === 1
      && collect(n => hasClass(n, 'vds-mode')).length === 2,
    collect(n => hasClass(n, 'vds-search-input')).length)

  const input = collect(n => hasClass(n, 'vds-search-input'))[0]
  input.props.onChange({ target: { value: 'proj' } })
  advance(300); await flush(); paint()
  check('typing searches titles after a debounce',
    hits().length === 1 && hits()[0] === '既有会话 proj' && searchCalls().length === 1
      && searchCalls()[0].payload.q === 'proj' && searchCalls()[0].payload.mode === 'title',
    { hits: hits(), calls: searchCalls().map(c => c.payload) })
  const meta = collect(n => hasClass(n, 'vds-search-meta')).map(n => textOf(n))
  check('each hit carries its workspace and directory breadcrumb',
    meta.length === 1 && meta[0].includes('proj') && meta[0].includes('设计'), meta)
  collect(n => n.type === 'button' && textOf(n) === '全量搜索')[0].props.onClick()
  await flush(); paint()
  check('switching mode re-runs the current keyword in full mode',
    searchCalls().length === 2 && searchCalls()[1].payload.q === 'proj' && searchCalls()[1].payload.mode === 'full',
    searchCalls().map(c => c.payload))
  // The modal re-rendered under the new mode; re-grab the input so the debounce
  // closure sees the fresh searchMode (a live DOM event always comes from the
  // current render, so a fresh capture mirrors real usage).
  const input2 = collect(n => hasClass(n, 'vds-search-input'))[0]
  input2.props.onChange({ target: { value: 'body' } })
  advance(300); await flush(); paint()
  check('full search surfaces sessions found only inside their conversation body',
    hits().length === 1 && hits()[0] === '旧会话', hits())
  const oldMeta = collect(n => hasClass(n, 'vds-search-meta')).find(n => textOf(n).includes('根目录'))
  check('a root-level hit breadcrumb names the root',
    !!oldMeta && textOf(oldMeta).includes('根目录'), oldMeta && textOf(oldMeta))
  collect(n => hasClass(n, 'vds-search-result')).find(n => textOf(n).includes('旧会话')).props.onClick()
  await flush(); paint()
  check('clicking a hit opens that session and dismisses the modal',
    openSessionCalls.length === 1 && openSessionCalls[0] === 's-old'
      && collect(n => hasClass(n, 'vds-search-overlay')).length === 0,
    openSessionCalls)

  // ---- 10. session drag reorder: same-container before/after ---------------
  const rows = () => collect(n => hasClass(n, 'vds-sess-drop'))
  const reorderCalls = () => rpcCalls.filter(c => c.method === 'vdirs-reorder-session')
  check('session rows render draggable inside their container',
    rows().length === 2 && rows().every(r => r.props.draggable === true), rows().length)
  const stub = (clientY) => ({
    preventDefault() {}, stopPropagation() {},
    dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 40 }) },
    clientY
  })
  const [rowA] = rows()
  rowA.props.onDragStart(stub(0))
  await flush(); paint()
  // Re-capture the rows: a rendered element's handlers close over the render
  // that produced it, and the drag state now lives in the fresh render — just as
  // a live DOM event always belongs to the current render.
  const [, rowB2] = rows()
  rowB2.props.onDragOver(stub(10))
  await flush(); paint()
  check('hovering the top half of a sibling previews an insertion line above it',
    rows().some(r => hasClass(r, 'vds-drop-before')), rows().map(r => r.props.className))
  rows().find(r => hasClass(r, 'vds-drop-before')).props.onDrop(stub(10))
  await flush(); paint()
  check('dropping above a sibling reorders within the same container',
    reorderCalls().length === 1 && reorderCalls()[0].payload.sessionId === 's-a'
      && reorderCalls()[0].payload.dirId === 'd1' && reorderCalls()[0].payload.targetId === 's-b'
      && reorderCalls()[0].payload.place === 'before',
    reorderCalls().map(c => c.payload))
  check('the reorder clears the drag state and indicator',
    !collect(n => hasClass(n, 'vds-dragging')).length && !collect(n => hasClass(n, 'vds-drop-before')).length)

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
