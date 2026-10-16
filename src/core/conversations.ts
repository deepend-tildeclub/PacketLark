import type { Message } from './model.js';

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
