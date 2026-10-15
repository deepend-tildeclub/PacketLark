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
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  await window.screenshot({ path: 'test-results/desktop-welcome.png' });
  console.log('Desktop smoke passed: preload IPC, initial mailbox, and renderer isolation.');
} finally {
  await desktop?.close();
  fs.rmSync(data, { recursive: true, force: true });
}
