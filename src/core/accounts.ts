import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  sameAddress,
  profileSchema,
  type Profile,
  type State,
  type AccountSummary,
  type UnreadItem,
} from './model.js';
import { Store, atomicWrite } from './store.js';

export const primaryAccount = 'primary';
export const accountIdSchema = z.union([z.literal(primaryAccount), z.string().uuid()]);
const entry = z.object({ id: accountIdSchema, paused: z.boolean() }).strict();
const registrySchema = z
  .object({
    version: z.literal(1),
    active: accountIdSchema,
    entries: z.array(entry).min(1).max(32),
  })
  .strict()
  .refine(
    (r) =>
      r.entries[0].id === primaryAccount &&
      new Set(r.entries.map((e) => e.id)).size === r.entries.length &&
      r.entries.some((e) => e.id === r.active),
    'Invalid account registry.',
  );
type Registry = z.infer<typeof registrySchema>;

export type AccountContext = {
  id: string;
  store: Store;
  paused: boolean;
  snapshot?: State;
  unread?: number;
  status: string;
  lastAttempt: number;
  nextCheck: number;
  failures: number;
};

export function snapshot(account: AccountContext): State {
  if (account.snapshot?.revision !== account.store.revision) {
    const state = account.store.state();
    account.snapshot = state;
    const areas = new Set(state.areas.map((a) => a.tag));
    account.unread = state.messages.reduce(
      (n, m) =>
        n +
        Number(m.folder === 'inbox' && !m.read && !m.internal && (!m.area || areas.has(m.area))),
      0,
    );
  }
  return account.snapshot!;
}

export class Accounts {
  private constructor(
    readonly root: string,
    private registry: Registry,
    readonly contexts: Map<string, AccountContext>,
    readonly unavailable: ReadonlySet<string>,
    private openStore: (file: string) => Promise<Store>,
  ) {}
  private adding = false;
  generation = 0;

  static async open(root: string, openStore: (file: string) => Promise<Store>, now = Date.now()) {
    const file = path.join(root, 'accounts.json');
    const registry = fs.existsSync(file)
      ? registrySchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
      : {
          version: 1 as const,
          active: primaryAccount,
          entries: [{ id: primaryAccount, paused: false }],
        };
    const contexts = new Map<string, AccountContext>();
    const unavailable = new Set<string>();
    for (const { id, paused } of registry.entries) {
      const mailbox = Accounts.mailboxPath(root, id);
      let store: Store | undefined;
      try {
        if ((id !== primaryAccount || fs.existsSync(file)) && !fs.existsSync(mailbox))
          throw new Error('An account mailbox is missing.');
        store = await openStore(mailbox);
        const context = {
          id,
          store,
          paused,
          status: '',
          lastAttempt: 0,
          nextCheck: 0,
          failures: 0,
        };
        const state = snapshot(context);
        if (id !== primaryAccount && !state.account)
          throw new Error('An account profile is missing.');
        context.nextCheck = now + (state.account?.pollMinutes || 10) * 60000;
        contexts.set(id, context);
      } catch (error) {
        store?.close();
        if (id === primaryAccount) {
          for (const context of contexts.values()) context.store.close();
          throw error;
        }
        unavailable.add(id);
      }
    }
    return new Accounts(root, registry, contexts, unavailable, openStore);
  }

  private static mailboxPath(root: string, id: string) {
    return id === primaryAccount
      ? path.join(root, 'mailbox.sqlite')
      : path.join(root, 'accounts', id, 'mailbox.sqlite');
  }
  get primary() {
    return this.contexts.get(primaryAccount)!;
  }
  get active() {
    return this.contexts.get(this.registry.active) || this.primary;
  }
  require(id: string) {
    const account = this.contexts.get(id);
    if (!account) throw new Error('That account is unavailable.');
    return account;
  }
  scope(id: unknown) {
    // Old callers without an account scope are only safe in the original single-mailbox view.
    const expected =
      id === undefined && this.registry.entries.length === 1
        ? primaryAccount
        : accountIdSchema.parse(id);
    if (expected !== this.active.id)
      throw new Error('The visible account changed. Reopen this action from the correct account.');
    return this.require(expected);
  }
  private save(value: Registry) {
    atomicWrite(
      path.join(this.root, 'accounts.json'),
      Buffer.from(JSON.stringify(registrySchema.parse(value))),
    );
    this.registry = value;
    this.generation++;
  }
  select(id: string) {
    this.require(id);
    if (this.registry.active !== id) this.save({ ...this.registry, active: id });
  }
  pause(id: string, paused: boolean, now = Date.now()) {
    const account = this.require(id);
    if (!snapshot(account).account) throw new Error('Set up this account first.');
    if (account.paused === paused) return;
    this.save({
      ...this.registry,
      entries: this.registry.entries.map((e) => (e.id === id ? { ...e, paused } : e)),
    });
    account.paused = paused;
    account.nextCheck = now + snapshot(account).account!.pollMinutes * 60000;
  }

