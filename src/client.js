// dsh-session-dir — browser half of the virtual-directory session manager.
//
// Replaces the sidebar's session browsing region (`sidebar.workspaces`) with a
// VSCode-style directory tree, and talks to the Host half over the `/vdirs`
// Connection-RPC channel. Always read services through ctx.get(): the client ctx
// is a controlled Proxy that throws on an un-injected property.
//
// New Session behaviour mirrors the shipped browser, which is what keeps exactly
// one reusable blank row: create through uiWorkspace.startSession() (reuse-or-
// create), and show that blank session only while it is the *current* one. See
// the claim machine below for how a virtual directory takes part in that rule.
window.__ModuleLoader__.load({
  id: 'dsh-session-dir',
  factory(require) {
    const React = require('react');

    // One idempotent <style data-plugin-css> tag, following the client-modules
    // convention so theme scoping stays consistent.
    function injectCss(css) {
      if (typeof document === 'undefined') return;
      const key = 'dsh-session-dir/main';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(key) + ']')) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-session-dir';
      tag.dataset.pluginCss = key;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const plugin = {
  inject: ['slots', 'uiWorkspace', 'workspaces'],

  apply(ctx) {
    const slots = ctx.slots || ctx.get('slots')
    if (slots === undefined) return

    const h = React.createElement
    const { useState, useEffect, useRef, useSyncExternalStore } = React

    // Static RPC caller over the Connection channel. The Host half serves
    // /vdirs, so endpoint names are the vdirs-* method names. Connection is
    // resolved per call: the client connection may appear after this apply runs.
    const rpc = {
      call: (method, payload) => {
        const conn = ctx.get('connection')
        if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
          return Promise.reject(new Error('no-connection'))
        }
        return conn.rpc.call('/vdirs', method, payload).then(result => {
          if (result && result.ok) return result.value
          if (result && !result.ok) {
            const e = new Error((result.error && result.error.message) || (result.error && result.error.code) || 'rpc-failed')
            throw e
          }
          return result
        })
      }
    }

    injectCss(`
.vds-side{display:flex;flex-direction:column;gap:4px;height:100%;overflow-y:auto;padding:8px;box-sizing:border-box;font-size:12px;color:var(--dsw-alias-label-primary);}
.vds-side-head{display:flex;align-items:center;gap:6px;padding:2px 4px 6px;}
.vds-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);}
.vds-spacer{flex:1;}
.vds-btn{background:rgba(127,127,127,.12);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;flex-shrink:0;}
.vds-btn:hover{background:rgba(127,127,127,.22);}
.vds-btn-danger:hover{background:rgba(229,72,77,.25);border-color:var(--dsw-alias-state-error-primary);}
.vds-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:2px 4px;}
.vds-hint{color:var(--dsw-alias-label-secondary);font-size:11px;padding:4px;}
.vds-rail{width:100%;display:flex;justify-content:center;padding:12px 0;background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.vds-rail:hover{color:var(--dsw-alias-brand-primary);}
.vds-sec{margin-top:4px;padding-top:4px;border-top:1px solid rgba(127,127,127,.3);border-left:1px solid rgba(127,127,127,.3);border-top-left-radius:8px;}
.vds-sec[draggable=true]{cursor:grab;}
.vds-sec[draggable=true]:active{cursor:grabbing;}
.vds-sec-head{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;color:var(--dsw-alias-label-primary);}
.vds-sec-head:hover{background:rgba(127,127,127,.12);}
.vds-sec-head-open{background:rgba(127,127,127,.08);}
.vds-wsname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}
.vds-count{font-size:11px;color:var(--dsw-alias-label-secondary);flex-shrink:0;}
.vds-mini{background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:1px 4px;border-radius:4px;flex-shrink:0;}
.vds-mini:hover{background:rgba(127,127,127,.22);color:var(--dsw-alias-label-primary);}
.vds-folder{display:flex;align-items:center;flex-shrink:0;color:var(--dsw-alias-label-secondary);}
.vds-sec-head-open .vds-folder{color:var(--dsw-alias-brand-primary);}
.vds-dir-glyph{display:flex;align-items:center;flex-shrink:0;color:var(--dsw-alias-brand-primary);}
.vds-chev{width:12px;height:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--dsw-alias-label-secondary);}
.vds-chev svg{transition:transform .12s ease;}
.vds-chev-open svg{transform:rotate(90deg);}.vds-tree-wrap{border-left:1px solid var(--dsw-alias-border-l1);margin-left:9px;padding-left:7px;display:flex;flex-direction:column;gap:2px;}
.vds-dir-group{display:flex;flex-direction:column;gap:2px;border-radius:8px;}
.vds-dir-group.vds-drop-into{background:rgba(96,150,255,.12);box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary);padding:2px;}
.vds-drop-into{background:rgba(96,150,255,.18);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);border-radius:6px;}
.vds-drop-before{box-shadow:0 -2px 0 0 var(--dsw-alias-brand-primary);}
.vds-drop-after{box-shadow:0 2px 0 0 var(--dsw-alias-brand-primary);}
.vds-rootlbl{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:11px;padding:4px 4px 2px;flex-shrink:0;}
.vds-rootlbl::after{content:'';flex:1;border-top:1px solid var(--dsw-alias-border-l1);margin-left:2px;}
.vds-rootzone{display:flex;flex-direction:column;gap:2px;border-radius:6px;}
.vds-rootzone.vds-drop-into{padding:2px;}
.vds-rootslot{border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;margin:2px 4px;padding:10px 8px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:11px;}
.vds-row{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;cursor:default;color:var(--dsw-alias-label-primary);}
.vds-row:hover{background:rgba(127,127,127,.13);}
.vds-row-active{background:rgba(96,150,255,.20);}
.vds-sess-title,.vds-dir-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.vds-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex-shrink:0;}
.vds-dot-off{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l2);flex-shrink:0;}
.vds-acts{margin-left:auto;display:flex;gap:2px;opacity:0;flex-shrink:0;}
.vds-row:hover .vds-acts{opacity:1;}
.vds-act{background:none;border:none;cursor:pointer;font-size:12px;padding:2px 5px;border-radius:4px;color:var(--dsw-alias-label-primary);}
.vds-act:hover{background:rgba(127,127,127,.22);}
.vds-blank{color:var(--dsw-alias-label-secondary);}
.vds-blank .vds-sess-title{font-style:italic;}
.vds-blank-note{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);flex-shrink:0;}
.vds-dragging{opacity:.45;}
.vds-menu{display:flex;flex-direction:column;gap:2px;margin:2px 0 2px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px;background:var(--dsw-alias-bg-overlay);}
.vds-menu-item{padding:3px 8px;border-radius:4px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary);}
.vds-menu-item:hover{background:rgba(127,127,127,.22);}
.vds-menu-title{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 8px;}
.vds-input{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;font-size:13px;flex:1;min-width:0;}
.vds-loading{color:var(--dsw-alias-label-secondary);font-size:12px;padding:8px;}
.vds-more{align-self:center;margin:6px 0;}
.vds-tiprow{position:relative;}
.vds-tip{display:none;position:absolute;left:6px;top:100%;z-index:60;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-primary);box-shadow:0 6px 18px rgba(0,0,0,.28);white-space:nowrap;pointer-events:none;flex-direction:column;gap:3px;max-width:340px;}
.vds-tip-on{display:flex;}
.vds-tip-k{color:var(--dsw-alias-label-secondary);}
.vds-tip-id{display:inline-block;max-width:260px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;white-space:nowrap;}
.vds-btn-ghost{background:transparent;border:none;color:var(--dsw-alias-label-secondary);padding:4px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.vds-btn-ghost:hover{background:rgba(127,127,127,.15);color:var(--dsw-alias-label-primary);}
.vds-search-overlay{position:fixed;inset:0;z-index:1100;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;}
.vds-search-modal{width:min(560px,calc(100vw - 48px));max-height:72vh;display:flex;flex-direction:column;gap:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);border-radius:16px;padding:16px;}
.vds-search-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;}
.vds-search-title{color:var(--dsw-alias-label-primary);}
.vds-search-hint{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.vds-search-close{margin-left:auto;background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:2px 6px;border-radius:4px;font-size:13px;}
.vds-search-close:hover{background:rgba(127,127,127,.18);color:var(--dsw-alias-label-primary);}
.vds-search-input{width:100%;box-sizing:border-box;height:40px;font-size:14px;}
.vds-search-modes{display:flex;gap:8px;flex-wrap:wrap;}
.vds-mode{background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer;}
.vds-mode:hover{background:rgba(127,127,127,.12);}
.vds-mode-on{background:rgba(96,150,255,.18);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);}
.vds-search-body{overflow-y:auto;display:flex;flex-direction:column;gap:2px;max-height:36vh;}
.vds-search-result{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;}
.vds-search-result:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.13));}
.vds-search-hit-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;color:var(--dsw-alias-label-primary);font-size:13px;}
.vds-search-meta{font-size:11px;color:var(--dsw-alias-label-secondary);flex-shrink:0;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.vds-search-empty{padding:14px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center;}
.vds-search-count{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 8px;text-align:right;}
`)

    // ---------------- helpers ----------------
    function fmtFull(ts) {
      if (!ts) return '未知'
      const d = new Date(ts)
      const p = n => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    const normPath = (p) => {
      try { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() } catch (e) { return '' }
    }

    const sessionList = () => {
      const svc = ctx.get('sessions')
      return svc && svc.list && typeof svc.list.subscribe === 'function' ? svc.list : null
    }

    // The current blank session: the one the main view retains — exactly the read
    // the shipped sidebar uses to pick its single New Session row.
    function currentBlankId(state) {
      const byId = state && state.byId
      if (!byId) return null
      for (const id of Object.keys(byId)) {
        const row = byId[id]
        if (row && row.blank && ((row.retainedBy && row.retainedBy.mainView) || 0) > 0) return id
      }
      return null
    }

    function runningSet(state) {
      const out = new Set()
      const byId = state && state.byId
      if (byId) for (const id of Object.keys(byId)) if (byId[id] && byId[id].running) out.add(id)
      return out
    }

    // Blank sessions are the shipped browser's provisional New Session rows. The
    // Host hides them too, but this side owns the visibility rule, so a row the
    // Host still lists can never reappear once the claim lets go of it.
    function blankSet(state) {
      const out = new Set()
      const byId = state && state.byId
      if (byId) for (const id of Object.keys(byId)) if (byId[id] && byId[id].blank) out.add(id)
      return out
    }

    // Reactive read of the shipped sessions store, shared by the claim machine
    // and the running dot. Reading the snapshot wholesale is what the shipped
    // browser does; the store keeps object identity between updates.
    const subscribeSessionList = (fn) => {
      const list = sessionList()
      return list ? list.subscribe(fn) : () => {}
    }
    const sessionListSnapshot = () => {
      const list = sessionList()
      return list ? list.getSnapshot() : null
    }

    // ---------------- blank-session claim ----------------
    // The shipped New Session flow (uiWorkspace.startSession) reuses one blank
    // session per workspace and navigates to it, and the shipped browser then
    // shows that session only while it is the current one — so any number of New
    // Session clicks leaves a single provisional row that reappears on the next
    // click.
    //
    // A claim extends that rule to virtual directories. It attaches the
    // provisional row to one directory *in the browser only*: no blank session is
    // ever written to .dsh-vdirs.json, so a blank can never leak into the durable
    // tree. The claim ends the moment the session stops being the current blank —
    // the row disappears and the directory keeps no trace — except when the user
    // actually used it (first prompt), in which case it is committed to the
    // directory it was created in.
    let claim = null
    const claimListeners = new Set()
    const subscribeClaim = (fn) => { claimListeners.add(fn); return () => { claimListeners.delete(fn) } }
    const claimSnapshot = () => claim
    let confirmOff = null

    function setClaim(next) {
      if (claim === next) return
      if (confirmOff) { try { confirmOff() } catch (e) {} confirmOff = null }
      claim = next
      for (const fn of Array.from(claimListeners)) {
        try { fn() } catch (e) { /* a listener must not break the machine */ }
      }
    }

    function reconcileClaim() {
      const list = sessionList()
      const state = list && list.getSnapshot()
      const current = claim
      if (!state || !current) return
      const blankId = currentBlankId(state)
      if (current.sessionId == null) {
        if (!blankId) return
        // startSession targets one workspace; a blank of another one is not ours.
        const row = state.byId[blankId] || {}
        if (current.wsPath && row.cwd && normPath(row.cwd) !== normPath(current.wsPath)) return
        setClaim(Object.assign({}, current, { sessionId: blankId }))
        return
      }
      if (blankId === current.sessionId) {
        if (confirmOff) { try { confirmOff() } catch (e) {} confirmOff = null }
        return
      }
      const row = state.byId[current.sessionId]
      // Used at last: the session is real, so it belongs to the directory it was
      // created in and the group can keep it.
      if (row && row.blank === false) {
        setClaim(null)
        if (current.dirId) {
          rpc.call('vdirs-move-session', { workspaceId: current.wsId, sessionId: current.sessionId, dirId: current.dirId })
            .catch(() => {})
        }
        return
      }
      // Gone, or blank but no longer the current one. A navigation in flight can
      // leave no current blank for a moment, so confirm before dropping the row.
      if (!row) { setClaim(null); return }
      if (confirmOff) return
      const timer = ctx.get('timer')
      if (!timer || typeof timer.timeout !== 'function') { setClaim(null); return }
      confirmOff = timer.timeout(() => {
        confirmOff = null
        if (claim !== current) return
        const now = sessionList()
        if (currentBlankId(now && now.getSnapshot()) !== current.sessionId) setClaim(null)
      }, 150)
    }

    let watching = false
    function watchSessions() {
      if (watching) return
      const list = sessionList()
      if (!list) return
      watching = true
      list.subscribe(reconcileClaim)
      reconcileClaim()
    }

    // Start a New Session aimed at one directory (null = the workspace root).
    function startSessionIn(wsId, wsPath, dirId) {
      setClaim({ wsId, wsPath: wsPath || '', dirId: dirId || null, sessionId: null })
      watchSessions()
      const svc = ctx.get('uiWorkspace')
      if (svc && typeof svc.startSession === 'function') svc.startSession(wsId)
      // The store subscription is the primary signal. These bounded retries only
      // cover a navigation that settled without publishing a new snapshot (the
      // reused blank was already current, so nothing changed).
      let tries = 0
      const settle = () => {
        reconcileClaim()
        if (!claim || claim.sessionId != null || ++tries >= 10) return
        const timer = ctx.get('timer')
        if (timer && typeof timer.timeout === 'function') timer.timeout(settle, 150)
      }
      settle()
    }

    // Rename through the official Session face: retaining the identity is the
    // shipped browser's own rename path, so no Host endpoint is needed.
    async function renameSessionVia(sessionId, title) {
      const svc = ctx.get('sessions')
      if (!svc || typeof svc.using !== 'function') throw new Error('当前环境不支持重命名')
      const result = await svc.using(sessionId, { source: 'controllerOperation' }, ref => ref.binding.session.rename(title))
      if (!result || !result.ok) throw new Error((result && result.error && result.error.message) || '重命名失败')
      return result.value
    }

    // ---------------- icons ----------------
    // Plain plus: "create a session".
    function PlusIcon(props) {
      const s = props.size ?? 14
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
        h('path', { d: 'M12 5.5v13' }),
        h('path', { d: 'M5.5 12h13' })
      )
    }

    // Folder outline with an inner plus: "create a virtual directory", kept
    // visually distinct from PlusIcon so the two are never confused.
    function FolderPlusIcon(props) {
      const s = props.size ?? 14
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l1.8 2H19A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z' }),
        h('path', { d: 'M12 8.8v6.4' }),
        h('path', { d: 'M8.8 12h6.4' })
      )
    }

    // Minimal line search glyph: a circle and a handle, no fill. The ghost
    // button that wears it is transparent, so the icon reads as a bare outline
    // until hover gives it a wash.
    function SearchIcon(props) {
      const s = props.size ?? 14
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'M16.5 16.5 L20.5 20.5' })
      )
    }

    function FolderIcon(props) {
      const s = props.size ?? 20
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
        h('path', { d: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l1.8 2H19A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z' })
      )
    }

    // The shipped sidebar's own workspace glyphs (16x16 artwork from the product
    // icon set, copied rather than imported: a Harness Client package is never a
    // plugin dependency). A workspace row is folder + disclosure triangle, exactly
    // as `ProjectRowItem` renders it.
    function WorkspaceFolderIcon(props) {
      const s = props.size ?? 16
      if (props.open) {
        return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', { d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z', fill: 'currentColor', opacity: '0.16' }),
          h('path', { d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z', fill: 'currentColor' }),
          h('path', { d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z', fill: 'currentColor' })
        )
      }
      return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z', stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor', strokeWidth: 1 })
      )
    }

    function ChevronIcon(props) {
      const s = props.size ?? 14
      return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z', fill: 'currentColor' })
      )
    }

    // A virtual directory is not a real folder on disk, so it draws its own mark:
    // a hairline folder outline with a dashed contour, no fill and no background
    // (the shipped workspace row keeps the solid product glyph). Colour comes from
    // the container's CSS token, so it follows the theme's brand accent.
    function VirtualDirIcon(props) {
      const s = props.size ?? 14
      return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.2 4.75C2.2 3.95 2.85 3.3 3.65 3.3H6.05C6.44 3.3 6.81 3.47 7.06 3.77L7.5 4.3H12.35C13.15 4.3 13.8 4.95 13.8 5.75V11.75C13.8 12.55 13.15 13.2 12.35 13.2H3.65C2.85 13.2 2.2 12.55 2.2 11.75Z',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          strokeDasharray: '2.5 1.7'
        })
      )
    }

    // ---------------- workspace tree ----------------
    const EMPTY_PAGE = { items: [], total: 0, hasMore: false, loading: false, offset: 0 }
    const KEEP_KEYS = new Set(['root'])
    const EXPAND_LIMIT = 300
    const TIP_DELAY = 500

    function BrowserWide(props) {
      const [workspaces, setWorkspaces] = useState([])
      const [openWs, setOpenWs] = useState({})
      const [views, setViews] = useState({})
      const [creating, setCreating] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const [dirName, setDirName] = useState('')
      const [wsRenaming, setWsRenaming] = useState(null)
      const [wsDeleting, setWsDeleting] = useState(null)
      const [wsName, setWsName] = useState('')
      const [sessionRenaming, setSessionRenaming] = useState(null)
      const [sessionName, setSessionName] = useState('')
      const [drag, setDrag] = useState(null)
      const [dropTgt, setDropTgt] = useState(null)
      const [error, setError] = useState(null)
      const [tipFor, setTipFor] = useState(null)
      const tipTimer = useRef(null)
      const clearTimer = useRef(null)
      const prevClaim = useRef(null)
      const [searchOpen, setSearchOpen] = useState(false)
      const [searchQ, setSearchQ] = useState('')
      const [searchMode, setSearchMode] = useState('title')
      const [searchRes, setSearchRes] = useState(null)
      const [searching, setSearching] = useState(false)
      const searchTimer = useRef(null)

      const claim = useSyncExternalStore(subscribeClaim, claimSnapshot, claimSnapshot)
      const sessionsState = useSyncExternalStore(subscribeSessionList, sessionListSnapshot, sessionListSnapshot)
      const running = runningSet(sessionsState)
      const blank = blankSet(sessionsState)

      const timerSvc = () => ctx.get('timer')
      const cancelTipTimer = () => {
        if (tipTimer.current) {
          try { tipTimer.current() } catch (e) {}
          tipTimer.current = null
        }
      }
      const cancelClear = () => {
        if (clearTimer.current) {
          try { clearTimer.current() } catch (e) {}
          clearTimer.current = null
        }
      }
      const scheduleClear = () => {
        cancelClear()
        const svc = timerSvc()
        if (!svc || typeof svc.timeout !== 'function') { setDropTgt(null); return }
        try {
          clearTimer.current = svc.timeout(() => { clearTimer.current = null; setDropTgt(null) }, 400)
        } catch (e) { setDropTgt(null) }
      }
      const startTip = (sessionId) => {
        if (drag) return
        cancelTipTimer()
        const svc = timerSvc()
        if (!svc || typeof svc.timeout !== 'function') return
        try {
          tipTimer.current = svc.timeout(() => { tipTimer.current = null; setTipFor(sessionId) }, TIP_DELAY)
        } catch (e) {}
      }
      const clearTip = (sessionId) => {
        cancelTipTimer()
        setTipFor(prev => prev === sessionId ? null : prev)
      }
      useEffect(() => () => { cancelTipTimer(); cancelClear(); cancelSearchTimer() }, [])

      const updView = (wsId, upd) => setViews(prev => {
        const v = prev[wsId] || { tree: null, open: {}, pages: {}, menu: null, sel: null }
        const patch = typeof upd === 'function' ? upd(v) : upd
        return Object.assign({}, prev, { [wsId]: Object.assign({}, v, patch) })
      })
      const view = (wsId) => views[wsId] || { tree: null, open: {}, pages: {}, menu: null, sel: null }
      const uiWs = () => ctx.get('uiWorkspace')
      const wsSvc = () => ctx.get('workspaces')

      const loadPage = (wsId, dirKey, mode) => {
        const p = view(wsId).pages[dirKey] || EMPTY_PAGE
        if (mode !== 'more' && p.loading) return
        const off = mode === 'more' ? p.offset : 0
        updView(wsId, vv => ({ pages: Object.assign({}, vv.pages, { [dirKey]: Object.assign({}, p, { loading: true }) }) }))
        rpc.call('vdirs-sessions', { workspaceId: wsId, dirId: dirKey === 'root' ? null : dirKey, offset: off, limit: 50 })
          .then(res => {
            if (res && res.error) { setError(String(res.error)); return }
            const arr = res && Array.isArray(res.items) ? res.items : []
            updView(wsId, vv => {
              const p2 = vv.pages[dirKey] || EMPTY_PAGE
              return { pages: Object.assign({}, vv.pages, { [dirKey]: { items: mode === 'more' ? p2.items.concat(arr) : arr, total: (res && typeof res.total === 'number') ? res.total : 0, hasMore: !!(res && res.hasMore), loading: false, offset: (mode === 'more' ? p2.offset : 0) + arr.length } }) }
            })
          })
          .catch(e => {
            setError('加载会话失败: ' + String((e && e.message) || e))
            updView(wsId, vv => ({ pages: Object.assign({}, vv.pages, { [dirKey]: Object.assign({}, vv.pages[dirKey] || EMPTY_PAGE, { loading: false }) }) }))
          })
      }

      const reloadAll = (wsId) => {
        const keys = ['root'].concat(Object.keys(view(wsId).open))
        keys.forEach(k => loadPage(wsId, k, 'reset'))
      }

      const applyTree = (wsId, res) => {
        updView(wsId, vv => {
          const ids = new Set(res.dirs.map(d => d.id))
          const open = Object.assign({}, vv.open)
          const pages = Object.assign({}, vv.pages)
          for (const k of Object.keys(open)) if (!KEEP_KEYS.has(k) && !ids.has(k)) delete open[k]
          for (const k of Object.keys(pages)) if (!KEEP_KEYS.has(k) && !ids.has(k)) delete pages[k]
          return { tree: res, open, pages }
        })
        reloadAll(wsId)
        return res
      }

      const callTree = (wsId, method, payload) => rpc.call(method, Object.assign({ workspaceId: wsId }, payload)).then(res => {
        if (res && res.error) { setError(String(res.error)); return null }
        applyTree(wsId, res)
        return res
      }).catch(e => { setError('操作失败: ' + String((e && e.message) || e)); return null })

      const openWorkspace = (wsId) => {
        setOpenWs(prev => Object.assign({}, prev, { [wsId]: true }))
        rpc.call('vdirs-tree', { workspaceId: wsId }).then(res => {
          if (res && res.error) { setError(String(res.error)); return }
          updView(wsId, { tree: res, open: {} })
          loadPage(wsId, 'root', 'reset')
        }).catch(e => setError('加载目录失败: ' + String((e && e.message) || e)))
      }

      const closeWorkspace = (wsId) => {
        setOpenWs(prev => {
          const next = Object.assign({}, prev)
          delete next[wsId]
          return next
        })
      }

      const toggleWs = (wsId) => {
        if (openWs[wsId]) closeWorkspace(wsId)
        else openWorkspace(wsId)
      }

      const toggleDir = (wsId, dirKey) => {
        const v = view(wsId)
        if (v.open[dirKey]) {
          updView(wsId, vv => { const open = Object.assign({}, vv.open); delete open[dirKey]; return { open } })
        } else {
          updView(wsId, vv => ({ open: Object.assign({}, vv.open, { [dirKey]: true }) }))
          loadPage(wsId, dirKey, 'reset')
        }
      }

      // Expand without toggling closed: the provisional New Session row of "new
      // session in this directory" has to be visible once the claim resolves.
      const openDir = (wsId, dirKey) => {
        if (view(wsId).open[dirKey]) return
        updView(wsId, vv => ({ open: Object.assign({}, vv.open, { [dirKey]: true }) }))
        loadPage(wsId, dirKey, 'reset')
      }

      const openSession = (sessionId) => {
        const svc = uiWs()
        if (svc && typeof svc.openSession === 'function') svc.openSession(sessionId)
      }

      const archiveSession = (wsId, sessionId) => {
        const svc = uiWs()
        if (!svc || typeof svc.archiveSession !== 'function') return
        svc.archiveSession(sessionId).then(() => {
          rpc.call('vdirs-tree', { workspaceId: wsId }).then(res => {
            if (res && !res.error) applyTree(wsId, res)
          }).catch(() => {})
        }).catch(e => setError('归档失败: ' + String((e && e.message) || e)))
      }

      const createDir = () => {
        const name = dirName.trim()
        if (!name || !creating) return
        const wsId = creating.wsId
        const parentId = creating.parent === 'root' ? null : creating.parent
        setCreating(null); setDirName('')
        callTree(wsId, 'vdirs-create-dir', { parentId, name })
      }

      const renameDir = (wsId, dirId) => {
        const name = dirName.trim()
        if (!name) { setRenaming(null); return }
        setRenaming(null); setDirName('')
        callTree(wsId, 'vdirs-rename-dir', { dirId, name })
      }

      const deleteDir = (wsId, dirId) => {
        setDeleting(null)
        callTree(wsId, 'vdirs-delete-dir', { dirId })
      }

      const moveSession = (wsId, sessionId, dirId) => {
        updView(wsId, { menu: null })
        callTree(wsId, 'vdirs-move-session', { sessionId, dirId: dirId || null })
      }

      const reorderDir = (wsId, dirId, targetId, place) => {
        callTree(wsId, 'vdirs-reorder-dir', { dirId, targetId: targetId || null, place: place || 'before' })
      }

      // Drag a session above/below a sibling inside the same container. dirId
      // is the container key ('root' or a directory id); the response refreshes
      // the tree and every open page.
      const reorderSession = (wsId, dirId, sessionId, targetId, place) => {
        callTree(wsId, 'vdirs-reorder-session', { dirId: dirId === 'root' ? null : dirId, sessionId, targetId, place: place || 'before' })
      }

      const saveSessionRename = (wsId, sessionId) => {
        const title = sessionName.trim()
        setSessionRenaming(null)
        if (!title) return
        renameSessionVia(sessionId, title).then(() => {
          // The durable title feeds the Host page, so refresh tree and pages.
          rpc.call('vdirs-tree', { workspaceId: wsId }).then(res => {
            if (res && !res.error) applyTree(wsId, res)
          }).catch(() => {})
        }).catch(e => setError('重命名失败: ' + String((e && e.message) || e)))
      }

      const expandAll = (wsId) => {
        const tree = view(wsId).tree
        if (!tree) return
        const open = {}
        tree.dirs.forEach(d => { if (d.count <= EXPAND_LIMIT) open[d.id] = true })
        updView(wsId, { open })
        const keys = ['root'].concat(tree.dirs.filter(d => d.count <= EXPAND_LIMIT).map(d => d.id))
        keys.forEach(k => loadPage(wsId, k, 'reset'))
      }

      const collapseAll = (wsId) => {
        updView(wsId, { open: {}, menu: null })
      }

      const endDrag = () => { cancelClear(); setDrag(null); setDropTgt(null) }

      const addWorkspace = () => {
        const svc = uiWs()
        if (!svc || typeof svc.pickDirectory !== 'function') return
        svc.pickDirectory().then(path => {
          if (!path) return
          const wsvc = wsSvc()
          if (!wsvc || typeof wsvc.create !== 'function') return
          wsvc.create({ path }).then(() => rpc.call('vdirs-workspaces')).then(res => {
            const list = res && Array.isArray(res.workspaces) ? res.workspaces : []
            setWorkspaces(list)
            if (list.length) openWorkspace(list[list.length - 1].id)
          }).catch(e => setError('创建工作区失败: ' + String((e && e.message) || e)))
        }).catch(e => setError('选择目录失败: ' + String((e && e.message) || e)))
      }

      const refreshWorkspaces = () => rpc.call('vdirs-workspaces').then(res => {
        const list = res && Array.isArray(res.workspaces) ? res.workspaces : []
        setWorkspaces(list)
        return list
      })

      const renameWorkspace = (wsId) => {
        const name = wsName.trim()
        if (!name) { setWsRenaming(null); return }
        setWsRenaming(null); setWsName('')
        const wsvc = wsSvc()
        if (!wsvc || typeof wsvc.rename !== 'function') return
        wsvc.rename(wsId, name).then(refreshWorkspaces).catch(e => setError('重命名工作区失败: ' + String((e && e.message) || e)))
      }

      const deleteWorkspace = (wsId) => {
        setWsDeleting(null)
        const wsvc = wsSvc()
        if (!wsvc || typeof wsvc.delete !== 'function') return
        wsvc.delete(wsId).then(refreshWorkspaces).catch(e => setError('删除工作区失败: ' + String((e && e.message) || e)))
      }

      // Move one workspace within the durable registry order: insert before
      // beforeId, or append at the end when beforeId is omitted — the same
      // DOM-insertBefore-like contract the shipped browser's row drag uses.
      const reorderWorkspace = (wsId, beforeId) => {
        const wsvc = wsSvc()
        if (!wsvc || typeof wsvc.insertBefore !== 'function') return
        wsvc.insertBefore(wsId, beforeId || undefined)
          .then(refreshWorkspaces)
          .catch(e => setError('排序工作区失败: ' + String((e && e.message) || e)))
      }

      // ---------------- search modal ----------------
      const cancelSearchTimer = () => {
        if (searchTimer.current) { try { searchTimer.current() } catch (e) {} searchTimer.current = null }
      }
      const runSearch = (q, mode) => {
        const needle = String(q == null ? searchQ : q).trim()
        const m = mode || searchMode
        if (!needle) { setSearchRes(null); setSearching(false); return }
        setSearching(true)
        rpc.call('vdirs-search', { q: needle, mode: m }).then(res => {
          setSearchRes(res && Array.isArray(res.items) ? res : { items: [], total: 0 })
          setSearching(false)
        }).catch(e => {
          setError('搜索失败: ' + String((e && e.message) || e))
          setSearchRes({ items: [], total: 0 })
          setSearching(false)
        })
      }
      const scheduleSearch = (q) => {
        setSearchQ(q)
        cancelSearchTimer()
        if (!String(q).trim()) { setSearchRes(null); setSearching(false); return }
        const svc = timerSvc()
        if (!svc || typeof svc.timeout !== 'function') { runSearch(q, null); return }
        try {
          searchTimer.current = svc.timeout(() => { searchTimer.current = null; runSearch(q, null) }, 300)
        } catch (e) { runSearch(q, null) }
      }
      const pickMode = (m) => {
        if (m === searchMode) return
        cancelSearchTimer()
        setSearchMode(m)
        runSearch(searchQ, m)
      }
      const openSearch = () => { setSearchOpen(true); setSearchQ(''); setSearchRes(null); setSearching(false) }
      const closeSearch = () => { cancelSearchTimer(); setSearchOpen(false) }
      const openSearchHit = (hit) => { closeSearch(); openSession(hit.sessionId) }

      useEffect(() => {
        let alive = true
        watchSessions()
        const load = () => rpc.call('vdirs-workspaces').then(res => {
          if (!alive) return
          const list = res && Array.isArray(res.workspaces) ? res.workspaces : []
          setWorkspaces(list)
          if (list.length) openWorkspace(list[0].id)
          else setError('当前没有任何工作区。')
        }).catch(e => { if (alive) setError('加载工作区失败: ' + String((e && e.message) || e)) })
        load()
        const off = ctx.on('connection/reset', load)
        return () => { alive = false; if (off) off() }
      }, [])

      useEffect(() => {
        const timer = ctx.get('timer')
        if (!timer || typeof timer.interval !== 'function') return
        let stopped = false
        const off = timer.interval(() => {
          if (stopped) return
          rpc.call('vdirs-workspaces').then(res => {
            const list = res && Array.isArray(res.workspaces) ? res.workspaces : []
            setWorkspaces(list)
            list.forEach(w => {
              rpc.call('vdirs-tree', { workspaceId: w.id }).then(tres => {
                if (tres && !tres.error) applyTree(w.id, tres)
              }).catch(() => {})
            })
          }).catch(() => {})
        }, 30000)
        return () => { stopped = true; if (off) off() }
      }, [])

      // The claim ended: the blank either lost focus (the row is simply gone) or
      // was committed to its directory after its first prompt. Reload that
      // workspace so the tree shows whichever happened.
      useEffect(() => {
        const previous = prevClaim.current
        prevClaim.current = claim
        if (!previous || !previous.sessionId || claim) return
        rpc.call('vdirs-tree', { workspaceId: previous.wsId }).then(res => {
          if (res && !res.error) applyTree(previous.wsId, res)
        }).catch(() => {})
      }, [claim])

      const secs = workspaces.map(w => {
        const isOpen = !!openWs[w.id]
        const v = view(w.id)
        const tree = v.tree
        const ttl = tree ? tree.total : '…'

        const dirOptions = []
        const pushOpts = (parentId, depth) => {
          const kids = (tree ? tree.dirs : []).filter(d => (d.parentId || null) === (parentId || null))
          for (const k of kids) {
            dirOptions.push({ id: k.id, label: '　'.repeat(depth) + k.name })
            pushOpts(k.id, depth + 1)
          }
        }
        pushOpts(null, 0)

        const createInput = () => h('div', { key: 'create', className: 'vds-row' },
          h('input', { className: 'vds-input', placeholder: '目录名称', value: dirName, autoFocus: true, onChange: e => setDirName(e.target.value), onKeyDown: e => { if (e.key === 'Enter') createDir(); if (e.key === 'Escape') { setCreating(null); setDirName('') } } }),
          h('button', { className: 'vds-btn', onClick: createDir }, '确定'),
          h('button', { className: 'vds-btn', onClick: () => { setCreating(null); setDirName('') } }, '取消')
        )

        // The provisional New Session row: the single blank session the official
        // flow reuses, shown here while this directory owns the claim. It carries
        // no session data because it has none yet, and it cannot be dragged.
        const provisionalRow = (dirKey) => {
          if (!claim || !claim.sessionId || claim.wsId !== w.id) return null
          if ((claim.dirId || 'root') !== dirKey) return null
          return h('div', { key: claim.sessionId, className: 'vds-row vds-blank', style: { paddingLeft: 4 }, title: '未使用的新会话 · 首次对话后会保留在此目录', onClick: () => openSession(claim.sessionId) },
            h('span', { className: 'vds-dot-off' }),
            h('span', { className: 'vds-sess-title' }, '新会话'),
            h('span', { className: 'vds-blank-note' }, '未使用')
          )
        }

        const leafRows = (dirKey, showEmpty) => {
          const p = v.pages[dirKey] || EMPTY_PAGE
          const provisional = provisionalRow(dirKey)
          const out = provisional ? [provisional] : []
          // The shipped visibility rule: a blank Session is visible only while it
          // is the provisional row this directory is currently creating.
          const items = (p.items || []).filter(it => !blank.has(it.sessionId) || (claim && it.sessionId === claim.sessionId))
          if (p.loading && !items.length) {
            out.push(h('div', { key: 'load', className: 'vds-loading' }, '加载中…'))
          }
          for (const it of items) {
            const isDragging = drag && drag.type === 'session' && drag.sessionId === it.sessionId
            const ren = sessionRenaming && sessionRenaming.wsId === w.id && sessionRenaming.sessionId === it.sessionId
            const tipShow = tipFor === it.sessionId && !drag
            // A same-container drag previews an insertion line above or below the
            // hovered sibling; cross-container falls through to the directory/root
            // drop zones ("move into").
            const sessTgt = drag && drag.type === 'session' && dropTgt && dropTgt.kind === 'sess'
              && dropTgt.wsId === w.id && dropTgt.id === it.sessionId ? dropTgt : null
            // vds-sess-drop: marker class the verify-claim contract expects on
            // every draggable session row (no CSS rule binds to it).
            out.push(
              h('div', { key: it.sessionId, className: 'vds-row vds-tiprow vds-sess-drop' + (isDragging ? ' vds-dragging' : '') + (sessTgt ? (sessTgt.place === 'after' ? ' vds-drop-after' : ' vds-drop-before') : ''), style: { paddingLeft: 4 }, draggable: true, onClick: () => openSession(it.sessionId),
                onMouseEnter: () => startTip(it.sessionId),
                onMouseLeave: () => clearTip(it.sessionId),
                onDragStart: e => { e.dataTransfer.setData('text/plain', it.sessionId); e.dataTransfer.effectAllowed = 'move'; setDrag({ type: 'session', sessionId: it.sessionId, wsId: w.id, container: dirKey }) },
                onDragEnd: endDrag,
                onDragOver: e => sessOver(e, it, dirKey),
                onDragLeave: () => { if (drag && drag.type === 'session') scheduleClear() },
                onDrop: e => sessDrop(e, it, dirKey) },
                h('span', { className: running.has(it.sessionId) ? 'vds-dot' : 'vds-dot-off' }),
                h('span', { className: 'vds-sess-title' }, it.title || it.sessionId),
                h('span', { className: 'vds-acts', onClick: e => e.stopPropagation() },
                  h('button', { className: 'vds-mini', title: '操作', onClick: () => updView(w.id, vv => ({ menu: vv.menu === it.sessionId ? null : it.sessionId })) }, '⋯')
                ),
                h('div', { className: 'vds-tip' + (tipShow ? ' vds-tip-on' : '') },
                  h('div', null, h('span', { className: 'vds-tip-k' }, '会话 ID：'), h('span', { className: 'vds-tip-id', title: it.sessionId }, String(it.sessionId))),
                  h('div', null, h('span', { className: 'vds-tip-k' }, '最后活跃：'), fmtFull(it.lastActiveAt)),
                  h('div', null, h('span', { className: 'vds-tip-k' }, '创建于：'), fmtFull(it.createdAt))
                )
              )
            )
            if (ren) {
              out.push(
                h('div', { key: it.sessionId + '-rn', className: 'vds-row', style: { paddingLeft: 4 } },
                  h('input', { className: 'vds-input', value: sessionName, autoFocus: true, onChange: e => setSessionName(e.target.value), onKeyDown: e => { if (e.key === 'Enter') saveSessionRename(w.id, it.sessionId); if (e.key === 'Escape') { setSessionRenaming(null); setSessionName('') } } }),
                  h('button', { className: 'vds-btn', onClick: () => saveSessionRename(w.id, it.sessionId) }, '确定'),
                  h('button', { className: 'vds-btn', onClick: () => { setSessionRenaming(null); setSessionName('') } }, '取消')
                )
              )
            } else if (v.menu === it.sessionId) {
              out.push(
                h('div', { key: it.sessionId + '-m', className: 'vds-menu' },
                  h('div', { className: 'vds-menu-item', onClick: () => { updView(w.id, { menu: null }); openSession(it.sessionId) } }, '打开会话'),
                  h('div', { className: 'vds-menu-item', onClick: () => { updView(w.id, { menu: null }); setSessionName(it.title || it.sessionId); setSessionRenaming({ wsId: w.id, sessionId: it.sessionId }) } }, '重命名'),
                  h('div', { className: 'vds-menu-item', onClick: () => { updView(w.id, { menu: null }); archiveSession(w.id, it.sessionId) } }, '归档（从所有目录移除）'),
                  h('div', { className: 'vds-menu-title' }, '移动到…'),
                  h('div', { className: 'vds-menu-item', onClick: () => moveSession(w.id, it.sessionId, null) }, '根目录'),
                  dirOptions.map(o => h('div', { key: o.id, className: 'vds-menu-item', onClick: () => moveSession(w.id, it.sessionId, o.id) }, o.label))
                )
              )
            }
          }
          if (p.hasMore) {
            out.push(h('button', { key: 'more', className: 'vds-btn vds-more', onClick: () => loadPage(w.id, dirKey, 'more') }, p.loading ? '加载中…' : '加载更多（' + items.length + '/' + p.total + '）'))
          }
          if (showEmpty && !p.loading && !items.length && !provisional) {
            out.push(h('div', { key: 'empty', className: 'vds-hint' }, '暂无会话'))
          }
          return out
        }

        // A directory's wrapper accepts a session dropped anywhere in its body,
        // unless an inner directory row is the real target.
        const blockerId = (e) => {
          const blocker = e.target && e.target.closest ? e.target.closest('.vds-dir-drop') : null
          return blocker ? String((blocker.getAttribute && blocker.getAttribute('data-dir-id')) || '') : null
        }
        const wrapOver = (e, d) => {
          if (!drag || drag.wsId !== w.id || drag.type !== 'session') return
          const blocker = blockerId(e)
          if (blocker !== null && blocker !== d.id) return
          e.preventDefault(); e.dataTransfer.dropEffect = 'move'
          cancelClear()
          setDropTgt(prev => prev && prev.kind === 'dir' && prev.id === d.id && prev.place === 'into' ? prev : { kind: 'dir', id: d.id, place: 'into', wsId: w.id })
        }
        const wrapDrop = (e, d) => {
          e.preventDefault()
          const dropped = drag
          endDrag()
          if (!dropped || dropped.wsId !== w.id || dropped.type !== 'session') return
          const blocker = blockerId(e)
          if (blocker !== null && blocker !== d.id) return
          moveSession(w.id, dropped.sessionId, d.id)
        }

        // Same-container session reorder: hovering the top/bottom half of a
        // sibling row previews an insertion line, dropping commits it. A drag
        // from another container is ignored here on purpose — it bubbles to the
        // wrap/root drop handler and becomes a move into that container.
        const sessOver = (e, it, dirKey) => {
          if (!drag || drag.wsId !== w.id || drag.type !== 'session') return
          if (drag.sessionId === it.sessionId || (drag.container || 'root') !== dirKey) return
          e.preventDefault(); e.dataTransfer.dropEffect = 'move'
          e.stopPropagation()
          cancelClear()
          const rect = e.currentTarget.getBoundingClientRect()
          const place = (e.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after'
          setDropTgt(prev => prev && prev.kind === 'sess' && prev.id === it.sessionId && prev.place === place && prev.wsId === w.id ? prev : { kind: 'sess', id: it.sessionId, place, wsId: w.id })
        }
        const sessDrop = (e, it, dirKey) => {
          const same = drag && drag.wsId === w.id && drag.type === 'session'
            && (drag.container || 'root') === dirKey && drag.sessionId !== it.sessionId
          if (!same) return
          const dropped = drag
          const rect = e.currentTarget.getBoundingClientRect()
          const place = (e.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after'
          e.preventDefault(); e.stopPropagation()
          endDrag()
          reorderSession(w.id, dirKey, dropped.sessionId, it.sessionId, place)
        }

        const dirRows = (parentId) => {
          const kids = (tree ? tree.dirs : []).filter(d => (d.parentId || null) === (parentId || null))
          const out = []
          for (const d of kids) {
            const open = !!v.open[d.id]
            const active = v.sel === d.id
            const isDraggingDir = drag && drag.type === 'dir' && drag.dirId === d.id
            const dt = dropTgt && dropTgt.wsId === w.id && dropTgt.kind === 'dir' && dropTgt.id === d.id ? dropTgt : null
            const into = !!dt && dt.place === 'into'
            const dropCls = dt ? (into ? '' : dt.place === 'after' ? ' vds-drop-after' : ' vds-drop-before') : ''
            const groupKids = []
            groupKids.push(
              h('div', { key: d.id + '-head', className: 'vds-row vds-dir-drop' + (active ? ' vds-row-active' : '') + (isDraggingDir ? ' vds-dragging' : '') + dropCls, 'data-dir-id': d.id, style: { paddingLeft: 4 }, draggable: true, title: '拖拽排序；拖入会话可放入此目录',
                onClick: () => { updView(w.id, { sel: d.id }); toggleDir(w.id, d.id) },
                onDragStart: e => { e.dataTransfer.setData('text/plain', d.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ type: 'dir', dirId: d.id, parentId: d.parentId || null, wsId: w.id }) },
                onDragEnd: endDrag,
                onDragOver: e => {
                  if (!drag || drag.wsId !== w.id) return
                  if (drag.type === 'session') {
                    e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                    cancelClear()
                    setDropTgt(prev => prev && prev.kind === 'dir' && prev.id === d.id && prev.place === 'into' ? prev : { kind: 'dir', id: d.id, place: 'into', wsId: w.id })
                  } else if (drag.type === 'dir' && drag.dirId !== d.id && drag.parentId === (d.parentId || null)) {
                    e.preventDefault(); e.dataTransfer.dropEffect = 'move'
                    const rect = e.currentTarget.getBoundingClientRect()
                    const place = (e.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after'
                    cancelClear()
                    setDropTgt(prev => prev && prev.kind === 'dir' && prev.id === d.id && prev.place === place ? prev : { kind: 'dir', id: d.id, place, wsId: w.id })
                  }
                },
                onDragLeave: () => scheduleClear(),
                onDrop: e => {
                  e.preventDefault()
                  const dropped = drag
                  endDrag()
                  if (!dropped || dropped.wsId !== w.id) return
                  if (dropped.type === 'session') moveSession(w.id, dropped.sessionId, d.id)
                  else if (dropped.type === 'dir' && dropped.dirId !== d.id) {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const place = (e.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after'
                    reorderDir(w.id, dropped.dirId, d.id, place)
                  }
                }
              },
                h('span', { className: 'vds-chev' + (open ? ' vds-chev-open' : '') }, h(ChevronIcon, { size: 12 })),
                h('span', { className: 'vds-dir-glyph' }, h(VirtualDirIcon, { size: 14 })),
                h('span', { className: 'vds-dir-name' }, d.name),
                h('span', { className: 'vds-count' }, String(d.count)),
                h('span', { className: 'vds-acts', onClick: e => e.stopPropagation() },
                  h('button', { className: 'vds-act', title: '新建会话', onClick: () => { openDir(w.id, d.id); startSessionIn(w.id, w.path, d.id) } }, h(PlusIcon, { size: 12 })),
                  h('button', { className: 'vds-act', title: '新建子目录', onClick: () => { setDirName(''); setCreating({ wsId: w.id, parent: d.id }); setRenaming(null); setDeleting(null) } }, h(FolderPlusIcon, { size: 12 })),
                  h('button', { className: 'vds-act', title: '重命名', onClick: () => { setDirName(d.name); setRenaming({ wsId: w.id, dirId: d.id }); setCreating(null); setDeleting(null) } }, '✎'),
                  h('button', { className: 'vds-act', title: '删除', onClick: () => { setDeleting({ wsId: w.id, dirId: d.id }); setRenaming(null); setCreating(null) } }, '✕')
                )
              )
            )
            if (renaming && renaming.wsId === w.id && renaming.dirId === d.id) {
              groupKids.push(
                h('div', { key: d.id + '-rn', className: 'vds-row', style: { paddingLeft: 4 } },
                  h('input', { className: 'vds-input', value: dirName, autoFocus: true, onChange: e => setDirName(e.target.value), onKeyDown: e => { if (e.key === 'Enter') renameDir(w.id, d.id); if (e.key === 'Escape') { setRenaming(null); setDirName('') } } }),
                  h('button', { className: 'vds-btn', onClick: () => renameDir(w.id, d.id) }, '确定'),
                  h('button', { className: 'vds-btn', onClick: () => { setRenaming(null); setDirName('') } }, '取消')
                )
              )
            }
            if (deleting && deleting.wsId === w.id && deleting.dirId === d.id) {
              groupKids.push(
                h('div', { key: d.id + '-dl', className: 'vds-row', style: { paddingLeft: 4 } },
                  h('span', { className: 'vds-hint' }, '删除目录？会话移回上级'),
                  h('button', { className: 'vds-btn vds-btn-danger', onClick: () => deleteDir(w.id, d.id) }, '删除'),
                  h('button', { className: 'vds-btn', onClick: () => setDeleting(null) }, '取消')
                )
              )
            }
            if (creating && creating.wsId === w.id && creating.parent === d.id) {
              groupKids.push(createInput())
            }
            if (open) {
              groupKids.push(
                h('div', { key: d.id + '-wrap', className: 'vds-tree-wrap',
                  onDragOver: e => wrapOver(e, d),
                  onDragLeave: () => scheduleClear(),
                  onDrop: e => wrapDrop(e, d) },
                  dirRows(d.id),
                  leafRows(d.id, true)
                )
              )
            }
            out.push(h('div', { key: d.id, className: 'vds-dir-group' + (into ? ' vds-drop-into' : '') }, groupKids))
          }
          return out
        }

        const rootOver = (e) => {
          if (!drag || drag.wsId !== w.id) return
          const allowed = drag.type === 'session' || (drag.type === 'dir' && drag.parentId === null)
          if (!allowed) return
          e.preventDefault(); e.dataTransfer.dropEffect = 'move'
          cancelClear()
          setDropTgt(prev => prev && prev.kind === 'root' ? prev : { kind: 'root', wsId: w.id })
        }
        const rootDrop = (e) => {
          e.preventDefault()
          const dropped = drag
          endDrag()
          if (!dropped || dropped.wsId !== w.id) return
          if (dropped.type === 'session') moveSession(w.id, dropped.sessionId, null)
          else if (dropped.type === 'dir' && dropped.parentId === null) reorderDir(w.id, dropped.dirId, null, 'before')
        }

        // Workspace reorder: drag a workspace section above/below a sibling.
        const wsOver = (e, target) => {
          if (!drag || drag.type !== 'ws' || drag.wsId === target.id) return
          e.preventDefault(); e.dataTransfer.dropEffect = 'move'
          cancelClear()
          const rect = e.currentTarget.getBoundingClientRect()
          const place = (e.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after'
          setDropTgt(prev => prev && prev.kind === 'ws' && prev.id === target.id && prev.place === place ? prev : { kind: 'ws', id: target.id, place })
        }
        const wsDrop = (e, target) => {
          e.preventDefault()
          const dropped = drag
          endDrag()
          if (!dropped || dropped.type !== 'ws' || dropped.wsId === target.id) return
          const rect = e.currentTarget.getBoundingClientRect()
          const place = (e.clientY - rect.top) < (rect.height / 2) ? 'before' : 'after'
          let beforeId
          if (place === 'before') {
            beforeId = target.id
          } else {
            // "After target": insert before the workspace following it in the
            // current order, or append when it is already the last one. Skipping
            // the dragged id keeps a no-op drop (already right after the target)
            // from jumping it to the end.
            const idx = workspaces.findIndex(x => x.id === target.id)
            const next = idx >= 0 ? workspaces.slice(idx + 1).find(x => x.id !== dropped.wsId) : undefined
            beforeId = next ? next.id : undefined
          }
          reorderWorkspace(dropped.wsId, beforeId)
        }

        const wsDragging = drag && drag.type === 'ws' && drag.wsId === w.id
        const wsTgt = drag && drag.type === 'ws' && dropTgt && dropTgt.kind === 'ws' && dropTgt.id === w.id ? dropTgt : null

        // ---- workspace body: root zone | directories ----
        // Always rendered, so an empty workspace (or one holding directories but
        // no sessions yet) still shows its tree.
        const content = []
        if (creating && creating.wsId === w.id && creating.parent === 'root') content.push(createInput())
        if (tree) {
          const rootInto = dropTgt && dropTgt.kind === 'root' && dropTgt.wsId === w.id
          const rootClaim = !!(claim && claim.wsId === w.id && !claim.dirId)
          const zoneKids = [h('div', { key: 'rootlbl', className: 'vds-rootlbl' }, '根目录 · ' + tree.rootCount)]
          if (tree.rootCount > 0 || rootClaim) zoneKids.push(leafRows('root', false))
          else zoneKids.push(h('div', { key: 'rootslot', className: 'vds-rootslot' }, tree.total === 0 && !tree.dirs.length ? '暂无会话，点标题栏 ＋ 新建' : '拖入会话以移出目录'))
          content.push(h('div', { key: 'rootzone', className: 'vds-rootzone' + (rootInto ? ' vds-drop-into' : ''),
            onDragOver: rootOver,
            onDragLeave: () => scheduleClear(),
            onDrop: rootDrop },
            zoneKids
          ))
        }
        dirRows(null).forEach(r => content.push(r))

        return h('div', { key: w.id, className: 'vds-sec' + (wsTgt ? (wsTgt.place === 'after' ? ' vds-drop-after' : ' vds-drop-before') : '') + (wsDragging ? ' vds-dragging' : ''), draggable: true, title: '拖拽排序工作区',
          // dragstart bubbles: session rows and directory rows are draggable
          // themselves, and their dragstart reaches this handler too. When the
          // drag source is a descendant, only that row's handler may start the
          // drag — otherwise every session/dir drag would be hijacked into a
          // workspace drag and "move into directory" would stop working. A
          // workspace drag starts only from the section element itself (header
          // or blank area), which is what the draggable attribute is for.
          onDragStart: e => { if (e.target !== e.currentTarget) return; e.dataTransfer.setData('text/plain', w.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ type: 'ws', wsId: w.id }) },
          onDragEnd: endDrag,
          onDragOver: e => wsOver(e, w),
          onDragLeave: () => scheduleClear(),
          onDrop: e => wsDrop(e, w) },
          h('div', { className: 'vds-sec-head' + (isOpen ? ' vds-sec-head-open' : ''), onClick: () => toggleWs(w.id) },
            // Folder + disclosure triangle, the shipped workspace row's own pair.
            h('span', { className: 'vds-folder' }, h(WorkspaceFolderIcon, { size: 16, open: isOpen })),
            h('span', { className: 'vds-chev' + (isOpen ? ' vds-chev-open' : '') }, h(ChevronIcon, { size: 12 })),
            h('span', { className: 'vds-wsname', title: w.path }, w.title),
            h('span', { className: 'vds-count' }, ttl),
            h('span', { className: 'vds-mini', title: '展开全部目录', onClick: e => { e.stopPropagation(); expandAll(w.id) } }, '⤵'),
            h('span', { className: 'vds-mini', title: '折叠全部目录', onClick: e => { e.stopPropagation(); collapseAll(w.id) } }, '⤴'),
            h('span', { className: 'vds-mini', title: '新建会话', onClick: e => { e.stopPropagation(); startSessionIn(w.id, w.path, null) } }, h(PlusIcon, { size: 14 })),
            h('span', { className: 'vds-mini', title: '新建根目录', onClick: e => { e.stopPropagation(); setDirName(''); setCreating({ wsId: w.id, parent: 'root' }); setRenaming(null); setDeleting(null) } }, h(FolderPlusIcon, { size: 14 })),
            h('span', { className: 'vds-mini', title: '重命名工作区', onClick: e => { e.stopPropagation(); setWsName(w.title); setWsRenaming(w.id); setWsDeleting(null) } }, '✎'),
            h('span', { className: 'vds-mini', title: '删除工作区', onClick: e => { e.stopPropagation(); setWsDeleting(w.id); setWsRenaming(null) } }, '✕')
          ),
          wsRenaming === w.id ? h('div', { className: 'vds-row' },
            h('input', { className: 'vds-input', value: wsName, autoFocus: true, onChange: e => setWsName(e.target.value), onKeyDown: e => { if (e.key === 'Enter') renameWorkspace(w.id); if (e.key === 'Escape') { setWsRenaming(null); setWsName('') } } }),
            h('button', { className: 'vds-btn', onClick: () => renameWorkspace(w.id) }, '确定'),
            h('button', { className: 'vds-btn', onClick: () => { setWsRenaming(null); setWsName('') } }, '取消')
          ) : null,
          wsDeleting === w.id ? h('div', { className: 'vds-row' },
            h('span', { className: 'vds-hint' }, '删除工作区？文件与会话保留'),
            h('button', { className: 'vds-btn vds-btn-danger', onClick: () => deleteWorkspace(w.id) }, '删除'),
            h('button', { className: 'vds-btn', onClick: () => setWsDeleting(null) }, '取消')
          ) : null,
          isOpen ? h('div', null, content) : null
        )
      })

      const searchResItems = searchRes && Array.isArray(searchRes.items) ? searchRes.items : []
      const overlay = h('div', { key: 'vds-search-overlay', className: 'vds-search-overlay', onClick: closeSearch },
        h('div', { className: 'vds-search-modal', onClick: e => e.stopPropagation() },
          h('div', { className: 'vds-search-head' },
            h('span', { className: 'vds-search-title' }, '搜索会话'),
            h('span', { className: 'vds-search-hint' }, searchMode === 'full' ? '全量搜索：标题 + 对话内容' : '仅按标题搜索'),
            h('button', { className: 'vds-search-close', title: '关闭 (Esc)', onClick: closeSearch }, '✕')
          ),
          h('input', {
            className: 'vds-input vds-search-input',
            placeholder: searchMode === 'full' ? '搜索标题与全部对话内容…' : '输入会话标题关键词…',
            value: searchQ,
            autoFocus: true,
            onChange: e => scheduleSearch(e.target.value),
            onKeyDown: e => {
              if (e.key === 'Enter') { cancelSearchTimer(); runSearch(searchQ, null) }
              if (e.key === 'Escape') { e.stopPropagation(); closeSearch() }
            }
          }),
          h('div', { className: 'vds-search-modes' },
            h('button', { className: 'vds-mode' + (searchMode === 'title' ? ' vds-mode-on' : ''), onClick: () => pickMode('title') }, '仅标题搜索'),
            h('button', { className: 'vds-mode' + (searchMode === 'full' ? ' vds-mode-on' : ''), onClick: () => pickMode('full') }, '全量搜索')
          ),
          searching
            ? h('div', { className: 'vds-search-empty' }, '搜索中…')
            : (!searchQ.trim()
              ? h('div', { className: 'vds-search-empty' }, '输入关键词即可搜索；切换模式会按当前关键词重新搜索。')
              : (searchResItems.length === 0
                ? h('div', { className: 'vds-search-empty' }, '未找到匹配的会话。')
                : h('div', { className: 'vds-search-body' },
                    searchResItems.map(it => h('div', {
                      key: it.workspaceId + '/' + it.sessionId,
                      className: 'vds-search-result',
                      title: '打开会话',
                      onClick: () => openSearchHit(it)
                    },
                      h('span', { className: running.has(it.sessionId) ? 'vds-dot' : 'vds-dot-off' }),
                      h('span', { className: 'vds-search-hit-title' }, it.title || it.sessionId),
                      h('span', { className: 'vds-search-meta' }, (it.workspaceTitle || '') + (it.dirName ? ' · ' + it.dirName : ' · 根目录'))
                    )),
                    h('div', { className: 'vds-search-count' }, '共 ' + searchResItems.length + ' 个匹配会话' + (searchRes && searchRes.total > searchResItems.length ? '（仅显示前 ' + searchResItems.length + ' 个）' : ''))
                  )))
        )
      )

      return [
        h('div', { key: 'vds-side', className: 'vds-side' },
          h('div', { className: 'vds-side-head' },
            h('span', { className: 'vds-title' }, '会话'),
            h('span', { className: 'vds-spacer' }),
            h('button', { className: 'vds-btn', onClick: addWorkspace }, '＋工作区'),
            h('button', { className: 'vds-btn', onClick: () => { refreshWorkspaces().catch(() => {}) } }, '刷新'),
            h('button', { className: 'vds-btn-ghost', title: '搜索会话', onClick: openSearch }, h(SearchIcon, { size: 14 }))
          ),
          error ? h('div', { className: 'vds-err' }, error) : null,
          secs
        ),
        searchOpen ? overlay : null
      ]
    }

    function SidebarBrowser(props) {
      if (!props.wide) {
        return h('button', { className: 'vds-rail', onClick: props.expandSidebar, title: '会话（点击展开侧边栏）' }, h(FolderIcon, { size: 20 }))
      }
      return h(BrowserWide, props)
    }

    // ---------------- registrations ----------------
    // sidebar.workspaces is a *single* slot already occupied by the shipped
    // ui-workspace browser at default priority 0, and SlotCore throws on a same-
    // priority duplicate ("already has a registration"). A negative priority
    // shadows the incumbent instead (lowest renders); keep it negative.
    slots.inject('sidebar.workspaces', () => slots.register(
      { name: 'sidebar.workspaces', priority: -100 },
      (props) => h(SidebarBrowser, { wide: props.wide, expandSidebar: props.expandSidebar })
    ))

    // The claim machine must run even while the sidebar is folded to its rail,
    // because a blank committed after its first prompt has to reach the Host.
    watchSessions()
    ctx.on('connection/reset', watchSessions)
  },
}

    return plugin;
  }
});
