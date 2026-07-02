# netbird-gnome Audit

Audited: `netbird-gnome/` at HEAD of working tree, against `gjs-guide/` (GJS/GNOME Shell reference)
and the bundled *GNOME Shell Extensions Review Guidelines* PDF (identical content to
`gjs-guide/docs/extensions/review-guidelines/review-guidelines.md`; cited below as "Review
Guidelines § <section>"). Dynamic checks were run with GJS 1.88 (`gjs -m`); the API test suite
(`./test-api.bash`) passes 35/35 on the unmodified tree.

## 1. Summary

The architectural core is sound: a full transitive import scan confirms the GTK/Shell boundary is
intact (no Gtk/Gdk/Adw reachable from `extension.js`; no Shell modules reachable from the
standalone windows; `api/index.js` imports only Gio/GLib), and the Quick Settings
lifecycle largely follows the reference pattern in `gjs-guide/docs/extensions/topics/quick-settings.md`.
However, two review-blocking Critical defects exist: the "Add Profile" dialog subclasses
`ModalDialog` without `GObject.registerClass()` and therefore crashes on open (reproduced on GJS
1.88), and `disable()` never terminates the spawned settings/networks GTK processes despite
CODEBASE.md and the review guidelines requiring it. A verified High-severity transport bug makes
every request hang for its full timeout whenever the daemon serves a chunked response without
closing the connection.

| ID | Title | Severity | File:Line |
|----|-------|----------|-----------|
| C1 | "Add Profile" dialog crashes: GObject subclass never registered | Critical | shellProfileDialog.js:7 |
| C2 | `disable()` leaves spawned settings/networks windows running | Critical | extension.js:914 |
| H1 | Chunked response on a kept-alive socket hangs until the timeout | High | api/index.js:761 |
| M1 | Unbounded response buffering with O(n²) header scan | Medium | api/index.js:776 |
| M2 | Synchronous file I/O on the GNOME Shell main loop | Medium | api/index.js:953, profileState.js:18 |
| M3 | Daemon/peer strings rendered as Pango markup in the GTK windows | Medium | networks-window.js:591 |
| L1 | `get_if_exited()` on a running process logs GLib-GIO-CRITICAL | Low | extension.js:833 |
| L2 | Profile name used unvalidated in a state-file path | Low | profileState.js:11 |
| L3 | `parseContentLength` accepts non-decimal values; wrong framing precedence | Low | api/index.js:859 |
| L4 | `decodeChunkedBody` accepts negative chunk sizes | Low | api/index.js:889 |
| L5 | `applyChanges()` reconnects even when no changed setting requires it | Low | settingsManager.js:187 |
| E1 | No gettext/i18n anywhere | Enhancement | extension.js:77 (et al.) |
| E2 | Missing accessible labels on icon-only/unlabeled controls | Enhancement | networks-window.js:509 |
| E3 | Dead `_settingCheckedFromStatus` flag | Enhancement | extension.js:99 |
| E4 | Test suite does not cover the HTTP framing edge cases | Enhancement | tests/api.test.js:226 |

**Verified clean (no finding):**
- Import boundary (Method step 1): full transitive scan of every `import` in the tree.
  `extension.js` → {`api/index.js`, `extensionErrors.js`, `profileState.js`, `shellProfileDialog.js`}
  reaches only `GObject/Gio/GLib/St/Clutter` and `resource:///` Shell modules. The standalone
  windows reach only `Gtk/Gdk/Adw/Gio/GLib` and never a `resource:///` import. `api/index.js`
  imports only `Gio` and `GLib`. No dynamic `import()` anywhere. Satisfies Review Guidelines
  § "Do not import GTK libraries in GNOME Shell" / § "Do not import GNOME Shell libraries in Preferences".
- `NetBirdExtension` has no constructor (no work before `enable()`); icons, indicator, toggle,
  menu items, signals, timeouts and cancellables are all created inside the `enable()` call graph
  (Review Guidelines § "Only use initialization for static resources").
- `NetBirdToggle.destroy()` (extension.js:775–789) removes both initial-refresh timeout sources,
  disconnects the tracked `open-state-changed` signal, cancels both cancellables and destroys the
  dialog; `NetBirdIndicator.destroy()` (extension.js:806–817) destroys `quickSettingsItems` then
  chains up — this matches `gjs-guide/src/extensions/topics/quick-settings/extension.js:153–155`
  exactly. In-flight `callNetBird` calls remove their own `GLib.timeout_add` source and disconnect
  the cancellable handler in `finally` (api/index.js:375–380), so cancelling on destroy also
  removes every transport-owned main-loop source (Review Guidelines § "Remove main loop sources").
- Request `Content-Length` is computed from encoded bytes, not JS string length
  (api/index.js:290: `new TextEncoder().encode(requestBody).length`) — correct.
- `spawnv` argv (extension.js:836–841) is a fixed array (`[gjs, '-m', windowPath]`) built from
  `this.dir`; no shell interpolation, no privileged helper, environment inherited plus one
  extension-dir variable. `NETBIRD_GNOME_EXTENSION_DIR` is only used to add an icon search path in
  the same-user child (windowIcon.js:43–48) — not a privilege boundary.
- metadata.json is well-formed: uuid `gnome@netbird.io` matches the required
  `extension-id@namespace` form and doesn't use `gnome.org` as namespace; `shell-version`
  ["46".."50"] contains only released versions; no unnecessary keys (Review Guidelines
  § "metadata.json must be well-formed"). Nothing in
  `gjs-guide/docs/extensions/upgrading/gnome-shell-46..50.md` breaks the APIs used
  (`QuickMenuToggle`, `SystemIndicator`, `addExternalIndicator`, `PopupImageMenuItem`, `ModalDialog`).
- pack-extension.bash includes exactly the runtime modules + icons + LICENSE (plus the automatic
  extension.js/metadata.json), and excludes tests, `.vscode`, the design file, the PDF and
  CODEBASE.md (Review Guidelines § "Don't include unnecessary files").

## 2. Findings

### C1 — "Add Profile" dialog crashes: GObject subclass never registered (Critical)

**Location:** `shellProfileDialog.js:7` (class declaration); construction site `extension.js:266`.

**What's wrong.** `ProfileNameDialog` extends `ModalDialog.ModalDialog` — a GObject class — as a
plain ES class. `gjs-guide/docs/guides/gobject/subclassing.md` § "Subclassing GObject" is explicit:
"Every class of GObject has a globally unique GType and so each subclass **must be registered
using the `GObject.registerClass()` function**." Without registration the subclass has no GType,
and construction fails. Reproduced on GJS 1.88 (the version range shipping with the targeted
shells): instantiating an unregistered subclass of a registered GObject class throws
`Error: Tried to construct an object without a GType`.

Consequence: clicking *Add Profile* in the Quick Settings menu throws inside the `activate`
handler at `extension.js:266`; the dialog never opens, every time. That makes a headline feature
fundamentally broken — Review Guidelines § "Extensions must be functional": "if an extension is
tested and found to be fundamentally broken it will be rejected." (Note the gjs-guide's own
`ModalDialog` example, `src/extensions/topics/dialogs/modalDialogModalDialog.js`, avoids this by
instantiating `ModalDialog.ModalDialog` directly rather than subclassing.)

