import { test as base, expect, _electron, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Compose, Message, RuntimeUpdate, State } from '../../src/core/model.js';

// Exercise the real Electron renderer against a mocked application API, without a downloaded browser.
// Playwright requires the destructuring signature even when no built-in fixtures are needed.
const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  page: async ({}, use) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-ui-'));
    const args = [path.resolve('tests/ui/harness.cjs'), `--user-data-dir=${data}`];
    if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox');
    if (process.env.RETROPOST_HEADLESS === '1')
      args.unshift('--ozone-platform=headless', '--disable-gpu');
    const desktop = await _electron.launch({ args });
    try {
      await use(await desktop.firstWindow());
    } finally {
      await desktop.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
});

const message: Message = {
  id: 'incoming',
  msgid: '1:123/456 abc',
  replyId: '',
  from: 'A friendly sysop',
  fromAddress: '1:123/456',
  to: 'Mike',
  toAddress: '1:123/456.100',
  subject: 'Welcome to PacketLark',
  body: 'Hello, Mike. This is a real conversation.\n<script>window.HACKED=true</script>',
  raw: '\x01MSGID: 1:123/456 abc',
  area: '',
  date: '2026-10-14T18:00:00Z',
  folder: 'inbox',
  read: false,
  starred: false,
  error: '',
  packetName: '',
};
declare global {
  interface Window {
    packetlarkTest: {
      stateReads(): number;
      runtime(status: string, syncing?: boolean): void;
      touch(): void;
      replaceMessage(message: Message): void;
    };
  }
}
const state: State = {
  revision: 0,
  account: {
    name: 'Mike',
    address: '1:123/456.100@fidonet',
    provider: 'RetroDigital BBS',
    host: 'bbs.example.invalid',
    port: 24554,
    tls: false,
    pollMinutes: 10,
    charset: 'UTF-8',
  },
  messages: [
    message,
    {
      ...message,
      id: 'public',
      msgid: '1:123/456 def',
      area: 'TEST',
      subject: 'A community discussion',
      body: 'A public post',
    },
  ],
  areas: [{ tag: 'TEST', name: 'Test discussion' }],
  discussions: { entries: [], requestId: null, requestedAt: null, updatedAt: null, error: '' },
  contacts: [{ name: 'A friendly sysop', address: '1:123/456' }],
  syncing: false,
  status: 'Ready.',
  lastSync: null,
  storageWarning: false,
};
async function click(locator: Locator) {
  if (process.env.RETROPOST_HEADLESS === '1') await locator.dispatchEvent('click');
  else await locator.click();
}
async function setup(
  page: Page,
  account = true,
  directory = state.discussions,
  messages = state.messages,
) {
  await page.addInitScript(
    ({ initial, account }) => {
      const data = structuredClone(initial);
      if (!account) {
        data.account = null;
        data.messages = [];
        data.areas = [];
      }
      let listSent = false;
      let stateReads = 0;
      const changed: ((update?: RuntimeUpdate) => void)[] = [];
      const emit = (dataChanged = true) => {
        if (dataChanged) data.revision = (data.revision || 0) + 1;
        changed.forEach((cb) =>
          cb({ revision: data.revision!, syncing: data.syncing, status: data.status }),
        );
      };
      window.packetlarkTest = {
        stateReads: () => stateReads,
        runtime: (status, syncing = false) => {
          data.status = status;
          data.syncing = syncing;
          emit(false);
        },
        touch: () => {
          emit();
        },
        replaceMessage: (message) => {
          data.messages = data.messages.filter((m) => m.id !== message.id);
          data.messages.push(message);
          emit();
        },
      };
      const make = (c: Compose, folder: Message['folder']): Message => ({
        ...data.messages[0],
        ...c,
        id: c.id || crypto.randomUUID(),
        msgid: 'test id',
        from: 'Mike',
        fromAddress: '1:123/456.100',
        date: new Date().toISOString(),
        folder,
        read: true,
        starred: false,
        error: '',
        raw: '',
        packetName: '',
      });
      Object.defineProperty(window, 'packetlark', {
        value: {
          state: async () => {
            stateReads++;
            return structuredClone({
              ...data,
              messages: data.messages.filter((m) => !m.internal),
              discussions: {
                ...data.discussions,
                queued: data.messages.filter((m) => m.folder === 'outbox').map((m) => m.id),
              },
            });
          },
          importAccount: async () => true,
          sync: async () => {
            if (data.discussions.requestId) {
              if (listSent) {
                data.discussions.updatedAt = new Date().toISOString();
                for (const [tag, name] of [
                  ['GENERAL', 'General conversation'],
                  ['TECH', 'Computers & technology'],
                  ['DENIED', '<script>window.HACKED=true</script>'],
                ])
                  if (!data.discussions.entries.some((a) => a.tag === tag))
                    data.discussions.entries.push({
                      tag,
                      name,
                      subscription: 'left',
                      confirmedAt: new Date().toISOString(),
                      pending: null,
                      error: '',
                    });
              }
              listSent = true;
            }
            for (const entry of data.discussions.entries) {
              if (!entry.pending) continue;
              const m = data.messages.find((m) => m.id === entry.pending?.messageId);
              if (m?.folder === 'sent') {
                entry.subscription = entry.pending.action === 'join' ? 'joined' : 'left';
                entry.pending = null;
                if (entry.subscription === 'joined' && !data.areas.some((a) => a.tag === entry.tag))
                  data.areas.push({ tag: entry.tag, name: entry.name });
              }
            }
            for (const m of data.messages) if (m.folder === 'outbox') m.folder = 'sent';
            data.status = 'Up to date.';
            emit();
          },
          saveDraft: async (c: Compose) => {
            const m = make(c, 'drafts');
            data.messages = data.messages.filter((x) => x.id !== m.id);
            data.messages.push(m);
            emit();
            return m.id;
          },
          queue: async (c: Compose) => {
            if (!c.to || !c.toAddress || !c.subject || !c.body)
              throw new Error('Complete all message fields.');
            const m = make(c, 'outbox');
            data.messages = data.messages.filter((x) => x.id !== m.id);
            data.messages.push(m);
            emit();
            return m.id;
          },
          mark: async (id: string, patch: Partial<Message>) => {
            Object.assign(
              data.messages.find((m) => m.id === id)!,
              patch,
            );
            emit();
          },
          removeDraft: async (id: string) => {
            data.messages = data.messages.filter((m) => m.id !== id);
            emit();
          },
          trashMessage: async (id: string) => {
            const m = data.messages.find((m) => m.id === id)!;
            if (m.folder === 'trash') return;
            m.trash = { folder: m.folder, deletedAt: new Date().toISOString() };
            m.folder = 'trash';
            emit();
          },
          restoreMessage: async (id: string) => {
            const m = data.messages.find((m) => m.id === id)!;
            m.folder = m.trash!.folder === 'outbox' ? 'drafts' : m.trash!.folder;
            delete m.trash;
            emit();
          },
          deleteMessage: async (id: string) => {
            data.messages = data.messages.filter((m) => m.id !== id);
            emit();
          },
          contact: async (name: string, address: string) => {
            data.contacts.push({ name, address });
            emit();
          },
          requestAreaList: async () => {
            const id = crypto.randomUUID();
            data.discussions.requestId = id;
            data.discussions.requestedAt = new Date().toISOString();
            data.messages.push(
              make(
                {
                  ...data.messages[0],
                  id,
                  to: 'AreaFix',
                  toAddress: '1:123/456',
                  subject: 'secret',
                  body: '%LIST',
                },
                'outbox',
              ),
            );
            data.messages.find((m) => m.id === id)!.internal = true;
            emit();
          },
          areaCommand: async (tag: string, join: boolean) => {
            if (!/^[A-Z0-9_!][A-Z0-9_!.-]*$/.test(tag)) throw new Error('Invalid discussion tag.');
            let entry = data.discussions.entries.find((a) => a.tag === tag);
            if (!entry) {
              entry = {
                tag,
                name: tag,
                subscription: 'unknown',
                confirmedAt: null,
                pending: null,
                error: '',
              };
              data.discussions.entries.push(entry);
            }
            const id = crypto.randomUUID();
            entry.pending = { action: join ? 'join' : 'leave', messageId: id };
            data.messages.push(
              make(
                {
                  ...data.messages[0],
                  id,
                  to: 'AreaFix',
                  toAddress: '1:123/456',
                  subject: 'secret',
                  body: `${join ? '+' : '-'}${tag}`,
                },
                'outbox',
              ),
            );
            data.messages.find((m) => m.id === id)!.internal = true;
            emit();
          },
          backup: async () => {},
          onChanged: (cb: (update?: RuntimeUpdate) => void) => {
            changed.push(cb);
            return () => {};
          },
        },
      });
    },
    { initial: { ...state, discussions: directory, messages }, account },
  );
  await page.goto('http://127.0.0.1:4173/');
}
test('welcomes new users with a single account-import action', async ({ page }) => {
  await setup(page, false);
  await expect(page.getByRole('button', { name: 'Import your account file' })).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ New message' })).toBeDisabled();
});
test('reads messages safely as text, marks read, stars and searches', async ({ page }) => {
  await setup(page);
  await click(page.getByRole('button', { name: /A friendly sysop.*Welcome to PacketLark/ }));
  await expect(page.locator('.body-text')).toContainText('<script>window.HACKED=true</script>');
  expect(await page.evaluate(() => Object.hasOwn(window, 'HACKED'))).toBe(false);
  await click(page.getByRole('button', { name: '☆ Star', exact: true }));
  await expect(page.getByRole('button', { name: '★ Starred', exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('absent search');
  await expect(page.getByText('No matching messages.')).toBeVisible();
});
test('composes, automatically saves an incomplete draft and reopens it', async ({ page }) => {
  await setup(page);
  await click(page.getByRole('button', { name: '＋ New message' }));
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A half-written message');
  await expect(page.getByText('Draft saved.', { exact: true })).toHaveText('Draft saved.');
  await click(page.getByRole('button', { name: 'Save & close' }).last());
  await click(page.getByRole('button', { name: /^Drafts/ }));
  await click(page.locator('.message-row'));
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'A half-written message',
  );
});
test('queues a direct message and shows it in the outbox', async ({ page }) => {
  await setup(page);
  await click(page.getByRole('button', { name: '＋ New message' }));
  await page.getByLabel('Recipient name').fill('A friendly sysop');
  await page.getByRole('textbox', { name: 'FidoNet address' }).fill('1:123/456');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Hello from the desktop');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Testing the first version.');
  await click(page.getByRole('button', { name: 'Queue message' }));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click(page.getByRole('button', { name: /^Outbox/ }));
  await expect(page.locator('.message-row')).toContainText('Hello from the desktop');
});
test('distinguishes public replies from private replies', async ({ page }) => {
  await setup(page);
  await click(page.getByRole('button', { name: /Test discussion/ }));
  await click(page.locator('.message-row'));
  await expect(page.getByText('PUBLIC DISCUSSION · TEST')).toBeVisible();
  await click(page.getByRole('button', { name: 'Reply privately' }));
  await expect(page.getByRole('combobox', { name: 'Send to' })).toHaveValue('');
  await expect(page.getByLabel('Recipient name')).toHaveValue('A friendly sysop');
});
test('applies dark-mode colors while preserving message text', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await setup(page);
  await click(page.locator('.message-row').first());
  await expect(page.locator('.body-text')).toContainText('Hello, Mike.');
  expect(await page.locator('body').evaluate((node) => getComputedStyle(node).color)).toBe(
    'rgb(225, 230, 233)',
  );
});

