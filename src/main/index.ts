import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
  Tray,
} from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store, atomicWrite } from '../core/store.js';
import {
  composeSchema,
  draftSchema,
  profileSchema,
  notificationSettingsSchema,
  readingSettingsSchema,
  desktopSettingsSchema,
  type DesktopSettings,
  type State,
} from '../core/model.js';
import { newMailNotice, notificationTarget } from '../core/notifications.js';
import { DesktopNotifications } from './notifications.js';
import { DesktopTray, unreadCount, unreadDot } from './background.js';
import { LoginStartup } from './startup.js';
import { exchange } from '../core/binkp.js';
import { unpackMail } from '../core/packet.js';

// Keep the original OS keyring identity and mailbox path across the public rename.
// Changing this would strand already-imported encrypted point credentials on Linux.
app.setName('retropost');
if (process.platform === 'win32') {
  // Match the existing installer identity, preserving mailbox/keyring compatibility.
  app.setAppUserModelId(
    app.isPackaged ? 'net.retrodigital.retropost' : 'net.retrodigital.retropost.development',
  );
  app.setToastActivatorCLSID(
    app.isPackaged
      ? '{A51D2906-5AC4-4F43-A2F3-8E2CDA12D580}'
      : '{B4B0E872-2290-4AA2-91A1-19B9A1C1E835}',
  );
} else if (process.platform === 'linux') app.setDesktopName('packetlark.desktop');

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
const applicationIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'notification-icon.png')
  : path.join(app.getAppPath(), 'build/icon.png');
const notifications = new DesktopNotifications({
  platform: process.platform,
  supported: () => Notification.isSupported(),
  create: (options) => new Notification(options),
  open: openNotification,
  icon: applicationIcon,
});
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
let pendingMessage: string | undefined;
let lastNotification = { id: '', time: 0 };
let desktop: DesktopTray | undefined;
let startup: LoginStartup;
let snapshot: State | undefined;
let badgeRevision = -1;
let badgeCount = 0;
let quitToken: string | undefined;
let quitTimer: ReturnType<typeof setTimeout> | undefined;
let aborting = false;
let startHidden = process.argv.includes('--background');
function mailboxSnapshot(): State {
  if (snapshot?.revision !== store.revision) snapshot = store.state();
  return snapshot!;
}
function showWindow() {
  if (quitting) return;
  startHidden = false;
  if (!win || win.isDestroyed()) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show();
  win!.focus();
}
function updateDesktop() {
  try {
    updateDesktopUnsafe();
  } catch {
    /* Shell/keyring failures must not affect mail exchange. */
  }
}
function updateDesktopUnsafe() {
  if (!store) return;
  const state = mailboxSnapshot();
  if (badgeRevision !== store.revision) {
    badgeRevision = store.revision;
    badgeCount = unreadCount(state);
    win?.setTitle(badgeCount ? `PacketLark (${badgeCount} unread)` : 'PacketLark');
    try {
      if (process.platform === 'win32')
        win?.setOverlayIcon(
          badgeCount ? nativeImage.createFromBitmap(unreadDot(), { width: 16, height: 16 }) : null,
          `${badgeCount} unread messages`,
        );
      else if (process.platform === 'linux') app.setBadgeCount(badgeCount);
    } catch {
      /* Badges depend on the desktop shell. */
    }
  }
  desktop?.update(badgeCount, syncing, !!state.account);
  if (
    store.desktopSettings().keepRunning &&
    !desktop?.available &&
    win &&
    !win.isVisible() &&
    !quitting
  )
    showWindow();
}
function finishQuit() {
  quitting = true;
  app.quit();
}
function requestQuit() {
  if (quitting || quitToken) return;
  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) {
    finishQuit();
    return;
  }
  quitToken = randomUUID();
  win.webContents.send('desktop:prepareQuit', quitToken);
  quitTimer = setTimeout(() => {
    quitToken = undefined;
    showWindow();
    void dialog
      .showMessageBox(win!, {
        type: 'warning',
        buttons: ['Keep open', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
        message: 'PacketLark could not confirm that your draft was saved.',
        detail: 'Keep the window open to save your work. Quit anyway may discard unsaved text.',
      })
      .then(({ response }) => {
        if (response === 1) finishQuit();
      });
  }, 5000);
}
function setDesktop(value: DesktopSettings) {
  if (
    value.keepRunning &&
    !desktop?.start() &&
    (!store.desktopSettings().keepRunning || value.startAtLogin)
  )
    throw new Error('Your desktop tray is unavailable. PacketLark will keep closing normally.');
  const previous = startup.enabled();
  if (previous !== value.startAtLogin) startup.set(value.startAtLogin);
  try {
    store.setDesktop(value);
  } catch (error) {
    if (previous !== value.startAtLogin) startup.set(previous);
    throw error;
  }
  if (!value.keepRunning && win && !win.isVisible()) showWindow();
  emit();
}

