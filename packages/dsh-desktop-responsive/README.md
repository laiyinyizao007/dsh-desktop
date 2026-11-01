# dsh-desktop-responsive

Phone-width layout for the Harness web UI.

At or below 640 px the upstream three-column frame stops working: the
expanded sidebar keeps a 264-420 px column and squeezes the centre column
to about 110 px, the settings dialog leaves its body about 200 px, and the
conversation body pins its content at the 680 px floor of its width clamp.

This plugin:

- turns the **expanded sidebar** into an overlay drawer that floats over the
  content, with a scrim, Escape-to-close and an inert content area;
- **hides the collapsed rail** and replaces it with a menu button, so a
  phone gives the whole width to the content;
- turns the **settings dialog** into a full-screen page whose section list
  becomes a horizontal tab strip along the top;
- lets the **conversation content** and the **home composer** follow the
  viewport instead of the 680 px clamp floor;
- gives the **messages you send** the full text column instead of the 70%
  upstream reserves for them;
- **folds the top and bottom chrome away**: the header's view tabs collapse
  behind a chevron, and the composer's status row collapses behind a single
  *usage stats* entry that opens it as a bottom sheet;
- **folds the model selector** to its icon, so the composer toolbar stops
  spending 80 px on a truncated model name;
- **follows the on-screen keyboard**: the shell is sized to the visual
  viewport, so the composer stays above the keyboard instead of under it.

## Adapting to the screen

The shell follows the **visible** size of the screen on both axes, not the
size of the layout viewport.

A phone's keyboard takes part of the screen *without* changing the layout
viewport, so `height: 100%` still resolves to the full screen. The composer
sticks to the bottom of its scroll port and ends up under the keyboard, and
the page looks the wrong height; in landscape the keyboard takes width as
well, and the content runs off the side.

The visual viewport is the only thing that knows how much of the screen is
left. The plugin publishes it as `--dsh-visual-width` and
`--dsh-visual-height` on the root and sizes the shell to it. The smaller of
the visual viewport and the window size is used on each axis, so the shell
never grows past the layout viewport when a browser bar retracts.

A visual viewport that is **too small to be a keyboard** is ignored. A
phone's keyboard never covers more than half the screen, so anything below
that share is not a keyboard: it is a web view reporting a viewport that
never settled, or one measured while a sheet was open. Trusting such a
number would leave the shell a third of the screen tall, with the rest of
the page bare.

The measurement is also repeated on a timer and after the focused field
gives up the focus, because a web view does not always say when the
viewport changed, and the keyboard restores the visible size a moment
after the field loses the focus.

What the plugin measured is published on the root as
`data-dshr-viewport`, as `published/window/viewport`. A device that shows a
wrong layout can be asked what the plugin saw:

```js
document.documentElement.getAttribute('data-dshr-viewport')
```

A pinch-zoom is not a smaller screen: the visual viewport shrinks when the
user zooms in, and re-laying out the shell then would fight the zoom, so the
layout viewport is used instead.

The layout mode follows the narrower of the frame and the visible width, so
it is never laid out for more space than the user can see. The rule is not
scoped to the phone layout — a desktop window that is resized or dragged
shorter is the same case.

## The messages you send

Upstream caps the sent-message stack at 70% of the content width, and at 82%
at most. On a phone that leaves your own message in about two thirds of the
screen, and a long message wraps far earlier than it needs to.

On a phone the stack is given the whole text column instead. The bubble
inside keeps its own maximum, so a short message still renders as a small
bubble and only a long one grows — which is how a phone chat is expected to
look.

The text column itself is wider on a phone as well. Upstream seats the
conversation flow 32 px inside the composer card — 16 px of side clearance
on each side — and the flow keeps a gutter of its own on top of that. On a
390 px phone that left a long message in a 303 px column: 78% of the
screen, with 47 px of blank space beside it. The clearance is dropped, the
flow's own gutter becomes the only margin around the conversation, and a
long message now takes 351 px — 90% of the screen, which is where a phone
chat puts it.

