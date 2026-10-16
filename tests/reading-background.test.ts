import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { NativeImage, MenuItemConstructorOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { readingSettingsSchema, desktopSettingsSchema, type Message } from '../src/core/model.js';
import { bodyBlocks, defaultReading, firstUnread } from '../src/core/reading.js';
import { DesktopTray, unreadCount, unreadDot } from '../src/main/background.js';
import { LoginStartup, desktopExec } from '../src/main/startup.js';
import { parsePacket } from '../src/core/packet.js';
import { incomingPacket, profile } from './fixtures.js';
const dirs: string[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-reading-'));
  dirs.push(dir);
  return dir;
}
async function open(file = path.join(directory(), 'mailbox.sqlite')) {
  return Store.open(
    file,
    path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
    (s) => s,
    (s) => s,
  );
}
const incoming = (): Message => parsePacket(incomingPacket(), profile)[0];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('reading preferences and conversation operations', () => {
  it('keeps quoted text, prefixes, signatures, Unicode and CRLF exactly recoverable', () => {
    const body =
      'Hello 🐦\r\n> quoted\r\n AB> another quote\r\nA new response\r\n-- \r\nSignature\r\n';
    const blocks = bodyBlocks(body);
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'quote', 'text', 'signature']);
    expect(blocks.map((b) => b.text).join('')).toBe(body);
    expect(bodyBlocks('')).toEqual([]);
    expect(bodyBlocks('plain text without newline')).toEqual([
      { kind: 'text', text: 'plain text without newline' },
    ]);
    expect(bodyBlocks('Text\n--- PacketLark\n * Origin: Test\n').at(-1)?.kind).toBe('signature');
  });
  it('finds the oldest received unread instant without choosing outgoing or internal mail', () => {
    const base = incoming();
    const messages = [
      { ...base, id: 'newer', date: '2026-10-16T00:00:00Z' },
      { ...base, id: 'older', date: '2026-10-16T01:00:00+03:00' },
      { ...base, id: 'sent', folder: 'sent' as const, date: '2020-01-01' },
      { ...base, id: 'internal', internal: true, date: '2020-01-01' },
      { ...base, id: 'invalid', date: 'Unknown' },
    ];
    expect(firstUnread(messages)?.id).toBe('older');
    expect(firstUnread(messages.map((m) => ({ ...m, read: true })))).toBeUndefined();
  });
  it('persists validated preferences, keeps original defaults and skips unchanged writes', async () => {
    expect(defaultReading).toEqual(readingSettingsSchema.parse({}));
    expect(desktopSettingsSchema.parse({})).toEqual({ keepRunning: false, startAtLogin: false });
    const store = await open();
    const revision = store.revision;
    store.setReading(defaultReading);
    store.setDesktop({ keepRunning: false, startAtLogin: false });
    expect(store.revision).toBe(revision);
    const reading = {
      ...defaultReading,
      fontSize: 18 as const,
      font: 'monospace' as const,
      density: 'compact' as const,
      collapseQuotes: true,
    };
    store.setReading(reading);
    store.setDesktop({ keepRunning: true, startAtLogin: false });
    const bytes = store.backup();
    expect(() => store.setReading({ ...reading, fontSize: 999 } as never)).toThrow();
    expect(() => store.setReading({ ...reading, unknown: true } as never)).toThrow();
    expect(() => store.setDesktop({ keepRunning: false, startAtLogin: true })).toThrow();
    expect(store.backup()).toEqual(bytes);
    const file = store.file;
    store.close();
    const again = await open(file);
    expect(again.state().reading).toEqual(reading);
    expect(again.state().desktop).toEqual({ keepRunning: true, startAtLogin: false });
    again.close();
  });
  it('marks an entire explicit conversation in one atomic write while preserving other mail and flags', async () => {
    const store = await open();
    store.install(profile);
    const root = incoming();
    const reply = {
      ...root,
      id: 'reading-reply',
      msgid: 'reading reply',
      replyId: root.msgid,
      starred: true,
    };
    store.receive([
      root,
      reply,
      { ...root, id: 'other', msgid: 'other' },
      { ...root, id: 'sent-reading', msgid: 'sent-reading', folder: 'sent', replyId: root.msgid },
      { ...root, id: 'trash', msgid: 'trash', replyId: root.msgid },
    ]);
    store.trashMessage('trash');
    const revision = store.revision;
    const writes = vi.spyOn(fs, 'renameSync');
    store.markConversationRead(root.id);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(store.revision).toBe(revision + 1);
    const messages = store.messages();
    expect(messages.find((m) => m.id === root.id)?.read).toBe(true);
    expect(messages.find((m) => m.id === reply.id)).toMatchObject({ read: true, starred: true });
    expect(messages.find((m) => m.id === 'other')?.read).toBe(false);
    expect(messages.find((m) => m.id === 'sent-reading')?.read).toBe(false);
    expect(messages.find((m) => m.id === 'trash')).toMatchObject({ folder: 'trash', read: false });
    store.markConversationRead(root.id);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(() => store.markConversationRead('trash')).toThrow();
    store.close();
  });
  it('rolls back every message when marking a conversation cannot be persisted', async () => {
    const store = await open();
    store.install(profile);
    const root = incoming();
    store.receive([root, { ...root, id: 'reply', msgid: 'reply', replyId: root.msgid }]);
    const revision = store.revision;
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk unavailable');
    });
    expect(() => store.markConversationRead(root.id)).toThrow('Disk unavailable');
    expect(store.revision).toBe(revision);
    expect(store.messages().every((m) => !m.read)).toBe(true);
    store.close();
  });
  it('refuses conversation changes in hidden administrative areas', async () => {
    const store = await open();
    store.install({ ...profile, areas: [{ tag: 'STAFF', name: 'ADM Staff' }] });
    const message = { ...incoming(), area: 'STAFF' };
    store.receive([message]);
    expect(() => store.markConversationRead(message.id)).toThrow('no longer available');
    store.close();
  });
});

