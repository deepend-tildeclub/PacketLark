import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { parsePacket } from '../src/core/packet.js';
import { compose, profile, incomingPacket } from './fixtures.js';
const dirs: string[] = [];
const wasm = path.resolve('node_modules/sql.js/dist/sql-wasm.wasm');
async function open(file?: string) {
  if (!file) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-'));
    dirs.push(dir);
    file = path.join(dir, 'mailbox.sqlite');
  }
  return Store.open(
    file,
    wasm,
    (s) => Buffer.from(s).toString('base64'),
    (s) => Buffer.from(s, 'base64').toString(),
  );
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
describe('durable mailbox', () => {
  it('reopens a legacy account and preserves its queued messages across the rename', async () => {
    const s = await open();
    s.install({ ...profile, format: 'retropost-account' });
    s.queue(compose);
    const original = s.pending()[0];
    const file = s.file;
    s.close();
    const reopened = await open(file);
    expect(reopened.profile()?.format).toBe('retropost-account');
    expect(reopened.pending()[0]).toEqual(original);
    reopened.close();
  });
  it('imports one account without exposing secrets in public state', async () => {
    const s = await open();
    s.install(profile);
    expect(s.state().account?.name).toBe(profile.name);
    expect(JSON.stringify(s.state())).not.toContain('TESTSESSION');
    expect(() => s.install(profile)).toThrow('already');
    s.close();
  });
  it('installs a manual point without resetting preferences and persists its connection', async () => {
    const s = await open();
    s.setNotifications({ enabled: false, discussions: false, previews: false });
    const manual = {
      ...profile,
      areas: [],
      uplink: {
        ...profile.uplink,
        tls: true,
        port: 24555,
        packetPassword: '',
        areaFixPassword: '',
      },
    };
    expect(() => s.install({ ...manual, address: '1:123/999.100' })).toThrow();
    expect(s.profile()).toBeNull();
    s.install(manual);
    const file = s.file;
    s.close();
    const reopened = await open(file);
    expect(reopened.profile()).toEqual(manual);
    expect(reopened.state().notifications?.enabled).toBe(false);
    expect(reopened.state().areas).toEqual([]);
    expect(reopened.pending()).toEqual([]);
    expect(() => reopened.install(profile)).toThrow('already installed');
    expect(reopened.profile()).toEqual(manual);
    reopened.close();
  });
  it('leaves the mailbox unchanged when the keyring cannot seal a new account', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-keyring-'));
    dirs.push(dir);
    const s = await Store.open(
      path.join(dir, 'mailbox.sqlite'),
      wasm,
      () => {
        throw new Error('Keyring locked');
      },
      (value) => value,
    );
    const before = s.backup();
    const revision = s.revision;
    expect(() => s.install(profile)).toThrow('Keyring locked');
    expect(s.backup()).toEqual(before);
    expect(s.revision).toBe(revision);
    expect(s.state().account).toBeNull();
    s.close();
  });
  it('saves incomplete drafts and reopens them after restart', async () => {
    const s = await open();
    s.install(profile);
    const id = s.saveDraft({ ...compose, to: '', toAddress: '', subject: '', body: 'Writing…' });
    const file = s.file;
    s.close();
    const reopened = await open(file);
    expect(reopened.messages()[0].id).toBe(id);
    expect(reopened.messages()[0].body).toBe('Writing…');
    reopened.close();
  });
  it('keeps stable outgoing bytes and identity across restart and retries', async () => {
    const s = await open();
    s.install(profile);
    const id = s.saveDraft(compose);
    s.queue({ ...compose, id });
    const original = s.pending()[0],
      file = s.file;
    const msgid = s.messages()[0].msgid;
    s.syncResult('Offline');
    s.close();
    const again = await open(file);
    expect(again.pending()[0]).toEqual(original);
    expect(again.messages()[0].msgid).toBe(msgid);
    expect(again.messages()[0].error).toBe('Offline');
    again.close();
  });
  it('moves mail to Sent only after provider acknowledgement', async () => {
    const s = await open();
    s.install(profile);
    s.queue(compose);
    expect(s.messages()[0].folder).toBe('outbox');
    s.sent(s.pending()[0].name);
    expect(s.pending()).toHaveLength(0);
    expect(s.messages()[0].folder).toBe('sent');
    s.close();
  });
  it('prevents accidentally queuing the same draft twice', async () => {
    const s = await open();
    s.install(profile);
    const id = s.saveDraft(compose);
    s.queue({ ...compose, id });
    expect(() => s.queue({ ...compose, id })).toThrow('already');
    expect(s.pending()).toHaveLength(1);
    s.close();
  });
  it('deduplicates repeated deliveries and preserves flags', async () => {
    const s = await open();
    s.install(profile);
    const messages = parsePacket(incomingPacket(), profile);
    expect(s.receive(messages)).toBe(1);
    s.mark(messages[0].id, { starred: true, read: true });
    expect(s.receive(messages)).toBe(0);
    expect(s.messages()[0].starred).toBe(true);
    s.close();
  });
  it('refuses to remove sent or incoming messages as drafts', async () => {
    const s = await open();
    s.install(profile);
    s.receive(parsePacket(incomingPacket(), profile));
    expect(() => s.removeDraft(s.messages()[0].id)).toThrow('Only drafts');
    s.close();
  });
  it('does not overwrite a corrupt mailbox with an empty database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-'));
    dirs.push(dir);
    const file = path.join(dir, 'bad.sqlite');
    fs.writeFileSync(file, 'not a database');
    await expect(open(file)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('not a database');
  });
});