test('discovers, searches, joins and leaves discussions with confirmed status', async ({
  page,
}) => {
  await setup(page);
  await click(page.getByRole('button', { name: '＋ Manage discussions' }));
  const browser = page.getByRole('dialog', { name: 'Manage discussions' });
  await click(browser.getByRole('button', { name: 'Get available discussions' }));
  await expect(browser.getByRole('status')).toContainText('Check for replies');
  await click(browser.getByRole('button', { name: 'Check for replies' }));
  await expect(browser.getByRole('button', { name: 'Refresh discussions' })).toBeEnabled();
  await browser.getByLabel('Search discussions').fill('technology');
  await expect(browser.locator('.discussion-row')).toHaveCount(1);
  await expect(browser.locator('.discussion-row')).toContainText('TECH');
  await click(browser.getByRole('button', { name: 'Join TECH', exact: true }));
  await expect(browser.locator('.discussion-row')).toContainText('Join awaiting confirmation');
  await click(browser.getByRole('button', { name: 'Check for replies' }));
  await expect(browser.getByRole('button', { name: 'Leave TECH', exact: true })).toBeVisible();
  await expect(browser.locator('.discussion-badge')).toHaveText('Joined');
  await click(browser.getByRole('button', { name: 'Leave TECH', exact: true }));
  await expect(browser.locator('.discussion-row')).toContainText('Leave awaiting confirmation');
  await click(browser.getByRole('button', { name: 'Check for replies' }));
  await expect(browser.locator('.discussion-badge')).toHaveText('Not joined');
  await browser.getByRole('combobox', { name: 'Show', exact: true }).selectOption('joined');
  await expect(browser.getByText('No matching discussions.', { exact: true })).toBeVisible();
});

