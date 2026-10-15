import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationConstructorOptions } from 'electron';
import { Store } from '../src/core/store.js';
import { buildPacket, parsePacket } from '../src/core/packet.js';
import {
  defaultNotifications,
  newMailNotice,
  notificationTarget,
  windowsToast,
} from '../src/core/notifications.js';
import { DesktopNotifications, type NativeNotice } from '../src/main/notifications.js';
import { compose, incomingPacket, profile } from './fixtures.js';
import type { Message } from '../src/core/model.js';

const dirs: string[] = [];
async function open(file?: string) {
  if (!file) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-notifications-'));
    dirs.push(dir);
    file = path.join(dir, 'mailbox.sqlite');
  }
  return Store.open(
    file,
    path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
    (s) => s,
    (s) => s,
  );
}
const incoming = () => parsePacket(incomingPacket(), profile)[0];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable new-mail notification eligibility', () => {
  it('keeps preferences across restart, rejects invalid updates, and skips unchanged writes', async () => {
    const store = await open();
    expect(store.state().notifications).toEqual(defaultNotifications);
    const revision = store.revision;
    store.setNotifications(defaultNotifications);
    expect(store.revision).toBe(revision);
    const settings = { enabled: false, discussions: false, previews: false };
    store.setNotifications(settings);
    const saved = store.backup();
    expect(() => store.setNotifications({ ...settings, enabled: 'yes' } as never)).toThrow();
    expect(store.backup()).toEqual(saved);
    const file = store.file;
    store.close();
    const again = await open(file);
    expect(again.state().notifications).toEqual(settings);
    again.close();
  });
  it('returns only freshly committed ordinary messages and excludes control replies and replays', async () => {
    const store = await open();
    store.install(profile);
    const message = incoming();
    const boss = {
      ...profile,
      name: 'SBBSecho',
      address: profile.uplink.address,
      uplink: { ...profile.uplink, address: profile.address },
    };
    const reply = parsePacket(
      buildPacket(
        boss,
        {
          ...compose,
          to: profile.name,
          toAddress: profile.address,
          subject: 'List of Available Areas',
          body: 'TECH Computers',
        },
        'notification control',
      ),
      profile,
    )[0];
    const accepted = store.receiveNew([message, { ...message, id: 'duplicate-id' }, reply]);
    expect(accepted.map((m) => m.id)).toEqual([message.id]);
    expect(store.state().discussions.entries[0].tag).toBe('TECH');
    expect(store.receiveNew([message, reply])).toEqual([]);
    const file = store.file;
    store.close();
    const again = await open(file);
    const ids = new Set(again.receiveNew([message, reply]).map((m) => m.id));
    expect(newMailNotice(ids, again.state())).toBeNull();
    again.trashMessage(message.id);
    again.deleteMessage(message.id);
    expect(again.receiveNew([message])).toEqual([]);
    again.close();
  });
  it('does not return notification candidates when the mailbox transaction fails', async () => {
    const store = await open();
    store.install(profile);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk unavailable');
    });
    expect(() => store.receiveNew([incoming()])).toThrow('Disk unavailable');
    expect(store.state().messages).toEqual([]);
    store.close();
  });
  it('batches eligible unread mail and excludes hidden ADM areas, read mail, sent mail and internal records', async () => {
    const store = await open();
    store.install({
      ...profile,
      areas: [
        { tag: 'TEST', name: 'Test discussion' },
        { tag: 'STAFF', name: 'ADM private' },
      ],
    });
    const base = incoming();
    const messages: Message[] = [
      {
        ...base,
        id: 'direct',
        msgid: 'direct',
        date: '2026-10-15T00:00:00+03:00',
        from: 'Earlier person',
      },
      {
        ...base,
        id: 'public',
        msgid: 'public',
        area: 'TEST',
        date: '2026-10-14T22:00:00Z',
        from: 'Later person',
        subject: 'Latest public post',
      },
      { ...base, id: 'hidden', msgid: 'hidden', area: 'STAFF', subject: 'Never preview ADM' },
      { ...base, id: 'read', msgid: 'read', read: true },
      { ...base, id: 'sent', msgid: 'sent', folder: 'sent' },
      { ...base, id: 'internal', msgid: 'internal', internal: true },
    ];
    const ids = new Set(store.receiveNew(messages).map((m) => m.id));
    const notice = newMailNotice(ids, store.state())!;
    expect(notice.title).toContain('2 new messages');
    expect(notice.body).toContain('1 direct message · 1 discussion post');
    expect(notice.body).toContain('Later person');
    expect(notice.body).not.toContain(base.body);
    expect(notice.messageId).toBe('public');
    store.setNotifications({ ...defaultNotifications, discussions: false, previews: false });
    expect(newMailNotice(ids, store.state())).toMatchObject({
      body: '1 direct message',
      messageId: 'direct',
    });
    store.mark('direct', { read: true });
    expect(newMailNotice(ids, store.state())).toBeNull();
    store.setNotifications({ ...defaultNotifications, enabled: false });
    expect(newMailNotice(ids, store.state())).toBeNull();
    store.close();
  });
  it('sanitizes preview text and escapes the Windows toast XML and launch data', async () => {
    const store = await open();
    store.install(profile);
    const message = {
      ...incoming(),
      from: '<sender>&\u202eevil\nname',
      subject: '<script>"&\'\nTitle',
    };
    const ids = new Set(store.receiveNew([message]).map((m) => m.id));
    const notice = newMailNotice(ids, store.state())!;
    expect(notice.body).not.toContain('\u202e');
    const xml = windowsToast(notice);
    expect(xml).toContain('&lt;script&gt;&quot;&amp;&apos; Title');
    expect(xml).not.toContain('<script>');
    expect(xml).toContain(`launch="packetlark-message:${message.id}"`);
    expect(notificationTarget(`packetlark-message:${message.id}`)).toBe(message.id);
    for (const value of [
      'https://example.invalid',
      'file:///etc/passwd',
      'packetlark-message:../mail',
      'packetlark-message:"bad',
      `packetlark-message:${'a'.repeat(129)}`,
    ])
      expect(notificationTarget(value)).toBeNull();
    store.close();
  });
});

