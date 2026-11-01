# The filter pills lose their text on a narrow panel

**Repository**: https://github.com/OliverLiy/projectHub
**File**: `src/client/styles.js`, the `@container pc-app (max-width:760px)` block

## The symptom

On a phone the filter pills along the top of the console are squeezed until
their text is clipped, and they overlap each other. "需关注 9" runs into
"日常工作 4", and the counts stop being readable.

## What the code does

```css
@container pc-app (max-width:760px){
  .pc-rail{flex:0 0 auto;flex-direction:row;gap:6px;padding:8px 10px;border-right:0;border-bottom:1px solid var(--pc-line);overflow-x:auto;overflow-y:hidden}
  .pc-rail-item{width:auto;height:28px;padding:0 10px;border:1px solid var(--pc-line-2);border-radius:999px}
```

The row becomes a horizontal scroller, which is right. But the pills inside
it are flex items with the default `flex-shrink: 1`, so they are squeezed
to fit the row rather than the row scrolling to fit them. Their `width:auto`
is their content's width before that squeeze, and the text is clipped
after it.

## The fix

```css
.pc-rail-item{flex:0 0 auto;width:auto;height:28px;padding:0 10px;border:1px solid var(--pc-line-2);border-radius:999px}
```

`flex: 0 0 auto` keeps each pill at the width its text needs; the row's
`overflow-x:auto` then does what it was put there to do.

## Where it was found

The DSH Desktop's phone layout adapts the console to a phone, and the pills
were the first thing that did not survive the width. The adaptation lives in
https://github.com/dataelement/dsh-desktop — the plugin
`dsh-desktop-responsive` — and the analysis is written up there as well.
