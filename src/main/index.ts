import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store, atomicWrite } from '../core/store.js';
import { composeSchema, draftSchema, profileSchema } from '../core/model.js';
import { exchange } from '../core/binkp.js';
import { unpackMail } from '../core/packet.js';

// Keep the original OS keyring identity and mailbox path across the public rename.
// Changing this would strand already-imported encrypted point credentials on Linux.
app.setName('retropost');

// Chromium's Wayland surface backend cannot use Vulkan. Keep the native
// Wayland window and other GPU acceleration, and preserve caller-disabled features.
if (
  process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY)
) {
  const disabledFeatures = new Set(
    app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean),
  );
  disabledFeatures.add('Vulkan');
  app.commandLine.appendSwitch('disable-features', [...disabledFeatures].join(','));
}

const here = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null,
  store: Store,
  timer: ReturnType<typeof setInterval> | undefined;
let syncing = false,
  status = '',
  lastAttempt = 0,
  quitting = false;
const controller = new AbortController();
const isAccountFile = (arg: string) => /\.(packetlark|retropost)$/i.test(arg);
let pendingImport = process.argv.find(isAccountFile);
const secureStorage = () =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
function emit() {
  win?.webContents.send('changed');
}
function safeError(error: unknown): string {
  // Remote errors may reflect credentials. Redact every configured secret before displaying.
  let message =
    error instanceof z.ZodError
      ? 'The account file or form contains invalid values. Check the format and required fields.'
      : error instanceof Error
        ? error.message
        : 'An unexpected error occurred.';
  try {
    const p = store?.profile();
    if (p)
      for (const secret of [
        p.uplink.sessionPassword,
        p.uplink.packetPassword,
        p.uplink.areaFixPassword,
      ].filter(Boolean))
        message = message.split(secret).join('[redacted]');
  } catch {
    /* Don't mask a credential-store failure. */
  }
  return message.slice(0, 400);
}
async function importFile(filename: string) {
  if (fs.statSync(filename).size > 128 * 1024)
    throw new Error('Account file exceeds the 128 KiB limit.');
  const profile = profileSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const result = await dialog.showMessageBox(win!, {
    type: 'question',
    buttons: ['Import account', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Import PacketLark account',
    message: `Set up ${profile.name} with ${profile.provider}?`,
    detail: `Point: ${profile.address}\nProvider: ${profile.uplink.host}:${profile.uplink.port}\nTransport: ${profile.uplink.tls ? 'certificate-verified TLS' : 'BinkP with CRAM-MD5; message traffic is not encrypted'}\n\nOnly import account files from a provider you trust.`,
  });
  if (result.response !== 0) return false;
  store.install(profile);
  status = 'Account ready. Send & receive to check your messages.';
  schedule();
  emit();
  return true;
}
function schedule() {
  if (timer) clearInterval(timer);
  const p = store.profile();
  if (p)
    timer = setInterval(() => {
      void sync().catch(() => {});
    }, p.pollMinutes * 60000);
}
async function sync() {
  if (syncing) return;
  if (Date.now() - lastAttempt < 5000)
    throw new Error('Please wait a few seconds before connecting again.');
  const p = store.profile();
  if (!p) throw new Error('Import an account first.');
  syncing = true;
  lastAttempt = Date.now();
  status = 'Connecting…';
  emit();
  let received = 0;
  try {
    await exchange(
      p,
      store.pending(),
      {
        status(text) {
          status = text;
          emit();
        },
        async receive(file) {
          received += store.receive(unpackMail(file.bytes, p));
          emit();
        },
        async sent(name) {
          store.sent(name);
          emit();
        },
      },
      controller.signal,
    );
    store.syncResult();
    status = `Up to date. ${received} new message${received === 1 ? '' : 's'}.`;
  } catch (error) {
    status = safeError(error);
    store.syncResult(status);
    throw new Error(status, { cause: error });
  } finally {
    syncing = false;
    emit();
  }
}
function register() {
  const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(name, async (event, ...args) => {
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame
      )
        throw new Error('Untrusted application frame.');
      try {
        return { ok: true, value: await fn(...args) };
      } catch (error) {
        return { ok: false, error: safeError(error) };
      }
    });
  handle('state', () => ({
    ...store.state(),
    syncing,
    status: status || store.state().status,
    storageWarning: !secureStorage(),
  }));
  handle('import', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import your PacketLark account',
      properties: ['openFile'],
      filters: [{ name: 'PacketLark account', extensions: ['packetlark', 'retropost', 'json'] }],
    });
    return result.canceled ? false : await importFile(result.filePaths[0]);
  });
  handle('sync', sync);
  handle('draft', (value) => {
    const id = store.saveDraft(draftSchema.parse(value));
    emit();
    return id;
  });
  handle('queue', (value) => {
    if (syncing)
      throw new Error('Wait for send & receive to finish before queuing another message.');
    const id = store.queue(composeSchema.parse(value));
    emit();
    return id;
  });
  handle('mark', (id, patch) => {
    store.mark(
      z.string().min(1).max(128).parse(id),
      z
        .object({ read: z.boolean().optional(), starred: z.boolean().optional() })
        .strict()
        .parse(patch),
    );
    emit();
  });
  handle('removeDraft', (id) => {
    store.removeDraft(z.string().uuid().parse(id));
    emit();
  });
  handle('contact', (name, addr) => {
    store.contact(z.string().parse(name), z.string().parse(addr));
    emit();
  });
  const mailboxChange = (fn: (id: string) => void) => (id: unknown) => {
    if (syncing)
      throw new Error('Wait for send & receive to finish before deleting or restoring mail.');
    fn(z.string().min(1).max(128).parse(id));
    emit();
  };
  handle(
    'trashMessage',
    mailboxChange((id) => store.trashMessage(id)),
  );
  handle(
    'restoreMessage',
    mailboxChange((id) => store.restoreMessage(id)),
  );
  handle(
    'deleteMessage',
    mailboxChange((id) => store.deleteMessage(id)),
  );
  handle('area', (tag, subscribe) => {
    if (syncing) throw new Error('Wait for send & receive to finish before changing discussions.');
    const add = z.boolean().parse(subscribe);
    store.areaCommand(z.string().parse(tag), add);
    status = `${add ? 'Join' : 'Leave'} request queued. Your provider will reply after processing it.`;
    emit();
  });
  handle('areaList', () => {
    if (syncing)
      throw new Error('Wait for send & receive to finish before requesting discussions.');
    store.requestAreaList();
    status = 'Discussion list requested. Your provider will reply after processing it.';
    emit();
  });
  handle('backup', async () => {
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: `packetlark-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: 'SQLite mailbox', extensions: ['sqlite'] }],
    });
    if (!result.canceled && result.filePath) atomicWrite(result.filePath, store.backup());
  });
}
function createWindow() {
  win = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'PacketLark',
    backgroundColor: '#f4f5f6',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  win.webContents.on('before-input-event', (_event, input) => {
    if (
      input.key === 'F12' &&
      (process.env.PACKETLARK_DEV === '1' || process.env.RETROPOST_DEV === '1')
    )
      win?.webContents.toggleDevTools();
  });
  void win.loadFile(path.join(here, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });
  win.webContents.once('did-finish-load', () => {
    if (pendingImport) {
      const file = pendingImport;
      pendingImport = undefined;
      void importFile(file).catch((error) => {
        status = safeError(error);
        emit();
      });
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    win?.restore();
    win?.focus();
    const file = argv.find(isAccountFile);
    if (file && win)
      void importFile(file).catch((e) => {
        status = safeError(e);
        emit();
      });
  });
  app.on('open-file', (event, file) => {
    event.preventDefault();
    pendingImport = file;
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (syncing && !quitting) {
      event.preventDefault();
      quitting = true;
      controller.abort();
      setTimeout(() => app.quit(), 250);
    }
  });
  app.on('will-quit', () => {
    if (timer) clearInterval(timer);
    store?.close();
  });
  void app
    .whenReady()
    .then(async () => {
      const wasm = app.isPackaged
        ? path.join(process.resourcesPath, 'sql-wasm.wasm')
        : path.join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm');
      store = await Store.open(
        path.join(app.getPath('userData'), 'mailbox.sqlite'),
        wasm,
        (s) => {
          if (!secureStorage())
            throw new Error(
              'Your operating system credential store is unavailable. Enable Windows credential protection or a Linux Secret Service/keyring, then restart PacketLark.',
            );
          return safeStorage.encryptString(s).toString('base64');
        },
        (s) => {
          if (!secureStorage())
            throw new Error('Unlock your operating system keyring, then restart PacketLark.');
          return safeStorage.decryptString(Buffer.from(s, 'base64'));
        },
      );
      register();
      createWindow();
      schedule();
      // Open links only through a tightly scoped IPC endpoint, never via message HTML.
      ipcMain.handle('external', async (event, value: unknown) => {
        if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame)
          return;
        if (typeof value === 'string' && value.length < 2048 && /^https?:\/\//i.test(value))
          await shell.openExternal(value);
      });
    })
    .catch((error) => {
      dialog.showErrorBox(
        'PacketLark could not open your mailbox',
        `${safeError(error)}\nYour mailbox has not been reset. Back it up before troubleshooting.`,
      );
      app.quit();
    });
}