class FakeNotice extends EventEmitter implements NativeNotice {
  shown = 0;
  closed = 0;
  show() {
    this.shown++;
  }
  close() {
    this.closed++;
    this.emit('close');
  }
}
function native(platform: 'linux' | 'win32' = 'linux') {
  const created: { options: NotificationConstructorOptions; handle: FakeNotice }[] = [];
  const deps = {
    platform,
    icon: '/test/icon.png',
    supported: vi.fn(() => true),
    open: vi.fn(),
    create: vi.fn((options: NotificationConstructorOptions) => {
      const handle = new FakeNotice();
      created.push({ options, handle });
      return handle;
    }),
  };
  return { deps, created, service: new DesktopNotifications(deps) };
}
describe('native desktop notification adapter', () => {
  it('renders sender/subject markup literally on Linux and contains a native show failure', () => {
    const { service, deps, created } = native();
    service.show({
      title: 'PacketLark',
      body: '<img src="https://example.invalid"> & private',
      messageId: 'message-1',
    });
    expect(created[0].options.body).toBe(
      '&lt;img src=&quot;https://example.invalid&quot;&gt; &amp; private',
    );
    deps.create.mockImplementationOnce(() => {
      const handle = new FakeNotice();
      handle.show = () => {
        throw new Error('Daemon gone');
      };
      return handle;
    });
    expect(service.show({ title: 'PacketLark', body: 'New message', messageId: 'message-2' })).toBe(
      false,
    );
    service.close();
  });
  for (const platform of ['linux', 'win32'] as const)
    it(`uses the ${platform} native API and handles a message click`, () => {
      const { service, deps, created } = native(platform);
      expect(
        service.show({ title: 'PacketLark', body: 'New message', messageId: 'message-1' }),
      ).toBe(true);
      expect(created[0].handle.shown).toBe(1);
      expect(created[0].options.icon).toBe('/test/icon.png');
      if (platform === 'win32')
        expect(created[0].options.toastXml).toContain('packetlark-message:message-1');
      else expect(created[0].options.toastXml).toBeUndefined();
      created[0].handle.emit('click');
      expect(deps.open).toHaveBeenCalledWith('message-1');
      service.close();
    });
  it('contains unavailable services, failed native calls, and stale-window click errors', () => {
    const { service, deps, created } = native();
    const notice = { title: 'PacketLark', body: 'New message', messageId: 'message-1' };
    deps.supported.mockReturnValueOnce(false);
    expect(service.show(notice)).toBe(false);
    expect(deps.create).not.toHaveBeenCalled();
    deps.supported.mockImplementationOnce(() => {
      throw new Error('No service');
    });
    expect(service.show(notice)).toBe(false);
    deps.create.mockImplementationOnce(() => {
      throw new Error('Native failure');
    });
    expect(service.show(notice)).toBe(false);
    service.show(notice);
    deps.open.mockImplementationOnce(() => {
      throw new Error('Window gone');
    });
    expect(() => created[0].handle.emit('click')).not.toThrow();
    service.close();
  });
  it('bounds retained handles and releases failed, dismissed and shutdown notifications', () => {
    const { service, created } = native();
    for (let i = 0; i < 22; i++)
      service.show({ title: 'PacketLark', body: 'New mail', messageId: String(i) });
    expect(created[0].handle.closed).toBe(1);
    expect(created[1].handle.closed).toBe(1);
    created[2].handle.emit('failed');
    created[3].handle.emit('close');
    service.close();
    expect(created[2].handle.closed).toBe(0);
    expect(created[3].handle.closed).toBe(0);
    expect(created.slice(4).every((item) => item.handle.closed === 1)).toBe(true);
  });
});
