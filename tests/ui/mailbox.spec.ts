import { test as base, expect, _electron, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Compose, Message, State } from '../../src/core/model.js';

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
const state: State = {
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
async function setup(page: Page, account = true, directory = state.discussions) {
  await page.addInitScript(
    ({ initial, account }) => {
      const data = structuredClone(initial);
      if (!account) {
        data.account = null;
        data.messages = [];
        data.areas = [];
      }
      let listSent = false;
      const changed: (() => void)[] = [];
      const emit = () => changed.forEach((cb) => cb());
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
          state: async () => structuredClone(data),
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
            emit();
          },
          backup: async () => {},
          onChanged: (cb: () => void) => {
            changed.push(cb);
            return () => {};
          },
        },
      });
    },
    { initial: { ...state, discussions: directory }, account },
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
