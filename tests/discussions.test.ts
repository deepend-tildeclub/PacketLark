import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { buildPacket, parsePacket } from '../src/core/packet.js';
import { managementTag, parseAreaReply } from '../src/core/discussions.js';
import type { Message, Profile } from '../src/core/model.js';
import { compose, profile } from './fixtures.js';

const dirs: string[] = [];
const wasm = path.resolve('node_modules/sql.js/dist/sql-wasm.wasm');
async function open(file?: string) {
  if (!file) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-discussions-'));
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
function reply(subject: string, body: string, overrides: Partial<Message> = {}): Message {
  const server: Profile = {
    ...profile,
    name: 'SBBSecho',
    address: profile.uplink.address,
    uplink: { ...profile.uplink, address: profile.address },
  };
  const packet = buildPacket(
    server,
    { ...compose, to: profile.name, toAddress: profile.address, subject, body },
    `1:123/456 ${randomUUID()}`,
  );
  return { ...parsePacket(packet, profile)[0], ...overrides };
}
function sentAll(s: Store) {
  for (const file of s.pending()) s.sent(file.name);
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SBBSecho discussion replies', () => {
  it('parses actual Type-2+ list messages with descriptions and continuation footers', () => {
    expect(
      parseAreaReply(
        reply(
          'List of Available Areas',
          'TEST    Test discussion\nTECH    Computers & technology\n\nContinued in next message...',
        ),
        profile,
      ),
    ).toEqual({
      kind: 'list',
      subscription: 'unknown',
      empty: false,
      entries: [
        { tag: 'TEST', name: 'Test discussion' },
        { tag: 'TECH', name: 'Computers & technology' },
      ],
    });
  });
  it('ignores quoted commands, tear lines, malformed output and command-prefix tags', () => {
    expect(
      parseAreaReply(
        reply(
          'List of Available Areas',
          '> TECH quoted\n%+ALL\n-ALL\n--- SBBSecho\nFAKE Fake entry',
        ),
        profile,
      ),
    ).toBeNull();
    expect(() => managementTag('-ALL')).toThrow('minus');
    expect(() => managementTag('TEST\n%+ALL')).toThrow();
  });
  it('requires the correct sender, boss, destination and private message type', () => {
    for (const overrides of [
      { fromAddress: '1:123/999' },
      { toAddress: '1:123/456.101' },
      { from: 'Ordinary person' },
      { area: 'TEST' },
      { folder: 'sent' as const },
    ])
      expect(
        parseAreaReply(reply('List of Available Areas', 'TECH Computers', overrides), profile),
      ).toBeNull();
  });
  it('recognizes empty lists and specific subscription acknowledgements', () => {
    expect(parseAreaReply(reply('List of Connected Areas', 'None.'), profile)).toMatchObject({
      kind: 'list',
      empty: true,
    });
    expect(
      parseAreaReply(
        reply(
          'Area Management Request',
          'TECH added.\nTEST already connected.\nOLD removed.\nOFF not connected.\nMISSING not found.',
        ),
        profile,
      ),
    ).toMatchObject({
      kind: 'changes',
      changes: [
        { tag: 'TECH', subscription: 'joined' },
        { tag: 'TEST', subscription: 'joined' },
        { tag: 'OLD', subscription: 'left' },
        { tag: 'OFF', subscription: 'left' },
        { tag: 'MISSING', subscription: null },
      ],
    });
  });
});

