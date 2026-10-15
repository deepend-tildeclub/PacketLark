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
async function setup(page: Page, account = true) {
  await page.addInitScript(
    ({ initial, account }) => {
      const data = structuredClone(initial);
      if (!account) {
        data.account = null;
        data.messages = [];
        data.areas = [];
      }
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
          areaCommand: async () => {},
          backup: async () => {},
          onChanged: (cb: () => void) => {
            changed.push(cb);
            return () => {};
          },
        },
      });
    },
    { initial: state, account },
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