describe('native tray adapter and startup integration', () => {
  class FakeTray extends EventEmitter {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    setImage = vi.fn();
    gone = false;
    destroy = vi.fn(() => {
      this.gone = true;
    });
    isDestroyed() {
      return this.gone;
    }
  }
  it('updates unread state, reuses unchanged menus and wires open, exchange and quit actions', () => {
    const tray = new FakeTray();
    let items: MenuItemConstructorOptions[] = [];
    const host = {
      create: () => tray,
      menu: (value: MenuItemConstructorOptions[]) => {
        items = value;
        return value;
      },
      normal: {} as NativeImage,
      unread: {} as NativeImage,
      open: vi.fn(),
      sync: vi.fn(),
      quit: vi.fn(),
    };
    const desktop = new DesktopTray(host);
    expect(desktop.start()).toBe(true);
    desktop.update(2, false, true);
    desktop.update(2, false, true);
    expect(tray.setContextMenu).toHaveBeenCalledTimes(1);
    expect(tray.setToolTip).toHaveBeenCalledWith('PacketLark — 2 unread messages');
    tray.emit('click');
    expect(host.open).toHaveBeenCalledOnce();
    (items.find((i) => i.label === 'Send & receive')?.click as () => void)();
    expect(host.sync).toHaveBeenCalledOnce();
    (items.find((i) => i.label === 'Quit PacketLark')?.click as () => void)();
    expect(host.quit).toHaveBeenCalledOnce();
    desktop.update(2, true, true);
    expect(items.find((i) => i.label === 'Connecting…')?.enabled).toBe(false);
    desktop.update(0, false, false);
    expect(tray.setImage).toHaveBeenLastCalledWith(host.normal);
    desktop.close();
    expect(desktop.available).toBe(false);
  });
  it('contains tray creation and shell-update failures so closing can fall back to a normal quit', () => {
    const tray = new FakeTray();
    const host = {
      create: vi.fn(() => {
        throw new Error('No tray');
      }),
      menu: () => null,
      normal: {} as NativeImage,
      unread: {} as NativeImage,
      open: vi.fn(),
      sync: vi.fn(),
      quit: vi.fn(),
    };
    const desktop = new DesktopTray(host);
    expect(desktop.start()).toBe(false);
    host.create.mockImplementation(() => tray as never);
    expect(desktop.start()).toBe(true);
    tray.setContextMenu.mockImplementation(() => {
      throw new Error('Desktop disconnected');
    });
    expect(() => desktop.update(1, false, true)).not.toThrow();
    expect(desktop.available).toBe(false);
  });
  it('counts only visible incoming unread mail and produces a bounded transparent badge', async () => {
    const store = await open();
    const state = store.state();
    const m = incoming();
    state.areas = [{ tag: 'TEST', name: 'Test' }];
    state.messages = [
      m,
      { ...m, area: 'TEST' },
      { ...m, area: 'HIDDEN' },
      { ...m, internal: true },
      { ...m, read: true },
      { ...m, folder: 'sent' },
    ];
    expect(unreadCount(state)).toBe(2);
    const pixels = unreadDot();
    expect(pixels.length).toBe(1024);
    expect(pixels[3]).toBe(0);
    expect(pixels[(8 * 16 + 8) * 4 + 3]).toBe(255);
    store.close();
  });
  function startup(platform: string, packaged = true) {
    const login = { read: vi.fn(() => false), write: vi.fn() };
    const home = directory();
    return {
      home,
      login,
      startup: new LoginStartup({
        platform,
        packaged,
        executable: path.join(home, 'PacketLark AppImage'),
        configHome: home,
        login,
      }),
    };
  }
  it('uses only Windows login settings on Windows and disables startup registration in development', () => {
    const windows = startup('win32');
    windows.startup.set(true);
    expect(windows.login.write).toHaveBeenCalledWith(true);
    windows.login.read.mockReturnValue(true);
    expect(windows.startup.enabled()).toBe(true);
    const development = startup('win32', false);
    expect(() => development.startup.set(true)).toThrow('installed');
    expect(development.login.write).not.toHaveBeenCalled();
  });
  it('creates and removes only its own Linux autostart entry with safely quoted arguments', () => {
    const linux = startup('linux');
    expect(linux.startup.enabled()).toBe(false);
    linux.startup.set(true);
    expect(linux.startup.enabled()).toBe(true);
    const file = path.join(linux.home, 'autostart', 'packetlark.desktop');
    expect(fs.readFileSync(file, 'utf8')).toContain(
      `Exec=${desktopExec(path.join(linux.home, 'PacketLark AppImage'))}\n`,
    );
    expect(linux.login.write).not.toHaveBeenCalled();
    linux.startup.set(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(desktopExec(path.join(linux.home, 'app%f'))).toContain('app%%f');
    expect(() => desktopExec('/bad\npath')).toThrow();
  });
  it('preserves unowned entries and refuses symlinks', () => {
    const linux = startup('linux');
    const folder = path.join(linux.home, 'autostart');
    fs.mkdirSync(folder);
    const file = path.join(folder, 'packetlark.desktop');
    fs.writeFileSync(file, 'User entry');
    expect(() => linux.startup.set(true)).toThrow('not managed');
    expect(() => linux.startup.set(false)).toThrow('not managed');
    expect(fs.readFileSync(file, 'utf8')).toBe('User entry');
    if (process.platform !== 'win32') {
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(linux.home, 'outside'), file);
      expect(() => linux.startup.set(true)).toThrow('not managed');
    }
  });
});
