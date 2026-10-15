import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { mailboxCounts, messageSort, sortMessages } from '../src/renderer/mailbox.js';
import { parsePacket } from '../src/core/packet.js';
import { incomingPacket, profile } from './fixtures.js';
import type { Message } from '../src/core/model.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('mailbox performance without changing data semantics', () => {
  it('sorts actual message timestamps across UTC offsets without mutating the mailbox', () => {
    const original = parsePacket(incomingPacket(), profile)[0];
    const messages = [
      { ...original, id: 'older', date: '2026-10-15T01:00:00+03:00' },
      { ...original, id: 'invalid', date: 'Unknown date' },
      { ...original, id: 'newer', date: '2026-10-14T23:00:00Z' },
      { ...original, id: 'same-instant', date: '2026-10-14T17:00:00-06:00' },
    ];
    const before = structuredClone(messages);
    expect(sortMessages(messages, 'newest').map((m) => m.id)).toEqual([
      'newer',
      'same-instant',
      'older',
      'invalid',
    ]);
    expect(sortMessages(messages, 'oldest').map((m) => m.id)).toEqual([
      'older',
      'newer',
      'same-instant',
      'invalid',
    ]);
    expect(messages).toEqual(before);
    expect(sortMessages([], 'newest')).toEqual([]);
  });
  it('defaults missing or unsupported sort preferences to newest first', () => {
    expect(messageSort(null)).toBe('newest');
    expect(messageSort('unsupported')).toBe('newest');
    expect(messageSort('newest')).toBe('newest');
    expect(messageSort('oldest')).toBe('oldest');
  });
  it('counts folders and unread areas identically to the original filters for a large mailbox', () => {
    const original = parsePacket(incomingPacket(), profile)[0];
    const messages: Message[] = Array.from({ length: 10000 }, (_, i) => ({
      ...original,
      id: String(i),
      folder: (['inbox', 'sent', 'drafts', 'outbox', 'trash'] as const)[i % 5],
      read: i % 7 === 0,
      starred: i % 11 === 0,
      area: i % 3 === 0 ? '' : `AREA_${i % 200}`,
    }));
    const counts = mailboxCounts(messages);
    for (const folder of ['inbox', 'sent', 'drafts', 'outbox', 'trash', 'starred']) {
      const expected = messages.filter((m) =>
        folder === 'starred'
          ? m.starred && m.folder !== 'trash'
          : folder === 'inbox'
            ? m.folder === 'inbox' && !m.area && !m.read
            : m.folder === folder,
      ).length;
      expect(counts.folders.get(folder)).toBe(expected);
    }
    for (let i = 0; i < 200; i++)
      expect(counts.unreadAreas.get(`AREA_${i}`) || 0).toBe(
        messages.filter((m) => m.area === `AREA_${i}` && m.folder === 'inbox' && !m.read).length,
      );
  });
  it('does not rewrite the SQLite snapshot for repeated unchanged flags', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-performance-'));
    dirs.push(dir);
    const s = await Store.open(
      path.join(dir, 'mailbox.sqlite'),
      path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
      (s) => s,
      (s) => s,
    );
    s.install(profile);
    const incoming = parsePacket(incomingPacket(), profile)[0];
    s.receive([incoming]);
    s.mark(incoming.id, { read: true });
    const revision = s.revision,
      snapshot = s.backup();
    const writes = vi.spyOn(fs, 'renameSync');
    for (let i = 0; i < 50; i++) s.mark(incoming.id, { read: true, starred: false });
    expect(writes).not.toHaveBeenCalled();
    expect(s.revision).toBe(revision);
    expect(s.backup()).toEqual(snapshot);
    s.mark(incoming.id, { starred: true });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(s.revision).toBe(revision + 1);
    s.close();
  });
  it('leaves the published revision and saved flags unchanged on a failed write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-performance-'));
    dirs.push(dir);
    const s = await Store.open(
      path.join(dir, 'mailbox.sqlite'),
      path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
      (s) => s,
      (s) => s,
    );
    s.install(profile);
    const incoming = parsePacket(incomingPacket(), profile)[0];
    s.receive([incoming]);
    const revision = s.revision;
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk unavailable');
    });
    expect(() => s.mark(incoming.id, { read: true })).toThrow('Disk unavailable');
    expect(s.revision).toBe(revision);
    expect(s.messages()[0].read).toBe(false);
    s.close();
  });
});
