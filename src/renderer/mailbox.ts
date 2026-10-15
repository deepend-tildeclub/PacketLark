import type { Message } from '../core/model.js';

export type MessageSort = 'newest' | 'oldest';

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
