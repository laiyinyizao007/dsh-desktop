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

The plugin also watches its own adaptations: see "Watching the adaptations"
in the responsive plugin's README.