**Current code** (`shellProfileDialog.js:1–12`):

```js
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';


export class ProfileNameDialog extends ModalDialog.ModalDialog {
    constructor({
        onAccept,
        onClose,
    } = {}) {
        super({destroyOnClose: true});
```

**Recommended fix** — register the class; the `constructor()`/`super()` pattern is fine on GJS ≥
1.72 per the warning in subclassing.md, and the existing `export`/import sites keep working
because `GObject.registerClass()` returns the class:

```js
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';


export const ProfileNameDialog = GObject.registerClass(
class ProfileNameDialog extends ModalDialog.ModalDialog {
    constructor({
        onAccept,
        onClose,
    } = {}) {
        super({destroyOnClose: true});
        // ... body unchanged ...
    }

    // ... _accept() and destroy() unchanged ...
});
```

(Only the class wrapper changes; the closing `}` of the class gains `);`.)

### C2 — `disable()` leaves spawned settings/networks windows running (Critical)

**Location:** `extension.js:914–919` (`_stopTrackedWindow`), called from `disable()` at
`extension.js:903–904`.

**What's wrong.** This confirms the first candidate lead. `_stopTrackedWindow()` cancels the
`wait_async` watch and nulls the references, but never terminates the child:

Cancelling `Gio.Subprocess.wait_async` only cancels the *wait*, not the process — the two
`gjs -m` GTK windows keep running after `disable()`. That contradicts CODEBASE.md:35 ("`disable()`
terminates spawned windows, cancels in-flight work…") and violates two review rules:
Review Guidelines § "General Guidelines" rule 3 ("Use `disable()` to cleanup anything done in
`enable()`") and § "Scripts and Binaries" ("Processes **MUST** be spawned carefully and exit
cleanly"). It also breaks the disable→enable cycle invariant: `enable()` resets
`_settingsWindowProcess`/`_networksWindowProcess` to `null` (extension.js:868–871), so after a
re-enable the orphaned windows are untracked and a second copy can be spawned.
`gjs-guide/docs/guides/gio/subprocesses.md` § "Cancellable Processes" shows the intended pattern:
connect the cancellable (or, here, the teardown path) to "call `Gio.Subprocess.force_exit()`".

**Current code** (`extension.js:914–919`):

```js
    _stopTrackedWindow(processProperty) {
        const cancellableProperty = `${processProperty}WaitCancellable`;
        this[cancellableProperty]?.cancel();
        this[cancellableProperty] = null;
        this[processProperty] = null;
    }
```

**Recommended fix:**

```js
    _stopTrackedWindow(processProperty) {
        const cancellableProperty = `${processProperty}WaitCancellable`;
        this[cancellableProperty]?.cancel();
        this[cancellableProperty] = null;

        const process = this[processProperty];
        this[processProperty] = null;
        process?.force_exit();
    }
```

`force_exit()` is safe to call unconditionally here: the `wait_async` callback
(extension.js:846–858) nulls `this[processProperty]` when the child exits, so a non-null value
means the process is still alive (see also L1, which relies on the same invariant).

### H1 — Chunked response on a kept-alive socket hangs until the timeout (High)

**Location:** `api/index.js:761–804` (`readHttpResponse`); completion checks at 771–774 and
787–793; the mitigating `Connection: close` request header at `api/index.js:291`.

**What's wrong.** This confirms the second candidate lead. The read loop has exactly two exits:
a zero-size read (peer closed) at :771, or `Content-Length` satisfied at :787–793. A chunked
response carries no `Content-Length`, so `contentLength` stays `null` and the loop's only exit is
EOF. If the daemon honors `Connection: close`, that works; if it keeps the connection alive
(standard Go `net/http` behavior is to honor it, but the "upcoming NetBird JSON API" is not
guaranteed to — any reverse proxy, HTTP/1.1 keep-alive default, or daemon bug flips this), the
client sits on a fully received body until the request timeout fires and the request **fails**.

Empirically verified: against a local server that sends a complete chunked response and does not
close the socket, `callNetBird('Status', {}, {timeoutMs: 2000})` rejected with
`NetBirdApiError: netbird JSON API timed out after 2000ms` after 2001 ms, despite the whole body
arriving in the first read. The same applies to a keep-alive response with **no** framing header
at all. The current test suite only passes because `FakeNetBirdJsonServer` always closes the
connection (`tests/api.test.js:231–233`) — see E4.

There is a second framing bug folded in here: when a (hostile or buggy) response carries *both*
`Content-Length` and `Transfer-Encoding: chunked`, `readHttpResponse` frames by `Content-Length`
(:787) while `parseResponse` decodes by chunked encoding (api/index.js:833–835). RFC 9112 § 6.3
gives `Transfer-Encoding` precedence; framing by the wrong one truncates mid-chunk and
`decodeChunkedBody` then throws.

**Current code** (`api/index.js:787–793`):

```js
                    if (headerEnd !== -1 && contentLength !== null) {
                        const bodyLength = responseBytes.length - (headerEnd + 4);
                        if (bodyLength >= contentLength) {
                            resolve(parseResponse(new Uint8Array(responseBytes)));
                            return;
                        }
                    }
```

**Recommended fix** — detect the chunked terminator in-loop, give chunked precedence over
`Content-Length`, and keep EOF as the close-delimited fallback. The replacement below also fixes
M1 (growable buffer, incremental header scan, size cap) and was **validated**: with it applied to
a scratch copy, all 35 existing tests pass and the keep-alive chunked request resolves in 7 ms.

```js
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function readHttpResponse(stream, cancellable) {
    let buffer = new Uint8Array(8192);
    let length = 0;
    let scanned = 0;
    let headerEnd = -1;
    let contentLength = null;
    let chunked = false;

    return new Promise((resolve, reject) => {
        function append(bytes) {
            if (length + bytes.length > buffer.length) {
                const grown = new Uint8Array(
                    Math.max(buffer.length * 2, length + bytes.length));
                grown.set(buffer.subarray(0, length));
                buffer = grown;
            }
            buffer.set(bytes, length);
            length += bytes.length;
        }

        function response() {
            return buffer.subarray(0, length);
        }

        function bodyComplete() {
            if (headerEnd === -1)
                return false;

            const bodyStart = headerEnd + 4;
            if (chunked)
                return chunkedBodyComplete(buffer.subarray(bodyStart, length));

            if (contentLength !== null)
                return length - bodyStart >= contentLength;

            return false;
        }

        function readNext() {
            stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result);
                    if (bytes.get_size() === 0) {
                        resolve(parseResponse(response()));
                        return;
                    }

                    append(bytes.toArray());
                    if (length > MAX_RESPONSE_BYTES)
                        throw new Error('NetBird JSON API response too large');

                    if (headerEnd === -1) {
                        headerEnd = findHeaderEnd(response(), scanned);
                        scanned = Math.max(0, length - 3);
                        if (headerEnd !== -1) {
                            const headerText = new TextDecoder().decode(
                                buffer.subarray(0, headerEnd));
                            contentLength = parseContentLength(headerText);
                            chunked = Boolean(parseHeaders(headerText)
                                .get('transfer-encoding')
                                ?.toLowerCase()
                                .includes('chunked'));
                        }
                    }

                    if (bodyComplete()) {
                        resolve(parseResponse(response()));
                        return;
                    }

                    readNext();
                } catch (error) {
                    reject(error);
                }
            });
        }

        readNext();
    });
}

function chunkedBodyComplete(body) {
    let offset = 0;

    while (offset < body.length) {
        let lineEnd = -1;
        for (let index = offset; index < body.length - 1; index++) {
            if (body[index] === 13 && body[index + 1] === 10) {
                lineEnd = index;
                break;
            }
        }
        if (lineEnd === -1)
            return false;

        const sizeText = new TextDecoder()
            .decode(body.slice(offset, lineEnd))
            .split(';')[0]
            .trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size) || size < 0)
            return true; // Malformed; decodeChunkedBody reports the error.

        offset = lineEnd + 2;
        if (size === 0)
            return body.length >= offset + 2;

        offset += size + 2;
    }

    return false;
}
```

and make `findHeaderEnd` resumable (used by the incremental scan; the existing call in
`parseResponse` is unaffected because the parameter defaults to 0):

```js
function findHeaderEnd(bytes, start = 0) {
    for (let index = start; index <= bytes.length - 4; index++) {
        if (bytes[index] === 13 &&
            bytes[index + 1] === 10 &&
            bytes[index + 2] === 13 &&
            bytes[index + 3] === 10)
            return index;
    }

    return -1;
}
```

Note on early EOF with `Content-Length`: as before, a connection closed before the declared length
arrives resolves with a truncated body; `parseJsonBody` then returns `null` and callers treat it
as a daemon error. That behavior is unchanged and acceptable, but if you prefer a hard error,
throw from `bodyComplete`'s EOF path when `length - bodyStart < contentLength`.

### M1 — Unbounded response buffering with O(n²) header scan (Medium)

**Location:** `api/index.js:776` (`responseBytes.push(...bytes.toArray())`),
`api/index.js:779` (`findHeaderEnd(responseBytes)` rescans from index 0), `api/index.js:806–816`.

**What's wrong.** This confirms (and refines) the third candidate lead:

- Correctness: `push(...array)` with a ≤4096-element spread is within argument limits, and the
  byte values are correct — no functional bug.
- Performance: until the blank line is seen, `findHeaderEnd` rescans the whole accumulated buffer
  on every 4 KB read — quadratic in the preamble size. For a well-behaved daemon (headers in the
  first read) this is negligible; a hostile or garbage endpoint streaming data with no `\r\n\r\n`
  makes the Shell process burn CPU quadratically *and*…
- Robustness: …there is no size cap at all, so such a response grows an element-per-byte JS
  `Array` (roughly an order of magnitude more memory than the payload) until the timeout —
  inside the compositor process. `parseResponse` then runs `findHeaderEnd` again over the whole
  buffer (:819), a third full pass.

Since `callNetBird` is the sole transport for the Shell UI (CODEBASE.md § Daemon API), the fix in
H1 (single growable `Uint8Array`, resumable scan via `scanned`, `MAX_RESPONSE_BYTES` cap) covers
this finding; no separate change needed.

### M2 — Synchronous file I/O on the GNOME Shell main loop (Medium)

**Location:** `api/index.js:953–957` (`netbirdJsonSocket`), `api/index.js:977–1000`
(`readConfiguredJsonSocket`, `GLib.file_get_contents`), `api/index.js:959–975`
(`unixSocketIsStable`, sync `query_info`), `profileState.js:18` (`GLib.file_get_contents`).
Shell-side call sites: every request (`callNetBird` → `netbirdJsonSocket`, api/index.js:282),
every profile/status refresh (`netbird_json_api_available`, extension.js:351 and 605), and every
status sync (`readProfileEmail`, extension.js:675).

**What's wrong.** GJS runs everything on the GLib main loop;
`gjs-guide/docs/guides/gjs/asynchronous-programming.md` § "Asynchronous Operations" exists
precisely because the async GIO variants "won't block the main thread for the duration of the
operation" — in an extension, the main thread is the compositor. Here, **every** daemon request
synchronously re-reads `/var/lib/netbird/service.json` / `/etc/netbird/service.json`
(api/index.js:983), and every status/profile refresh additionally stats the socket and reads
`~/.config/netbird/<profile>.state.json`. These are small local files, so this is a stutter risk
rather than a hang — but it is per-request work that can trivially be cached, and NFS/automounted
`/etc` or a slow rootfs turns it into visible compositor jank. (Review note: this is a
performance-quality issue, not a MUST-rule violation.)

**Current code** (`api/index.js:953–957`):

```js
function netbirdJsonSocket() {
    return GLib.getenv('NETBIRD_JSON_SOCKET') ||
        readConfiguredJsonSocket() ||
        DEFAULT_NETBIRD_JSON_SOCKET;
}
```

**Recommended fix** — cache the discovery with a short TTL (keeps late daemon installs working,
removes the per-request read; the env override still wins inside the cached computation):

```js
const JSON_SOCKET_CACHE_TTL_US = 30000000;

let cachedJsonSocket = '';
let cachedJsonSocketAtUs = -1;

function netbirdJsonSocket() {
    const nowUs = GLib.get_monotonic_time();
    if (cachedJsonSocketAtUs === -1 ||
        nowUs - cachedJsonSocketAtUs >= JSON_SOCKET_CACHE_TTL_US) {
        cachedJsonSocket = GLib.getenv('NETBIRD_JSON_SOCKET') ||
            readConfiguredJsonSocket() ||
            DEFAULT_NETBIRD_JSON_SOCKET;
        cachedJsonSocketAtUs = nowUs;
    }

    return cachedJsonSocket;
}
```

For the menu-header email, switch `readProfileEmail` to the async GIO variant and update the
header when it lands (`profileState.js`):

```js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';


const NETBIRD_PROFILE_STATE_DIR = 'netbird';


export async function readProfileEmail(profileName) {
    if (!profileName)
        return '';

    const statePath = GLib.build_filenamev([
        GLib.get_user_config_dir(),
        NETBIRD_PROFILE_STATE_DIR,
        `${profileName}.state.json`,
    ]);

    try {
        const contents = await new Promise((resolve, reject) => {
            Gio.File.new_for_path(statePath).load_contents_async(null, (source, result) => {
                try {
                    const [, bytes] = source.load_contents_finish(result);
                    resolve(bytes);
                } catch (error) {
                    reject(error);
                }
            });
        });

        const profileState = JSON.parse(new TextDecoder().decode(contents));
        return typeof profileState.email === 'string' ? profileState.email.trim() : '';
    } catch {
        return '';
    }
}
```

and in `extension.js` (`_setSelectedProfileName`, :673–677):

```js
    _setSelectedProfileName(profileName) {
        this._selectedProfileName = profileName;
        this._setHeader(null);
        this._runAsync(
            readProfileEmail(profileName).then(email => {
                if (!this._destroyed && this._selectedProfileName === profileName)
                    this._setHeader(email || null);
            }),
            'Failed to read NetBird profile state');
        this._selectProfileName(profileName);
    }
```

`unixSocketIsStable` can keep its sync `query_info` if the socket-discovery result is cached the
same way; otherwise apply the same async treatment.

### M3 — Daemon/peer strings rendered as Pango markup in the GTK windows (Medium)

**Location:** `networks-window.js:591–593` (peer name/IP/status → `Adw.ActionRow`),
`networks-window.js:607–609` (resource id/range → `Adw.ActionRow`), `networks-window.js:840–843`
and `settings-window-ui.js:782–787` (`Adw.Toast` titles built from error/profile strings, e.g.
`networks-window.js:299` and `:302`), `settings-window-ui.js:559–561` (profile name rows).

**What's wrong.** Verified against the installed libadwaita: `Adw.ActionRow` (via
`AdwPreferencesRow:use-markup`) and `Adw.Toast` both default `use_markup` to **true**
(`Adw.AlertDialog` body defaults to false, so `gtkProfileDialogs.js` is safe). Peer FQDNs and
hostnames come from *remote peers* in the NetBird network, and error bodies/profile names come
from the daemon — none of these are trusted display strings. Anything containing `<`, `&`, or a
crafted `<span>` is interpreted as Pango markup: at best a `Failed to set text from markup`
warning and a blank row, at worst attacker-influenced styling of your UI (e.g. a peer named
`<span foreground='red' size='xx-large'>…</span>`). This is exactly the "untrusted daemon output
rendered in the UI" class the audit brief calls out. (The Shell side is unaffected: `St.Label`
text and Quick Settings titles/subtitles are plain text; St.Button labels default to plain text
since GNOME 46 per `gjs-guide/docs/extensions/upgrading/gnome-shell-46.md` § "St.Button".)

