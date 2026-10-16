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
  assert.equal(state.desktop.keepRunning, false);
  const reading = await window.evaluate(async () => {
    const initial = (await window.packetlark.state()).reading;
    await window.packetlark.setReading({ ...initial, fontSize: 18, font: 'monospace' });
    let rejected = false;
    try {
      await window.packetlark.setReading({ ...initial, fontSize: 999 });
    } catch {
      rejected = true;
    }
    let invalidDesktop = false;
    try {
      await window.packetlark.setDesktop({ keepRunning: false, startAtLogin: true });
    } catch {
      invalidDesktop = true;
    }
    let missingConversation = false;
    try {
      await window.packetlark.markConversationRead('missing');
    } catch {
      missingConversation = true;
    }
    return {
      saved: (await window.packetlark.state()).reading,
      rejected,
      invalidDesktop,
      missingConversation,
      quitHandler: typeof window.packetlark.onPrepareQuit,
    };
  });
  assert.equal(reading.saved.fontSize, 18);
  assert.equal(reading.saved.font, 'monospace');
  assert.equal(reading.rejected, true);
  assert.equal(reading.invalidDesktop, true);
  assert.equal(reading.missingConversation, true);
  assert.equal(reading.quitHandler, 'function');
  if (state.traySupported) {
    await window.evaluate(() =>
      window.packetlark.setDesktop({ keepRunning: true, startAtLogin: false }),
    );
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    );
    await desktop.evaluate(({ app }) => app.emit('second-instance', {}, ['packetlark']));
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      true,
    );
    await window.evaluate(() =>
      window.packetlark.setDesktop({ keepRunning: false, startAtLogin: false }),
    );
  }
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
  const manual = await window.evaluate(async () => {
    const value = {
      format: 'packetlark-account',
      version: 1,
      name: 'IPC smoke point',
      provider: 'Test BBS',
      address: '1:123/456.100@fidonet',
      uplink: {
        address: '1:123/456@fidonet',
        host: 'bbs.example.invalid',
        port: 24554,
        tls: false,
        sessionPassword: 'SMOKESESSION',
        packetPassword: '',
        areaFixPassword: '',
      },
      areas: [],
      pollMinutes: 1440,
      charset: 'UTF-8',
    };
    const initial = await window.packetlark.state();
    let invalid = false;
    try {
      await window.packetlark.setupAccount({ ...value, address: '1:123/999.100' });
    } catch {
      invalid = true;
    }
    const afterInvalid = await window.packetlark.state();
    let installed = false;
    try {
      await window.packetlark.setupAccount(value);
      installed = true;
    } catch (error) {
      if (!initial.storageWarning) throw error;
    }
    const after = await window.packetlark.state();
    let replacementRejected = false;
    if (installed) {
      try {
        await window.packetlark.setupAccount({ ...value, name: 'Replacement' });
      } catch {
        replacementRejected = true;
      }
    }
    return {
      invalid,
      unchanged: afterInvalid.revision === initial.revision && afterInvalid.account === null,
      installed,
      storageWarning: initial.storageWarning,
      after,
      replacementRejected,
    };
  });
  assert.equal(manual.invalid, true);
  assert.equal(manual.unchanged, true);
  assert.equal(manual.installed, !manual.storageWarning);
  if (manual.installed) {
    assert.equal(manual.after.account.name, 'IPC smoke point');
    assert.equal(manual.replacementRejected, true);
  } else assert.equal(manual.after.account, null);
  assert.equal(JSON.stringify(manual.after).includes('SMOKESESSION'), false);
  await window.screenshot({ path: 'test-results/desktop-welcome.png' });
  console.log(
    'Desktop smoke passed: preferences and validation, tray close/reopen where available, isolated IPC, notification navigation, and mailbox refresh.',
  );
} finally {
  await desktop?.close();
  fs.rmSync(data, { recursive: true, force: true });
}
