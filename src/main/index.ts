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
  connectionSettingsSchema,
  draftSchema,
  profileSchema,
  notificationSettingsSchema,
  readingSettingsSchema,
  desktopSettingsSchema,
  areaSchema,
  discussionPreferenceSchema,
  mailSearchSchema,
  type DesktopSettings,
  type State,
} from '../core/model.js';
import {
  accountNotificationTarget,
  newMailNotice,
  notificationTarget,
} from '../core/notifications.js';
import { DesktopNotifications } from './notifications.js';
import { DesktopTray, unreadDot } from './background.js';
import { LoginStartup } from './startup.js';
import {
  Accounts,
  accountIdSchema,
  primaryAccount,
  snapshot,
  type AccountContext,
} from '../core/accounts.js';
import { AccountSync, connectionError } from '../core/account-sync.js';
import { secretServiceAvailable, unlockSecretService } from './secret-service.js';

// Keep the original OS keyring identity and mailbox path across the public rename.
// Changing this would strand already-imported encrypted point credentials on Linux.
const nativeStorageAppName = app.getName();
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
  accounts: Accounts,
  timer: ReturnType<typeof setInterval> | undefined;
let quitting = false;
const sessions = new AccountSync({ emit, received: notifyReceived });
const primaryStore = () => accounts.primary.store;
const isAccountFile = (arg: string) => /\.(packetlark|retropost)$/i.test(arg);
let pendingImport = process.argv.find(isAccountFile);
let pendingMessage: { id: string; accountId: string } | undefined;
let lastNotification = { id: '', time: 0 };
let desktop: DesktopTray | undefined;
let startup: LoginStartup;
let revision = 0;
let generation = -1;
let mailboxRevisions = new Map<string, number>();
let summaries: NonNullable<State['accounts']> = [];
function updateRevision() {
  const changed =
    generation !== accounts.generation ||
    [...accounts.contexts.values()].some((a) => mailboxRevisions.get(a.id) !== a.store.revision);
  if (!changed) return;
  const next = accounts.summaries();
  generation = accounts.generation;
  mailboxRevisions = new Map([...accounts.contexts.values()].map((a) => [a.id, a.store.revision]));
  summaries = next;
  revision++;
}
let badgeRevision = -1;
let badgeCount = 0;
let quitToken: string | undefined;
let quitTimer: ReturnType<typeof setTimeout> | undefined;
let aborting = false;
let startHidden = process.argv.includes('--background');
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
  if (!accounts) return;
  updateRevision();
  if (badgeRevision !== revision) {
    badgeRevision = revision;
    badgeCount = summaries.reduce((n, a) => n + a.unread, 0);
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
  desktop?.update(
    badgeCount,
    sessions.busy,
    summaries.some((a) => !a.paused) || summaries.length === 1,
  );
  if (
    primaryStore().desktopSettings().keepRunning &&
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
    (!primaryStore().desktopSettings().keepRunning || value.startAtLogin)
  )
    throw new Error('Your desktop tray is unavailable. PacketLark will keep closing normally.');
  const previous = startup.enabled();
  if (previous !== value.startAtLogin) startup.set(value.startAtLogin);
  try {
    primaryStore().setDesktop(value);
  } catch (error) {
    if (previous !== value.startAtLogin) startup.set(previous);
    throw error;
  }
  if (!value.keepRunning && win && !win.isVisible()) showWindow();
  emit();
}

function openNotification(id: string, accountId = primaryAccount) {
  if (quitting) return;
  // Windows can deliver both the live click event and the persistent activation callback.
  const key = `${accountId}:${id}`;
  if (key === lastNotification.id && Date.now() - lastNotification.time < 250) return;
  lastNotification = { id: key, time: Date.now() };
  showWindow();
  if (!id) return;
  if (win!.webContents.isLoadingMainFrame()) pendingMessage = { id, accountId };
  else win!.webContents.send('notification:open', id, accountId);
}

function notifyReceived(account: AccountContext, ids: ReadonlySet<string>) {
  if (!ids.size || quitting || !win || win.isDestroyed() || win.isFocused()) return;
  try {
    const notice = newMailNotice(ids, {
      ...snapshot(account),
      notifications: primaryStore().notificationSettings(),
    });
    if (notice)
      notifications.show(
        account.id === primaryAccount
          ? notice
          : {
              ...notice,
              accountId: account.id,
              title: `${notice.title} · ${snapshot(account).account?.provider || 'Account'}`,
            },
      );
  } catch {
    // Notification service/keyring failures must not change transport success or retry behavior.
  }
}
const secureStorage = () =>
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text') &&
  safeStorage.isEncryptionAvailable();