**Current code** (`networks-window.js:590–596`):

```js
function createPeerRow(peer, connected) {
    const row = new Adw.ActionRow({
        title: peer.name || 'Peer',
        subtitle: [peer.ip, peer.status].filter(Boolean).join(' - '),
        activatable: false,
        sensitive: connected,
    });
```

**Recommended fix** — disable markup wherever daemon-derived text lands (libadwaita ≥ 1.4 is
guaranteed on every distro shipping GNOME 46+, so `Adw.Toast:use-markup` is safe to set):

```js
function createPeerRow(peer, connected) {
    const row = new Adw.ActionRow({
        title: peer.name || 'Peer',
        subtitle: [peer.ip, peer.status].filter(Boolean).join(' - '),
        use_markup: false,
        activatable: false,
        sensitive: connected,
    });
```

Apply `use_markup: false` likewise in `createResourceRow`, `createExitNodesRow` children,
`createStatusRow` (both windows' variants), `createProfileRow`, and the profile-switcher row
subtitle assignments; and in both `showToast` helpers:

```js
function showToast(window, title) {
    if (typeof window.add_toast === 'function')
        window.add_toast(new Adw.Toast({title, use_markup: false}));
}
```

### L1 — `get_if_exited()` on a running process logs GLib-GIO-CRITICAL (Low)

**Location:** `extension.js:833` in `_openTrackedWindow`.

**What's wrong.** `g_subprocess_get_if_exited()` has a precondition that the process has already
been waited on. Verified on this system: calling it on a live child logs
`GLib-GIO-CRITICAL **: g_subprocess_get_if_exited: assertion 'pid == 0' failed` and returns
`false`. Because the `wait_async` callback (extension.js:852–856) nulls `this[processProperty]`
as soon as the child exits, a non-null reference already means "still running" — the
`get_if_exited()` call is both invalid and redundant, and it spams a CRITICAL to the journal every
time the user re-activates the menu item while a window is open (Review Guidelines § "No excessive
logging").

**Current code** (`extension.js:831–834`):

```js
    _openTrackedWindow(processProperty, windowPath, label) {
        const existingProcess = this[processProperty];
        if (existingProcess && !existingProcess.get_if_exited())
            return;
```

**Recommended fix:**

```js
    _openTrackedWindow(processProperty, windowPath, label) {
        // The wait_async callback clears this as soon as the child exits,
        // so a non-null process is still running.
        if (this[processProperty])
            return;
```

### L2 — Profile name used unvalidated in a state-file path (Low)

**Location:** `profileState.js:11–15`.

**What's wrong.** `profileName` originates from daemon responses (`netbird_status` /
`netbird_profile_list`), yet is interpolated into a filesystem path:
`~/.config/netbird/<profileName>.state.json`. A name containing `/` or `../` walks out of the
state directory and makes the Shell read (and JSON-parse) an arbitrary `*.state.json`-suffixed
file. Impact is limited — only a string `email` field is extracted and shown as a menu-header
label — but a compromised or spoofed daemon shouldn't get to choose which files the compositor
opens. Defense in depth is one line.

**Current code** (`profileState.js:7–15`):

```js
export function readProfileEmail(profileName) {
    if (!profileName)
        return '';

    const statePath = GLib.build_filenamev([
        GLib.get_user_config_dir(),
        NETBIRD_PROFILE_STATE_DIR,
        `${profileName}.state.json`,
    ]);
```

**Recommended fix:**

```js
export function readProfileEmail(profileName) {
    if (!profileName || profileName !== GLib.path_get_basename(profileName))
        return '';
```

### L3 — `parseContentLength` accepts non-decimal values; framing precedence (Low)

**Location:** `api/index.js:859–868`.

**What's wrong.** `Number(...)` is too permissive for a header that frames the read loop:
`Number('')` is `0` (a bare `Content-Length:` header truncates the body to zero),
`Number('0x10')` is 16 (hex accepted), `Number('1e3')` is 1000, and with duplicate
`Content-Length` headers the first is silently used. Combined with the original code's preference
for `Content-Length` over `Transfer-Encoding` (fixed in H1), these are classic
request/response-smuggling-shaped parser laxities. Against a trusted local daemon the practical
risk is malformed-input misbehavior, not smuggling — but strict parsing costs nothing.

**Current code** (`api/index.js:866–867`):

```js
    const value = Number(line.slice(line.indexOf(':') + 1).trim());
    return Number.isFinite(value) ? value : null;
```

**Recommended fix:**

```js
    const text = line.slice(line.indexOf(':') + 1).trim();
    if (!/^\d+$/.test(text))
        return null;

    return Number(text);
```

### L4 — `decodeChunkedBody` accepts negative chunk sizes (Low)

**Location:** `api/index.js:889–891`.

**What's wrong.** `Number.parseInt('-5', 16)` is `-5`, which passes the `Number.isFinite` check.
A negative size then walks `offset` and the `body.slice`/terminator checks with inconsistent
indices; in practice it ends in the "Invalid … chunk terminator" error, but by accident rather
than by validation, and `parseInt` also tolerates garbage suffixes (`parseInt('12zz', 16)` → 18).

**Current code** (`api/index.js:884–891`):

```js
        const sizeText = new TextDecoder()
            .decode(body.slice(offset, lineEnd))
            .split(';')[0]
            .trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size))
            throw new Error('Invalid NetBird JSON API chunk size');
```

**Recommended fix:**

```js
        const sizeText = new TextDecoder()
            .decode(body.slice(offset, lineEnd))
            .split(';')[0]
            .trim();
        if (!/^[0-9a-f]+$/i.test(sizeText))
            throw new Error('Invalid NetBird JSON API chunk size');
        const size = Number.parseInt(sizeText, 16);
```

### L5 — `applyChanges()` reconnects even when no changed setting requires it (Low)

**Location:** `settingsManager.js:187–199` (tail of `applyChanges`).

**What's wrong.** CODEBASE.md:60–61 documents `settingsManager.js` as reconnecting "when a changed
setting **requires** it." The implementation reconnects unconditionally: after any successful
`SetConfig` — and even when `profileDirty` is false and nothing was written — it queries status
and, if connected, tears the tunnel down and back up. Toggling *Notifications* therefore drops
your VPN. This is a documented-behavior deviation with real user impact, though not a review
blocker. (I'm confident the unconditional-reconnect reading is correct; which keys genuinely
require a reconnect is a product decision, so the set below is a starting point for the
maintainer to curate.)

**Current code** (`settingsManager.js:187–199`):

```js
        const status = await netbird_status({
            timeoutMs: NETBIRD_SETTINGS_QUERY_TIMEOUT_MS,
        });

        if (!status.connected)
            return;

        await netbird_down({timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS});
        await netbird_up({
            profileName,
            openLoginUrl: false,
            timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
        });
```

**Recommended fix:**

```js
const RECONNECT_REQUIRED_KEYS = new Set([
    'allowSsh',
    'blockInboundConnections',
    'connectionQuantumResistance',
    'disableClientRoutes',
    'disableDns',
    'disableLanAccess',
    'disableServerRoutes',
    'interfaceName',
    'interfacePort',
    'lazyConnections',
    'managementUrl',
    'mtu',
    'networkMonitor',
    'preSharedKey',
    'quantumResistance',
]);
```

```js
        if (!profileDirty)
            return;

        const needsReconnect = Array.from(appliedValues.keys())
            .some(key => RECONNECT_REQUIRED_KEYS.has(key));
        if (!needsReconnect)
            return;

        const status = await netbird_status({
            timeoutMs: NETBIRD_SETTINGS_QUERY_TIMEOUT_MS,
        });

        if (!status.connected)
            return;

        await netbird_down({timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS});
        await netbird_up({
            profileName,
            openLoginUrl: false,
            timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
        });
```

## 3. Enhancements

### E1 — No gettext/i18n

Every user-facing string is hardcoded English (`extension.js:77` "NetBird", :123 "Refresh",
:254 "No profiles found", :404 "Switching profile…", shellProfileDialog.js:19/24/43/48, and all
of the GTK windows and `settings.js`). Translations are recommended, not required, by
`gjs-guide/docs/extensions/development/translations.md` (add `gettext-domain` to metadata.json;
in the Shell process import the extension's gettext). Shell side:

```js
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
```

```js
        addMenuActionItem(this.menu, _('Refresh'), 'view-refresh-symbolic', () => {
            this._refreshNetBirdState();
        });
```

The standalone GTK processes cannot use the Shell's gettext helper (boundary!); they would
initialize the same domain via GJS's `imports.gettext` / `bindtextdomain` with the extension dir's
`locale/` path passed through `NETBIRD_GNOME_EXTENSION_DIR`.

### E2 — Missing accessible labels

The connect/disconnect `Gtk.Switch` in the networks window (`networks-window.js:509–513`) has no
label relationship — a screen reader announces an anonymous switch that controls your VPN. The
gjs-guide's Quick Settings example sets `accessible_name` on icon-only controls
(`src/extensions/topics/quick-settings/extension.js:125`); the Shell side of this codebase is fine
(the toggle has a title), but the GTK side should do the GTK4 equivalent:

```js
    const statusSwitch = new Gtk.Switch({
        active: connected || connecting,
        sensitive: Boolean(state) && !state.busy && !loading,
        halign: Gtk.Align.CENTER,
    });
    statusSwitch.update_property(
        [Gtk.AccessibleProperty.LABEL],
        ['Connect NetBird']);
```

Same treatment for the icon-only refresh buttons (`networks-window.js:154–158`,
`settings-window-ui.js:542–545`) — `tooltip_text` alone is not a reliable accessible name.

### E3 — Dead `_settingCheckedFromStatus` flag

`extension.js:99, 636, 639`: the flag is written in `_setCheckedFromStatus()` but never read
anywhere (its apparent purpose — suppressing a reentrant `clicked`/`notify::checked` reaction —
isn't needed because `QuickMenuToggle` with `toggleMode: false` doesn't emit `clicked` on
programmatic `checked` writes). Delete the three lines to avoid implying a guard that doesn't
exist.

### E4 — Test coverage gaps around HTTP framing (tests/api.test.js)

The suite (35 green) exercises every RPC wrapper and several status-normalization shapes, but the
fake server always closes the connection (`tests/api.test.js:231–233`), so none of the framing
failure modes are covered:

- chunked response on a kept-alive socket (the H1 regression — most important);
- response with neither `Content-Length` nor chunked framing on a kept-alive socket;
- truncated body (early EOF with `Content-Length` unsatisfied);
- oversized body (once `MAX_RESPONSE_BYTES` exists);
- malformed status line / garbage preamble;
- timeout path (`timedOut` → `NetBirdApiError` with `statusText: 'Timeout'`);
- non-JSON 2xx body (`data === null`);
- a `unix://` endpoint (only `tcp://` is tested).

Suggested minimal H1 regression: keep completed connections open behind an env flag —

```js
    async _handleConnection(connection) {
        try {
            const request = await readHttpRequest(connection.get_input_stream());
            const response = this._dispatch(request);
            await writeHttpResponse(connection.get_output_stream(), response);
        } finally {
            if (GLib.getenv('NETBIRD_FAKE_KEEP_ALIVE') === '1')
                this._openConnections.push(connection);
            else
                connection.close(null);
        }
    }
```

```js
    ['netbird_status chunked keep-alive', async () => {
        GLib.setenv('NETBIRD_FAKE_KEEP_ALIVE', '1', true);
        try {
            await netbird_status({timeoutMs: TEST_TIMEOUT_MS});
        } finally {
            GLib.unsetenv('NETBIRD_FAKE_KEEP_ALIVE');
        }
    }],
```

(initialize `this._openConnections = [];` in the constructor and close them in `stop()`).
Also note `writeHttpResponse` computes the chunk size from `responseBody.length` — JS string
length, not bytes (`tests/api.test.js:443`); fine while fixtures are ASCII, wrong the day a
fixture contains non-ASCII. Use `new TextEncoder().encode(responseBody)` for both the size and the
payload.

## 4. Prioritized action list

**Review-blocking (must fix before submitting to extensions.gnome.org):**

1. **C1** — register `ProfileNameDialog` with `GObject.registerClass()` (one-file change; the
   feature is currently a guaranteed crash → fails § "Extensions must be functional").
2. **C2** — `force_exit()` the tracked window processes in `_stopTrackedWindow()` (violates
   § "Scripts and Binaries" / `disable()` cleanup rule and CODEBASE.md:35).
3. **L1** — drop the invalid `get_if_exited()` call (tiny; folds into the C2 patch; a reviewer
   watching the journal will see the CRITICALs → § "No excessive logging").

**High value, not review-blocking:**

4. **H1 + M1** — replace `readHttpResponse` with the validated version above (chunked completion
   detection, framing precedence, growable buffer, size cap). Without it, the extension breaks
   against any daemon build that keeps connections alive.
5. **M3** — `use_markup: false` on every Adw row/toast fed daemon or peer strings (mechanical,
   ~10 sites, closes the only injection-shaped hole found).
6. **M2** — cache socket discovery; make `readProfileEmail` async (removes per-request sync I/O
   from the compositor loop).
7. **L5** — gate the post-apply reconnect on a reconnect-required key set (stops settings changes
   from dropping the VPN; curate the key list).

**Cheap hardening / hygiene:**

8. **L2, L3, L4** — one-liner validations (path basename check, strict decimal Content-Length,
   strict hex chunk size).
9. **E3** — delete the dead flag.
10. **E4** — add the keep-alive regression test plus the framing edge cases (locks in fix 4).

**Longer-term:**

11. **E1** — gettext across both runtimes (+ `gettext-domain` in metadata.json).
12. **E2** — accessible labels on the GTK switch and icon-only buttons.
