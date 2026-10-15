# Architecture and reliability

## Application boundaries

The Electron main process owns the OS-encrypted account, SQLite mailbox, BinkP socket, and filesystem dialogs. The renderer uses a small typed IPC bridge. It has no Node integration, remains sandboxed with context isolation, rejects navigation/new windows and permissions, and renders message bodies with textContent. A restrictive Content Security Policy prevents network fetches, inline scripts, and remote content. This is a locally packaged desktop application, not a web service or Electron wrapper for a remote site.

The renderer never receives session credentials or the packet password. Automatic discussion requests use internal message records excluded from public state, including their AreaFix password subject. Exact queued wire packets are retained for retry until acknowledged; then the internal subject/body/raw payload is cleared. Recognized SBBSecho replies update the directory and leave only a duplicate-detection receipt, not a mailbox item. Old recognized incoming copies and generated request records are cleaned up on open. Unrelated messages remain visible. Persisted outgoing wire packets contain their packet password until acknowledged; treat the mailbox and backups as private even though the account profile is separately encrypted. SQLite page remnants and older backups are not securely erased.

The SQL.js SQLite database is operated synchronously by one main process. Changes are committed and exported to a private temporary file, fsynced, and renamed into place before success is reported. Unix directory entries are fsynced. On write failure the in-memory database is restored to its previous snapshot. Windows and Linux filesystem/power-loss guarantees still depend on the OS and storage. Snapshots are practical for this initial small-mailbox implementation; large mailboxes should move to a native incremental SQLite backend later without changing the IPC contract.

## Interface updates

Durable mutations increment an in-memory revision only after the atomic save
succeeds. The main process caches the public mailbox snapshot for that revision.
Connection progress sends a small revision/status event, so it does not rescan
SQLite, decrypt the profile, or copy the entire mailbox across IPC on every update.
New data invalidates the snapshot; notifications arriving together are coalesced
before fetching a new copy. Repeatedly setting an unchanged read/starred flag
does not rewrite the database. Individual message operations use primary-key
lookups instead of parsing every stored message.

The renderer counts sidebar badges in one pass, reuses one date formatter,
retains keyed message buttons, and preserves the reader body on flag-only changes.
Unchanged panels and status text are left in place, retaining scroll and focus.
Folders initially render 200 rows and expose more in batches of 200; local search
still covers the complete selected folder. These changes preserve synchronous
durable commits and the existing network acknowledgement rules. GPU acceleration
and platform graphics backend selection are unchanged.

## Sending

Composing uses a draft record, debounced while typing. Queuing validates fields and encoded byte lengths, builds one raw Type-2+ packet, and persists its exact bytes, filename, timestamp, and message identity. Retrying uses the same bytes and MSGID. A draft cannot be queued twice using its existing ID.

A BinkP session advertises the assigned point and protocol 1.0, verifies the boss's advertised address, authenticates using its advertised CRAM-MD5 challenge (or a plain password only within verified TLS), then exchanges files. This version does not advertise MB, NR, compression, CRYPT, or other unsupported extensions. Only a matching filename/size/timestamp M_GOT changes that message from Outbox to Sent. Transport acknowledgement does not prove that the remote tosser accepted, routed, or delivered the contained message.

Interrupted transfers keep unacknowledged outgoing messages queued. A remote may have received a packet but lost its acknowledgement; stable MSGIDs help the remote deduplicate a retry, but exactly-once delivery cannot be guaranteed by the client alone. The point does not forward third-party packets or route directly to arbitrary nodes; everything goes through its configured boss. Point-origin echomail leaves routing lines for the boss tosser to add and never claims that the boss already routed the post.

## Receiving

File frames are bounded at the protocol level. Individual incoming files are limited to 16 MiB. ZIP mail bundles allow only flat `.pkt` entries, at most 1,000 entries and 32 MiB total declared expansion. Files are never extracted to arbitrary filesystem paths. Unsupported archives, attachments, encodings, envelope addresses, packet passwords, or malformed records fail the session without acknowledging the file.

The incoming packet envelope must come from the configured boss and be addressed to the exact point. Individual direct messages must also target that point. Echomail origin lines and netmail INTL/FMPT/TOPT determine displayed sender/recipient identities. MSGID/REPLY supports threading; missing IDs use content-derived identities for local duplicate detection. Search and the initial mailbox list run locally in memory.

The application durably imports user messages and applies recognized management replies before transmitting M_GOT. A reconnect after import but before acknowledgement reimports idempotently, preserving existing read/starred flags. Consumed replies and permanently deleted mail retain only identity receipts so packet retries cannot recreate them. Receipt keys use JSON-encoded area/MSGID pairs rather than NUL-delimited SQLite text. No raw incoming archive is retained once its content is safely imported; ordinary stored messages include decoded original body/control text for inspection. The remote retains a file that fails import.

## Deleting and restoring mail

Moving a message to Trash records its original folder and deletion time in the existing JSON message row. Removing any queued wire packet is part of the same durable transaction. A restored outbox item becomes a draft, preserving MSGID but requiring explicit review and queuing again; incoming, sent, and draft items return to their original folders. Trash items are excluded from Starred and normal conversation threading. Permanent deletion is allowed only from Trash and requires a renderer confirmation. The main process rejects delete/restore while an exchange is active, including direct IPC calls. Existing read/starred flags, contacts, area configuration, and other queued packets are preserved. The legacy draft-removal IPC remains available for compatibility.

## Account format and secrets

`.packetlark` is strict versioned JSON, limited to 128 KiB at import. It carries provider/name, a point and boss in the same FTN domain, server/port/TLS selection, separate credentials, initial discussion catalogue, polling interval, and outgoing charset. Profile import is reviewed in a native confirmation dialog. There are no executable hooks, file paths to run, downloaded code, or scriptable signup commands in the file.

Credentials are stored in an OS-encrypted JSON blob. Linux `basic_text` fallback is refused. Message bodies, contact information, control headers, and SQLite backups are not encrypted. No telemetry, remote fonts, analytics, AI services, or update server is configured.

## Current limits

- A single point account per mailbox; no in-app replacement/removal or multi-device state synchronization.
- Desktop application must be running for scheduled polling; no notification tray/background service yet.
- Search, list generation, and SQLite snapshot costs grow with mailbox size; rendered message rows are batched, but automatic retention is not implemented.
- Basic threading uses explicit parent references. Missing/malformed legacy headers are not guessed by subject.
- Discussion requests are asynchronous netmail commands; the interface does not parse every provider-specific AreaFix response format or maintain authoritative membership state.
- Unsupported incoming mail stays on the provider and needs sysop attention. Local display cannot retract or edit network posts.
- No attachments, file areas, modem links, automatic upgrades, or hosting/provisioning web API.

## Next useful iterations

After live interoperability testing: provider-confirmed subscription status and catalogue browsing; first-run automatic connection; notifications; profile migration and backup restore UI; a native incremental SQLite backend; then multi-account/network support. Keep each change compatible with the existing mailbox and account format, with migrations when required.