## The usage sheet

The status row under the composer holds the token count, the cost, the cache
hit rate and the context meter — six numbers in one line. On a phone that is
a lot of screen for information nobody reads while typing.

The row is folded away, and a single *usage stats* entry brings it back as a
bottom sheet. The entry lives in the **model menu**, which is already the
place where the model, the reasoning effort and the session's other knobs
live — so the phone gains one unified entry instead of a new floating
control on an already crowded screen.

The sheet **is** the row: the row is promoted to a fixed bottom panel with a
backdrop and a drag handle, and its items stack vertically. Nothing is moved
in the DOM, so React never sees a change and the row's own slot
contributions — the cost meter, the context meter — come along unchanged.

The entry is injected into the menu while that menu is open. Upstream
renders the menu into a portal on the body, and several menus share that
surface, so the plugin picks the model menu out by the name upstream gives
it. The plugin keeps that name in its own dictionary, and
`test/responsive-layout.test.mjs` fails when the two drift apart: a renamed
menu would otherwise leave the phone without an entry at all.

The sheet sits at z-index 1200, above upstream's portals: the context
meter's tooltip and the model picker both live at 1100, and they would
otherwise float on top of it. It carries `role="dialog"` and
`aria-modal="true"`, takes the focus when it opens, keeps Tab inside itself
while it is open, and closes on Escape, on a backdrop click, or on a drag
of the handle.

## The model selector

Upstream folds the model name to its icon when the controls cannot share a
line, but it measures the *truncated* label, so a long model name still
shows as "MiniMax-M3 H…".

The seat reads two inherited variables, so the plugin sets them on the
document root: the model label is hidden and its icon takes over. That
leaves the composer toolbar ~80 px narrower without touching the row
upstream measures — and without fighting the observer it puts on that row.

The menu behind the icon is where the *usage stats* entry is added.

## Type and icons

The chrome's smallest labels are 11 px and 12 px. That is fine on a
desktop and too small on a phone. The theme hands the sizes out as design
tokens, so the phone layout raises the small end of the scale without
touching a single component.

The **reading** size is different: it is a user setting. The theme writes
it onto the body as an inline style and the settings dialog exposes it, so
the plugin only nudges it while it is still the default — a deliberate
choice wins.

The icons in the surfaces the reader touches most are 14 px and 16 px. They
carry their size as attributes, which a stylesheet can override; only the
icons inside a button are resized, so the artwork keeps its proportions.

## The header's actions

Six small buttons share the top-right corner: the open-in-app actions, the
bottom panel, the diagnostics and the right sidebar. At 28 px each they take
a third of a phone's width, and none of them is a target a thumb can hit.

They collapse into one menu instead. The containers are not moved in the
DOM — they are lifted out of the header's grid and parked below it, so
React never sees a change and every button keeps its own owner. A tap
outside the menu, or Escape, puts it away.

The floating controls — the menu button, the view-tabs chevron and this
menu's trigger — share the title row's centre line. The row's height
follows its content (a session with a running task is taller than one
without), so the line is measured and published as `--dsh-header-centre`
rather than pinned to a fixed offset that drifts by a couple of pixels.

The measurement has to take the plugin's own move back out. The frame is
moved down by the visual offset so that the header stays on the screen
when the keyboard opens, and the row moves with it — so reading the row's
position as it stands would place the controls wherever the header was
pushed to, and the header would be left with its title alone.

## Adding items to the collapsed menu

The collapsed menu **is** upstream's own slot. A plugin that injects into
`conversation.session.header.utilities` lands in it for free, and that is the
better path: the item stays a React component and keeps the host's own
styling.

```ts
export const inject = ['slots']
export function apply(ctx: Context) {
  ctx.effect(() =>
    ctx.slots.inject('conversation.session.header.utilities', () =>
      ctx.slots.register(
        { name: 'conversation.session.header.utilities' },
        () => <MyButton />,
      ),
    ),
  )
}
```