class CredentialStoreError extends Error {}
let credentialsReady = false;
let nativeKeyringFailed = false;
let credentialAttempt: Promise<void> | undefined;
const keyringHelp =
  'Start and unlock your desktop keyring (Secret Service or KWallet), then try again.';

function credentialWarning() {
  if (process.platform !== 'linux') return !secureStorage();
  // Do not initialise Chromium's synchronous key cache while rendering the Welcome screen.
  return nativeKeyringFailed || safeStorage.getSelectedStorageBackend() === 'basic_text';
}

function requireCredentialStore(): Promise<void> {
  if (credentialsReady) return Promise.resolve();
  return (credentialAttempt ??= (async () => {
    const linux = process.platform === 'linux';
    const backend = linux ? safeStorage.getSelectedStorageBackend() : '';
    if (backend === 'basic_text')
      throw new CredentialStoreError(
        'PacketLark needs a secure desktop keyring. Start a Secret Service provider and open PacketLark again.',
      );
    if (backend === 'gnome_libsecret' && !nativeKeyringFailed) {
      const result = await unlockSecretService([nativeStorageAppName, app.getName()]);
      if (result === 'cancelled')
        throw new CredentialStoreError('Keyring unlock cancelled. Try again when you’re ready.');
      // If the auxiliary D-Bus client cannot reach the service, let the native
      // backend try once. It may support a session transport unavailable here.
    }
    if (!secureStorage()) {
      nativeKeyringFailed = linux;
      throw new CredentialStoreError(
        linux
          ? 'Start and unlock your desktop keyring (Secret Service or KWallet), then reopen PacketLark.'
          : 'Your Windows credential store is unavailable.',
      );
    }
    credentialsReady = true;
  })().finally(() => {
    credentialAttempt = undefined;
  }));
}

function relaunch(args = process.argv.slice(1)) {
  const image = process.env.APPIMAGE;
  app.relaunch({
    args,
    ...(process.platform === 'linux' && image && path.isAbsolute(image) ? { execPath: image } : {}),
  });
  finishQuit();
}

async function useSecretServiceFallback(): Promise<boolean> {
  if (
    process.platform !== 'linux' ||
    safeStorage.getSelectedStorageBackend() !== 'basic_text' ||
    app.commandLine.hasSwitch('password-store') ||
    !(await secretServiceAvailable()) ||
    quitting
  )
    return false;
  // The synchronous backend is selected before the app's JavaScript can change it.
  relaunch([...process.argv.slice(1), '--password-store=gnome-libsecret']);
  return true;
}