test('keeps manual tag requests and renders provider descriptions as text', async ({ page }) => {
  await setup(page);
  await click(page.getByRole('button', { name: '＋ Manage discussions' }));
  const browser = page.getByRole('dialog');
  await click(browser.getByRole('button', { name: 'Get available discussions' }));
  await click(browser.getByRole('button', { name: 'Check for replies' }));
  await expect(
    browser.getByText('<script>window.HACKED=true</script>', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'HACKED'))).toBe(false);
  await click(browser.locator('summary'));
  await browser.getByLabel('Discussion tag', { exact: true }).fill('custom_echo');
  await click(browser.getByRole('button', { name: 'Request to join', exact: true }));
  await browser.getByRole('combobox', { name: 'Show', exact: true }).selectOption('pending');
  await expect(browser.locator('.discussion-row')).toHaveCount(1);
  await expect(browser.locator('.discussion-row')).toContainText('CUSTOM_ECHO');
});

test('browses a large cached directory offline and paginates without losing search', async ({
  page,
}) => {
  await setup(page, true, {
    ...state.discussions,
    updatedAt: '2026-10-15T00:00:00Z',
    entries: Array.from({ length: 250 }, (_, i) => ({
      tag: `AREA_${i}`,
      name: `Discussion ${String(i).padStart(3, '0')}`,
      subscription: 'left',
      confirmedAt: null,
      pending: null,
      error: '',
    })),
  });
  await click(page.getByRole('button', { name: '＋ Manage discussions' }));
  const browser = page.getByRole('dialog');
  await expect(browser.locator('.discussion-row')).toHaveCount(100);
  await click(browser.getByRole('button', { name: 'Show more discussions' }));
  await expect(browser.locator('.discussion-row')).toHaveCount(200);
  await browser.getByLabel('Search discussions').fill('AREA_249');
  await expect(browser.locator('.discussion-row')).toHaveCount(1);
  await expect(browser.locator('.discussion-row')).toContainText('Discussion 249');
});

