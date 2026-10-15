# PacketLark

FidoNet messaging with a familiar inbox. Built for Windows and Linux, from RetroDigital BBS.

**0.1.0 is a working alpha for controlled point testing.** It contains an actual BinkP client, Type-2+ packet reader/writer, durable SQLite mailbox, desktop interface, and Synchronet point provisioning tool. It needs a live acceptance test against your BinkIT/SBBSecho installation before inviting everyday users. The source does not contain a configured account or contact your BBS automatically.

## Start here

Install **Node.js 24 LTS or Node.js 26** (including npm) on Windows or Linux. Node 24 remains the default in `.nvmrc`; CI also checks Node 26 with npm 12. This is the development prerequisite; installed-app users do not need Node, Python, or a separate FidoNet mailer.

```sh
npm ci
npm run dev
```

The app opens with an account-import screen. Ask your sysop for a `.packetlark` file, or follow [Synchronet setup](docs/SYNCHRONET.md) to create one. The example file uses an intentionally non-working hostname and sample credentials.

Linux needs a working desktop session, GTK 3/NSS/audio libraries, and a Secret Service/keyring such as GNOME Keyring or KWallet. Credentials are encrypted using Electron safeStorage; the application refuses to use Linux's unprotected `basic_text` fallback. Run as your normal desktop user, not root. `npm run dev` builds locally and runs from the source tree; it does not install system-wide.

On Linux Wayland, startup disables Chromium's incompatible Vulkan feature while retaining the native Wayland window and other GPU acceleration. For display-driver troubleshooting, `npm run dev:x11` explicitly uses XWayland/X11, and `npm run dev:software` disables GPU acceleration. See [development troubleshooting](docs/DEVELOPMENT.md#linux-startup-warnings).

## What works

- Import a provider-issued account and keep credentials in OS-protected storage.
- Direct messages and public discussions, with a three-pane reader.
- Messages default to **Newest first**, including the messages displayed together inside an open conversation and its reply links. The **Sort** menu also offers **Oldest first** and remembers your choice on this device across folders, discussions, and restarts.
- Large folders initially show 200 messages; **Show older messages** (or **Show newer messages** when sorted oldest first) loads more, while search covers every message in the selected folder.
- Compose, automatic draft saving, saved drafts, queued Outbox, and Sent after provider acknowledgement.
- Delete to Trash, restore, and confirmed permanent deletion; deleting queued mail cancels its pending send and restores to Drafts.
- Send & receive manually or periodically while the application is running.
- Plain-text display, UTF-8 and selected legacy outgoing encodings, incoming declared encodings supported by iconv-lite.
- Conversation links from FTN MSGID/REPLY, unread flags, stars, local search, and contacts.
- Explicit public replies and private replies, plus AreaFix join/leave requests.
- Browse available discussions with descriptions, search and subscription filters; join or leave using buttons and track provider confirmations.
- Administrative discussions whose descriptions contain `ADM` are hidden from the discussion browser, sidebar, and compose area menu, including cached entries.
- Handle discussion-management requests and replies internally, including cleaning up recognized copies from older mailboxes.
- Raw Type-2+ packets and standard flat ZIP mail bundles on receive; raw Type-2+ packets on send.
- Persist incoming mail before sending M_GOT; preserve outgoing bytes, filename, timestamp, and MSGID until acknowledged.
- Back up the local mailbox using Account → Back up mailbox.

This release supports **one point account and its matching boss node**. Other FTN domains are supported in the account format, but messages cannot cross domains. New accounts cannot replace an installed account inside the UI yet.

## Build packages

```sh
npm run check
python3 -m unittest discover -s tools -p 'test_*.py' -v
npm run build
npm run test:desktop
npm run test:ui -- --workers=1
npm run dist
```

On Windows use `python` if `python3` is not present. On a headless Linux build machine use `xvfb-run -a` before each desktop/UI test command. See [development](docs/DEVELOPMENT.md).

`release/` receives the platform's packages:

| Build host  | Outputs                                           |
| ----------- | ------------------------------------------------- |
| Windows x64 | NSIS setup `.exe` and portable application `.zip` |
| Linux x64   | `.AppImage` and `.deb`                            |

The Windows ZIP is an unpack-and-run application bundle. Its mailbox still lives in the normal OS application-data directory; it is not a USB-portable account store.

