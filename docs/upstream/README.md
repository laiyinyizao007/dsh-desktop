# Reports to the plugins this repository adapts

The phone layout in `packages/dsh-desktop-responsive` adapts the surfaces of
two other plugins: the bottom workbench and the project console. Their class
names are semantic rather than hashed, but they belong to somebody else,
and a plugin that is upgraded may rename them.

So the fixes belong upstream, where they will keep working. These are the
reports, written to be sent:

| Plugin | File | What |
| --- | --- | --- |
| `dsh-workbench-project-console` | `projectHub-console-narrow.md` + `.patch` | The filter pills lose their text on a narrow panel. A patch is attached. |
| `dsh-better-sidebar` | `better-sidebar-keyboard-inset.md` | The keyboard inset counts the browser's own bars, so the bottom workbench is lifted by the height of the address bar. An issue rather than a patch: there is no standard way to tell the keyboard's height from the chrome's on iOS, and the fix needs a device to try. |

The Harness itself is adapted in the same way: the proxy in front of it
fixes the session cookie's `SameSite` on the way out, because the Harness
issues it `Strict` and that breaks a cross-site arrival — a QR code, a
chat message, a bookmark in another app.

| Upstream | File | What |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-connection` | `session-cookie-same-site-strict.md` | The session cookie is `SameSite=Strict`, so a cross-site arrival never finishes the token exchange and the app never loads. |

The Harness's repository has issues disabled, so this one goes to
**Discussions** rather than an issue.

None of them has been sent yet. The GitHub token this machine holds is a
fine-grained one with read access to those repositories and no write
access, so a post cannot be made from here without extending it: give it
"Discussions: read and write" on `deepseek-ai/deepseek-harness` and
"Issues: read and write" on `omdsh-dev/DSH-better-sidebar`, and the
reports can go out as they are written.

The plugin also watches its own adaptations: see "Watching the adaptations"
in the responsive plugin's README.
