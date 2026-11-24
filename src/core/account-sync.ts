import { exchange, testConnection } from './binkp.js';
import { unpackMail } from './packet.js';
import { type AccountContext, snapshot } from './accounts.js';
import type { Profile } from './model.js';

export function connectionError(error: unknown, profile?: Profile | null): string {
  let message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    message = 'Could not find the BinkP server. Check the hostname and DNS.';
  else if (code === 'ECONNREFUSED')
    message =
      'The BinkP server refused the connection. Check the port and whether the mailer is running.';
  else if (code === 'ETIMEDOUT')
    message = 'The connection timed out. Check the network and server address.';
  else if (code && /CERT|TLS|SSL|SELF_SIGNED/.test(code))
    message = 'TLS verification failed. Check the server name, certificate and TLS port.';
  const secrets = profile
    ? [
        profile.uplink.sessionPassword,
        profile.uplink.packetPassword,
        profile.uplink.areaFixPassword,
      ]
    : [];
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    message = message.split(secret).join('[redacted]');
  return message.slice(0, 400);
}

export class AccountSync {
  current?: AccountContext;
  private batch = false;
  private controller?: AbortController;
  private probe?: AbortController;
  private stopped = false;
  private startupHandled = false;
  constructor(
    private hooks: {
      emit: () => void;
      received: (account: AccountContext, ids: ReadonlySet<string>) => void;
      exchange?: typeof exchange;
      now?: () => number;
    },
  ) {}
  get busy() {
    return !!this.current || this.batch || !!this.probe;
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
    this.probe?.abort();
  }
  async test(profile: Profile): Promise<void> {
    if (this.busy || this.stopped)
      throw new Error('Wait for the current connection to finish, then try again.');
    this.probe = new AbortController();
    this.hooks.emit();
    try {
      await testConnection(profile, this.probe.signal);
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_SSL_WRONG_VERSION_NUMBER')
        throw new Error('Could not establish a session. Check the BinkP port and TLS setting.', {
          cause: error,
        });
      if (error instanceof Error && error.message === 'Provider connection timed out.')
        throw new Error('The server did not respond. Check the hostname, port, TLS and network.', {
          cause: error,
        });
      throw new Error(connectionError(error, profile), { cause: error });
    } finally {
      this.probe = undefined;
      this.hooks.emit();
    }
  }
  tick(accounts: Iterable<AccountContext>) {
    if (this.busy || this.stopped) return;
    const now = this.hooks.now?.() ?? Date.now();
    const next = [...accounts]
      .filter((a) => !a.paused && a.nextCheck <= now && !!snapshot(a).account)
      .sort((a, b) => a.nextCheck - b.nextCheck)[0];
    if (next) void this.run(next).catch(() => {});
  }
  async onStartup(enabled: boolean, active: AccountContext, accounts: Iterable<AccountContext>) {
    if (this.startupHandled || this.stopped) return;
    this.startupHandled = true;
    if (!enabled) return;
    const order = [active, ...[...accounts].filter((account) => account !== active)];
    if (!order.some((account) => !account.paused && snapshot(account).account)) return;
    try {
      await this.all(order);
    } catch {
      // The exchange records details on its own account. A background check
      // must not report another account's failure on the visible mailbox.
    }
  }
  async all(accounts: AccountContext[]) {
    if (this.busy || this.stopped) return;
    this.batch = true;
    this.hooks.emit();
    let failures = 0;
    try {
      for (const account of accounts) {
        if (this.stopped) break;
        if (account.paused || !snapshot(account).account) continue;
        try {
          await this.run(account, true);
        } catch {
          failures++;
        }
      }
    } finally {
      this.batch = false;
      this.hooks.emit();
    }
    if (failures)
      throw new Error(
        `${failures} account${failures === 1 ? '' : 's'} could not check mail. Open Account for the connection status.`,
      );
  }

  async run(account: AccountContext, inBatch = false) {
    if (this.current || this.probe || (this.batch && !inBatch) || this.stopped) return;
    const now = this.hooks.now || Date.now;
    if (account.lastAttempt && now() - account.lastAttempt < 5000)
      throw new Error('Please wait a few seconds before connecting again.');
    // The store and profile belong to this exchange even if the user switches views.
    const store = account.store;
    let p: Profile | null;
    try {
      p = store.profile();
    } catch (error) {
      account.status = connectionError(error);
      account.nextCheck = now() + (account.snapshot?.account?.pollMinutes || 10) * 60000;
      this.hooks.emit();
      throw error;
    }
    if (!p) throw new Error('Import an account first.');
    this.current = account;
    this.controller = new AbortController();
    account.lastAttempt = now();
    account.status = 'Connecting…';
    this.hooks.emit();
    let received = 0;
    const ids = new Set<string>();
    try {
      await (this.hooks.exchange ?? exchange)(
        p,
        store.pending(),
        {
          status: (text) => {
            account.status = text;
            this.hooks.emit();
          },
          receive: async (file) => {
            const saved = store.receiveNew(unpackMail(file.bytes, p));
            received += saved.length;
            for (const message of saved) ids.add(message.id);
            this.hooks.emit();
          },
          sent: async (name) => {
            store.sent(name);
            this.hooks.emit();
          },
        },
        this.controller.signal,
      );
      store.syncResult();
      account.failures = 0;
      account.status = `Up to date. ${received} new message${received === 1 ? '' : 's'}.`;
    } catch (error) {
      account.status = connectionError(error, p);
      account.failures++;
      store.syncResult(account.status);
      throw new Error(account.status, { cause: error });
    } finally {
      account.nextCheck =
        now() +
        Math.max(
          p.pollMinutes * 60000,
          account.failures ? Math.min(3600000, 30000 * 2 ** Math.min(account.failures, 7)) : 0,
        );
      this.current = undefined;
      this.controller = undefined;
      this.hooks.emit();
      this.hooks.received(account, ids);
    }
  }
}
