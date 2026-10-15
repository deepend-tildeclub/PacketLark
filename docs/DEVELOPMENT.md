# Development

Use Node.js 24 LTS or Node.js 26 and the committed package-lock.json. The app's runtime is supplied by Electron; there is no native SQLite dependency or separate mailer build. Node 24 remains the `.nvmrc` default; an additional CI job checks Node 26 and npm 12.

```sh
npm ci
npm run dev
```

The development command builds TypeScript and the renderer, then starts Electron from the source directory. It does not run an HTTP development server. Rebuild/restart to pick up edits. `PACKETLARK_DEV=1` (or the legacy `RETROPOST_DEV=1`) enables F12 developer tools. Do not run the application as root or disable its sandbox for normal use.

## Checks

```sh
npm run check
python3 -m unittest discover -s tools -p 'test_*.py' -v
npm run build
npm run test:desktop
npm run test:ui -- --workers=1
```

`npm test` covers wire headers, encodings, malformed/misrouted packets, ZIP bounds, database persistence, retry identity, and actual loopback TCP sessions. The server in those tests is a controlled BinkP peer, not a claim of live Synchronet acceptance.

The desktop smoke test opens the production main process/preload and checks initial IPC and isolation settings. Renderer tests launch Electron with a test-only host and injected application API; they exercise the real packaged renderer UI while keeping transport tests independent. No separate Playwright browser download is required. On Linux without a desktop use `xvfb-run -a` for each desktop command. Native CI uses actual displayed Electron windows under Xvfb or the Windows desktop.

For unusually restricted test containers, renderer tests support `RETROPOST_HEADLESS=1`, which uses Electron's headless/offscreen backend and dispatches click events directly. This verifies DOM behavior but does not substitute for native input/layout testing. The normal application has no test mode or bypass for OS credential protection. The root-only sandbox bypass in the test fixture applies only to that test host, not shipped application code.

Python tests exercise preview behavior, point collisions, credential/config consistency, file permissions, backup preservation, and failure cleanup in temporary directories. They never touch the BBS configuration.

## Platform packaging

```sh
npm run dist
```

Build on the target OS. On Linux install your distribution's Electron runtime dependencies (GTK 3, NSS, GBM and ALSA libraries). Debian package tooling is downloaded by electron-builder; first builds require network access. AppImages may require FUSE on the target machine; users can also extract them with `--appimage-extract` or use the `.deb` on Debian-based systems.

The GitHub workflow deliberately builds Linux on Ubuntu 22.04 for a broadly compatible glibc baseline, and Windows on Windows 2025. Native desktop tests and packaging run on both. Artifacts are retained for fourteen days. Publishing is disabled. Signing is not configured for the first Windows alpha; add signing as a separate reviewed change.

## Linux startup warnings

Electron's Wayland surface backend reports a Vulkan incompatibility when Vulkan is enabled. The main process disables only the `Vulkan` Chromium feature on Wayland, before app readiness, preserving other disabled features and the normal hardware-accelerated renderer. It does not force all users to X11 or disable the sandbox.

For driver-specific failures, try either explicit fallback:

```sh
npm run dev:x11
npm run dev:software
```

The X11 fallback requires an X server or XWayland. The software fallback trades rendering performance for compatibility. Neither command changes mailbox/account data.

Fontconfig cache-version warnings come from the system/Electron font stack. Chromium frame-latency diagnostics alone do not indicate a build failure or a message-delivery error. An XDG portal request-cancelled message may occur when a file dialog is cancelled; investigate further if a dialog fails without being cancelled. Avoid changing keyring or account credentials to address graphics diagnostics.

## Dependency audit and npm 12

The eight moderate audit findings are one transitive chain: `electron-builder → app-builder-lib → @electron/get → global-agent → roarr → sprintf-js` (plus package-level metavulnerabilities). `sprintf-js` has no patched release. npm's suggested force-fix downgrades the packager. A tested `global-agent` major override cleared the audit but broke certificate-verified HTTPS proxy downloads, so it is deliberately not shipped. The existing downloader and transport behavior are retained. Track the upstream fix rather than applying `npm audit fix --force`.

The application/runtime dependency audit is clean. CI fails on moderate-or-higher runtime findings and separately reports the complete build-tool audit without suppressing its output. That report remains advisory while this upstream issue is unresolved.

`allowScripts` explicitly denies `electron-winstaller` and `fsevents` hooks. Squirrel Windows and macOS are not supported packaging targets in this application; the NSIS/ZIP Windows build uses electron-builder's own tooling. If you add those platforms or targets later, review the hooks and change the policy as part of that feature.

Some deprecated `glob`, `inflight`, and `rimraf` versions may remain transitively in packaging tools. Their deprecation notices are separate from audit findings. Do not force incompatible major overrides merely to suppress notices. The workflow reports both runtime and complete-tree audits.

The compiled preload is `dist/main/preload.cjs` because sandboxed Electron preloads use CommonJS. Other main/core modules use ESM. SQL.js WASM is copied as an external resource and resolved from process.resourcesPath in installed builds. Include this resource when changing packaging.

## File layout

| Path                          | Responsibility                                   |
| ----------------------------- | ------------------------------------------------ |
| `src/core/model.ts`           | Strict schemas, addresses, and IPC types         |
| `src/core/packet.ts`          | Type-2+ messages and bounded ZIP import          |
| `src/core/binkp.ts`           | Socket framing, authentication, file exchange    |
| `src/core/store.ts`           | SQLite snapshots, queue state, deduplication     |
| `src/main/`                   | Electron lifecycle, IPC, keyring, native dialogs |
| `src/renderer/`               | Mailbox, composer, contacts, discussions         |
| `tools/provision_point.py`    | BBS-side point/signup provisioning               |
| `.github/workflows/build.yml` | Checks and native package artifacts              |

## Backup restoration

Close PacketLark. Back up the existing OS application-data directory before changing it. Restore a saved `mailbox.sqlite` to that same directory on the **same machine/user with the original OS keyring**, then restart. The normal locations are `%APPDATA%/retropost/` on Windows and `~/.config/retropost/` on Linux, subject to OS overrides. Account → Back up mailbox saves a consistent database snapshot. Restoring a backup intentionally restores its historical queue state, so inspect Outbox before sending to avoid retransmitting old mail. Cross-machine account migration and merge/import are not implemented yet.

## Maintenance

Follow Conventional Commits. Run format, checks, and relevant desktop tests before a patch. Avoid changing profile version 1 or discarding unknown mailbox data to bypass a migration. `package-lock.json` must accompany dependency changes. Review Dependabot upgrades, especially Electron and native packaging changes. Do not commit generated signup files or user databases.

## Rename compatibility

PacketLark retains the original internal `retropost` application name, app ID, keyring identity, and data directory to preserve existing accounts and encrypted credentials. Window branding, desktop/package names, wire identifiers, new signup files, and build artifacts use PacketLark. Existing `.retropost` files and `retropost-account` profiles remain accepted; new files use `.packetlark` and `packetlark-account`. Do not manually rename the mailbox directory or reset the OS keyring for this update.
