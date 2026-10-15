import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import {
  addressSchema,
  composeSchema,
  draftSchema,
  profileSchema,
  type Compose,
  type Message,
  type Profile,
  type State,
} from './model.js';
import { buildPacket, draftMessage } from './packet.js';
import type { MailFile } from './binkp.js';

export function atomicWrite(destination: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const tmp = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, destination);
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(destination), 'r');
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export class Store {
  private constructor(
    private db: Database,
    private sql: SqlJsStatic,
    readonly file: string,
    private seal: (text: string) => string,
    private unseal: (text: string) => string,
  ) {}
  static async open(
    file: string,
    wasmPath: string,
    seal: (s: string) => string,
    unseal: (s: string) => string,
  ): Promise<Store> {
    const sql = await initSqlJs({ locateFile: () => wasmPath });
    const db = new sql.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outgoing (name TEXT PRIMARY KEY, message_id TEXT NOT NULL, time INTEGER NOT NULL, bytes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (address TEXT PRIMARY KEY, name TEXT NOT NULL);`);
    const version = db.exec('PRAGMA user_version')[0]?.values[0]?.[0];
    if (version !== 0 && version !== 1)
      throw new Error('Mailbox was created by a newer version of PacketLark.');
    db.exec('PRAGMA user_version=1');
    const store = new Store(db, sql, file, seal, unseal);
    if (!fs.existsSync(file)) atomicWrite(file, db.export());
    return store;
  }
  private rows(sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const result: Record<string, unknown>[] = [];
      while (stmt.step()) result.push(stmt.getAsObject());
      return result;
    } finally {
      stmt.free();
    }
  }
  private meta(key: string): string | null {
    return (this.rows('SELECT value FROM meta WHERE key=?', [key])[0]?.value as string) || null;
  }
  private setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO meta VALUES (?,?)', [key, value]);
  }
  private mutate(fn: () => void): void {
    const previous = this.db.export();
    try {
      this.db.exec('BEGIN');
      fn();
      this.db.exec('COMMIT');
      atomicWrite(this.file, this.db.export());
    } catch (error) {
      this.db.close();
      this.db = new this.sql.Database(previous);
      throw error;
    }
  }
  profile(): Profile | null {
    const value = this.meta('profile');
    return value ? profileSchema.parse(JSON.parse(this.unseal(value))) : null;
  }
  install(value: unknown): void {
    const profile = profileSchema.parse(value);
    if (this.meta('profile'))
      throw new Error('An account is already installed. Version 1 uses one account per mailbox.');
    const sealed = this.seal(JSON.stringify(profile));
    this.mutate(() => {
      this.setMeta('profile', sealed);
      this.setMeta('areas', JSON.stringify(profile.areas));
    });
  }
  messages(): Message[] {
    return this.rows('SELECT data FROM messages').map(
      (r) => JSON.parse(r.data as string) as Message,
    );
  }
  private put(message: Message): void {
    this.db.run('INSERT OR REPLACE INTO messages VALUES (?,?)', [
      message.id,
      JSON.stringify(message),
    ]);
  }
  state(): State {
    const p = this.profile();
    return {
      account: p
        ? {
            name: p.name,
            address: p.address,
            provider: p.provider,
            host: p.uplink.host,
            port: p.uplink.port,
            tls: p.uplink.tls,
            pollMinutes: p.pollMinutes,
            charset: p.charset,
          }
        : null,
      messages: this.messages(),
      areas: JSON.parse(this.meta('areas') || '[]') as State['areas'],
      contacts: this.rows('SELECT name,address FROM contacts ORDER BY name') as State['contacts'],
      syncing: false,
      status: p ? 'Ready to send & receive.' : 'Import your account file to get started.',
      lastSync: this.meta('lastSync'),
      storageWarning: false,
    };
  }
  saveDraft(value: Compose): string {
    const p = this.profile();
    if (!p) throw new Error('Import an account first.');
    const c = draftSchema.parse(value);
    const old = c.id ? this.messages().find((m) => m.id === c.id) : undefined;
    if (c.id && (!old || old.folder !== 'drafts')) throw new Error('This draft no longer exists.');
    const message = draftMessage(p, c, c.id);
    if (old) message.msgid = old.msgid;
    this.mutate(() => this.put(message));
    return message.id;
  }
  queue(value: Compose): string {
    const p = this.profile();
    if (!p) throw new Error('Import an account first.');
    const c = composeSchema.parse(value);
    const old = c.id ? this.messages().find((m) => m.id === c.id) : undefined;
    if (c.id && (!old || old.folder !== 'drafts'))
      throw new Error('This draft was already queued or removed.');
    const message = draftMessage(p, c, c.id);
    if (old) message.msgid = old.msgid;
    const bytes = buildPacket(p, c, message.msgid);
    message.folder = 'outbox';
    message.packetName = `${randomBytes(4).toString('hex')}.pkt`;
    this.mutate(() => {
      this.put(message);
      this.db.run('INSERT INTO outgoing VALUES (?,?,?,?)', [
        message.packetName,
        message.id,
        Math.floor(Date.now() / 1000),
        bytes.toString('base64'),
      ]);
    });
    return message.id;
  }
  pending(): MailFile[] {
    return this.rows('SELECT name,time,bytes FROM outgoing ORDER BY time,name').map((r) => ({
      name: r.name as string,
      time: r.time as number,
      bytes: Buffer.from(r.bytes as string, 'base64'),
    }));
  }
  sent(name: string): void {
    const row = this.rows('SELECT message_id FROM outgoing WHERE name=?', [name])[0];
    if (!row) throw new Error('Outgoing message is no longer queued.');
    const message = this.messages().find((m) => m.id === row.message_id);
    if (!message) throw new Error('Outgoing message record is missing.');
    message.folder = 'sent';
    message.error = '';
    this.mutate(() => {
      this.put(message);
      this.db.run('DELETE FROM outgoing WHERE name=?', [name]);
    });
  }
  receive(messages: Message[]): number {
    const known = this.messages(),
      ids = new Set(known.map((m) => m.id)),
      keys = new Set(known.filter((m) => m.msgid).map((m) => `${m.area}\0${m.msgid}`));
    let count = 0;
    this.mutate(() => {
      for (const m of messages) {
        const key = `${m.area}\0${m.msgid}`;
        if (ids.has(m.id) || (m.msgid && keys.has(key))) continue;
        this.put(m);
        ids.add(m.id);
        if (m.msgid) keys.add(key);
        count++;
        if (m.area) {
          const areas = JSON.parse(this.meta('areas') || '[]') as State['areas'];
          if (!areas.some((a) => a.tag === m.area)) {
            areas.push({ tag: m.area, name: m.area });
            this.setMeta('areas', JSON.stringify(areas));
          }
        }
      }
    });
    return count;
  }
  mark(id: string, patch: { read?: boolean; starred?: boolean }): void {
    const m = this.messages().find((m) => m.id === id);
    if (!m) throw new Error('Message not found.');
    this.mutate(() => this.put({ ...m, ...patch }));
  }
  removeDraft(id: string): void {
    if (this.messages().find((m) => m.id === id)?.folder !== 'drafts')
      throw new Error('Only drafts can be removed in version 1.');
    this.mutate(() => this.db.run('DELETE FROM messages WHERE id=?', [id]));
  }
  contact(name: string, address: string): void {
    if (!name.trim() || name.length > 35 || /[\x00-\x1f]/.test(name))
      throw new Error('Enter a contact name of up to 35 characters.');
    addressSchema.parse(address);
    this.mutate(() =>
      this.db.run('INSERT OR REPLACE INTO contacts VALUES (?,?)', [address, name.trim()]),
    );
  }
  syncResult(error = ''): void {
    this.mutate(() => {
      if (!error) this.setMeta('lastSync', new Date().toISOString());
      for (const m of this.messages().filter((m) => m.folder === 'outbox'))
        this.put({ ...m, error });
    });
  }
  backup(): Buffer {
    return Buffer.from(this.db.export());
  }
  close(): void {
    this.db.close();
  }
}