test('deletes incoming mail to Trash, removes it from Starred, and restores it', async ({
  page,
}) => {
  await setup(page);
  await click(page.locator('.message-row').first());
  await click(page.getByRole('button', { name: '☆ Star', exact: true }));
  await click(page.getByRole('button', { name: 'Delete', exact: true }));
  await expect(page.locator('.message-row')).toHaveCount(0);
  await click(page.getByRole('button', { name: /^Starred/ }));
  await expect(page.locator('.message-row')).toHaveCount(0);
  await click(page.getByRole('button', { name: /^Trash/ }));
  await click(page.locator('.message-row'));
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await click(page.getByRole('button', { name: 'Restore', exact: true }));
  await click(page.getByRole('button', { name: /^Inbox/ }));
  await expect(page.locator('.message-row')).toContainText('Welcome to PacketLark');
});

test('requires confirmation for permanent deletion and lets the user cancel', async ({ page }) => {
  await setup(page);
  await click(page.locator('.message-row').first());
  await click(page.getByRole('button', { name: 'Delete', exact: true }));
  await click(page.getByRole('button', { name: /^Trash/ }));
  await click(page.locator('.message-row'));
  await click(page.getByRole('button', { name: 'Delete permanently', exact: true }));
  const confirmation = page.getByRole('dialog', { name: 'Delete message permanently?' });
  await click(confirmation.getByRole('button', { name: 'Cancel', exact: true }));
  await expect(page.locator('.message-row')).toHaveCount(1);
  await click(page.getByRole('button', { name: 'Delete permanently', exact: true }));
  await click(confirmation.getByRole('button', { name: 'Delete permanently', exact: true }));
  await expect(page.locator('.message-row')).toHaveCount(0);
  await expect(confirmation).toHaveCount(0);
});

test('deletes and restores an incomplete draft from inside the composer', async ({ page }) => {
  await setup(page);
  await click(page.getByRole('button', { name: '＋ New message' }));
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Keep this unfinished draft');
  await click(page.getByRole('dialog').getByRole('button', { name: 'Delete draft', exact: true }));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click(page.getByRole('button', { name: /^Trash/ }));
  await click(page.locator('.message-row'));
  await expect(page.locator('.body-text')).toContainText('Keep this unfinished draft');
  await click(page.getByRole('button', { name: 'Restore', exact: true }));
  await click(page.getByRole('button', { name: /^Drafts/ }));
  await click(page.locator('.message-row'));
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Keep this unfinished draft',
  );
});

test('cancels queued mail and restores it as a draft without automatically sending', async ({
  page,
}) => {
  await setup(page);
  await click(page.getByRole('button', { name: '＋ New message' }));
  await page.getByLabel('Recipient name').fill('Friend');
  await page.getByRole('textbox', { name: 'FidoNet address' }).fill('1:123/456');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Cancel this send');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep as a draft');
  await click(page.getByRole('button', { name: 'Queue message' }));
  await click(page.getByRole('button', { name: /^Outbox/ }));
  await click(page.locator('.message-row'));
  await click(page.getByRole('button', { name: 'Delete', exact: true }));
  await click(page.getByRole('button', { name: /^Trash/ }));
  await click(page.locator('.message-row'));
  await click(page.getByRole('button', { name: 'Restore', exact: true }));
  await click(page.getByRole('button', { name: /^Outbox/ }));
  await expect(page.locator('.message-row')).toHaveCount(0);
  await click(page.getByRole('button', { name: /^Drafts/ }));
  await expect(page.locator('.message-row')).toContainText('Cancel this send');
});

