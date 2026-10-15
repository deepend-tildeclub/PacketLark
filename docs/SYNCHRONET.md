# Synchronet point setup

PacketLark 0.1 is a point client. Your existing node remains the boss, routes netmail, and distributes echomail using SBBSecho. BinkIT accepts the desktop's outbound connections. No incoming connection to a user's PC is required.

## Before provisioning

Use your current working Synchronet/SBBSecho v3/BinkIT v2 configuration. Verify your node already exchanges normal mail. Keep your existing BinkP listener and events. PacketLark does not install a BBS, replace a mailer, change your AKAs, or change global routing.

Use the actual path to your active `ctrl/sbbsecho.ini`. On your Linux BBS, run the Python tool as the account that normally owns that configuration. Python 3.10+ is the only server-side dependency. Coordinate applying changes with a quiet period: pause mail-processing events and do not keep EchoCfg open with unsaved changes. The script's lock coordinates its own invocations; Synchronet and other editors do not honor that lock.

Back up your normal BBS configuration using your existing procedure before the first trial. The tool also makes a private timestamped backup of the exact file it appends to. It does not rewrite or reserialize existing sections.

## Preview a point

Replace every example address, hostname, and path below with your real values. `1:123/456` is an example, not an assigned address.

```sh
python3 tools/provision_point.py \
  --config /home/sbbs/sbbs/ctrl/sbbsecho.ini \
  --boss 1:123/456@fidonet \
  --host bbs.example.invalid \
  --name 'Example Person' \
  --point auto \
  --start 100 \
  --area 'TEST=Test discussion' \
  --output /home/sbbs/private-signups/example-person.packetlark
```

Without `--apply`, this only prints a credential-free plan. No config, signup file, lock, or backup is written. Auto-allocation selects the first unused point at or above `--start`, within the specified boss/domain. You can use `--point 105` for an explicit unused point.

After reviewing the point, host, port, and output path, run the same command with `--apply` appended. It will:

1. Refuse an existing point or output file, or a competing allocator lock.
2. Generate independent random session, packet, and AreaFix credentials.
3. Save a mode-0600 timestamped backup alongside `sbbsecho.ini`.
4. Append only the new `[node:zone:net/node.point@domain]` section.
5. Create the matching private `.packetlark` file with mode 0600 on Unix.

The link uses Type-2+ packets, no archive packing, hold-for-pickup status, no outbound polling, and CRAM-MD5 authentication. The account tells PacketLark to poll every ten minutes while open. Existing links, global options, domain sections, and user records remain untouched.

On Windows, use equivalent single-line PowerShell commands and protected NTFS folders; Unix mode bits do not substitute for Windows ACLs. The tool must be able to preserve the config file's ownership and replace it in its existing directory.

Resume your normal events after checking the appended section in EchoCfg. Do not save an old, already-open EchoCfg session over the newly appended file. BinkIT normally reads the configuration for its sessions; follow your installation's usual refresh/reload procedure where needed.

## First user connection

Deliver the `.packetlark` file privately. It contains reusable account credentials in plaintext so the recipient can import them; do not put it in a public download directory, repository, or public attachment. PacketLark encrypts the account at import using the user's OS keyring. Remove unneeded copies after delivery and secure retention.

The user installs/starts PacketLark, chooses **Import your account file**, reviews the provider and point address, then selects **Send & receive**. This first connection proves addressing and session authentication. An empty exchange is a valid result.

The `--area` arguments list groups in the client sidebar. They **do not subscribe the point on your BBS**. The user should choose **Manage discussions → Request to join**, then Send & receive. Your normal SBBSecho inbound processing must process the AreaFix message; a later exchange retrieves its response. A successful BinkP session alone does not mean SBBSecho has processed the packet yet.

Allow only the groups you intend to offer this point. Existing SBBSecho EchoList keys, area permissions, and security remain authoritative. The tool does not grant access to restricted EchoLists or modify `areas.bbs`/`areas.ini`. You may also manually add the point as a link to an existing group using your normal sysop procedure.

## Acceptance test before inviting users

Use one disposable point account and a local/test discussion first.

1. Confirm the client imports the profile and completes an empty exchange. Watch BinkIT logs for the assigned point and successful authentication.
2. Send direct netmail from the client to your own node/sysop. Confirm BinkIT receipt, SBBSecho import, and the recipient address/name.
3. Reply from the BBS to the user's **point address**, then run the normal outbound processing. Confirm pickup in PacketLark and a successful response back.
4. Request a test discussion subscription. Process the request with SBBSecho and inspect its AreaFix response. Correct authorization failures on the BBS rather than assuming a queued request succeeded.
5. Post from the point, confirm it imports into the intended BBS sub-board, and reply from the BBS. Verify a second permitted downlink receives the post if you want to validate forwarding; transport acknowledgement is not proof of forwarding.
6. Disconnect the client before an outgoing acknowledgement and retry. Its stored packet identity should remain stable. Confirm the BBS's own duplicate handling before repeating publicly.
7. Restart PacketLark and verify drafts, read/starred flags, and unsent messages remain present.

Once these pass on Linux, repeat import, send/reply, discussion reply, and restart checks with the Windows CI artifact. Only then expand to ordinary users.

## TLS and compatibility

Default port 24554 uses standard BinkP and CRAM-MD5. It authenticates the point to BinkIT but does not encrypt message contents or authenticate the server like TLS does. If your BinkIT deployment has an **implicit TLS** listener and a certificate trusted by the user's OS, add `--tls --port YOUR_TLS_PORT` when provisioning. The tool does not create that listener or certificates. STARTTLS and BinkD CRYPT are not implemented.

Keep **BinkpAllowPlainText = true** for these point links when using ordinary BinkP. This permits unencrypted payloads, not plain-password authentication; the generated link separately disallows plain passwords. Do not change a global security option to accommodate a single point. A TLS listener encrypts the connection even though legacy BinkP CRYPT is not negotiated.

Prefer `PacketType = 2+` and `Archive = None` for the first trial. ZIP bundles are supported, but ARC/ARJ/LZH and arbitrary attachments are not. Incoming unsupported or invalid files are not acknowledged; the provider retains its copy and the client reports the reason. A bad file can therefore block progress until the sysop resolves it. Keep logs and backups while investigating.

The script does not confirm that `--boss` is one of your configured local AKAs; you must supply the correct existing one. It also does not create a BBS terminal user, configure a nodelist, pointlist, routing policy, subscriptions, or public self-service signup endpoint.

## Undo the trial

Stop using the trial point, pause relevant processing, and remove only that point's node section and area links using your normal configuration tools. Inspect queued mail for the point before removing it. Keep or revoke credentials according to your policy. Restoring the entire timestamped INI backup is appropriate only if no subsequent unrelated configuration changes need preserving. Do not blindly restore it over newer BBS changes.

## References

- [SBBSecho configuration](https://wiki.synchro.net/config:sbbsecho.ini)
- [SBBSecho installation and AreaFix](https://wiki.synchro.net/util:sbbsecho)
- [BinkIT](https://wiki.synchro.net/module:binkit)
- [FTSC document catalogue](https://ftsc.org/docs/)
