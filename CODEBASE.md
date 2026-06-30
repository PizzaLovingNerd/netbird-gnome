# NetBird GNOME Extension Architecture

## Runtime boundaries

The project has two deliberately separate runtimes:

- `extension.js` runs inside GNOME Shell. It may import Shell, Clutter, St,
  Gio, GLib, and the Shell-safe modules listed below. It must never import
  GTK, GDK, or libadwaita, including through another module.
- `settings-window.js` and `networks-window.js` are standalone GJS processes.
  They may use GTK 4 and libadwaita, but must never import GNOME Shell modules.

Keeping this boundary intact is required by the GNOME Extensions review rules.

## Shell process

`extension.js` is the entry point declared by `metadata.json`.

`enable()` creates one `NetBirdIndicator`, registers it with Quick Settings,
and initializes references to the two optional window processes. The indicator
owns a `NetBirdToggle`, which owns its menu items, cancellables, and scheduled
initial refreshes.

The toggle calls `api/index.js` to:

1. list and select profiles;
2. read daemon status;
3. connect or disconnect NetBird; and
4. add profiles.

`shellProfileDialog.js` provides the profile-name dialog using Shell widgets.
`profileState.js` reads the optional profile email shown in the menu header.
`extensionErrors.js` turns transport failures into short user-facing messages.

`disable()` terminates spawned windows, cancels in-flight work, removes every
GLib source, destroys all Quick Settings objects, and clears retained
references. The extension constructor intentionally performs no work.

## Daemon API

`api/index.js` is the only NetBird transport layer. It sends HTTP/JSON requests
to the daemon socket, applies per-request timeouts, propagates cancellation,
closes each connection, and normalizes responses for UI consumers.

The module has no GTK or Shell dependencies, so it is shared by all runtimes.
New operations belong here rather than in UI code. The extension intentionally
has no CLI or configuration-file fallback: it targets the upcoming NetBird
JSON API. When that API is unavailable, the UI reports the unavailable service
without spawning another transport.

## Standalone windows

`networks-window.js` creates the Networks, Peers, and Resources UI. It reads
status and routed networks through the daemon API. Resource selection and
profile changes also use daemon RPCs.

`settings-window.js` creates the settings application.
`settings-window-ui.js` builds and binds its widgets.
`settings.js` is the declarative page and row catalog.
`settingsManager.js` maps row keys to `GetConfig` and `SetConfig` fields and
reconnects NetBird when a changed setting requires it.
`gtkProfileDialogs.js` contains dialogs used only by the GTK settings process.
`windowIcon.js` sets application identity and registers the bundled icon.

## Common flows

Status refresh:

```text
Quick Settings or Networks window
  -> api/index.js
  -> NetBird daemon JSON socket
  -> normalized status
  -> widgets update
```

Settings apply:

```text
settings-window-ui.js
  -> SettingsManager.applyChanges()
  -> netbird_set_config()
  -> optional down/up reconnect
  -> committed row values
```

## Development and review

Run the API regression suite:

```bash
./test-api.bash
```

Open a development Shell (`--nested` on GNOME 46-48 and `--devkit` on 49+):

```bash
./test.bash
```

Build the review archive:

```bash
./pack-extension.bash
```

The archive is written to `dist/`. The pack script explicitly includes every
runtime module and icon while excluding tests, editor files, design sources,
the review PDF, and this development documentation.

When adding code, preserve these invariants:

- create objects, signals, and GLib sources only after `enable()`;
- undo or destroy everything in `disable()`;
- pass a cancellable and timeout to daemon requests owned by Shell objects;
- keep GTK imports out of the Shell dependency graph;
- keep Shell imports out of standalone window modules; and
- do not add CLI fallbacks, privileged helpers, telemetry, generated bundles,
  or runtime dependency installers.
