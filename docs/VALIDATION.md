# 0.1.0 validation record

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
