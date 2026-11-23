import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { Accounts, primaryAccount, snapshot } from '../src/core/accounts.js';
import { AccountSync } from '../src/core/account-sync.js';
import { Store } from '../src/core/store.js';
import { parsePacket } from '../src/core/packet.js';
import { recipientSuggestions } from '../src/core/contacts.js';
import {
  accountNotificationTarget,
  notificationTarget,
  windowsToast,
} from '../src/core/notifications.js';
import { compose, incomingPacket, profile } from './fixtures.js';
import type { ConnectionSettings, Message } from '../src/core/model.js';

const dirs: string[] = [];
const open = (file: string, beforeCredentials?: () => Promise<void>) =>
  Store.open(
    file,
    path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
    (s) => Buffer.from(s).toString('base64'),
    (s) => Buffer.from(s, 'base64').toString(),
    beforeCredentials,
  );
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-accounts-'));
  dirs.push(dir);
  return dir;
};
const second = {
  ...profile,
  address: '1:123/456.101@fidonet',
  provider: 'Second account',
  uplink: { ...profile.uplink, sessionPassword: 'OTHERSESSION' },
};
const third = {
  ...profile,
  address: '1:123/456.101@othernet',
  provider: 'Other network',
  uplink: { ...profile.uplink, address: '1:123/456@othernet' },
};
const received = () => parsePacket(incomingPacket(), profile)[0];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('opens an empty mailbox without unlocking and leaves an existing mailbox intact on cancellation', async () => {
  const file = path.join(scratch(), 'mailbox.sqlite');
  let prompts = 0;
  const cancel = async () => {
    prompts++;
    throw new Error('Unlock cancelled');
  };
  const blank = await open(file, cancel);
  expect(prompts).toBe(0);
  blank.install(profile);
  blank.queue(compose);
  blank.close();
  const before = fs.readFileSync(file);
  await expect(open(file, cancel)).rejects.toThrow('Unlock cancelled');
  expect(prompts).toBe(1);
  expect(fs.readFileSync(file)).toEqual(before);
  const reopened = await open(file, async () => {
    prompts++;
  });
  expect(prompts).toBe(2);
  expect(reopened.profile()).toEqual(profile);
  expect(reopened.pending()).toHaveLength(1);
  reopened.close();
});

it('adopts the legacy mailbox in place, keeps queue bytes and loads independent mailboxes on restart', async () => {
  const root = scratch();
  const legacy = await open(path.join(root, 'mailbox.sqlite'));
  legacy.install({ ...profile, format: 'retropost-account' });
  const draft = legacy.saveDraft(compose);
  legacy.queue(compose);
  legacy.contact('Old contact', '1:123/9');
  const queued = legacy.pending()[0];
  legacy.setReading({ ...legacy.readingSettings(), fontSize: 18 });
  legacy.close();
  const original = fs.readFileSync(path.join(root, 'mailbox.sqlite'));
  const a = await Accounts.open(root, open);
  expect(a.active.id).toBe(primaryAccount);
  const b = await a.add(second);
  const c = await a.add(third);
  expect(a.active.id).toBe(primaryAccount);
  expect(() => a.scope(b.id)).toThrow('visible account changed');
  expect(() => a.scope(undefined)).toThrow();
  expect(a.summaries().map((x) => x.account.address)).toEqual([
    profile.address,
    second.address,
    third.address,
  ]);
  expect(JSON.stringify(a.summaries())).not.toContain('OTHERSESSION');
  await expect(a.add({ ...second, address: '01:00123/00456.101@FIDONET' })).rejects.toThrow(
    'already installed',
  );
  a.select(b.id);
  a.pause(b.id, true);
  expect(snapshot(a.active).messages).toEqual([]);
  expect(snapshot(a.active).contacts).toEqual([]);
  expect(() => a.scope(primaryAccount)).toThrow('visible account changed');
  a.close();
  expect(fs.readFileSync(path.join(root, 'mailbox.sqlite'))).toEqual(original);

  const reopened = await Accounts.open(root, open);
  expect(reopened.active.id).toBe(b.id);
  expect(reopened.active.paused).toBe(true);
  expect(reopened.primary.store.pending()).toEqual([queued]);
  expect(reopened.primary.store.messages().some((m) => m.id === draft)).toBe(true);
  expect(reopened.primary.store.readingSettings().fontSize).toBe(18);
  expect(reopened.require(c.id).store.profile()?.address).toBe(third.address);
  reopened.close();
});

