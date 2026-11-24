import { z } from 'zod';

export const addressPattern =
  /^(\d{1,5}):(\d{1,5})\/(\d{1,5})(?:\.(\d{1,5}))?(?:@([a-z0-9.-]{1,40}))?$/i;
export function address(value: string) {
  const match = addressPattern.exec(value.trim());
  if (!match || match.slice(1, 5).some((v) => v && Number(v) > 65535) || !Number(match[1]))
    throw new Error('Use a FidoNet address such as 1:123/456.7@fidonet.');
  return {
    zone: +match[1],
    net: +match[2],
    node: +match[3],
    point: +(match[4] || 0),
    domain: (match[5] || 'fidonet').toLowerCase(),
  };
}
export function formatAddress(a: ReturnType<typeof address>, domain = false): string {
  return `${a.zone}:${a.net}/${a.node}${a.point ? `.${a.point}` : ''}${domain ? `@${a.domain}` : ''}`;
}
export function sameAddress(a: string, b: string): boolean {
  return formatAddress(address(a), true) === formatAddress(address(b), true);
}
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v), 'Control characters are not allowed.');
export const addressSchema = z
  .string()
  .max(80)
  .refine((v) => {
    try {
      address(v);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid FidoNet address.');
export const areaSchema = z.string().regex(/^[A-Z0-9_!.-]{1,60}$/);
const secret = z
  .string()
  .max(128)
  .regex(/^[\x21-\x7e]*$/);
export const profileSchema = z
  .object({
    format: z.enum(['packetlark-account', 'retropost-account']),
    version: z.literal(1),
    provider: line(80),
    name: line(35),
    address: addressSchema,
    uplink: z
      .object({
        address: addressSchema,
        host: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-zA-Z0-9.:_-]+$/),
        port: z.number().int().min(1).max(65535).default(24554),
        tls: z.boolean().default(false),
        sessionPassword: secret.min(1),
        packetPassword: z
          .string()
          .max(8)
          .regex(/^[\x21-\x7e]*$/)
          .default(''),
        areaFixPassword: secret.default(''),
      })
      .strict(),
    areas: z
      .array(z.object({ tag: areaSchema, name: line(100) }).strict())
      .max(500)
      .default([]),
    pollMinutes: z.number().int().min(1).max(1440).default(10),
    charset: z.enum(['UTF-8', 'CP437', 'CP850', 'CP866', 'WINDOWS-1252']).default('UTF-8'),
  })
  .strict()
  .superRefine((p, ctx) => {
    const a = address(p.address),
      b = address(p.uplink.address);
    if (
      !a.point ||
      b.point ||
      a.zone !== b.zone ||
      a.net !== b.net ||
      a.node !== b.node ||
      a.domain !== b.domain
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Version 1 requires a point address and its matching boss node.',
      });
    if (new Set(p.areas.map((a) => a.tag)).size !== p.areas.length)
      ctx.addIssue({ code: 'custom', message: 'Discussion tags must be unique.' });
  });
export type Profile = z.infer<typeof profileSchema>;
export const connectionSettingsSchema = z
  .object({
    host: profileSchema.shape.uplink.shape.host,
    port: profileSchema.shape.uplink.shape.port,
    tls: profileSchema.shape.uplink.shape.tls,
    pollMinutes: profileSchema.shape.pollMinutes,
    charset: profileSchema.shape.charset,
    sessionPassword: profileSchema.shape.uplink.shape.sessionPassword.optional(),
    packetPassword: profileSchema.shape.uplink.shape.packetPassword.removeDefault().optional(),
    areaFixPassword: profileSchema.shape.uplink.shape.areaFixPassword.removeDefault().optional(),
  })
  .strict();
export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;

export const composeSchema = z
  .object({
    id: z.string().uuid().optional(),
    to: line(35),
    toAddress: addressSchema,
    subject: line(71),
    body: z
      .string()
      .min(1)
      .max(60000)
      .refine((s) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s)),
    area: z.union([areaSchema, z.literal('')]).default(''),
    replyId: z
      .string()
      .max(160)
      .regex(/^[^\x00-\x1f]*$/)
      .default(''),
  })
  .strict();
export type Compose = z.infer<typeof composeSchema>;
export const draftSchema = composeSchema.extend({
  to: z
    .string()
    .max(35)
    .refine((s) => !/[\x00-\x1f]/.test(s)),
  toAddress: z.union([addressSchema, z.literal('')]),
  subject: z
    .string()
    .max(71)
    .refine((s) => !/[\x00-\x1f]/.test(s)),
  body: z
    .string()
    .max(60000)
    .refine((s) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s)),
});
export type Message = {
  id: string;
  msgid: string;
  replyId: string;
  from: string;
  fromAddress: string;
  to: string;
  toAddress: string;
  subject: string;
  body: string;
  raw: string;
  area: string;
  date: string;
  folder: 'inbox' | 'sent' | 'outbox' | 'drafts' | 'trash';
  trash?: { folder: 'inbox' | 'sent' | 'outbox' | 'drafts'; deletedAt: string };
  internal?: boolean;
  read: boolean;
  starred: boolean;
  error: string;
  packetName: string;
};
export type PublicAccount = {
  name: string;
  address: string;
  provider: string;
  host: string;
  port: number;
  tls: boolean;
  pollMinutes: number;
  charset: string;
};
export type Discussion = {
  tag: string;
  name: string;
  subscription: 'unknown' | 'joined' | 'left';
  confirmedAt: string | null;
  pending: { action: 'join' | 'leave'; messageId: string } | null;
  error: string;
};
export type DiscussionDirectory = {
  queued?: string[];
  entries: Discussion[];
  requestId: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  error: string;
};
export const notificationSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    discussions: z.boolean().default(true),
    previews: z.boolean().default(true),
  })
  .strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const readingSettingsSchema = z
  .object({
    fontSize: z
      .union([
        z.literal(12),
        z.literal(14),
        z.literal(16),
        z.literal(18),
        z.literal(20),
        z.literal(24),
      ])
      .default(14),
    font: z.enum(['system', 'monospace']).default('system'),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
    collapseRead: z.boolean().default(false),
    collapseQuotes: z.boolean().default(false),
    collapseSignatures: z.boolean().default(false),
  })
  .strict();
