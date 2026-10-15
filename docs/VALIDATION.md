# 0.1.0 validation record

## Live point provisioning and administrative discussion filtering

Based on PacketLark `main` commit `e912dd4`. TypeScript, ESLint, Prettier,
the application build, 74 core tests, 25 Electron renderer tests in headless
DOM mode, and 24 Python provisioning tests pass. The existing Windows/Linux
workflow discovers the new tests and packages the application without any
workflow or dependency changes.

Provisioning regression coverage includes the native SBBSecho mutex, busy
timeouts without deleting another owner's lock, rereading config after waiting,
EchoCfg detection, concurrent config edits, atomic-write failures, interruption
before and after commit, event rescheduling, existing semaphore preservation,
custom data/event paths, CLI invocation, credential redaction, and offline use.
ADM filtering covers cached/profile descriptions, case-insensitive matching,
provider description updates, manual join rejection, preserved stored mail,
sidebar/compose/browser visibility, and existing search/status filters.

The mutex protocol was checked against Synchronet's `src/sbbs3/nopen.c`
(`fmutex`) and `src/sbbs3/sbbsecho.c`. Testing used disposable local config
files and simulated jobs, not a production Synchronet installation. Native
Windows execution and live BBS acceptance remain to be verified on their
respective hosts. No production BBS was changed during these checks.

## Original source ZIP

Validated against the source ZIP baseline in the build environment:

| Check                                             | Result                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| TypeScript renderer and Node/Electron compilation | Passed                                                    |
| ESLint and Prettier                               | Passed                                                    |
| Protocol/packet/mailbox tests                     | 38 passed                                                 |
| Synchronet provisioning tests                     | 10 passed                                                 |
| Electron renderer behavior tests                  | 6 passed in headless DOM mode                             |
| Production dependency audit                       | No reported vulnerabilities                               |
| Native production main/preload initial IPC        | Exercised successfully with an external test wrapper      |
| Linux AppImage and Debian package generation      | Passed                                                    |
| Windows native packaging and full desktop smoke   | Workflow included; not executed in this Linux environment |
| Live BinkIT/SBBSecho acceptance                   | Not performed; requires your disposable point and BBS     |

This environment restricts Unix sockets and native screen/input services. The external main-process test wrapper bypassed only the single-instance lock in the test process; it is not included in the product. Renderer tests used the documented headless mode, with click events dispatched to the DOM. These tests cover interface behavior and dark-mode styles, not visual screenshot acceptance or native input integration.

The GitHub workflow runs the normal production desktop smoke and standard input-based renderer tests on both native runners, then builds packages. The first repository push will provide that additional validation. A successful workflow is still separate from a successful live network acceptance test; follow the checklist in SYNCHRONET.md before wider rollout.

## PacketLark rename and startup patch

The patch accepts Node 24 or 26 and was checked with a clean Node 26.7.0/npm 12.2.0 install. The explicit install-script policy removes unreviewed-hook warnings for supported Windows/Linux targets. New regression checks cover importing a legacy RetroPost profile and reopening its queued mail. Native initial IPC reports the PacketLark title while retaining the `retropost` keyring/data identity. Linux Wayland disables only Vulkan before app readiness; actual Wayland GPU behavior must be verified on the affected desktop.

The complete dependency audit still reports eight moderate build-tool metavulnerabilities from the unpatched `sprintf-js` dependency chain. The runtime audit is clean. Major overrides were rejected after HTTPS proxy regressions; no TLS verification bypass or forced packager downgrade is included.

## Discussion browser patch

Based on PacketLark `main` commit `7629068`. Local checks pass for TypeScript,
ESLint, Prettier, 53 protocol/mailbox/discussion tests, 10 Python provisioning
tests, and 9 Electron renderer tests in the documented headless DOM mode. The
application builds successfully. Discussion tests cover real Type-2+ list and
acknowledgement packets, split replies across exchanges, sender/destination
checks, duplicate suppression, persistence, transaction rollback, rejected
requests, and preserving historical mail. Renderer tests cover discovery,
search, subscription status, manual tags, text-only descriptions, and pagination.

The existing Windows/Linux workflow automatically includes these tests and keeps
both packaging targets. This patch adds no dependencies or server-side setup.
Native display/input verification and live SBBSecho acceptance remain necessary;
local renderer tests do not claim visual screenshot verification or a live BBS
exchange.

## Hidden management traffic and mail deletion patch

Based on PacketLark `main` commit `ade6804`. TypeScript, ESLint, Prettier, the
application build, 67 core tests, 14 Electron renderer tests in headless DOM mode,
and 10 provisioning tests pass. The production main/preload IPC smoke also
exercises the new delete/restore endpoints and retains renderer isolation. Its
external test wrapper bypasses only the single-instance lock for this restricted
environment and is not shipped.

Regression coverage includes hidden requests before/after acknowledgement,
split reply processing without Inbox items or new-mail counts, duplicate receipt
persistence, friendly errors, old-mailbox cleanup, preserving ordinary queued
bytes, deletion rollback on failed saves, permanent-deletion replay suppression,
Trash/restore flags, draft deletion while editing, outbox cancellation/restoration,
and explicit permanent-delete confirmation. Existing protocol, mailbox, public
and private reply, draft autosave, and area-browser tests continue to pass.

The unchanged Windows/Linux workflow runs the additional tests before packaging.
Native display/input checks and live BBS acceptance were not run locally. No
dependencies, provisioning settings, keyring identities, or transport options
change in this patch.

## Interface performance patch

Based on PacketLark `main` commit `ffc60d8`. Compilation, lint/format checks,
70 core tests, 19 Electron renderer tests in headless DOM mode, and 10 Python
provisioning tests pass. The production IPC smoke verifies revision-bearing
notifications, snapshot refresh after a mutation, and retained sandbox/isolation.
The existing native Windows/Linux Actions run these checks before packaging.

The changes eliminate full-mailbox fetches for status-only updates, coalesce
data invalidations, cache public snapshots per durable revision, count sidebar
badges in one pass, reuse message-row elements and selected reader content,
cache the date formatter, and initially render at most 200 folder rows. Search
still covers all messages in the folder. Individual message operations now query
the primary key; setting already-current flags does not flush SQLite again.

A local synthetic run used 5,000 messages across 100 discussion areas, including
2,500 direct messages, in Electron's headless test host with GPU disabled:

| Metric                                                       | Baseline | Patched |
| ------------------------------------------------------------ | -------: | ------: |
| Navigation to first displayed row                            |   484 ms |  187 ms |
| Full mailbox fetches for six status updates                  |        6 |       0 |
| List/reader child-list mutations during those updates        |   15,024 |       0 |
| Initially rendered direct-message rows                       |    2,500 |     200 |
| Six-update elapsed time, including 180 ms deliberate waiting | 2,752 ms |  182 ms |

Timing is illustrative for that local run, not a Windows frame-rate claim. The
regression tests assert stable nodes/scroll, data freshness, batching, and complete
search rather than machine-dependent timing thresholds. Native text-selection
verification runs in the regular GUI tests; the restricted offscreen host cannot
create a normal selection. Actual Windows GPU/compositor smoothness must be
verified on the affected desktop. Hardware acceleration, Linux Wayland handling,
mailbox durability, credentials, protocol transport, and dependencies are unchanged.
