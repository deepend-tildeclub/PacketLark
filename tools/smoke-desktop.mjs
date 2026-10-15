import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-desktop-'));
fs.mkdirSync('test-results', { recursive: true });
let desktop;
try {
  desktop = await electron.launch({ args: ['.', `--user-data-dir=${data}`], timeout: 30000 });
  const window = await desktop.firstWindow();
  await window.getByRole('button', { name: 'Import your account file' }).waitFor();
  const security = await desktop.evaluate(({ BrowserWindow }) => {
    const options = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: options.sandbox,
      nodeIntegration: options.nodeIntegration,
      contextIsolation: options.contextIsolation,
    };
  });
  assert.deepEqual(security, { sandbox: true, nodeIntegration: false, contextIsolation: true });
  const state = await window.evaluate(() => window.packetlark.state());
  assert.equal(state.account, null);
  assert.deepEqual(state.notifications, { enabled: true, discussions: true, previews: true });
  assert.equal(typeof state.notificationsSupported, 'boolean');
  const preferences = await window.evaluate(async () => {
    await window.packetlark.setNotifications({
      enabled: false,
      discussions: false,
      previews: false,
    });
    const saved = (await window.packetlark.state()).notifications;
    let rejected = false;
    try {
      await window.packetlark.setNotifications({ enabled: 'invalid' });
    } catch {
      rejected = true;
    }
    return {
      saved,
      rejected,
      listener: typeof window.packetlark.onNotification,
      test: typeof window.packetlark.testNotification,
    };
  });
  assert.deepEqual(preferences.saved, { enabled: false, discussions: false, previews: false });
  assert.equal(preferences.rejected, true);
  assert.equal(preferences.listener, 'function');
  assert.equal(preferences.test, 'function');
  const update = await window.evaluate(async () => {
    const changed = new Promise((resolve) => {
      const off = window.packetlark.onChanged((value) => {
        off();
        resolve(value);
      });
    });
    await window.packetlark.contact('IPC smoke contact', '1:123/456');
    return { event: await changed, state: await window.packetlark.state() };
  });
  assert.ok(update.state.revision > state.revision);
  assert.equal(update.event.revision, update.state.revision);
  assert.equal(update.state.contacts[0].name, 'IPC smoke contact');
  await window.evaluate(() => {
    window.notificationSmoke = [];
    window.stopNotificationSmoke = window.packetlark.onNotification((...args) => {
      window.notificationSmoke.push(args);
    });
  });
  await desktop.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('notification:open', { privileged: 'not a message ID' });
    contents.send('notification:open', '../invalid');
    contents.send('notification:open', 'missing-message');
  });
  await window
    .getByText('That message is no longer available in your Inbox.', { exact: true })
    .waitFor();
  const clicks = await window.evaluate(() => {
    window.stopNotificationSmoke();
    return window.notificationSmoke;
  });
  assert.deepEqual(clicks, [['missing-message']]);
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  await window.screenshot({ path: 'test-results/desktop-welcome.png' });
  console.log(
    'Desktop smoke passed: preload IPC, native-notification preferences, revision notifications, mailbox refresh, and renderer isolation.',
  );
} finally {
  await desktop?.close();
  fs.rmSync(data, { recursive: true, force: true });
}