async function openAccounts(wasm: string): Promise<Accounts | undefined> {
  while (!quitting) {
    try {
      return await Accounts.open(app.getPath('userData'), (file) =>
        Store.open(
          file,
          wasm,
          (s) => {
            if (!credentialsReady) throw new CredentialStoreError(keyringHelp);
            return safeStorage.encryptString(s).toString('base64');
          },
          (s) => {
            if (!credentialsReady) throw new CredentialStoreError(keyringHelp);
            return safeStorage.decryptString(Buffer.from(s, 'base64'));
          },
          requireCredentialStore,
        ),
      );
    } catch (error) {
      if (process.platform !== 'linux' || !(error instanceof CredentialStoreError)) throw error;
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'PacketLark keyring',
        message: 'PacketLark needs access to your keyring',
        detail: error.message,
        buttons: ['Try again', 'Quit'],
        cancelId: 1,
        defaultId: 0,
      });
      if (response !== 0 || quitting) break;
      if (await useSecretServiceFallback()) return;
      if (nativeKeyringFailed) {
        // Chromium remembers a failed native key lookup. Retry it in a fresh process.
        relaunch();
        return;
      }
    }
  }
  finishQuit();
}
function emit() {
  try {
    updateRevision();
    const a = accounts.active;
    win?.webContents.send('changed', {
      revision,
      syncing: sessions.current === a,
      anySyncing: sessions.busy,
      status: a.status || snapshot(a).status,
    });
  } catch {
    // A closing renderer must not change mail delivery or acknowledgement.
  }
  updateDesktop();
}
function safeError(error: unknown): string {
  if (error instanceof z.ZodError)
    return 'The account file or form contains invalid values. Check the format and required fields.';
  try {
    return connectionError(error, accounts?.active.store.profile());
  } catch {
    return connectionError(error);
  }
}
function reportError(error: unknown) {
  if (!accounts) return;
  accounts.active.status = safeError(error);
  emit();
}
async function importFile(filename: string) {
  if (fs.statSync(filename).size > 128 * 1024)
    throw new Error('Account file exceeds the 128 KiB limit.');
  const profile = profileSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const detail = `Point: ${profile.address}\nProvider: ${profile.uplink.host}:${profile.uplink.port}\nTransport: ${profile.uplink.tls ? 'certificate-verified TLS' : 'BinkP with CRAM-MD5; message traffic is not encrypted'}\n\nOnly import account files from a provider you trust.`;
  let outcome = '';
  while (!quitting && win && !win.isDestroyed()) {
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Import account', 'Cancel', 'Test connection'],
      defaultId: 1,
      cancelId: 1,
      title: 'Import PacketLark account',
      message: `Set up ${profile.name} with ${profile.provider}?`,
      detail: outcome ? `${detail}\n\n${outcome}` : detail,
    });
    if (quitting || result.response === 1) break;
    if (result.response === 0) {
      await installAccount(profile);
      return true;
    }
    try {
      await sessions.test(profile);
      outcome = 'Connection successful. The provider accepted your login. No mail was exchanged.';
    } catch (error) {
      outcome = safeError(error);
    }
  }
  return false;
}
async function installAccount(value: unknown) {
  const profile = profileSchema.parse(value);
  await requireCredentialStore();
  if (quitting) return;
  const account = await accounts.add(profile);
  account.status = 'Account ready. Send & receive to check your messages.';
  emit();
}

function idle(account: AccountContext) {
  if (sessions.current === account)
    throw new Error('Wait for this account to finish send & receive.');
}

function readBackup(file: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
      throw new Error('Choose a regular SQLite backup file smaller than 512 MiB.');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) throw new Error('The backup changed while it was being read.');
      offset += n;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