it('opens the primary account when another mailbox is missing, without creating an empty replacement', async () => {
  const root = scratch();
  const accounts = await Accounts.open(root, open);
  await accounts.add(profile);
  const other = await accounts.add(second);
  accounts.select(other.id);
  accounts.close();
  fs.renameSync(other.store.file, other.store.file + '.saved');
  const reopened = await Accounts.open(root, open);
  expect(reopened.active.id).toBe(primaryAccount);
  expect(reopened.unavailable.has(other.id)).toBe(true);
  expect(fs.existsSync(other.store.file)).toBe(false);
  await expect(reopened.add(second)).rejects.toThrow('could not be opened');
  reopened.close();
});

it('keeps receive commits, queue acknowledgements, and notification routing in the exchange owner after switching', async () => {
  const accounts = await Accounts.open(scratch(), open);
  const a = await accounts.add(profile);
  const b = await accounts.add(second);
  const sent = a.store.queue(compose);
  const bSent = b.store.queue({ ...compose, subject: 'Stay queued' });
  const notices: [string, string[]][] = [];
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const original = incomingPacket();
  const sync = new AccountSync({
    emit: () => {},
    received: (account, ids) => notices.push([account.id, [...ids]]),
    exchange: async (p, files, hooks) => {
      expect(p.address).toBe(profile.address);
      expect(files).toHaveLength(1);
      await gate;
      await hooks.receive({ name: 'incoming.pkt', time: 0, bytes: original });
      await hooks.sent(files[0].name);
    },
  });
  const transfer = sync.run(a);
  expect(sync.current).toBe(a);
  accounts.select(b.id);
  b.store.saveDraft({ ...compose, subject: 'Other draft' });
  unblock();
  await transfer;
  expect(a.store.messages().find((m) => m.id === sent)?.folder).toBe('sent');
  expect(a.store.messages().find((m) => m.folder === 'inbox')?.id).toBe(received().id);
  expect(b.store.messages().find((m) => m.id === bSent)?.folder).toBe('outbox');
  expect(b.store.messages().some((m) => m.folder === 'inbox')).toBe(false);
  expect(notices).toEqual([[a.id, [received().id]]]);
  expect(accounts.active).toBe(b);
  accounts.close();
});

it('checks enabled accounts in order after a failure and records a redacted error on its owner', async () => {
  const accounts = await Accounts.open(scratch(), open);
  const a = await accounts.add(profile);
  const b = await accounts.add(second);
  const c = await accounts.add(third);
  accounts.pause(c.id, true);
  const tried: string[] = [];
  const sync = new AccountSync({
    emit: () => {},
    received: () => {},
    exchange: async (p) => {
      tried.push(p.address);
      if (p.address === profile.address) throw new Error('Rejected TESTSESSION and TESTPKT');
    },
    now: () => 1_000_000,
  });
  await expect(sync.all([a, b, c])).rejects.toThrow('1 account');
  expect(tried).toEqual([profile.address, second.address]);
  expect(a.store.state().lastError).toBe('Rejected [redacted] and [redacted]');
  expect(a.store.state().lastSync).toBeNull();
  expect(b.store.state().lastSync).not.toBeNull();
  expect(b.store.state().lastError).toBe('');
  expect(c.store.state().lastSync).toBeNull();
  expect(a.nextCheck).toBeGreaterThan(a.lastAttempt);
  accounts.close();
});

it('keeps same-ID mail separate in unified unread and hides read, control, trashed and hidden discussion mail', async () => {
  const accounts = await Accounts.open(scratch(), open);
  const a = await accounts.add({
    ...profile,
    areas: [...profile.areas, { tag: 'HIDDEN', name: 'ADM staff' }],
  });
  const b = await accounts.add(second);
  const m = received();
  const read = { ...m, id: 'read', msgid: 'read', read: true };
  a.store.receive([m, read, { ...m, id: 'unlisted', msgid: 'unlisted', area: 'HIDDEN' }]);
  b.store.receive([
    { ...m, subject: 'Same ID, different account' },
    { ...m, id: 'deleted', msgid: 'deleted' },
  ]);
  b.store.trashMessage('deleted');
  expect(accounts.unread('newest', 0).total).toBe(2);
  expect(accounts.unread('oldest', 0).items.map((x) => [x.accountId, x.messageId])).toEqual(
    expect.arrayContaining([
      [a.id, m.id],
      [b.id, m.id],
    ]),
  );
  expect(accounts.unread('newest', 2).items).toEqual([]);
  expect(accounts.summaries().map((x) => x.unread)).toEqual([1, 1]);
  a.store.mark(m.id, { read: true });
  expect(accounts.unread('newest', 0).items.map((x) => x.accountId)).toEqual([b.id]);
  accounts.close();
});

