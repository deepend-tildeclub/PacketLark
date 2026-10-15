import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { buildPacket, parsePacket } from '../src/core/packet.js';
import type { Message, Profile } from '../src/core/model.js';
import { compose, profile, incomingPacket } from './fixtures.js';

const dirs: string[] = [];
const wasm = path.resolve('node_modules/sql.js/dist/sql-wasm.wasm');
async function open(file?: string) {
  if (!file) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-controls-'));
    dirs.push(dir);
    file = path.join(dir, 'mailbox.sqlite');
  }
  return Store.open(
    file,
    wasm,
    (s) => s,
    (s) => s,
  );
}
function reply(subject: string, body: string, overrides: Partial<Message> = {}) {
  const server: Profile = {
    ...profile,
    name: 'SBBSecho',
    address: profile.uplink.address,
    uplink: { ...profile.uplink, address: profile.address },
  };
  return {
    ...parsePacket(
      buildPacket(
        server,
        { ...compose, to: profile.name, toAddress: profile.address, subject, body },
        `1:123/456 ${randomUUID()}`,
      ),
      profile,
    )[0],
    ...overrides,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mail deletion and recovery', () => {
  it('moves incoming mail to Trash and restores all content and flags after restart', async () => {
    const s = await open();
    s.install(profile);
    const incoming = parsePacket(incomingPacket(), profile)[0];
    s.receive([incoming]);
    s.mark(incoming.id, { read: true, starred: true });
    s.trashMessage(incoming.id);
    expect(s.state().messages[0]).toMatchObject({ folder: 'trash', trash: { folder: 'inbox' } });
    expect(s.receive([incoming])).toBe(0);
    const file = s.file;
    s.close();
    const again = await open(file);
    again.restoreMessage(incoming.id);
    expect(again.messages()[0]).toEqual({ ...incoming, read: true, starred: true });
    again.close();
  });
  it('restores sent mail to Sent without putting it back in the send queue', async () => {
    const s = await open();
    s.install(profile);
    const id = s.queue(compose);
    s.sent(s.pending()[0].name);
    s.trashMessage(id);
    s.restoreMessage(id);
    expect(s.messages()[0].folder).toBe('sent');
    expect(s.pending()).toHaveLength(0);
    s.close();
  });
  it('cancels queued mail atomically and restores it as a draft retaining its message identity', async () => {
    const s = await open();
    s.install(profile);
    const id = s.queue(compose),
      original = s.messages()[0];
    s.trashMessage(id);
    expect(s.pending()).toHaveLength(0);
    const file = s.file;
    s.close();
    const again = await open(file);
    again.restoreMessage(id);
    expect(again.messages()[0]).toMatchObject({
      id,
      folder: 'drafts',
      msgid: original.msgid,
      body: compose.body,
      packetName: '',
    });
    expect(again.pending()).toHaveLength(0);
    again.queue({ ...compose, id });
    expect(again.pending()).toHaveLength(1);
    expect(again.messages()[0].msgid).toBe(original.msgid);
    again.close();
  });
  it('allows draft recovery, requires Trash before permanent deletion, and refuses invalid IDs', async () => {
    const s = await open();
    s.install(profile);
    const id = s.saveDraft({ ...compose, to: '', subject: '', body: 'Unfinished' });
    expect(() => s.deleteMessage(id)).toThrow('Trash');
    expect(() => s.restoreMessage(id)).toThrow('Trash');
    expect(() => s.trashMessage('missing')).toThrow('not found');
    s.trashMessage(id);
    s.restoreMessage(id);
    expect(s.messages()[0]).toMatchObject({ folder: 'drafts', body: 'Unfinished' });
    s.close();
  });
  it('keeps permanently deleted incoming mail deleted on packet retries, including changed local IDs', async () => {
    const s = await open();
    s.install(profile);
    const incoming = parsePacket(incomingPacket(), profile)[0];
    s.receive([incoming]);
    s.trashMessage(incoming.id);
    s.deleteMessage(incoming.id);
    expect(s.messages()).toHaveLength(0);
    const file = s.file;
    s.close();
    const again = await open(file);
    expect(again.receive([incoming, { ...incoming, id: 'changed-id' }])).toBe(0);
    expect(again.messages()).toHaveLength(0);
    const other = { ...incoming, id: 'other-message', msgid: '1:123/456 different' };
    expect(again.receive([other])).toBe(1);
    again.close();
  });
  it('keeps areas and contacts when a public post is deleted', async () => {
    const s = await open();
    s.install(profile);
    const incoming = parsePacket(incomingPacket({ area: 'TEST' }), profile)[0];
    s.receive([incoming]);
    s.contact('Friend', '1:123/456');
    s.trashMessage(incoming.id);
    s.deleteMessage(incoming.id);
    expect(s.state().areas).toEqual(profile.areas);
    expect(s.state().contacts).toContainEqual({ name: 'Friend', address: '1:123/456' });
    s.close();
  });
  it('rolls back a failed deletion without cancelling or changing the queued packet', async () => {
    const s = await open();
    s.install(profile);
    const id = s.queue(compose),
      queued = s.pending()[0];
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk unavailable');
    });
    expect(() => s.trashMessage(id)).toThrow('Disk unavailable');
    expect(s.pending()[0]).toEqual(queued);
    expect(s.messages()[0].folder).toBe('outbox');
    s.close();
  });
  it('rolls back failed permanent deletion and leaves the original Trash item restorable', async () => {
    const s = await open();
    s.install(profile);
    const incoming = parsePacket(incomingPacket(), profile)[0];
    s.receive([incoming]);
    s.trashMessage(incoming.id);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk unavailable');
    });
    expect(() => s.deleteMessage(incoming.id)).toThrow('Disk unavailable');
    s.restoreMessage(incoming.id);
    expect(s.messages()[0].folder).toBe('inbox');
    s.close();
  });
});