test('keeps management traffic out of Inbox, Outbox, Sent and Trash while subscriptions work', async ({
  page,
}) => {
  await setup(page);
  await click(page.getByRole('button', { name: '＋ Manage discussions' }));
  const browser = page.getByRole('dialog');
  await click(browser.getByRole('button', { name: 'Get available discussions' }));
  await click(browser.getByRole('button', { name: 'Check for replies' }));
  await click(browser.getByRole('button', { name: 'Join TECH', exact: true }));
  await expect(browser.getByText('Join awaiting confirmation', { exact: true })).toBeVisible();
  await click(browser.getByRole('button', { name: 'Check for replies' }));
  await expect(browser.getByRole('button', { name: 'Leave TECH', exact: true })).toBeVisible();
  await click(browser.getByRole('button', { name: 'Close', exact: true }));
  for (const name of ['Inbox', 'Outbox', 'Sent', 'Trash']) {
    await click(page.getByRole('button', { name: new RegExp(`^${name}`) }));
    await expect(page.locator('.message-row').filter({ hasText: 'AreaFix' })).toHaveCount(0);
    await expect(page.locator('.message-row').filter({ hasText: '%LIST' })).toHaveCount(0);
  }
});

test('status updates preserve the reader, text selection, rows, and scroll without fetching snapshots', async ({
  page,
}) => {
  await setup(page, true, state.discussions, [
    { ...message, read: true, body: 'A long conversation.\n'.repeat(150) },
  ]);
  await click(page.locator('.message-row').first());
  const body = await page.locator('.body-text').elementHandle();
  const row = await page.locator('.message-row').elementHandle();
  const before = await page.evaluate(() => {
    const text = document.querySelector('.body-text')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.querySelector('.reader')!.scrollTop = 100;
    return {
      reads: window.packetlarkTest.stateReads(),
      scroll: document.querySelector('.reader')!.scrollTop,
      selectedText: window.getSelection()!.toString(),
    };
  });
  await page.evaluate(() => {
    for (let i = 0; i < 50; i++) window.packetlarkTest.runtime(`Transfer ${i}`);
  });
  await expect(page.locator('.statusbar')).toContainText('Transfer 49');
  expect(await page.locator('.body-text').evaluate((current, old) => current === old, body)).toBe(
    true,
  );
  expect(await page.locator('.message-row').evaluate((current, old) => current === old, row)).toBe(
    true,
  );
  if (process.env.RETROPOST_HEADLESS !== '1') expect(before.selectedText).toBe('A long');
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(before.selectedText);
  expect(await page.evaluate(() => window.packetlarkTest.stateReads())).toBe(before.reads);
  expect(await page.locator('.reader').evaluate((node) => node.scrollTop)).toBe(before.scroll);
  await page.evaluate(() => window.packetlarkTest.runtime('Connecting', true));
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await page.evaluate(() => window.packetlarkTest.runtime('Ready', false));
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
});

test('flag changes update controls while retaining the selected body and row', async ({ page }) => {
  await setup(page);
  await click(page.locator('.message-row').first());
  const body = await page.locator('.body-text').elementHandle();
  const row = await page.locator('.message-row').elementHandle();
  await click(page.getByRole('button', { name: '☆ Star', exact: true }));
  await expect(page.getByRole('button', { name: '★ Starred', exact: true })).toBeVisible();
  await click(page.getByRole('button', { name: '★ Starred', exact: true }));
  await expect(page.getByRole('button', { name: '☆ Star', exact: true })).toBeVisible();
  await click(page.getByRole('button', { name: 'Mark unread', exact: true }));
  await expect(page.getByRole('button', { name: 'Mark read', exact: true })).toBeVisible();
  expect(await page.locator('.body-text').evaluate((current, old) => current === old, body)).toBe(
    true,
  );
  expect(await page.locator('.message-row').evaluate((current, old) => current === old, row)).toBe(
    true,
  );
});