async function restoreMailbox(id: unknown) {
  const target = accounts.scope(id);
  idle(target);
  const files = await dialog.showOpenDialog(win!, {
    title: 'Restore a mailbox backup',
    properties: ['openFile'],
    filters: [{ name: 'SQLite mailbox', extensions: ['sqlite'] }],
  });
  if (files.canceled || quitting) return false;
  accounts.scope(target.id);
  idle(target);
  const before = target.store.revision;
  const data = target.store.prepareRestore(readBackup(files.filePaths[0]));
  const confirm = await dialog.showMessageBox(win!, {
    type: 'warning',
    title: 'Restore mailbox',
    buttons: ['Restore backup', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Replace the mailbox for ${data.point}?`,
    detail: `This replaces this account’s messages, contacts and connection settings. A recovery copy of the current mailbox will be saved. Automatic checks will be paused.${data.queued ? ` The backup contains ${data.queued} queued item(s); review Outbox before sending or resuming checks.` : ''}`,
  });
  if (confirm.response !== 0 || quitting) return false;
  accounts.scope(target.id);
  idle(target);
  if (target.store.revision !== before)
    throw new Error(
      'This mailbox changed while the restore dialog was open. Start the restore again.',
    );
  const copy = path.join(accounts.root, 'recovery', `${target.id}-${randomUUID()}.sqlite`);
  atomicWrite(copy, target.store.backup());
  accounts.pause(target.id, true);
  target.store.replaceMailbox(data.bytes);
  target.status = 'Mailbox restored. Automatic checks are paused. Review Outbox before sending.';
  emit();
  return true;
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
    updateRevision();
    const account = accounts.active;
    const current = snapshot(account);
    return {
      ...current,
      revision,
      accountId: account.id,
      accounts: summaries,
      accountProblem: accounts.unavailable.size
        ? 'A saved mailbox could not be opened. Its files have been left in place.'
        : '',
      syncing: sessions.current === account,
      anySyncing: sessions.busy,
      status: account.status || current.status,
      reading: primaryStore().readingSettings(),
      notifications: primaryStore().notificationSettings(),
      storageWarning: credentialWarning(),
      notificationsSupported: notifications.supported(),
      desktop: { ...primaryStore().desktopSettings(), startAtLogin: startup.enabled() },
      checkOnStartup: primaryStore().checkOnStartup(),
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
  handle('sync', (id) => sessions.run(accounts.scope(id)));
  handle('syncAll', () => sessions.all([...accounts.contexts.values()]));
  handle('selectAccount', (id) => {
    accounts.select(accountIdSchema.parse(id));
    emit();
  });
  handle('pauseAccount', (id, paused) => {
    accounts.pause(accountIdSchema.parse(id), z.boolean().parse(paused));
    emit();
  });
  handle('allUnread', (order, offset) =>
    accounts.unread(
      z.enum(['newest', 'oldest']).parse(order),
      z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(offset),
    ),
  );
  handle('updateConnection', (value, id) => {
    const account = accounts.scope(id);
    idle(account);
    const settings = connectionSettingsSchema.parse(value);
    account.store.updateConnection(settings);
    account.nextCheck = Date.now() + settings.pollMinutes * 60000;
    account.failures = 0;
    account.status = 'Connection settings saved. Use Send & receive to check them.';
    emit();
  });
  handle('restoreMailbox', restoreMailbox);
  handle('cancelDiscussionRequests', async (id) => {
    const account = accounts.scope(id);
    idle(account);
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['Keep requests', 'Cancel queued requests'],
      defaultId: 0,
      cancelId: 0,
      message: 'Cancel this account’s queued discussion requests?',
      detail:
        'This removes local retries. If the BBS already received a request, it may still take effect. This does not cancel normal messages.',
    });
    if (!response || quitting) return 0;
    accounts.scope(account.id);
    idle(account);
    const count = account.store.cancelDiscussionRequests();
    emit();
    return count;
  });
  handle('setupAccount', installAccount);
  handle('testSetupConnection', (value) => sessions.test(profileSchema.parse(value)));
  handle('testSavedConnection', (value, id) => {
    const p = accounts.scope(id).store.profile();
    if (!p) throw new Error('Set up an account first.');
    const settings = connectionSettingsSchema.parse(value);
    return sessions.test({
      ...p,
      uplink: {
        ...p.uplink,
        host: settings.host,
        port: settings.port,
        tls: settings.tls,
        sessionPassword: settings.sessionPassword ?? p.uplink.sessionPassword,
      },
    });
  });
  handle('searchAllMail', (value) => accounts.searchMail(mailSearchSchema.parse(value)));
  handle('setDiscussionPreference', (tag, value, id) => {
    accounts
      .scope(id)
      .store.setDiscussionPreference(
        areaSchema.parse(tag),
        discussionPreferenceSchema.parse(value),
      );
    emit();
  });
  handle('reading', (value) => {
    primaryStore().setReading(readingSettingsSchema.parse(value));
    emit();
  });
  handle('desktop', (value) => setDesktop(desktopSettingsSchema.parse(value)));
  handle('setCheckOnStartup', (value) => {
    primaryStore().setCheckOnStartup(z.boolean().parse(value));
    emit();
  });
  handle('markConversationRead', (id, account) => {
    accounts.scope(account).store.markConversationRead(z.string().min(1).max(128).parse(id));
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
    primaryStore().setNotifications(notificationSettingsSchema.parse(value));
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
  handle('draft', (value, id) => {
    const saved = accounts.scope(id).store.saveDraft(draftSchema.parse(value));
    emit();
    return saved;
  });
  handle('queue', (value, id) => {
    const account = accounts.scope(id);
    idle(account);
    const queued = account.store.queue(composeSchema.parse(value));
    emit();
    return queued;
  });
  handle('mark', (id, patch, account) => {
    accounts
      .scope(account)
      .store.mark(
        z.string().min(1).max(128).parse(id),
        z
          .object({ read: z.boolean().optional(), starred: z.boolean().optional() })
          .strict()
          .parse(patch),
      );
    emit();
  });
  handle('removeDraft', (id, account) => {
    accounts.scope(account).store.removeDraft(z.string().uuid().parse(id));
    emit();
  });
  handle('contact', (name, addr, account) => {
    accounts.scope(account).store.contact(z.string().parse(name), z.string().parse(addr));
    emit();
  });
  for (const operation of ['trashMessage', 'restoreMessage', 'deleteMessage'] as const)
    handle(operation, (id, scope) => {
      const account = accounts.scope(scope);
      idle(account);
      account.store[operation](z.string().min(1).max(128).parse(id));
      emit();
    });
  handle('area', (tag, subscribe, id) => {
    const account = accounts.scope(id);
    idle(account);
    const add = z.boolean().parse(subscribe);
    account.store.areaCommand(z.string().parse(tag), add);
    account.status = `${add ? 'Join' : 'Leave'} request queued. Your provider will reply after processing it.`;
    emit();
  });
  handle('areaList', (id) => {
    const account = accounts.scope(id);
    idle(account);
    account.store.requestAreaList();
    account.status = 'Discussion list requested. Your provider will reply after processing it.';
    emit();
  });
  handle('backup', async (id) => {
    const account = accounts.scope(id);
    const point = snapshot(account).account?.address.replace(/[^A-Za-z0-9_-]/g, '-') || 'mailbox';
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: `packetlark-backup-${point}-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: 'SQLite mailbox', extensions: ['sqlite'] }],
    });
    if (result.canceled || !result.filePath || quitting) return;
    const target = fs.existsSync(result.filePath)
      ? fs.realpathSync(result.filePath)
      : path.join(fs.realpathSync(path.dirname(result.filePath)), path.basename(result.filePath));
    const relative = path.relative(fs.realpathSync(accounts.root), target);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
      throw new Error('Save backups outside the PacketLark application data directory.');
    atomicWrite(result.filePath, account.store.backup());
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
    if (accounts && primaryStore().desktopSettings().keepRunning && desktop?.available) win?.hide();
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
      primaryStore().desktopSettings().keepRunning &&
      desktop?.available &&
      !pendingImport &&
      pendingMessage === undefined
    )
      win?.hide();
    startHidden = false;
    if (pendingMessage !== undefined) {
      win?.webContents.send('notification:open', pendingMessage.id, pendingMessage.accountId);
      pendingMessage = undefined;
    }
    if (pendingImport) {
      const file = pendingImport;
      pendingImport = undefined;
      void importFile(file).catch(reportError);
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    const file = argv.find(isAccountFile);
    if (!accounts) {
      if (file) pendingImport = file;
      startHidden = false;
      return;
    }
    showWindow();
    if (file && win) void importFile(file).catch(reportError);
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
    if (sessions.current && !aborting) {
      event.preventDefault();
      quitting = true;
      aborting = true;
      sessions.stop();
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
    sessions.stop();
    accounts?.close();
  });
  void app
    .whenReady()
    .then(async () => {
      if (await useSecretServiceFallback()) return;
      if (quitting) return;
      const wasm = app.isPackaged
        ? path.join(process.resourcesPath, 'sql-wasm.wasm')
        : path.join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm');
      const opened = await openAccounts(wasm);
      if (!opened) return;
      if (quitting) {
        opened.close();
        return;
      }
      accounts = opened;
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
              const work =
                summaries.length <= 1
                  ? sessions.run(accounts.active)
                  : sessions.all([...accounts.contexts.values()]);
              void work.catch(reportError);
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
            const target = accountNotificationTarget(details.arguments);
            if (target) {
              openNotification(target.id, target.accountId);
              return;
            }
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
      timer = setInterval(() => {
        if (!quitting) sessions.tick(accounts.contexts.values());
      }, 1000);
      // Open links only through a tightly scoped IPC endpoint, never via message HTML.
      ipcMain.handle('external', async (event, value: unknown) => {
        if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame)
          return;
        if (typeof value === 'string' && value.length < 2048 && /^https?:\/\//i.test(value))
          await shell.openExternal(value);
      });
      // A new app process checks installed accounts once. A tray reopen, refresh
      // or later import must not start another launch exchange.
      void sessions.onStartup(
        primaryStore().checkOnStartup(),
        accounts.active,
        accounts.contexts.values(),
      );
    })
    .catch((error) => {
      dialog.showErrorBox(
        'PacketLark could not open your mailbox',
        `${safeError(error)}\nYour mailbox has not been reset. Back it up before troubleshooting.`,
      );
      finishQuit();
    });
}
