window.__ModuleLoader__.load({
  id: 'dsh-desktop-client-ui',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { FishLogo, MenuItemButton, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

    // Tight bounds of the mark inside its source artwork.
    const BRAND_MARK_VIEWBOX = { x: 238, y: 220, width: 504, height: 493 }
    // AveryHub robot mark: a bot head with an antenna, drawn in currentColor so
    // it follows the sidebar text color in both themes. The path is traced from
    // the 980x980 source artwork, so the viewBox above keeps its original
    // pixel coordinates. The outer contour, the face hole and the two eye
    // islands use alternating winding, so the default non-zero fill rule
    // paints them.
    const BRAND_MARK_PATH = "M495.5 221.0 L485.5 221.0 L476.5 225.0 L472.0 229.5 L468.0 237.5 L469.0 251.5 L473.0 258.5 L480.0 263.5 L473.5 297.0 L443.5 300.0 L429.5 303.0 L424.5 306.0 L417.0 315.5 L415.0 336.5 L413.5 338.0 L400.5 342.0 L377.5 353.0 L354.5 368.0 L336.5 383.0 L318.0 402.5 L293.5 438.0 L271.5 443.0 L261.0 451.5 L249.0 483.5 L243.0 509.5 L240.0 530.5 L239.0 543.5 L243.0 555.5 L249.5 562.0 L264.0 570.5 L269.0 595.5 L281.0 623.5 L292.0 639.5 L309.5 658.0 L332.5 675.0 L364.5 691.0 L407.5 704.0 L454.5 711.0 L510.5 712.0 L562.5 706.0 L607.5 694.0 L647.5 675.0 L670.5 658.0 L689.0 638.5 L699.0 623.5 L708.0 604.5 L714.0 583.5 L716.0 570.5 L730.5 562.0 L737.0 555.5 L741.0 544.5 L739.0 521.5 L735.0 499.5 L729.0 476.5 L719.0 451.5 L708.5 443.0 L686.5 438.0 L672.0 415.5 L654.0 393.5 L621.5 365.0 L586.5 345.0 L566.5 338.0 L565.0 336.5 L564.0 319.5 L562.0 313.5 L555.5 306.0 L541.5 301.0 L520.5 298.0 L509.5 298.0 L506.0 296.5 L500.0 263.5 L509.0 255.5 L511.0 251.5 L512.0 237.5 L508.0 229.5 L503.5 225.0 ZM652.0 591.5 L634.5 611.0 L615.5 624.0 L593.5 634.0 L553.5 645.0 L523.5 649.0 L469.5 650.0 L446.5 648.0 L408.5 641.0 L386.5 634.0 L366.5 625.0 L345.5 611.0 L330.0 594.5 L323.0 581.5 L318.0 559.5 L319.0 535.5 L322.0 518.5 L329.0 494.5 L342.0 467.5 L360.0 442.5 L385.5 419.0 L410.5 404.0 L440.5 393.0 L469.5 388.0 L511.5 388.0 L549.5 396.0 L575.5 407.0 L604.5 427.0 L625.0 448.5 L641.0 472.5 L655.0 506.5 L660.0 528.5 L662.0 548.5 L660.0 572.5 ZM407.5 567.0 L419.5 562.0 L430.0 550.5 L436.0 535.5 L437.0 515.5 L433.0 499.5 L428.0 490.5 L418.5 481.0 L411.5 478.0 L402.5 477.0 L391.5 481.0 L385.0 486.5 L380.0 493.5 L376.0 501.5 L373.0 513.5 L373.0 530.5 L376.0 542.5 L386.0 558.5 L395.5 565.0 ZM572.5 567.0 L584.5 565.0 L595.0 557.5 L603.0 544.5 L607.0 530.5 L606.0 508.5 L600.0 493.5 L594.0 485.5 L588.5 481.0 L577.5 477.0 L572.5 477.0 L563.5 480.0 L552.0 490.5 L547.0 499.5 L543.0 515.5 L544.0 535.5 L550.0 550.5 L560.5 562.0 Z"

    function DesktopBrandMark() {
      const height = 17
      return React.createElement(
        'svg',
        {
          width: height * BRAND_MARK_VIEWBOX.width / BRAND_MARK_VIEWBOX.height,
          height,
          viewBox: `${BRAND_MARK_VIEWBOX.x} ${BRAND_MARK_VIEWBOX.y} ${BRAND_MARK_VIEWBOX.width} ${BRAND_MARK_VIEWBOX.height}`,
          fill: 'none',
          'aria-hidden': 'true'
        },
        React.createElement('path', { d: BRAND_MARK_PATH, fill: 'currentColor' })
      )
    }

    // The product name is real text rather than the upstream SVG wordmark, so
    // it stays readable, selectable and localisable.
    function DesktopBrandName() {
      return React.createElement(
        'span',
        {
          style: {
            fontSize: 15,
            fontWeight: 600,
            lineHeight: '24px',
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap'
          }
        },
        'averyhub'
      )
    }

    function ConversationBrandMark(props) {
      return React.createElement(FishLogo, props)
    }

    function OpenUnpreviewableFile({ absolutePath, openWorkspacePath }) {
      const [error, setError] = React.useState('')
      const label = document.documentElement.lang?.toLowerCase().startsWith('zh')
        ? '用本地应用打开'
        : 'Open with local app'
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-textpreview-open-local': true,
          onClick: () => {
            setError('')
            void openWorkspacePath(absolutePath).catch((reason) => {
              setError(reason instanceof Error ? reason.message : String(reason))
            })
          }
        }, label),
        error && React.createElement('span', { role: 'alert' }, error)
      )
    }

    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, deleteSession }) {
      const [, setMenuOpen] = useMenuOpenState()
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      const label = chinese ? '永久删除会话' : 'Delete session permanently'
      const warning = chinese
        ? `确定删除“${displayTitle || sessionId}”？工作区文件会保留。此操作无法撤销。`
        : `Delete “${displayTitle || sessionId}”? Workspace files are kept. This can’t be undone.`
      return React.createElement(MenuItemButton, {
        danger: true,
        onSelect: () => {
          setMenuOpen(false)
          if (!window.confirm(warning)) return
          void Promise.resolve().then(() => deleteSession(sessionId)).catch((reason) => {
            window.alert(reason instanceof Error ? reason.message : String(reason))
          })
        }
      }, label)
    }

    function OpenSessionFolderMenuItem({ sessionId, useMenuOpenState, openInFinder }) {
      const [, setMenuOpen] = useMenuOpenState()
      if (typeof window.dshDesktop?.openInFinder !== 'function') return null
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      const label = chinese ? '在文件管理器中打开' : 'Open in file manager'
      return React.createElement(MenuItemButton, {
        onSelect: () => {
          setMenuOpen(false)
          void Promise.resolve().then(() => openInFinder(sessionId)).catch((reason) => {
            window.alert(reason instanceof Error ? reason.message : String(reason))
          })
        }
      }, label)
    }

    function UnreadSessionMenuItem({ sessionId, unread, onUnreadChange, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState()
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      return React.createElement(MenuItemButton, {
        onSelect: () => {
          setMenuOpen(false)
          onUnreadChange(sessionId, !unread)
        }
      }, unread ? (chinese ? '标为已读' : 'Mark as read') : (chinese ? '标为未读' : 'Mark as unread'))
    }

    const ENTERPRISE_NS = 'dsh-desktop-enterprise-entry'
    function EnterpriseEntry({ t }) {
      return React.createElement('a', {
        href: 'https://dshdesktop.com/zh/enterprise/', target: '_blank', rel: 'noopener noreferrer',
        'data-dsh-enterprise-entry': true
      }, t('learnMore'), React.createElement('span', { 'aria-hidden': true }, ' ↗'))
    }

    const REPAIR_NS = 'dsh-desktop-repair'
    function DesktopUtilityActions({ t, wide }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [connected, setConnected] = React.useState(false)
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        const bridge = window.dshDesktop
        const unsubscribe = bridge?.onMobileStatus?.(status => {
          if (mounted.current) setConnected(status.connected === true)
        })
        void bridge?.getMobileStatus?.().then(status => {
          if (mounted.current) setConnected(status.connected === true)
        }).catch(reason => { if (mounted.current) setError(t('phoneFailed')) })
        return () => { mounted.current = false; unsubscribe?.() }
      }, [t])
      const bridge = window.dshDesktop
      if (!bridge) return null
      const open = async (operation) => {
        if (busy) return
        setBusy(true); setError('')
        try {
          const result = await operation()
          if (result?.ok === false) throw new Error(result.error || t('failed'))
        } catch (reason) {
          if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
        } finally { if (mounted.current) setBusy(false) }
      }
      const icon = (kind) => React.createElement('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
      }, kind === 'phone'
        ? React.createElement(React.Fragment, null,
          React.createElement('rect', { x: 7, y: 2.75, width: 10, height: 18.5, rx: 2.25 }),
          React.createElement('path', { d: 'M10.2 5.5h3.6M10.5 18.35h3' }))
        : React.createElement('path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-7.91 7.91a2.12 2.12 0 0 1-3-3l7.91-7.91a6 6 0 0 1 7.94-7.94z' }))
      return React.createElement('div', { 'data-dsh-desktop-utilities': true, 'data-wide': wide },
        typeof bridge.openRepairAgent === 'function' && React.createElement(Tooltip, {
          label: t(busy ? 'opening' : 'description'), side: 'top', align: 'end',
          portal: true, maxWidth: 280, delayMs: 0, focusDelayMs: 0
        }, React.createElement('button', {
          type: 'button', disabled: busy,
          'aria-label': t(busy ? 'opening' : 'open'), 'aria-description': t('description'), 'data-dsh-repair-entry': true,
          onClick: () => { void open(() => bridge.openRepairAgent()) }
        }, icon('repair'))),
        typeof bridge.openMobilePairing === 'function' && (wide || connected) && React.createElement('button', {
          type: 'button', disabled: busy, title: t(connected ? 'phoneManage' : 'phone'),
          'aria-label': t(connected ? 'phoneManage' : 'phone'), 'data-dsh-mobile-entry': true,
          onClick: () => { void open(() => bridge.openMobilePairing()) }
        }, icon('phone'), connected && React.createElement('span', { 'data-connected': true, 'aria-hidden': true })),
        error && React.createElement('span', { role: 'alert', 'data-dsh-utility-error': true }, error))
    }

    // The session-scope slot supplies Harness's public editor actions. Capture the
    // revision before IPC so an async suggestion can never overwrite a user's edit.
    function RepairDraft({ session, input, inputActions }) {
      const currentInput = React.useRef(input)
      currentInput.current = input
      React.useEffect(() => {
        const bridge = window.dshDesktop
        if (typeof bridge?.getRepairDraft !== 'function') return
        let live = true
        const sessionId = session.sessionId
        const span = inputActions.captureInsertion()
        const empty = input.draft === '' && input.attachmentIds.length === 0 && input.phase === 'plain'
        void bridge.getRepairDraft(sessionId).then(async draft => {
          if (!live || typeof draft?.token !== 'string') return
          const current = currentInput.current
          if (empty && current.draft === '' && current.attachmentIds.length === 0 && current.phase === 'plain' && typeof draft.text === 'string' && draft.text !== '') {
            if (inputActions.insertText(draft.text, span)) inputActions.persistDraft()
          }
          // Preserved user input consumes the initial suggestion too; clearing it
          // later must not unexpectedly restore a repair prompt.
          await bridge.acknowledgeRepairDraft(sessionId, draft.token)
        }).catch(reason => { console.warn('[repair] unable to initialize draft', reason) })
        return () => { live = false }
      }, [session.sessionId, inputActions])
      return null
    }

    const inject = ['locale', 'slots', 'remote.session', 'sessions', 'uiWorkspace']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(ENTERPRISE_NS, {
        zh: { learnMore: '了解企业版' }, en: { learnMore: 'Explore Enterprise' }
      }))
      const enterpriseText = ctx.locale.bind(ENTERPRISE_NS)
      ctx.slots.inject('settings.sidebar.footer', () => ctx.slots.register({
        name: 'settings.sidebar.footer', id: 'desktop-enterprise-entry', locale: ENTERPRISE_NS,
        inject: () => ({ t: enterpriseText })
      }, EnterpriseEntry))
      ctx.effect(() => ctx.locale.register(REPAIR_NS, {
        zh: { open: '进入维修模式', description: '维修 Agent：协助排查和修复问题。点击进入修复模式，描述问题后发送。', opening: '正在打开维修…', failed: '无法打开维修会话，请重试', phone: '连接手机', phoneManage: '管理手机连接', phoneFailed: '无法读取手机连接状态' },
        en: { open: 'Enter repair mode', description: 'Repair Agent helps diagnose and resolve problems. Click to enter repair mode, describe the issue, and send when ready.', opening: 'Opening repair…', failed: 'Could not open repair. Please retry.', phone: 'Connect phone', phoneManage: 'Manage phone connection', phoneFailed: 'Could not read phone connection status.' }
      }))
      const repairText = ctx.locale.bind(REPAIR_NS)
      ctx.slots.inject('sidebar.settings.action', () => ctx.slots.register({
        name: 'sidebar.settings.action', id: 'desktop-utilities', locale: REPAIR_NS,
        inject: () => ({ t: repairText })
      }, DesktopUtilityActions))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'desktop-repair-draft'
      }, RepairDraft))
      ctx.effect(() => {
        const id = 'dsh-desktop-preset-toolbar-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.textContent = `
          [data-dsh-enterprise-entry] {
            display:flex; align-items:center; gap:4px; min-height:36px; padding:0 12px;
            border-radius:8px; color:var(--dsw-alias-label-secondary); font-size:13px;
            line-height:20px; text-decoration:none;
          }
          [data-dsh-enterprise-entry]:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
          [data-dsh-enterprise-entry]:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
          :root { --dsh-page-title-top-spacing:56px; }
          [data-dsh-sidebar-settings] { display:flex; align-items:center; }
          [data-dsh-sidebar-settings-content] { flex:1; min-width:0; }
          [data-dsh-sidebar-settings-actions] { flex:none; display:flex; align-items:center; }
          [data-dsh-desktop-utilities] { display:flex; align-items:center; flex:none; position:relative; }
          [data-dsh-desktop-utilities][data-wide=false] { flex-direction:column; }
          [data-dsh-desktop-utilities] button {
            appearance:none; display:inline-flex; align-items:center; justify-content:center;
            width:32px; height:36px; padding:0; position:relative; border:0; border-radius:8px;
            color:var(--dsw-alias-label-secondary); background:transparent; cursor:pointer;
          }
          [data-dsh-desktop-utilities] button > svg { display:block; flex:none; }
          [data-dsh-desktop-utilities] button:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
          [data-dsh-desktop-utilities] button:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
          [data-dsh-desktop-utilities] button:disabled { opacity:.5; cursor:wait; }
          [data-dsh-desktop-utilities] [data-connected] { position:absolute; top:7px; right:5px; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
          [data-dsh-utility-error] { position:absolute; right:0; bottom:100%; width:200px; padding:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-state-error-primary); border-radius:8px; }
          [data-dsh-sidebar-root][data-dsh-sidebar-wide=false] [data-dsh-sidebar-settings] { flex-direction:column; }

          /* Top-level page titles align with the sidebar brand row. Keep
             conversation chrome and detail/dialog headers in their own layout. */
          [data-plugin-panel] > header[data-window-drag] {
            padding-top:var(--dsh-page-title-top-spacing);
          }
          [data-dsh-preset-heading] { display:flex; align-items:center; flex-wrap:wrap; gap:12px 16px; }
          [data-dsh-preset-heading] h2 { margin:0; }
          [data-dsh-preset-actions] { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-left:auto; }
          [data-dsh-preset-actions] button { white-space:nowrap; }
          [data-dsh-preset-search] { margin-bottom:16px; }
          [data-dsh-preset-search] input[type=search] {
            box-sizing:border-box; width:100%; min-width:0; height:36px;
            border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
            background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-primary);
            padding:0 12px; font:inherit; font-size:13px;
          }
          [data-dsh-preset-search] input[type=search]::placeholder { color:var(--dsw-alias-label-caption); }
          [data-dsh-preset-search] input[type=search]:focus-visible {
            outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px;
            background:var(--dsw-alias-bg-base);
          }
        `
        document.head.appendChild(style)
        return () => style.remove()
      })
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.inject('conversation.hero.brand.mark', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark' }, DesktopBrandMark)
            yield ctx.slots.register({ name: 'sidebar.brand.name' }, DesktopBrandName)
            yield ctx.slots.register(
              { name: 'conversation.hero.brand.mark' },
              ConversationBrandMark
            )
          })
        )
      )
      ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () =>
        ctx.slots.register({
          name: 'sidebar.right.tab.document.unpreviewable',
          id: 'desktop-open-local',
          inject: () => ({
            openWorkspacePath: (path) => ctx.remote.session.openWorkspacePath({ path })
          })
        }, OpenUnpreviewableFile)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-delete-session',
          order: 900,
          inject: () => ({
            deleteSession: (sessionId) => {
              const workspace = ctx.get('uiWorkspace')
              if (!workspace) throw new Error('Workspace navigation is unavailable')
              return workspace.deleteSession(sessionId)
            }
          })
        }, DeleteSessionMenuItem)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-open-session-folder',
          order: 800,
          inject: () => ({
            openInFinder: (sessionId) => {
              const cwd = ctx.get('sessions').list.getSnapshot().byId[sessionId]?.cwd
              if (!cwd) throw new Error('Session workspace directory is unavailable')
              return window.dshDesktop.openInFinder(cwd)
            }
          })
        }, OpenSessionFolderMenuItem)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-unread-session',
          order: 350
        }, UnreadSessionMenuItem)
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