test('bounds a large mailbox and searches messages beyond the initial displayed rows', async ({
  page,
}) => {
  await setup(
    page,
    true,
    state.discussions,
    Array.from({ length: 1200 }, (_, i) => ({
      ...message,
      id: `large-${i}`,
      msgid: `large ${i}`,
      subject: `Unique conversation ${i}`,
      read: true,
      date: new Date(Date.UTC(2026, 9, 14, 18, 0, 0) - i * 1000).toISOString(),
    })),
  );
  await expect(page.locator('.message-row')).toHaveCount(200);
  const first = await page.locator('.message-row').first().elementHandle();
  await click(page.getByRole('button', { name: 'Show older messages', exact: true }));
  await expect(page.locator('.message-row')).toHaveCount(400);
  expect(
    await page
      .locator('.message-row')
      .first()
      .evaluate((current, old) => current === old, first),
  ).toBe(true);
  await page
    .getByRole('searchbox', { name: 'Search messages', exact: true })
    .fill('Unique conversation 1199');
  await expect(page.locator('.message-row')).toHaveCount(1);
  await expect(page.locator('.message-row')).toContainText('Unique conversation 1199');
  await page.getByRole('searchbox', { name: 'Search messages', exact: true }).fill('');
  await expect(page.locator('.message-row')).toHaveCount(200);
});

test('coalesces data notifications and still refreshes changed message contents', async ({
  page,
}) => {
  await setup(page, true, state.discussions, [{ ...message, read: true }]);
  await click(page.locator('.message-row').first());
  const reads = await page.evaluate(() => window.packetlarkTest.stateReads());
  await page.evaluate(() => {
    for (let i = 0; i < 100; i++) window.packetlarkTest.touch();
  });
  await expect.poll(() => page.evaluate(() => window.packetlarkTest.stateReads())).toBe(reads + 1);
  await page.evaluate(
    (m) =>
      window.packetlarkTest.replaceMessage({ ...m, read: true, body: 'Changed content arrived.' }),
    message,
  );
  await expect(page.locator('.body-text')).toHaveText('Changed content arrived.');
});

test('inserts newly received mail without remounting existing rows or the selected conversation', async ({
  page,
}) => {
  await setup(page, true, state.discussions, [{ ...message, read: true }]);
  await click(page.locator('.message-row'));
  const row = await page.locator('.message-row').elementHandle();
  const body = await page.locator('.body-text').elementHandle();
  await page.evaluate(
    (m) =>
      window.packetlarkTest.replaceMessage({
        ...m,
        id: 'new-arrival',
        msgid: 'new arrival',
        subject: 'A newly arrived message',
        date: '2026-10-15T00:00:00Z',
      }),
    message,
  );
  await expect(page.locator('.message-row')).toHaveCount(2);
  await expect(page.locator('.message-row').first()).toContainText('A newly arrived message');
  expect(
    await page
      .locator('.message-row')
      .nth(1)
      .evaluate((current, old) => current === old, row),
  ).toBe(true);
  expect(await page.locator('.body-text').evaluate((current, old) => current === old, body)).toBe(
    true,
  );
  await expect(page.getByRole('button', { name: /^Inbox/ }).locator('.count')).toHaveText('1');
});

test('defaults to chronological newest first and remembers sorting without remounting the reader', async ({
  page,
}) => {
  const messages = [
    {
      ...message,
      id: 'older',
      subject: 'Earlier message',
      date: '2026-10-15T01:00:00+03:00',
      read: true,
    },
    { ...message, id: 'newer', subject: 'Later message', date: '2026-10-14T23:00:00Z', read: true },
  ];
  await setup(page, true, state.discussions, messages);
  const sort = page.getByRole('combobox', { name: 'Sort messages', exact: true });
  await expect(sort).toHaveValue('newest');
  await expect(page.locator('.message-row .subject')).toHaveText([
    'Later message',
    'Earlier message',
  ]);
  await click(page.locator('.message-row').first());
  const body = await page.locator('.body-text').elementHandle();
  const row = await page.locator('.message-row').first().elementHandle();
  await sort.selectOption('oldest');
  await expect(page.locator('.message-row .subject')).toHaveText([
    'Earlier message',
    'Later message',
  ]);
  expect(await page.locator('.body-text').evaluate((current, old) => current === old, body)).toBe(
    true,
  );
  expect(
    await page
      .locator('.message-row')
      .nth(1)
      .evaluate((current, old) => current === old, row),
  ).toBe(true);
  await expect(page.locator('.message-row.selected')).toContainText('Later message');
  await click(page.getByRole('button', { name: 'Test discussion', exact: true }));
  await expect(sort).toHaveValue('oldest');
  await click(page.getByRole('button', { name: /^Inbox/ }));
  await page.reload();
  await expect(sort).toHaveValue('oldest');
  await expect(page.locator('.message-row .subject')).toHaveText([
    'Earlier message',
    'Later message',
  ]);
});