describe('invisible discussion management', () => {
  it('hides requests through delivery and discards their passwords once acknowledged', async () => {
    const s = await open();
    s.install(profile);
    s.requestAreaList();
    expect(s.pending()).toHaveLength(1);
    expect(s.state().messages).toHaveLength(0);
    expect(s.state().discussions.queued).toContain(s.state().discussions.requestId);
    expect(JSON.stringify(s.state())).not.toContain(profile.uplink.areaFixPassword);
    const original = s.pending()[0],
      file = s.file;
    s.close();
    const again = await open(file);
    expect(again.pending()[0]).toEqual(original);
    again.sent(original.name);
    expect(again.state().discussions.queued).toHaveLength(0);
    expect(again.state().messages).toHaveLength(0);
    expect(again.messages()[0]).toMatchObject({ internal: true, subject: '', body: '', raw: '' });
    expect(() => again.trashMessage(again.messages()[0].id)).toThrow('not found');
    again.close();
  });
  it('processes list parts and confirmations without creating mail or increasing new-mail counts', async () => {
    const s = await open();
    s.install(profile);
    s.areaCommand('TECH', true);
    s.sent(s.pending()[0].name);
    const added = reply('Area Management Request', 'TECH added.');
    expect(
      s.receive([
        reply('List of Available Areas', 'TECH Computers\nContinued in next message...'),
        added,
      ]),
    ).toBe(0);
    expect(s.state().messages).toHaveLength(0);
    expect(s.state().discussions.entries[0]).toMatchObject({
      name: 'Computers',
      subscription: 'joined',
      pending: null,
    });
    const file = s.file;
    s.close();
    const again = await open(file);
    again.areaCommand('TECH', false);
    again.sent(again.pending()[0].name);
    expect(again.receive([{ ...added, id: 'repeated-added' }])).toBe(0);
    expect(again.state().discussions.entries[0].pending?.action).toBe('leave');
    again.close();
  });
  it('keeps personal mail and unrelated or forged service messages visible', async () => {
    const s = await open();
    s.install(profile);
    const unknown = reply('Personal note from the sysop', 'A normal message.');
    const wrongSource = reply('List of Available Areas', 'TECH Computers', {
      from: 'Someone else',
    });
    expect(s.receive([unknown, wrongSource])).toBe(2);
    expect(s.state().messages).toHaveLength(2);
    s.close();
  });
  it('shows a friendly browser error instead of raw malformed or rejected control replies', async () => {
    const s = await open();
    s.install(profile);
    expect(s.receive([reply('List of Available Areas', '> unparseable response')])).toBe(0);
    expect(s.state().discussions.error).toContain('unreadable');
    expect(s.receive([reply('Area Management Request', 'Invalid Password.')])).toBe(0);
    expect(s.state().discussions.error).toContain('password');
    expect(s.state().messages).toHaveLength(0);
    s.close();
  });
  it('does not acknowledge management processing locally if the durable save fails', async () => {
    const s = await open();
    s.install(profile);
    const list = reply('List of Available Areas', 'TECH Computers');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk unavailable');
    });
    expect(() => s.receive([list])).toThrow('Disk unavailable');
    expect(s.state().discussions.entries).toHaveLength(0);
    expect(s.receive([list])).toBe(0);
    expect(s.state().discussions.entries[0].tag).toBe('TECH');
    s.close();
  });
  it('cleans existing traffic once on upgrade without changing ordinary queued packets', async () => {
    const s = await open();
    s.install(profile);
    const normal = s.queue(compose),
      original = s.pending()[0];
    const request = s.queue({
      ...compose,
      to: 'AreaFix',
      toAddress: profile.uplink.address,
      subject: profile.uplink.areaFixPassword,
      body: '%LIST\n%QUERY\n---',
    });
    s.sent(s.messages().find((m) => m.id === request)!.packetName);
    const list = reply('List of Available Areas', 'TECH Computers');
    const file = s.file;
    s.close();
    // Simulate a pre-upgrade mailbox that retained an already processed incoming reply.
    const sql = await initSqlJs({ locateFile: () => wasm });
    const db = new sql.Database(fs.readFileSync(file));
    db.run('INSERT INTO messages VALUES (?,?)', [list.id, JSON.stringify(list)]);
    fs.writeFileSync(file, db.export());
    db.close();
    const again = await open(file);
    expect(again.state().messages.map((m) => m.id)).toEqual([normal]);
    expect(again.pending()[0]).toEqual(original);
    expect(again.state().discussions.entries[0].tag).toBe('TECH');
    expect(again.receive([list])).toBe(0);
    again.close();
    const twice = await open(file);
    expect(twice.state().messages.map((m) => m.id)).toEqual([normal]);
    twice.close();
  });
});