For the plugins that cannot speak React there is a service of this plugin's
own. It takes a plain description and the plugin renders a button in a strip
of its own, inside the menu:

```ts
export const inject = ['dshDesktopResponsive']
export function apply(ctx: Context) {
  ctx.effect(() => {
    const service = ctx.get('dshDesktopResponsive')
    return service.registerAction({
      id: 'my-plugin:action',
      label: 'My action',
      icon: '<svg viewBox="0 0 16 16">…</svg>',
      onSelect: () => doTheThing(),
    })
  })
}
```

`registerAction` returns a function that removes the item. Registering the
same id twice replaces the earlier item, so a plugin can update its entry
without knowing whether it is already there.

The strip publishes its width as `--dsh-actions-extra`, and the upstream
containers move aside for it — so the menu stays one row however many items
are in it.

## The bottom workbench's handle

The bottom panel of the better-sidebar plugin is a desktop workbench. On a
phone it sits below the fold, translated out of the way — but its resize
handle is drawn four pixels above the panel's own edge, so a strip of it
stays on the screen and can be dragged up.

On a phone the plugin takes that handle away: it stops taking the pointer
and no longer offers a resize cursor. A wide window keeps the drag.

The workbench itself is a band along the bottom of a desktop window, and
on a phone it becomes a **full-screen overlay** instead — a file tree in a
band a third of the screen tall is no use to anybody.

That also settles the gap the band used to leave. The layout pushes the
columns down by the height it reserves for the panel, while the panel
itself is drawn at a height that includes the keyboard's inset, so the two
disagreed and the difference showed as a bare band above the panel. A
screen-filling panel leaves nothing to disagree about.

The panel is mounted in a fixed layer of its own, and that layer is what
the panel's z-index is measured against — so the plugin marks the layer and
raises it above its own floating controls, which would otherwise show
through the panel's tab bar.

The handle carries no attribute of its own, so it is found through the one
thing that says what it is — it is the panel's first child and it offers a
row-resize cursor. Both have to hold before the plugin touches it, so a
panel that grows a header is left alone.

## Reading comfort

**Tables.** Upstream keeps a wide table's horizontal scroll bar hidden until
the pointer hovers it. A phone has no pointer, so the table stayed clipped
and its last columns were simply out of reach. On a phone the container
always scrolls, and a soft shadow at its right edge says there is more to
the side. The shadow follows the scroll position: it disappears once the
last column is in view, because a hint that points at nothing is worse than
no hint.

**Line height.** The markdown body takes its line height from a design
token, and 24 px on a 14 px face reads tight for a long answer. The
paragraphs get a little more air on a phone, where the line is short and the
eye has less to hold on to.

**Floating controls.** A small control pinned to the corner of the screen
lands on the body text. The plugin adopts the small fixed controls in that
corner — it cannot know which button is meant, since the button may come
from any package — and gives them a translucent, blurred surface, so they
stay readable without hiding what is underneath.

## The collapsed rail

The rail is 56 px wide on Linux and on Windows without a title bar — a sixth
of a phone screen spent on icons. On a phone the plugin zeroes that track
and renders a menu button where the rail's own toggle was, so the whole
width goes to the content.

