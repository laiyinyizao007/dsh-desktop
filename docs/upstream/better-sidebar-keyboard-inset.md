# better-sidebar: the keyboard inset counts the browser's own bars

**Repository**: https://github.com/omdsh-dev/DSH-better-sidebar
**File**: `src/client/Sidebar.tsx`, the `keyboardInset` effect

## The symptom

On a phone the bottom workbench is lifted off the bottom of the screen by
the height of the browser's own address bar, and the space it leaves
between the panel and the bottom of the window is empty.

## What the code does

```ts
const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
setKeyboardInset(inset > 1 ? Math.round(inset) : 0)
```

`window.innerHeight` is the **layout** viewport, and on iOS Safari it still
covers the browser's own bars — the address bar is drawn *over* the layout
viewport rather than taking room from it. `visualViewport.height` is the
**visual** viewport, which does exclude them.

So the difference is the browser's chrome *as well as* the keyboard, and the
whole of it is treated as the keyboard. `visualViewport.offsetTop` does not
make up for it: that is the scroll offset of the visual viewport inside the
layout one, and it is zero unless the page is scrolled.

The comment above the effect already knows about the chrome — it says
`offsetTop` is non-zero "while the visual viewport is scrolled/zoomed under
browser chrome" — but on a phone the chrome is there whether the page is
scrolled or not.

## Why it matters here

The inset is used twice: the panel is anchored `keyboardInset` above the
bottom of the window, and the same amount is pushed out of the app shell's
centre column. The panel therefore clears the address bar, and the column
gives up the height of the address bar as well — so on a phone with the
keyboard closed the workbench sits a bar's height above the bottom edge.

## The question

Is there a way to tell the keyboard's height from the chrome's on iOS?
Tracking the smallest inset seen so far — the chrome alone, with no
keyboard over it — and subtracting that from the current one would work,
but it is wrong if the first measurement ever happens with the keyboard
already open.

## Why this was found

The DSH Desktop's phone layout adapts the bottom workbench to a phone, and
the gap between the conversation and the panel turned out to be this
height. The adaptation lives in
https://github.com/dataelement/dsh-desktop — the plugin `dsh-desktop-responsive` —
and the analysis is written up there as well.