export type ReadingSettings = z.infer<typeof readingSettingsSchema>;
export const desktopSettingsSchema = z
  .object({
    keepRunning: z.boolean().default(false),
    startAtLogin: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => !v.startAtLogin || v.keepRunning,
    'Enable background operation before starting at sign-in.',
  );
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>;
export type AccountSummary = {
  id: string;
  account: PublicAccount;
  unread: number;
  paused: boolean;
};
export type UnreadItem = {
  accountId: string;
  provider: string;
  messageId: string;
  from: string;
  subject: string;
  area: string;
  date: string;
};
export const discussionPreferenceSchema = z
  .object({
    pinned: z.boolean(),
    muted: z.boolean(),
  })
  .strict();
export type DiscussionPreference = z.infer<typeof discussionPreferenceSchema>;
export const mailSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(160),
    order: z.enum(['newest', 'oldest']),
    offset: z.number().int().nonnegative().safe(),
  })
  .strict();
export type MailSearch = z.infer<typeof mailSearchSchema>;
export type MailHit = UnreadItem & {
  accountAddress: string;
  folder: Message['folder'];
  to: string;
  preview: string;
};
export type MailSearchResult = { items: MailHit[]; total: number };
export type State = {
  accountId?: string;
  accounts?: AccountSummary[];
  accountProblem?: string;
  lastError?: string;
  anySyncing?: boolean;
  revision?: number;
  account: PublicAccount | null;
  messages: Message[];
  areas: { tag: string; name: string }[];
  discussions: DiscussionDirectory;
  discussionPreferences?: { tag: string; pinned: boolean; muted: boolean }[];
  contacts: { name: string; address: string }[];
  syncing: boolean;
  status: string;
  lastSync: string | null;
  storageWarning: boolean;
  notifications?: NotificationSettings;
  notificationsSupported?: boolean;
  reading?: ReadingSettings;
  desktop?: DesktopSettings;
  checkOnStartup?: boolean;
  traySupported?: boolean;
  startupSupported?: boolean;
};
export type RuntimeUpdate = {
  revision: number;
  syncing: boolean;
  status: string;
  anySyncing?: boolean;
};
export type Api = {
  state(): Promise<State>;
  importAccount(): Promise<boolean>;
  setupAccount(value: Profile): Promise<void>;
  testSetupConnection(value: Profile): Promise<void>;
  testSavedConnection(value: ConnectionSettings, accountId?: string): Promise<void>;
  sync(accountId?: string): Promise<void>;
  syncAll(): Promise<void>;
  selectAccount(accountId: string): Promise<void>;
  pauseAccount(accountId: string, paused: boolean): Promise<void>;
  updateConnection(value: ConnectionSettings, accountId?: string): Promise<void>;
  restoreMailbox(accountId?: string): Promise<boolean>;
  cancelDiscussionRequests(accountId?: string): Promise<number>;
  allUnread(
    order: 'newest' | 'oldest',
    offset: number,
  ): Promise<{ items: UnreadItem[]; total: number }>;
  searchAllMail(value: MailSearch): Promise<MailSearchResult>;
  setDiscussionPreference(
    tag: string,
    value: DiscussionPreference,
    accountId?: string,
  ): Promise<void>;
  saveDraft(value: Compose, accountId?: string): Promise<string>;
  queue(value: Compose, accountId?: string): Promise<string>;
  mark(id: string, patch: { read?: boolean; starred?: boolean }, accountId?: string): Promise<void>;
  removeDraft(id: string, accountId?: string): Promise<void>;
  trashMessage(id: string, accountId?: string): Promise<void>;
  restoreMessage(id: string, accountId?: string): Promise<void>;
  deleteMessage(id: string, accountId?: string): Promise<void>;
  contact(name: string, address: string, accountId?: string): Promise<void>;
  areaCommand(tag: string, subscribe: boolean, accountId?: string): Promise<void>;
  requestAreaList(accountId?: string): Promise<void>;
  backup(accountId?: string): Promise<void>;
  setNotifications(value: NotificationSettings): Promise<void>;
  testNotification(): Promise<void>;
  setReading(value: ReadingSettings): Promise<void>;
  setDesktop(value: DesktopSettings): Promise<void>;
  setCheckOnStartup(enabled: boolean): Promise<void>;
  markConversationRead(messageId: string, accountId?: string): Promise<void>;
  onPrepareQuit(cb: () => Promise<boolean>): () => void;
  onNotification(cb: (messageId: string, accountId?: string) => void): () => void;
  onChanged(cb: (update?: RuntimeUpdate) => void): () => void;
};
