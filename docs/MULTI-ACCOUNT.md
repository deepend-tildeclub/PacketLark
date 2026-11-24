# Accounts and preview builds

## Adding a point

Use **Account → Add another account**. A sysop can send the same
`.packetlark` file as before. Existing `.retropost` files also work. If you
already know the connection details, use **Advanced setup**. This does not
create a point on the BBS. An address already installed on the same FTN
domain cannot be added twice.

The first mailbox and the app's OS keyring identity stay in place. Adding a
point does not move old mail or change the selected account. Pick the account
from the toolbar to switch. The message editor names the sending account when
more than one is installed. A notification from a different account waits for
an open dialog or draft to close before switching.

**All unread** shows unread direct messages and visible discussion posts
across accounts. Open a result to read or reply in the mailbox that received
it. Contact suggestions use saved contacts and recent local mail within the
account's FTN domain. If two addresses use the same name, choose the address
yourself.

## Checks and connection settings

Automatic checks are tracked per account and run one exchange at a time. One
failed account does not stop the others; repeated failures delay its next
automatic attempt. The Account dialog shows last successful check and the
most recent exchange error. Common network and TLS errors have suggestions
on what to check. There is no automatic retry with TLS disabled.

By default, PacketLark checks mail when it starts. To wait for the normal
poll interval instead, turn off **Preferences → Mail checks → Send & receive
on startup**. Pause excludes that account from startup checks, automatic
polling, and **Send & receive all**. You can still check the selected account
with **Send & receive**. A running exchange is allowed to finish.

Use **Account → Connection settings** to change the hostname, port, TLS,
polling, encoding, or passwords. Leave password fields blank to keep them.
The point and boss addresses stay fixed. Add a new account to use a
different point.

Queued packets retain their exact bytes and MSGIDs until acknowledged.
Before changing the packet or AreaFix password, finish sending or cancel
queued items. Trash ordinary queued mail to cancel it. Restore it from
Trash to Drafts and review it before sending again. If there are hidden
AreaFix requests, **Cancel queued discussion requests** is available in
Connection settings. It removes local retries only; ask for a fresh list
after fixing the credentials if the BBS may have processed a request.

## Backup and restore

Switch to the account you want to back up and choose **Account → Back up
mailbox**. Back up each account separately, or quit PacketLark and copy the
entire application-data directory for a full backup. Mail and backups contain
private data. Moving a database does not move the OS decryption key.

Use **Account → Restore mailbox** to restore a matching backup (up to 512 MiB)
on the same computer and OS user with its original keyring. The app validates
the file and point before replacing anything. Restoring saves the current
mailbox under `recovery/` in PacketLark's app data, preserves app-wide
preferences, and pauses automatic checks. Review the restored Outbox before
checking mail or resuming. Restoring can bring back packets the BBS has
already accepted. It can also restore older account passwords.

The legacy mailbox is still `mailbox.sqlite`. Keep `accounts.json` and the
`accounts/` directory together when backing up or restoring the entire app.
For a missing mailbox, quit and recover the original file to its original
path before reopening the app. The beta will not replace a missing registered
mailbox with a blank one. An older single-account build can only see the
original mailbox; use a separate copy of your full backup when testing a
downgrade.

## Publishing a preview

For a single-account fallback, build the previous 0.1.0 commit on Windows and
Linux with `npm ci` and `npm run dist`, and attach its packages to a
[v0.1.0 prerelease](https://github.com/deepend-tildeclub/PacketLark/releases/new)
targeting that commit. Do this before publishing the beta if you want both
versions available.

The beta workflow tests and packages on Windows and Linux, then publishes the
four packages and SHA-256 checksums to GitHub Releases. Branch builds retain
their current CI artifacts. After you've applied, tested, and committed the
patch, tag the beta when you're ready to publish:

```sh
git tag -a v0.2.0-beta.1 -m 'PacketLark 0.2.0 beta 1'
git push origin v0.2.0-beta.1
```

The tag must match `package.json`. The website is a separate deployment; set
its `DOWNLOAD_URL` to `https://github.com/deepend-tildeclub/PacketLark/releases`
once packages are available. The existing account-file generator needs no
changes for this beta.

Before inviting testers, try the packaged Windows and Linux builds with two
test points on RetroDigital: import both, send and receive, switch during a
check, join a discussion, click a notification from the other account, and
restore a backup with automatic checks paused. Confirm in the BBS logs that
each point's packets used the expected link. Use test accounts and inspect
their restored Outbox before resuming checks.
