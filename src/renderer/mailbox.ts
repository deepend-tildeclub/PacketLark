import type { Message } from '../core/model.js';

export type MessageSort = 'newest' | 'oldest';
export type MessageView = 'conversations' | 'messages';

export function messageView(value: string | null): MessageView {
  return value === 'messages' ? 'messages' : 'conversations';
}

export type Conversation = { key: string; messages: Message[] };

/** Index explicit reply links once per snapshot, including branches and missing parents. */
export function indexConversations(messages: readonly Message[]): Map<string, Conversation> {
  const eligible = messages.filter(
    (m) => !m.internal && (m.folder === 'inbox' || m.folder === 'sent'),
  );
  const reference = (m: Message, id: string) => JSON.stringify([m.area, id]);
  const byReference = new Map<string, Message | null>();
  for (const m of eligible) {
    if (!m.msgid) continue;
    const key = reference(m, m.msgid);
    // A broken sender can reuse MSGIDs. An ambiguous parent must not join unrelated mail.
    byReference.set(key, byReference.has(key) ? null : m);
  }
  const parents = new Map<string, string>();
  const node = (m: Message) => JSON.stringify(['message', m.id]);
  function root(key: string): string {
    let current = key;
    while (parents.has(current)) current = parents.get(current)!;
    while (parents.has(key)) {
      const next = parents.get(key)!;
      parents.set(key, current);
      key = next;
    }
    return current;
  }
  for (const m of eligible) {
    if (!m.replyId) continue;
    const key = reference(m, m.replyId);
    const parent = byReference.get(key);
    if (parent === null) continue;
    const from = root(node(m));
    const to = root(parent ? node(parent) : JSON.stringify(['missing', key]));
    if (from !== to) parents.set(from, to);
  }
  const groups = new Map<string, Conversation>();
  const index = new Map<string, Conversation>();
  for (const m of eligible) {
    const key = root(node(m));
    let group = groups.get(key);
    if (!group) {
      group = { key, messages: [] };
      groups.set(key, group);
    }
    group.messages.push(m);
    index.set(m.id, group);
  }
  return index;
}

export type MailboxRow = {
  key: string;
  message: Message;
  latest: Message;
  members: Message[];
  total: number;
  unread: number;
  starred: boolean;
};

/** Filter within the current folder, retaining a whole row when any member matches. */
export function mailboxRows(
  messages: Message[],
  index: Map<string, Conversation>,
  grouped: boolean,
  order: MessageSort,
  matches: (m: Message) => boolean,
): MailboxRow[] {
  const groups = new Map<string, Message[]>();
  for (const m of grouped ? sortMessages(messages, 'newest') : messages) {
    const key = grouped && index.has(m.id) ? index.get(m.id)!.key : m.id;
    const members = groups.get(key);
    if (members) members.push(m);
    else groups.set(key, [m]);
  }
  const rows = new Map<string, MailboxRow>();
  for (const [key, members] of groups) {
    const message = members.find(matches);
    if (!message) continue;
    rows.set(members[0].id, {
      key,
      message,
      latest: members[0],
      members,
      total: grouped ? index.get(message.id)?.messages.length || members.length : 1,
      unread: members.filter((m) => !m.read).length,
      starred: members.some((m) => m.starred),
    });
  }
  return sortMessages(
    [...rows.values()].map((row) => row.latest),
    order,
  ).map((m) => rows.get(m.id)!);
}

export function messageSort(value: string | null): MessageSort {
  return value === 'oldest' ? 'oldest' : 'newest';
}

export function sortMessages(messages: Message[], order: MessageSort): Message[] {
  // Compare instants rather than date strings, which can carry different UTC offsets.
  return messages
    .map((message) => ({ message, time: Date.parse(message.date) }))
    .sort((a, b) => {
      if (Number.isNaN(a.time)) return Number.isNaN(b.time) ? 0 : 1;
      if (Number.isNaN(b.time)) return -1;
      return order === 'oldest' ? a.time - b.time : b.time - a.time;
    })
    .map(({ message }) => message);
}

export function mailboxCounts(messages: Message[]) {
  const folders = new Map<string, number>();
  const unreadAreas = new Map<string, number>();
  let unreadInbox = 0,
    starred = 0;
  for (const m of messages) {
    folders.set(m.folder, (folders.get(m.folder) || 0) + 1);
    if (m.starred && m.folder !== 'trash') starred++;
    if (m.folder === 'inbox' && !m.read) {
      if (m.area) unreadAreas.set(m.area, (unreadAreas.get(m.area) || 0) + 1);
      else unreadInbox++;
    }
  }
  folders.set('inbox', unreadInbox);
  folders.set('starred', starred);
  return { folders, unreadAreas };
}

/** Keep connected nodes in place when neither their order nor identity changed. */
export function reconcileChildren(parent: HTMLElement, children: Node[]): void {
  children.forEach((child, i) => {
    const current = parent.childNodes[i];
    if (current !== child) parent.insertBefore(child, current || null);
  });
  while (parent.childNodes.length > children.length) parent.lastChild!.remove();
}
