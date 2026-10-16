import { describe, expect, it } from 'vitest';
import type { Message } from '../src/core/model.js';
import { indexConversations, mailboxRows, messageView } from '../src/renderer/mailbox.js';

function mail(id: string, values: Partial<Message> = {}): Message {
  return {
    id,
    msgid: `message ${id}`,
    replyId: '',
    from: 'Sender',
    fromAddress: '1:123/456',
    to: 'Mike',
    toAddress: '1:123/456.100',
    subject: 'A conversation',
    body: id,
    raw: '',
    area: '',
    date: '2026-10-16T00:00:00Z',
    folder: 'inbox',
    read: true,
    starred: false,
    error: '',
    packetName: '',
    ...values,
  };
}
const ids = (messages: Message[]) => messages.map((m) => m.id);

describe('conversation grouping', () => {
  it('defaults to conversations and retains the explicit individual-message preference', () => {
    for (const value of [null, '', 'invalid', 'conversations'])
      expect(messageView(value)).toBe('conversations');
    expect(messageView('messages')).toBe('messages');
  });

  it('joins branches and sent replies only through explicit links, without mutating messages', () => {
    const root = mail('root');
    const messages = [
      mail('grandchild', { replyId: 'message child' }),
      mail('child', { replyId: root.msgid, folder: 'sent' }),
      mail('sibling', { replyId: root.msgid }),
      root,
      mail('same-subject'),
    ];
    const before = structuredClone(messages);
    const index = indexConversations(messages);
    expect(ids(index.get(root.id)!.messages)).toEqual(['grandchild', 'child', 'sibling', 'root']);
    expect(index.get('child')).toBe(index.get(root.id));
    expect(index.get('same-subject')).not.toBe(index.get(root.id));
    expect(messages).toEqual(before);
  });

  it('groups siblings whose parent has not arrived and reconnects a later parent', () => {
    const messages = [
      mail('a', { replyId: 'missing parent' }),
      mail('b', { replyId: 'missing parent' }),
    ];
    const index = indexConversations(messages);
    expect(index.get('a')).toBe(index.get('b'));
    const parent = mail('parent', { msgid: 'missing parent' });
    const next = indexConversations([...messages, parent]);
    expect(next.get('parent')!.messages).toHaveLength(3);
    expect(index.get('a')!.messages).toHaveLength(2);
  });

  it('isolates areas, direct mail, internal controls and unsent/deleted messages', () => {
    const messages = [
      mail('root'),
      mail('direct', { replyId: 'message root' }),
      mail('area', { area: 'TEST', replyId: 'message root' }),
      ...(['trash', 'drafts', 'outbox'] as const).map((folder) =>
        mail(folder, { folder, replyId: 'message root' }),
      ),
      mail('control', { internal: true, replyId: 'message root' }),
    ];
    const index = indexConversations(messages);
    expect(ids(index.get('root')!.messages)).toEqual(['root', 'direct']);
    expect(ids(index.get('area')!.messages)).toEqual(['area']);
    for (const id of ['trash', 'drafts', 'outbox', 'control']) expect(index.has(id)).toBe(false);
  });

  it('does not join empty or ambiguous reused MSGIDs', () => {
    const messages = [
      mail('a', { msgid: 'reused' }),
      mail('b', { msgid: 'reused' }),
      mail('c', { replyId: 'reused' }),
      mail('d', { msgid: '' }),
      mail('e', { msgid: '' }),
    ];
    expect(new Set(indexConversations(messages).values()).size).toBe(5);
  });

  it('handles self references, cycles, and a deep thread without recursion', () => {
    const cycle = indexConversations([
      mail('a', { replyId: 'message b' }),
      mail('b', { replyId: 'message a' }),
      mail('self', { replyId: 'message self' }),
    ]);
    expect(cycle.get('a')).toBe(cycle.get('b'));
    expect(cycle.get('self')!.messages).toHaveLength(1);
    const chain = Array.from({ length: 20000 }, (_, i) =>
      mail(String(i), {
        replyId: i === 19999 ? '' : `message ${i + 1}`,
      }),
    );
    const index = indexConversations(chain);
    expect(index.get('0')).toBe(index.get('19999'));
    expect(index.get('0')!.messages).toHaveLength(20000);
  });

  it('keeps a row identity when a new reply arrives', () => {
    const root = mail('root');
    const before = indexConversations([root]).get(root.id)!.key;
    const next = indexConversations([mail('reply', { replyId: root.msgid }), root]);
    expect(next.get('reply')!.key).toBe(before);
  });

  it('orders rows by the last activity in the current folder, with correct UTC offsets', () => {
    const root = mail('root', { date: '2026-10-15T20:00:00Z' });
    const reply = mail('reply', { replyId: root.msgid, date: '2026-10-16T01:00:00+02:00' });
    const other = mail('other', { date: '2026-10-15T22:00:00Z' });
    const sent = mail('sent', {
      replyId: other.msgid,
      folder: 'sent',
      date: '2026-10-17T00:00:00Z',
    });
    const messages = [root, other, reply, mail('invalid', { date: 'Unknown' })];
    const index = indexConversations([...messages, sent]);
    const rows = (order: 'oldest' | 'newest') =>
      mailboxRows(messages, index, true, order, () => true);
    expect(rows('newest').map((r) => r.message.id)).toEqual(['reply', 'other', 'invalid']);
    expect(rows('oldest').map((r) => r.message.id)).toEqual(['other', 'reply', 'invalid']);
    expect(ids(rows('newest')[0].members)).toEqual(['reply', 'root']);
  });

  it('finds older matches, counts folder members, and keeps unread/search filters on the same message', () => {
    const root = mail('root', {
      body: 'needle',
      read: false,
      starred: true,
      date: '2026-10-15T00:00:00Z',
    });
    const reply = mail('reply', { replyId: root.msgid, date: '2026-10-16T00:00:00Z' });
    const sent = mail('sent', { replyId: root.msgid, folder: 'sent', read: false });
    const index = indexConversations([root, reply, sent]);
    const rows = mailboxRows(
      [root, reply],
      index,
      true,
      'newest',
      (m) => !m.read && m.body.includes('needle'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe(root);
    expect(rows[0].latest).toBe(reply);
    expect(rows[0].unread).toBe(1);
    expect(rows[0].starred).toBe(true);
    expect(rows[0].members).toHaveLength(2);
    expect(rows[0].total).toBe(3);
    expect(
      mailboxRows([root, reply], index, true, 'newest', (m) => !m.read && m.body === 'reply'),
    ).toEqual([]);
  });

  it('retains individually sorted rows and action folders when grouping is disabled', () => {
    const root = mail('root', { date: '2026-10-15T00:00:00Z' });
    const reply = mail('reply', { replyId: root.msgid });
    const index = indexConversations([root, reply]);
    expect(
      mailboxRows([root, reply], index, false, 'oldest', () => true).map((r) => r.message.id),
    ).toEqual(['root', 'reply']);
    const drafts = [
      mail('a', { folder: 'drafts' }),
      mail('b', { folder: 'drafts', replyId: 'message a' }),
    ];
    expect(mailboxRows(drafts, index, true, 'newest', () => true)).toHaveLength(2);
  });
});