Windows packages are unsigned in this initial version. Code signing can be added once you have a certificate; no signing or publishing secrets are required to build the source.

## GitHub Actions

Push this directory's **contents**, including `.github/`, to the repository root. The included [workflow](.github/workflows/build.yml) runs on pushes, pull requests, and manual dispatch. Each native runner installs locked dependencies, checks types/lint/formatting, runs protocol/mailbox/provisioning and desktop/UI tests, then **builds actual packages** and uploads them as workflow artifacts. It never publishes a release automatically.

Open **Actions → Build PacketLark → a successful run → Artifacts** to download Windows or Linux packages. The workflow does not need a repository name, tokens, BBS credentials, or a FidoNet account. The package homepage currently points to the maintainer's GitHub profile; change it to your new repository URL after creating the repo.

Commit `package-lock.json`. Dependabot updates npm dependencies and pinned GitHub Actions. TypeScript 6 is retained for compatibility with the current typescript-eslint parser; the lockfile records the tested toolchain.

The npm 12 install-script policy explicitly denies hooks for the unused Squirrel installer (`electron-winstaller`) and macOS-only optional watcher (`fsevents`). PacketLark's Windows targets are NSIS and ZIP, so neither hook is needed for supported builds. Electron 44 downloads its executable on first launch if necessary. Do not blanket-approve dependency hooks or use `npm audit fix --force` to resolve packaging warnings.

## Sysop provisioning

The stdlib-only Python script allocates an unused point number, generates independent session/packet/AreaFix passwords, backs up `sbbsecho.ini`, appends a point-only linked-node entry, and writes a matching private signup file. Preview is the default. With `--apply`, live coordination automatically waits for SBBSecho/EchoCfg, uses SBBSecho's mutex, and signals import/export events afterwards; your BBS stays online without manual event pausing or a restart. See [the full Synchronet instructions](docs/SYNCHRONET.md) for custom paths/event codes and exceptional failure handling.

This is a **point link**, not a Synchronet terminal-login user. No BBS user record is required for the client. Initial discussion names in a signup file are a catalogue, not existing server subscriptions; use Manage discussions to request joins and wait for the provider's response.

## Limits and privacy

FidoNet is store-and-forward. Sent means the provider accepted the packet, not delivered or read. Direct messages are not end-to-end encrypted. CRAM-MD5 is legacy BinkP authentication, not message encryption; use the optional certificate-verified implicit TLS connection if your provider offers it. The app does not implement BinkD's legacy CRYPT extension or silently downgrade TLS verification.

Messages in `mailbox.sqlite` are local plaintext. The account profile is OS-encrypted, but queued wire packets contain their packet password and pending discussion-management requests contain their AreaFix password. Automatic management traffic is hidden from the mailbox; its request subject/body are cleared after transport acknowledgement, and recognized replies are consumed after processing. Backups therefore need private storage. Moving the database to another computer does not move the OS decryption key. Keep the original signup file securely for a future account move. Restoring a backup is currently a documented offline operation, not a UI feature.

**Delete** moves a message to **Trash**, retaining its read/starred flags and original folder. Use **Restore** to recover it, or **Delete permanently** in Trash to remove its local contents after confirmation. Queued mail is removed from the send queue when trashed, and restores to Drafts for review rather than resending automatically. Deletion does not recall mail already accepted by another system or remove a public post from other BBSes.

There is no HTML mail, email/SMTP transport, file attachments, file echoes/TIC handling, global user directory, read receipts, modem support, packet forwarding, background system service, automatic update service, or account self-registration in 0.1. This client does not edit or retract messages already sent through the network. Read [architecture and reliability](docs/ARCHITECTURE.md) for the scope and failure behavior.

## Repository baseline

Treat the source ZIP as the 0.1.0 baseline. Create your repository and commit it before applying follow-up patches:

```sh
git init -b main
git add .
git commit -m "feat: bootstrap PacketLark 0.1.0 point client"
```

MIT licensed. Dependency licenses are retained in installed packages by the normal npm/Electron packaging process. The application is independent of Synchronet; no Synchronet source is included.

Existing RetroPost accounts and `.retropost` signup files remain compatible. PacketLark retains the original internal mailbox/keyring identity so the rename does not require reimporting credentials.