  async add(value: unknown, now = Date.now()): Promise<AccountContext> {
    if (this.adding) throw new Error('Another account is being added.');
    this.adding = true;
    try {
      const profile = profileSchema.parse(value);
      if (this.unavailable.size)
        throw new Error(
          'An account could not be opened. Restore access to it before adding more accounts.',
        );
      if (this.duplicate(profile)) throw new Error('This point account is already installed.');
      if (!snapshot(this.primary).account) {
        this.primary.store.install(profile);
        this.primary.nextCheck = now + profile.pollMinutes * 60000;
        return this.primary;
      }
      if (this.registry.entries.length >= 32)
        throw new Error('This installation already has 32 accounts.');
      const id = randomUUID();
      const file = Accounts.mailboxPath(this.root, id);
      let store: Store | undefined;
      try {
        store = await this.openStore(file);
        store.install(profile);
        const account = {
          id,
          store,
          paused: false,
          status: '',
          lastAttempt: 0,
          nextCheck: now + profile.pollMinutes * 60000,
          failures: 0,
        };
        snapshot(account);
        // Install the mailbox first. A crash before the registry write leaves only an unlisted file.
        this.save({ ...this.registry, entries: [...this.registry.entries, { id, paused: false }] });
        this.contexts.set(id, account);
        return account;
      } catch (error) {
        store?.close();
        // An I/O failure after rename may have persisted the registry. Never delete its mailbox.
        throw error;
      }
    } finally {
      this.adding = false;
    }
  }
  private duplicate(profile: Profile) {
    return [...this.contexts.values()].some((a) => {
      const p = snapshot(a).account;
      return !!p && sameAddress(profile.address, p.address);
    });
  }

  summaries(): AccountSummary[] {
    return [...this.contexts.values()].flatMap((a) => {
      const account = snapshot(a).account;
      return account ? [{ id: a.id, account, unread: a.unread || 0, paused: a.paused }] : [];
    });
  }
  unread(order: 'newest' | 'oldest', offset: number): { items: UnreadItem[]; total: number } {
    const messages = [...this.contexts.values()].flatMap((a) => {
      const s = snapshot(a);
      if (!s.account || !a.unread) return [];
      const areas = new Map(s.areas.map(({ tag, name }) => [tag, name]));
      return s.messages
        .filter(
          (m) => m.folder === 'inbox' && !m.read && !m.internal && (!m.area || areas.has(m.area)),
        )
        .map((m) => ({
          accountId: a.id,
          provider: s.account!.provider,
          messageId: m.id,
          from: m.from,
          subject: m.subject,
          area: areas.get(m.area) || '',
          date: m.date,
        }));
    });
    const sortable = messages.map((m) => ({ m, stamp: Date.parse(m.date) }));
    sortable.sort(
      (a, b) =>
        Number(!Number.isFinite(a.stamp)) - Number(!Number.isFinite(b.stamp)) ||
        (order === 'newest' ? b.stamp - a.stamp : a.stamp - b.stamp) ||
        a.m.accountId.localeCompare(b.m.accountId) ||
        a.m.messageId.localeCompare(b.m.messageId),
    );
    return { items: sortable.slice(offset, offset + 200).map((r) => r.m), total: messages.length };
  }
  close() {
    for (const a of this.contexts.values()) a.store.close();
  }
}