it('blocks packet and AreaFix password changes while original packets are queued', async () => {
  const a = await open(path.join(scratch(), 'mailbox.sqlite'));
  a.install(profile);
  const id = a.queue(compose);
  const queued = a.pending();
  const settings: ConnectionSettings = {
    host: 'changed.example.invalid',
    port: 24555,
    tls: true,
    charset: 'CP437',
    pollMinutes: 25,
  };
  expect(() => a.updateConnection({ ...settings, packetPassword: 'NEWPKT' })).toThrow('queued');
  expect(() => a.updateConnection({ ...settings, areaFixPassword: '' })).toThrow('queued');
  expect(a.profile()).toEqual(profile);
  a.updateConnection({ ...settings, sessionPassword: 'ROTATED' });
  expect(a.profile()?.uplink).toMatchObject({
    sessionPassword: 'ROTATED',
    packetPassword: 'TESTPKT',
    tls: true,
    port: 24555,
  });
  expect(a.pending()).toEqual(queued);
  a.trashMessage(id);
  expect(a.pending()).toEqual([]);
  a.updateConnection({ ...settings, packetPassword: '', areaFixPassword: 'NEWAREA' });
  expect(a.profile()?.uplink).toMatchObject({ packetPassword: '', areaFixPassword: 'NEWAREA' });
  a.close();
});

it('validates and restores only the matching account, preserving global preferences and exact queued bytes', async () => {
  const s = await open(path.join(scratch(), 'mailbox.sqlite'));
  const b = await open(path.join(scratch(), 'mailbox.sqlite'));
  s.install(profile);
  b.install(second);
  const queuedId = s.queue(compose);
  const queued = s.pending()[0];
  const backup = s.backup();
  s.sent(queued.name);
  s.setDesktop({ keepRunning: true, startAtLogin: false });
  s.setReading({ ...s.readingSettings(), fontSize: 20 });
  const rev = s.revision;
  expect(() => s.prepareRestore(Buffer.from('junk'))).toThrow('SQLite');
  expect(() => s.prepareRestore(b.backup())).toThrow('different point');
  const next = s.prepareRestore(backup);
  expect(next.queued).toBe(1);
  expect(s.revision).toBe(rev);
  expect(s.pending()).toEqual([]);
  s.replaceMailbox(next.bytes);
  expect(s.revision).toBe(rev + 1);
  expect(s.pending()).toEqual([queued]);
  expect(s.messages().find((m) => m.id === queuedId)?.folder).toBe('outbox');
  expect(s.readingSettings().fontSize).toBe(20);
  expect(s.desktopSettings().keepRunning).toBe(true);
  b.close();
  s.close();
});

it('uses saved contact names, normalizes duplicate addresses and ignores foreign, trashed and internal senders', () => {
  const m = received();
  const msg = (patch: Partial<Message>) => ({ ...m, ...patch });
  expect(
    recipientSuggestions(
      [
        { name: 'Saved name', address: '1:123/456' },
        { name: 'All', address: profile.address },
      ],
      [
        m,
        msg({
          from: 'Recipient in sent mail',
          to: 'Someone',
          toAddress: '1:123/456.3',
          folder: 'sent',
        }),
        msg({ from: 'Another domain', fromAddress: '1:123/456.4@test' }),
        msg({ from: 'Removed', fromAddress: '1:123/456.5', folder: 'trash' }),
        msg({ from: 'Internal', fromAddress: '1:123/456.6', internal: true }),
      ],
      profile.address,
    ),
  ).toEqual([
    { name: 'Saved name', address: '1:123/456' },
    { name: 'All', address: profile.address },
    { name: 'Someone', address: '1:123/456.3' },
  ]);
});

it('preserves legacy toast activation and includes the account in a new Windows toast', () => {
  const accountId = '02451957-4c3e-4a59-abb4-70920a25b543';
  expect(notificationTarget('packetlark-message:id')).toBe('id');
  const args = `packetlark-account:${accountId}:same-id`;
  expect(
    windowsToast({ title: 'Mail', body: 'After switching', messageId: 'same-id', accountId }),
  ).toContain(args);
  expect(accountNotificationTarget(args)).toEqual({ id: 'same-id', accountId });
  expect(accountNotificationTarget(`packetlark-account:${accountId}:../bad`)).toBeNull();
});

it('cancels hidden queued requests without cancelling ordinary mail or changing subscriptions', async () => {
  const store = await open(path.join(scratch(), 'mailbox.sqlite'));
  store.install(profile);
  store.queue(compose);
  const outgoing = store.pending()[0];
  store.requestAreaList();
  store.areaCommand('TEST', true);
  expect(store.cancelDiscussionRequests()).toBe(2);
  expect(store.pending()).toEqual([outgoing]);
  expect(store.state().discussions.requestId).toBeNull();
  expect(store.state().discussions.entries[0]).toMatchObject({
    pending: null,
    subscription: 'unknown',
  });
  expect(store.cancelDiscussionRequests()).toBe(0);
  store.close();
});