test('sorts the entire folder before pagination and retains filters and arrivals', async ({
  page,
}) => {
  const messages = Array.from({ length: 450 }, (_, i) => ({
    ...message,
    id: `sort-${i}`,
    subject: `Sortable message ${i}`,
    date: new Date(Date.UTC(2026, 9, 14) + i * 1000).toISOString(),
    read: i % 2 === 0,
  }));
  await setup(page, true, state.discussions, messages);
  const sort = page.getByRole('combobox', { name: 'Sort messages', exact: true });
  await expect(page.locator('.message-row').first().locator('.subject')).toHaveText(
    'Sortable message 449',
  );
  await sort.selectOption('oldest');
  await expect(page.locator('.message-row')).toHaveCount(200);
  await expect(page.locator('.message-row').first().locator('.subject')).toHaveText(
    'Sortable message 0',
  );
  await click(page.getByRole('button', { name: 'Show newer messages', exact: true }));
  await expect(page.locator('.message-row')).toHaveCount(400);
  await click(page.getByRole('button', { name: 'Unread only', exact: true }));
  await expect(page.locator('.message-row').first().locator('.subject')).toHaveText(
    'Sortable message 1',
  );
  const search = page.getByRole('searchbox', { name: 'Search messages', exact: true });
  await search.fill('Sortable message 449');
  await expect(page.locator('.message-row')).toHaveCount(1);
  await expect(page.locator('.message-row')).toContainText('Sortable message 449');
  await search.fill('');
  await click(page.getByRole('button', { name: 'Unread only ✓', exact: true }));
  await page.evaluate(
    (m) =>
      window.packetlarkTest.replaceMessage({
        ...m,
        id: 'arrival',
        date: '2026-10-16T00:00:00Z',
        subject: 'Newest arrival',
      }),
    message,
  );
  await sort.selectOption('newest');
  await expect(page.locator('.message-row')).toHaveCount(200);
  await expect(page.locator('.message-row').first()).toContainText('Newest arrival');
  await expect(
    page.getByRole('button', { name: 'Show older messages', exact: true }),
  ).toBeVisible();
});

test('keeps sorting usable when preference storage is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('Preferences unavailable');
    };
    Storage.prototype.setItem = () => {
      throw new Error('Preferences unavailable');
    };
  });
  await setup(page);
  const sort = page.getByRole('combobox', { name: 'Sort messages', exact: true });
  await expect(sort).toHaveValue('newest');
  await sort.selectOption('oldest');
  await expect(sort).toHaveValue('oldest');
  await expect(page.locator('.message-row')).toHaveCount(1);
  await page.reload();
  await expect(sort).toHaveValue('newest');
});

test('orders messages inside a discussion conversation and its replies using the remembered preference', async ({
  page,
}) => {
  const root = {
    ...message,
    id: 'root',
    msgid: 'thread root',
    replyId: '',
    area: 'TEST',
    read: true,
    from: 'Root author',
    subject: 'Thread root',
    body: 'Root body',
    date: '2026-10-14T17:00:00Z',
  };
  const parent = {
    ...root,
    id: 'parent',
    msgid: 'thread parent',
    replyId: root.msgid,
    from: 'Parent author',
    subject: 'Thread parent',
    body: 'Parent body',
    date: '2026-10-14T18:00:00Z',
  };
  const selected = {
    ...root,
    id: 'selected',
    msgid: 'thread selected',
    replyId: parent.msgid,
    from: 'Selected author',
    subject: 'Thread selected',
    body: 'Selected body',
    date: '2026-10-14T19:00:00Z',
  };
  const olderReply = {
    ...root,
    id: 'older-reply',
    msgid: 'thread older reply',
    replyId: selected.msgid,
    from: 'Earlier responder',
    subject: 'Earlier reply',
    body: 'Earlier reply body',
    date: '2026-10-15T00:00:00+03:00',
  };
  const newerReply = {
    ...root,
    id: 'newer-reply',
    msgid: 'thread newer reply',
    replyId: selected.msgid,
    from: 'Later responder',
    subject: 'Later reply',
    body: 'Later reply body',
    date: '2026-10-14T22:00:00Z',
  };
  await setup(page, true, state.discussions, [
    olderReply,
    parent,
    selected,
    root,
    newerReply,
    { ...newerReply, id: 'other-area', area: 'OTHER', body: 'Other area body' },
    { ...newerReply, id: 'trashed-reply', folder: 'trash', body: 'Trashed body' },
    {
      ...root,
      id: 'unrelated',
      msgid: 'unrelated',
      subject: selected.subject,
      body: 'Unrelated body',
    },
  ]);
  await click(page.getByRole('button', { name: 'Test discussion', exact: true }));
  await click(page.locator('.message-row').filter({ hasText: 'Selected author' }));
  const bodies = page.locator('.reader .body-text');
  const replies = page.locator('.thread-links button');
  const sort = page.getByRole('combobox', { name: 'Sort messages', exact: true });
  await expect(bodies).toHaveText(['Selected body', 'Parent body', 'Root body']);
  await expect(replies).toHaveText([
    'Later responder — Later reply',
    'Earlier responder — Earlier reply',
  ]);
  await sort.selectOption('oldest');
  await expect(bodies).toHaveText(['Root body', 'Parent body', 'Selected body']);
  await expect(replies).toHaveText([
    'Earlier responder — Earlier reply',
    'Later responder — Later reply',
  ]);
  await expect(page.locator('.reader-heading h1')).toHaveText('Thread selected');
  await click(replies.first());
  await expect(bodies).toHaveText([
    'Root body',
    'Parent body',
    'Selected body',
    'Earlier reply body',
  ]);
  await expect(page.locator('.reader-heading h1')).toHaveText('Earlier reply');
  await page.reload();
  await click(page.getByRole('button', { name: 'Test discussion', exact: true }));
  await click(page.locator('.message-row').filter({ hasText: 'Selected author' }));
  await expect(sort).toHaveValue('oldest');
  await expect(bodies).toHaveText(['Root body', 'Parent body', 'Selected body']);
  await sort.selectOption('newest');
  await expect(bodies).toHaveText(['Selected body', 'Parent body', 'Root body']);
});