The button is only shown where the rail actually took space. On macOS and on
a window with a title bar the rail is already zero-width, because the native
window controls live there — a button would sit on top of them.

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
| `sidebarCollapsed` | `[data-sidebar-collapsed]` | upstream attribute | `dsh-client-ui-layout` |
| `sidebarToggle` | `[data-dsh-region="sidebar-toggle"]` | marker | `dsh-client-ui-sidebar` |
| `conversationContent` | `[data-conversation-content]` | upstream attribute | `dsh-client-ui-conversation` |
| `modelMenu` | `[data-menu-material="translucent"]` | upstream attribute | `dsh-client-ui-primitives` |
| `table` | `table` | semantic element | `dsh-client-ui-primitives` |
| `composerRegion` | `[data-conversation-region="composer"]` | upstream attribute | `dsh-client-ui-conversation` |
| `titleRow` | `[data-dsh-region="conversation-title-row"]` | marker | `dsh-client-ui-conversation` |
| `headerUtilities` | `[data-slot="conversation.session.header.utilities"]` | upstream attribute | `dsh-client-ui-conversation` |
| `headerCorner` | `[data-slot="conversation.session.header.corner"]` | upstream attribute | `dsh-client-ui-conversation` |
| `conversationWidthHandle` | `[data-width-handle]` | upstream attribute | `dsh-client-ui-conversation` |
| `workspaceRow` | `[data-dsh-region="conversation-workspace-row"]` | marker | `dsh-client-ui-conversation` |
| `chatUserStack` | `[data-dsh-region="chat-user-stack"]` | marker | `dsh-client-ui-chat` |
| `conversationHeader` | `[data-dsh-region="conversation-header"]` | marker | `dsh-client-ui-conversation` |
| `conversationTabs` | `[data-dsh-region="conversation-tabs"]` | marker | `dsh-client-ui-conversation` |
| `composerDock` | `[data-dsh-region="composer-dock"]` | marker | `dsh-client-ui-conversation` |
| `settingsOverlay` | `[data-dsh-region="settings-overlay"]` | marker | `dsh-client-ui-settings-general` |
| `settingsNav` | `[data-dsh-region="settings-nav"]` | marker | `dsh-client-ui-settings-general` |
| `settingsNavList` | `[data-dsh-region="settings-nav-list"]` | marker | `dsh-client-ui-settings-general` |
| `settingsNavTitle` | `[data-dsh-region="settings-nav-title"]` | marker | `dsh-client-ui-settings-general` |
| `settingsContent` | `[data-dsh-region="settings-content"]` | marker | `dsh-client-ui-settings-general` |
| `settingsHeader` | `[data-dsh-region="settings-header"]` | marker | `dsh-client-ui-settings-general` |
| `settingsOptions` | `[data-dsh-region="settings-options"]` | marker | `dsh-client-ui-settings-general` |
| `settingsFooter` | `[data-dsh-settings-sidebar-footer]` | upstream attribute | `dsh-client-ui-settings-general` |

A *marker* anchor is a `data-dsh-region` attribute this repository adds to
upstream through a minimal patch. The patch only adds an attribute; it never
restructures upstream's render tree.

`test/responsive-layout.test.mjs` guards the manifest: it fails when an
anchor disappears from its package, when a patch stops carrying its marker,
when the plugin selects on anything that is not in the manifest, when the
plugin relies on upstream's DOM *structure* (`:first-child` and friends), and
when a patch file no longer carries the installed upstream version. The cost
of an upstream upgrade is therefore one manifest entry per changed surface,
not a hunt through renamed class names.

## What an upstream upgrade costs

The plugin is written so that a new Harness release does not become a chase:

- **The build never breaks.** `patch-package` applies a patch whose file name
  carries another version, and it only warns. A patch whose context no
  longer matches is skipped with an error — and the install still succeeds.
  The desktop keeps booting; the affected surface degrades.
- **The breakage is named, not silent.** The plugin audits its anchors at
  runtime and logs which ones upstream no longer provides, on the console and
  on `data-dshr-missing`. It also checks the *symptom*: if the conversation
  content overflows the frame, or the frame is no longer a three-column
  grid, it says so on `data-dshr-problem`. A renamed design token is
  reported even though no marker went missing.
- **The test points at the fix.** The failing test names the anchor, its
  upstream package and whether the patch still carries it.

## The breakpoint

The layout adapts to the **frame's** width, not the window's: the desktop
shell and the embedded web view can both put the frame in a pane narrower
than the window, and a media query on the window would miss that. The
decision is written to `data-dshr-mode` on the document root.

The settings dialog is the exception — it is portalled into the body and
covers the viewport, so it follows the window and carries its own
`data-dshr-mode`.