describe('persistent discussion browsing', () => {
  it('queues the three safe discovery commands once and persists the request after restart', async () => {
    const s = await open();
    s.install(profile);
    s.requestAreaList();
    const message = parsePacket(s.pending()[0].bytes, {
      ...profile,
      address: profile.uplink.address,
      uplink: { ...profile.uplink, address: profile.address },
    })[0];
    expect(message.to).toBe('AreaFix');
    expect(message.subject).toBe(profile.uplink.areaFixPassword);
    expect(message.body).toContain('%LIST\n%QUERY\n%UNLINKED');
    expect(() => s.requestAreaList()).toThrow('already queued');
    const state = s.state().discussions,
      file = s.file;
    s.close();
    const again = await open(file);
    expect(again.state().discussions).toEqual(state);
    expect(again.pending()).toHaveLength(1);
    again.close();
  });
  it('merges split list replies across exchanges, deduplicates and retains cached descriptions', async () => {
    const s = await open();
    s.install(profile);
    const first = reply(
      'List of Available Areas',
      'TECH Computers\n\nContinued in next message...',
    );
    s.receive([first]);
    s.receive([reply('List of Available Areas', 'GAMES Games and fun')]);
    expect(s.receive([first])).toBe(0);
    s.receive([reply('List of Connected Areas', 'TECH Computers')]);
    s.receive([reply('List of Unlinked Areas', 'GAMES Games and fun')]);
    expect(s.state().discussions.entries).toMatchObject([
      { tag: 'TECH', name: 'Computers', subscription: 'joined' },
      { tag: 'GAMES', name: 'Games and fun', subscription: 'left' },
    ]);
    expect(s.state().areas).toContainEqual({ tag: 'TECH', name: 'Computers' });
    const file = s.file;
    s.close();
    const again = await open(file);
    expect(again.state().discussions.entries).toHaveLength(2);
    again.close();
  });
  it('keeps joins pending after transport acknowledgement and confirms from the provider reply', async () => {
    const s = await open();
    s.install(profile);
    s.areaCommand('TECH', true);
    expect(() => s.areaCommand('TECH', true)).toThrow('already queued');
    sentAll(s);
    expect(s.state().discussions.entries[0]).toMatchObject({
      subscription: 'unknown',
      pending: { action: 'join' },
    });
    s.receive([reply('Area Management Request', 'TECH added.')]);
    expect(s.state().discussions.entries[0]).toMatchObject({
      subscription: 'joined',
      pending: null,
    });
    s.areaCommand('TECH', false);
    sentAll(s);
    s.receive([reply('Area Management Request', 'TECH removed.')]);
    expect(s.state().discussions.entries[0]).toMatchObject({ subscription: 'left', pending: null });
    expect(s.state().areas.some((a) => a.tag === 'TECH')).toBe(true); // Keep historical mail accessible.
    s.close();
  });
  it('reports missing areas and authentication failures without claiming subscription success', async () => {
    const s = await open();
    s.install(profile);
    s.areaCommand('MISSING', true);
    sentAll(s);
    s.receive([reply('Area Management Request', 'MISSING not found.')]);
    expect(s.state().discussions.entries[0]).toMatchObject({
      subscription: 'unknown',
      pending: null,
      error: expect.stringContaining('authorize'),
    });
    s.areaCommand('MISSING', true);
    sentAll(s);
    s.receive([reply('Area Management Request', 'Invalid Password.')]);
    expect(s.state().discussions.error).toContain('password');
    expect(s.state().discussions.entries[0].pending).toBeNull();
    expect(s.state().messages.filter((m) => m.folder === 'inbox')).toHaveLength(2);
    s.close();
  });
  it('does not remove subscriptions when a list is partial, and ignores older status replies', async () => {
    const s = await open();
    s.install(profile);
    s.receive([
      reply('List of Connected Areas', 'TECH Computers', { date: '2026-10-15T00:00:00Z' }),
    ]);
    s.receive([reply('List of Connected Areas', 'GAMES Games\n\nContinued in next message...')]);
    s.receive([
      reply('List of Unlinked Areas', 'TECH Computers', { date: '2026-10-14T00:00:00Z' }),
    ]);
    expect(s.state().discussions.entries.find((a) => a.tag === 'TECH')?.subscription).toBe(
      'joined',
    );
    s.close();
  });
  it('handles an explicit empty subscription list without deleting history or pending requests', async () => {
    const s = await open();
    s.install(profile);
    s.receive([reply('List of Connected Areas', 'TECH Computers')]);
    s.areaCommand('TECH', false);
    s.receive([reply('List of Connected Areas', 'None.')]);
    expect(s.state().discussions.entries[0]).toMatchObject({
      subscription: 'left',
      pending: { action: 'leave' },
    });
    expect(s.state().areas.some((a) => a.tag === 'TECH')).toBe(true);
    s.close();
  });
  it('preserves old mailboxes and rejects unavailable management and unsafe tags', async () => {
    const s = await open();
    s.install({ ...profile, uplink: { ...profile.uplink, areaFixPassword: '' } });
    expect(s.state().areas).toEqual(profile.areas);
    expect(s.state().discussions.entries).toEqual([]);
    expect(() => s.requestAreaList()).toThrow('password');
    expect(() => s.areaCommand('TECH', true)).toThrow('password');
    s.close();
  });
  it('does not resolve a new request using an older delayed acknowledgement', async () => {
    const s = await open();
    s.install(profile);
    s.areaCommand('TECH', true);
    sentAll(s);
    s.receive([reply('Area Management Request', 'TECH added.', { date: '2000-01-01T00:00:00Z' })]);
    expect(s.state().discussions.entries[0].pending?.action).toBe('join');
    s.receive([reply('Area Management Request', 'TECH already connected.')]);
    expect(s.state().discussions.entries[0].pending).toBeNull();
    s.close();
  });
  it('rolls back queued packets and pending state together if saving fails', async () => {
    const s = await open();
    s.install(profile);
    const write = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk unavailable');
    });
    expect(() => s.areaCommand('TECH', true)).toThrow('Disk unavailable');
    write.mockRestore();
    expect(s.pending()).toHaveLength(0);
    expect(s.state().discussions.entries).toHaveLength(0);
    s.close();
  });
});
