import type { NotificationSettings, State } from './model.js';

export const defaultNotifications: NotificationSettings = {
  enabled: true,
  discussions: true,
  previews: true,
};
export type MailNotice = { title: string; body: string; messageId: string };

function line(value: string, limit: number): string {
  const text = value
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, limit).join('');
}

/** Only IDs returned by a successful durable receive may create new-mail alerts. */
export function newMailNotice(ids: ReadonlySet<string>, state: State): MailNotice | null {
  const settings = state.notifications || defaultNotifications;
  if (!settings.enabled) return null;
  const areas = new Set(state.areas.map((area) => area.tag));
  const messages = state.messages.filter(
    (m) =>
      ids.has(m.id) &&
      m.folder === 'inbox' &&
      !m.read &&
      !m.internal &&
      (!m.area || (settings.discussions && areas.has(m.area))),
  );
  if (!messages.length) return null;
  const newest = messages.reduce((a, b) =>
    (Date.parse(b.date) || 0) > (Date.parse(a.date) || 0) ? b : a,
  );
  const title = `PacketLark — ${messages.length === 1 ? 'New message' : `${messages.length} new messages`}`;
  const direct = messages.filter((m) => !m.area).length;
  const counts = [
    direct ? `${direct} direct message${direct === 1 ? '' : 's'}` : '',
    messages.length - direct
      ? `${messages.length - direct} discussion post${messages.length - direct === 1 ? '' : 's'}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    body: settings.previews
      ? `${messages.length > 1 ? `${counts}\nLatest: ` : ''}${line(newest.from, 80) || 'Someone'}${newest.area ? ` · ${line(newest.area, 60)}` : ''}\n${line(newest.subject, 160) || '(No subject)'}`
      : counts,
    messageId: newest.id,
  };
}

export function notificationTarget(arguments_: string): string | null {
  return /^packetlark-message:([A-Za-z0-9_-]{1,128})$/.exec(arguments_)?.[1] || null;
}

export function notificationMarkup(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );
}

export function windowsToast(notice: MailNotice): string {
  const launch = notice.messageId ? `packetlark-message:${notice.messageId}` : 'packetlark-test';
  return `<toast launch="${notificationMarkup(launch)}"><visual><binding template="ToastGeneric"><text>${notificationMarkup(notice.title)}</text><text>${notificationMarkup(notice.body)}</text></binding></visual></toast>`;
}
