# dsh-desktop-responsive

Phone-width layout for the Harness web UI.

At or below 640 px the upstream three-column frame stops working: the
expanded sidebar keeps a 264-420 px column and squeezes the centre column
to about 110 px, the settings dialog leaves its body about 200 px, and the
conversation body pins its content at the 680 px floor of its width clamp.

This plugin:

- turns the **expanded sidebar** into an overlay drawer that floats over the
  content, with a scrim, Escape-to-close and an inert content area;
- turns the **settings dialog** into a full-screen page whose section list
  becomes a horizontal tab strip along the top;
- lets the **conversation content** and the **home composer** follow the
  viewport instead of the 680 px clamp floor.

## The upstream contract

Upstream's CSS module class names are hashed (`pI_x6G_frame`) and the hash
changes on every upstream build, so selecting on them breaks silently. This
plugin binds only to the anchors listed in `ANCHORS` in `client.js`:

| Anchor | Selector | Origin | Upstream package |
| --- | --- | --- | --- |
| `frame` | `[data-dsh-region="layout"]` | marker | `dsh-client-ui-layout` |
| `sidebar` | `[data-dsh-region="sidebar"]` | marker | `dsh-client-ui-layout` |
| `center` | `[data-dsh-region="center"]` | marker | `dsh-client-ui-layout` |
| `rightbarColumn` | `[data-rightbar-col]` | upstream attribute | `dsh-client-ui-layout` |
| `sidebarResizeHandle` | `[data-side="sidebar"]` | upstream attribute | `dsh-client-ui-layout` |
| `sidebarToggle` | `[data-dsh-region="sidebar-toggle"]` | marker | `dsh-client-ui-sidebar` |
| `conversationContent` | `[data-conversation-content]` | upstream attribute | `dsh-client-ui-conversation` |
| `conversationWidthHandle` | `[data-width-handle]` | upstream attribute | `dsh-client-ui-conversation` |
| `workspaceRow` | `[data-dsh-region="conversation-workspace-row"]` | marker | `dsh-client-ui-conversation` |
| `settingsOverlay` | `[data-dsh-region="settings-overlay"]` | marker | `dsh-client-ui-settings-general` |
| `settingsNav` | `[data-dsh-region="settings-nav"]` | marker | `dsh-client-ui-settings-general` |
| `settingsNavList` | `[data-dsh-region="settings-nav-list"]` | marker | `dsh-client-ui-settings-general` |
| `settingsNavTitle` | `[data-dsh-region="settings-nav-title"]` | marker | `dsh-client-ui-settings-general` |
| `settingsContent` | `[data-dsh-region="settings-content"]` | marker | `dsh-client-ui-settings-general` |
| `settingsOptions` | `[data-dsh-region="settings-options"]` | marker | `dsh-client-ui-settings-general` |
| `settingsFooter` | `[data-dsh-settings-sidebar-footer]` | upstream attribute | `dsh-client-ui-settings-general` |

A *marker* anchor is a `data-dsh-region` attribute this repository adds to
upstream through a minimal patch. The patch only adds an attribute; it never
restructures upstream's render tree.

`test/responsive-layout.test.mjs` guards the manifest: it fails when an
anchor disappears from its package, when a patch stops carrying its marker,
and when the plugin selects on anything that is not in the manifest. The cost
of an upstream upgrade is therefore one manifest entry per changed surface,
not a hunt through renamed class names.

## The breakpoint

The layout adapts to the **frame's** width, not the window's: the desktop
shell and the embedded web view can both put the frame in a pane narrower
than the window, and a media query on the window would miss that. The
decision is written to `data-dshr-mode` on the document root.

The settings dialog is the exception — it is portalled into the body and
covers the viewport, so it follows the window and carries its own
`data-dshr-mode`.
