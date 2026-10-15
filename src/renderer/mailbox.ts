import type { Message } from '../core/model.js';

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
