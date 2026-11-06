/**
 * Say something while the client is still coming up.
 *
 * The page is a client that downloads about three megabytes of JavaScript
 * before the app mounts. Over a slow link — a phone on a mobile network,
 * or a first visit through a tunnel whose edge does not hold the bundles
 * yet — that takes tens of seconds. Until it is over the page says nothing:
 * a white screen with a spinner, and no way to tell whether it is working
 * or stuck.
 *
 * So the notice counts the seconds and carries a retry button. A page that
 * is not going to come up can then be asked to try again instead of being
 * stared at.
 *
 * The upstream boot screen marks itself with `data-dsh-boot`, and the card
 * is gone once the app has mounted — so the notice knows when to get out of
 * the way without knowing anything else about the app.
 */

/** The marker that says the notice is already in the page. */
const BOOT_NOTICE_MARKER = 'data-dsh-boot-notice'

/**
 * How long the boot may take before the notice says anything.
 *
 * A warm edge cache brings the page up in about two seconds; a cold one
 * takes twenty. Eight seconds is past the warm case and well before the
 * cold case has given up.
 */
const BOOT_NOTICE_AFTER_SECONDS = 8

/** The notice itself. */
function buildBootNotice() {
  return `<div ${BOOT_NOTICE_MARKER} style="display:none;position:fixed;left:50%;top:calc(14px + env(safe-area-inset-top));transform:translateX(-50%);z-index:2147483001;align-items:center;gap:10px;padding:8px 10px 8px 15px;border-radius:999px;background:rgba(24,24,30,.88);color:#cdd6f4;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)">
  <span data-dsh-boot-notice-text style="white-space:nowrap">加载中…</span>
  <button type="button" data-dsh-boot-notice-retry title="重新加载 / Reload" aria-label="重新加载 / Reload" style="display:grid;place-items:center;width:28px;height:28px;margin:0;border:0;border-radius:50%;background:rgba(205,214,244,.16);color:#cdd6f4;font:15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer">&#8635;</button>
</div>
<script>
(function () {
  var notice = document.querySelector('[${BOOT_NOTICE_MARKER}]')
  if (notice === null) return
  var text = notice.querySelector('[data-dsh-boot-notice-text]')
  var retry = notice.querySelector('[data-dsh-boot-notice-retry]')
  var started = Date.now()
  var shown = false

  // The app has come up when the boot card is gone and the root holds
  // something. An empty root means the client has not run at all, which is
  // still booting as far as the reader is concerned.
  function booting() {
    var root = document.getElementById('root')
    if (root === null) return true
    if (root.querySelector('[data-dsh-boot]') !== null) return true
    return root.children.length === 0
  }

  function tick() {
    if (!booting()) {
      notice.remove()
      return
    }
    var seconds = Math.round((Date.now() - started) / 1000)
    if (seconds >= ${BOOT_NOTICE_AFTER_SECONDS}) {
      if (!shown) {
        shown = true
        notice.style.display = 'flex'
      }
      text.textContent = seconds < 45
        ? '加载中… ' + seconds + 's'
        : '加载较慢… ' + seconds + 's'
    }
    setTimeout(tick, 1000)
  }

  retry.addEventListener('click', function () { location.reload() })
  setTimeout(tick, 1000)
})()
</script>`
}

/**
 * Put the notice into a page.
 *
 * The notice is a sibling of the app rather than a part of it: the app
 * replaces the whole body when it mounts, so anything inside the app's own
 * tree would be thrown away with it.
 *
 * @param html - the page
 * @returns the page with the notice in it
 */
export function injectBootNotice(html) {
  if (typeof html !== 'string' || html === '') return html
  if (html.includes(BOOT_NOTICE_MARKER)) return html
  const notice = buildBootNotice()
  const bodyEnd = html.toLowerCase().lastIndexOf('</body>')
  if (bodyEnd === -1) return html + notice
  return html.slice(0, bodyEnd) + notice + html.slice(bodyEnd)
}