test('also sorts direct-message conversation bodies without changing reply actions', async ({
  page,
}) => {
  const root = {
    ...message,
    id: 'direct-root',
    msgid: 'direct root',
    read: true,
    body: 'Earlier direct body',
    date: '2026-10-14T17:00:00Z',
  };
  const reply = {
    ...root,
    id: 'direct-reply',
    msgid: 'direct reply',
    replyId: root.msgid,
    body: 'Later direct body',
    date: '2026-10-14T18:00:00Z',
    subject: 'Direct reply',
  };
  await setup(page, true, state.discussions, [root, reply]);
  await click(page.locator('.message-row').first());
  await expect(page.locator('.body-text')).toHaveText(['Later direct body', 'Earlier direct body']);
  await page.getByRole('combobox', { name: 'Sort messages', exact: true }).selectOption('oldest');
  await expect(page.locator('.body-text')).toHaveText(['Earlier direct body', 'Later direct body']);
  await click(page.getByRole('button', { name: 'Reply', exact: true }));
  await expect(
    page.getByRole('dialog').getByRole('textbox', { name: 'Subject', exact: true }),
  ).toHaveValue('Re: Direct reply');
});

test('hides cached ADM descriptions from the sidebar, composer, search and discussion filters', async ({
  page,
}) => {
  const entry = (tag: string, name: string, subscription: 'joined' | 'left') => ({
    tag,
    name,
    subscription,
    confirmedAt: null,
    pending: null,
    error: '',
  });
  await setup(page, true, {
    ...state.discussions,
    updatedAt: '2026-10-15T00:00:00Z',
    entries: [
      entry('TEST', 'Private discussion (ADM)', 'joined'),
      entry('STAFF', 'Staff aDm only', 'left'),
      entry('ADM_TAG', 'General conversation', 'left'),
      entry('TECH', 'Computers & technology', 'joined'),
    ],
  });
  await expect(page.getByRole('button', { name: 'Test discussion', exact: true })).toHaveCount(0);
  await click(page.getByRole('button', { name: '＋ New message' }));
  await expect(
    page.getByRole('dialog').locator('option', { hasText: 'Test discussion' }),
  ).toHaveCount(0);
  await click(
    page.getByRole('dialog').getByRole('button', { name: 'Save & close', exact: true }).last(),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click(page.getByRole('button', { name: '＋ Manage discussions' }));
  const browser = page.getByRole('dialog', { name: 'Manage discussions' });
  await expect(browser.locator('.discussion-row')).toHaveCount(2);
  await expect(browser.getByRole('button', { name: 'Join ADM_TAG', exact: true })).toBeVisible();
  await browser.getByRole('combobox', { name: 'Show', exact: true }).selectOption('joined');
  await expect(browser.locator('.discussion-row')).toHaveCount(1);
  await expect(browser.locator('.discussion-row')).toContainText('TECH');
  await browser.getByRole('combobox', { name: 'Show', exact: true }).selectOption('all');
  await browser.getByLabel('Search discussions').fill('Private');
  await expect(browser.locator('.discussion-row')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Test discussion', exact: true })).toHaveCount(0);
});
