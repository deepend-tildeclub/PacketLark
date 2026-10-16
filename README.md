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
- Related replies are grouped into **Conversations** by default. The **View** menu also offers **Individual messages** and remembers your choice on this device. Threads use explicit reply links within the same discussion, including sent replies and branches; matching subjects alone never combine unrelated mail.
- Messages default to **Newest first**, including the messages displayed together inside an open conversation and its reply links. The **Sort** menu also offers **Oldest first** and remembers your choice on this device across folders, discussions, and restarts.
- Large folders initially show 200 rows (conversations or individual messages); **Show older messages** (or **Show newer messages** when sorted oldest first) loads more, while search covers every message in the selected folder. Long grouped conversations initially display 100 bodies, with **Show more of this conversation** to continue.
- Compose, automatic draft saving, saved drafts, queued Outbox, and Sent after provider acknowledgement.
- Delete to Trash, restore, and confirmed permanent deletion; deleting queued mail cancels its pending send and restores to Drafts.
- Send & receive manually or periodically while the application is running.
- Native Windows/Linux new-mail notifications while the app is in the background, with click-to-open and saved notification preferences.
- Optional close-to-tray background operation, unread indicators, and start at sign-in in packaged builds.
- First unread navigation, one-action conversation read marking, collapsible replies/quotes/signatures, and saved reading preferences.
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

### Conversation view

Inbox, discussion, Sent, and Starred lists can group replies. Each row shows the conversation's message count and unread count for the selected folder. Rows sort by the latest activity in that folder, in your chosen direction. Search and **Unread only** keep a conversation when at least one message in the folder matches both filters; opening it selects the newest matching message and displays the linked conversation for context, including sent replies.

Select an author inside a grouped conversation to choose a particular message. Reply, private reply, star, read/unread, details, and delete apply to that selected message. Opening a conversation marks only the selected message read. Deleting a message moves only that message to Trash; the rest of the conversation stays available. Drafts, Outbox, and Trash always show individual messages so editing, cancellation, restoration, and permanent deletion remain explicit. The view preference returns when you switch back to another folder.

Messages without reply links remain separate. Repeated ambiguous message identifiers are not used to guess a parent. Both view and sort controls continue working for the current session if local preference storage is unavailable. No mailbox conversion or database migration is required.

## Reading and background preferences

Open **Preferences** in the toolbar to choose message text size (12–24 px), system or monospace font, and comfortable or compact spacing. Optional switches collapse read replies, quoted text, and signatures/message footers. These display choices are saved in your local mailbox. Folded text can always be expanded, and **Show original text** restores the complete plain-text display. Reply quoting and message details still use the original message.

In a grouped conversation, **First unread** selects the oldest received unread message, even beyond the initial 100-body page. **Mark conversation read** marks received messages in that explicit thread together; it leaves other conversations, deleted mail, and outgoing flags alone. **Collapse read replies** and **Expand replies** change the current thread without changing your saved preference. The selected message stays expanded, and the existing per-message reply, star, read/unread, details, and delete actions remain available.

Background operation is **off by default**. Enable **Keep running when the window is closed** to make Close hide the window while retaining drafts and the normal mail-check interval. The native tray menu offers **Open PacketLark**, **Send & receive**, and **Quit PacketLark**, with an unread count and indicator. Reopening PacketLark or clicking a mail notification restores the existing window. A missing or failed tray falls back to normal window operation; Linux needs a desktop panel with tray support.

The optional **Start PacketLark when I sign in** uses Windows login settings or a per-user Linux XDG autostart entry. It is available only in packaged builds with background operation enabled. Turning background operation off also disables sign-in startup. Keep an AppImage at a stable path when using this option. PacketLark never overwrites an autostart entry it does not own.

**Quit PacketLark** saves any pending draft before exiting. If saving fails, the window stays open with the text intact. Quitting stops background mail checks; this is a desktop application, not a system service. Native tray and taskbar badge appearance depends on the desktop shell.

## Advanced connection setup

Importing a sysop-provided `.packetlark` file remains the primary setup path. Without a file, choose **Advanced setup** on the welcome screen, under **Account**, or in **Preferences → Connection setup**. This is for an **existing point account**: it does not create or register a point on the BBS, and version 1 still requires a point address with its matching boss node.

Enter your name, provider/BBS label, assigned point address, boss-node address, BinkP hostname/IP and port, and session password. Optional packet and AreaFix passwords must match the boss-node configuration; a packet password is at most eight printable ASCII characters without spaces. Leave an optional password empty only if it is not required. Choose the polling interval and outgoing encoding as agreed with your provider. Enable certificate-verified implicit TLS only for a server endpoint that offers it, using that endpoint's port; otherwise BinkP requires CRAM-MD5 and message traffic is not encrypted.

**Set up account** validates and saves through the same keyring-protected account installer used by imports. It does not connect immediately: use **Send & receive** when ready. With an AreaFix password, open **Manage discussions → Get available discussions** to find and join areas. Validation or keyring failures leave the form available to correct/retry. Existing accounts cannot be overwritten, and passwords are never returned in public mailbox state.

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

## Desktop notifications

Notifications use the operating system's own UI: Windows toasts/Notification Center and Linux's desktop notification service through Electron/libnotify. They are enabled by default for direct messages and discussion posts while PacketLark is open in the background. Mail collected in one exchange is grouped into one alert; clicking it brings PacketLark forward and opens the latest eligible message. An open draft stays intact. Existing unread messages do not generate a startup alert, and duplicates, consumed AreaFix traffic, and hidden ADM discussions do not generate alerts.

Open **Preferences → Desktop notifications** to turn alerts off, exclude discussion posts, or hide sender/subject previews. Message bodies are never included in notifications. Preferences are saved with the mailbox and survive restarts. **Test notification** requests an alert even while the app has focus; sound, banners, lock-screen display, and Do Not Disturb are controlled by the OS. Closing the window exits and stops polling unless you have enabled background operation in Preferences.

The Windows NSIS and ZIP builds retain the existing application ID and use a stable toast activation identity; the current Electron runtime registers the required per-user shortcut/activation information when its notification presenter is initialized. A moved ZIP build needs to be launched again from its new location. Development runs use a separate identity to avoid replacing the installed app's toast activation registration. Linux uses the existing `packetlark.desktop` identity and a bundled notification icon. The `.deb` package already depends on `libnotify4`; other Linux installs also need libnotify and a running desktop notification server. Hyprland setups need a notification daemon such as mako or dunst. The app does not install or replace your desktop's notification service.

Unavailable/disabled notification services do not fail mail delivery or packet acknowledgement. Notifications are generated only from newly committed mailbox messages, including mail saved before a later exchange error. A notification pointing to a deleted/hidden message leaves the mailbox unchanged and displays a friendly notice.

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