function openNotification(id: string) {
  if (quitting) return;
  // Windows can deliver both the live click event and the persistent activation callback.
  if (id === lastNotification.id && Date.now() - lastNotification.time < 250) return;
  lastNotification = { id, time: Date.now() };
  showWindow();
  if (!id) return;
  if (win!.webContents.isLoadingMainFrame()) pendingMessage = id;
  else win!.webContents.send('notification:open', id);
}

function notifyReceived(ids: ReadonlySet<string>) {
  if (!ids.size || quitting || !win || win.isDestroyed() || win.isFocused()) return;
  try {
    const notice = newMailNotice(ids, store.state());
    if (notice) notifications.show(notice);
  } catch {
    // Notification service/keyring failures must not change transport success or retry behavior.
  }
}
const secureStorage = () =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
function emit() {
  win?.webContents.send('changed', { revision: store.revision, syncing, status });
  updateDesktop();
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
  installAccount(profile);
  return true;
}
function installAccount(value: unknown) {
  store.install(profileSchema.parse(value));
  status = 'Account ready. Send & receive to check your messages.';
  schedule();
  emit();
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
  const newIds = new Set<string>();
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
          const saved = store.receiveNew(unpackMail(file.bytes, p));
          received += saved.length;
          for (const message of saved) newIds.add(message.id);
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
    notifyReceived(newIds);
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
  handle('state', () => {
    // Connection progress doesn't change the mailbox. Avoid repeated SQL scans,
    // JSON decoding and OS credential decryption for the same durable revision.
    const snapshot = mailboxSnapshot();
    return {
      ...snapshot,
      syncing,
      status: status || snapshot.status,
      storageWarning: !secureStorage(),
      notificationsSupported: notifications.supported(),
      desktop: { ...store.desktopSettings(), startAtLogin: startup.enabled() },
      traySupported: desktop?.available || false,
      startupSupported: startup.supported(),
    };
  });
  handle('import', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import your PacketLark account',
      properties: ['openFile'],
      filters: [{ name: 'PacketLark account', extensions: ['packetlark', 'retropost', 'json'] }],
    });
    return result.canceled ? false : await importFile(result.filePaths[0]);
  });
  handle('sync', sync);
  handle('setupAccount', installAccount);
  handle('reading', (value) => {
    store.setReading(readingSettingsSchema.parse(value));
    emit();
  });
  handle('desktop', (value) => setDesktop(desktopSettingsSchema.parse(value)));
  handle('markConversationRead', (id) => {
    store.markConversationRead(z.string().min(1).max(128).parse(id));
    emit();
  });
  handle('finishQuit', (token, saved) => {
    const validToken = z.string().uuid().parse(token);
    const ok = z.boolean().parse(saved);
    if (validToken !== quitToken) return;
    quitToken = undefined;
    if (quitTimer) clearTimeout(quitTimer);
    if (ok) finishQuit();
    else showWindow();
  });
  handle('notifications', (value) => {
    store.setNotifications(notificationSettingsSchema.parse(value));
    emit();
  });
  handle('testNotification', () => {
    if (
      !notifications.show({
        title: 'PacketLark',
        body: 'This is a test notification.',
        messageId: '',
      })
    )
      throw new Error(
        'Your operating system notification service is unavailable. Check your desktop notification settings.',
      );
  });
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
    icon: applicationIcon,
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
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (store?.desktopSettings().keepRunning && desktop?.available) win?.hide();
    else requestQuit();
  });
  win.on('page-title-updated', (event) => event.preventDefault());
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
    badgeRevision = -1;
    updateDesktop();
    if (
      startHidden &&
      store.desktopSettings().keepRunning &&
      desktop?.available &&
      !pendingImport &&
      pendingMessage === undefined
    )
      win?.hide();
    startHidden = false;
    if (pendingMessage !== undefined) {
      win?.webContents.send('notification:open', pendingMessage);
      pendingMessage = undefined;
    }
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
    showWindow();
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
    if (!quitting && win && !win.isDestroyed()) {
      event.preventDefault();
      requestQuit();
      return;
    }
    if (syncing && !aborting) {
      event.preventDefault();
      quitting = true;
      aborting = true;
      controller.abort();
      setTimeout(() => app.quit(), 250);
    } else quitting = true;
  });
  app.on('will-quit', () => {
    if (timer) clearInterval(timer);
    if (quitTimer) clearTimeout(quitTimer);
    desktop?.close();
    try {
      if (process.platform === 'linux') app.setBadgeCount(0);
    } catch {
      /* The shell may already be gone. */
    }
    notifications.close();
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
      const executable =
        process.platform === 'linux' &&
        process.env.APPIMAGE &&
        path.isAbsolute(process.env.APPIMAGE)
          ? process.env.APPIMAGE
          : process.execPath;
      const configHome =
        process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
          ? process.env.XDG_CONFIG_HOME
          : path.join(app.getPath('home'), '.config');
      startup = new LoginStartup({
        platform: process.platform,
        packaged: app.isPackaged,
        executable,
        configHome,
        login: {
          read: () => {
            const settings = app.getLoginItemSettings({ path: executable, args: ['--background'] });
            return settings.openAtLogin && settings.executableWillLaunchAtLogin;
          },
          write: (enabled) =>
            app.setLoginItemSettings({
              openAtLogin: enabled,
              enabled,
              path: executable,
              args: ['--background'],
            }),
        },
      });
      // GTK tray initialization can abort a process without a display, rather than throw.
      const trayEnvironment =
        process.platform !== 'linux' ||
        (!!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) &&
          app.commandLine.getSwitchValue('ozone-platform') !== 'headless');
      if (trayEnvironment)
        try {
          const icon = nativeImage
            .createFromPath(applicationIcon)
            .resize({ width: 32, height: 32 });
          const pixels = Buffer.from(icon.toBitmap());
          const dot = unreadDot();
          for (let y = 0; y < 16; y++)
            for (let x = 0; x < 16; x++) {
              const from = (y * 16 + x) * 4,
                to = (y * 32 + x + 16) * 4;
              if (dot[from + 3]) dot.copy(pixels, to, from, from + 4);
            }
          desktop = new DesktopTray({
            create: () => new Tray(icon),
            menu: (items) => Menu.buildFromTemplate(items),
            normal: icon,
            unread: nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }),
            open: showWindow,
            quit: requestQuit,
            sync: () => {
              void sync().catch((error) => {
                status = safeError(error);
                emit();
              });
            },
          });
          desktop.start();
        } catch {
          /* A tray failure must leave the mailbox usable in a normal window. */
        }
      register();
      createWindow();
      if (process.platform === 'win32') {
        try {
          Notification.handleActivation((details) => {
            if (details.type !== 'click') return;
            const id = notificationTarget(details.arguments);
            if (id || details.arguments === 'packetlark-test') {
              try {
                openNotification(id || '');
              } catch {
                /* The app may be closing. */
              }
            }
          });
        } catch {
          /* Native activation support must not prevent mailbox startup. */
        }
      }
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
      finishQuit();
    });
}
