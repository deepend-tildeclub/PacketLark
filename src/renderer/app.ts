import type { Api, Compose, Discussion, Message, RuntimeUpdate, State } from '../core/model.js';
import './style.css';
import { mailboxCounts, messageSort, reconcileChildren, sortMessages } from './mailbox.js';
import { visibleDiscussions } from '../core/areas.js';
import { defaultNotifications } from '../core/notifications.js';
declare global {
  interface Window {
    packetlark: Api;
  }
}
const api = window.packetlark;
const sortPreference = 'packetlark.messageSort';
let sortOrder = messageSort(null);
try {
  sortOrder = messageSort(localStorage.getItem(sortPreference));
} catch {
  // Keep the mailbox usable when browser preference storage is unavailable.
}
let state: State,
  folder = 'inbox',
  selection = '',
  query = '',
  unreadOnly = false;
let composer: HTMLDialogElement | null = null,
  refreshing = false,
  refreshAgain = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let sidebarKey = '',
  headingKey = '',
  readerKey = '',
  readerSelection = '',
  listViewKey = '';
let rowLimit = 200;
const rowCache = new Map<string, { key: string; node: HTMLButtonElement }>();
let moreMessages: HTMLButtonElement | undefined;
let renderDiscussions: (() => void) | null = null;
let pendingNotification: string | undefined;
const app = document.querySelector<HTMLDivElement>('#app')!;
function e<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}
function button(text: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = e('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
function notify(text: string, error = false) {
  const t = document.querySelector<HTMLDivElement>('#toast')!;
  t.textContent = text;
  t.className = error ? 'visible error' : 'visible';
  setTimeout(() => {
    t.className = '';
  }, 6500);
}
async function action(fn: () => Promise<unknown>) {
  try {
    await fn();
    await refresh();
  } catch (error) {
    notify(error instanceof Error ? error.message : 'The operation failed.', true);
  }
}
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
function date(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : dateFormatter.format(d);
}
function setText(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}

const toolbar = e('header', 'toolbar');
const brand = e('div', 'brand');
brand.append(e('div', 'brand-mark', 'P'), e('div', '', 'PacketLark'));
toolbar.append(brand);
const composeButton = button('＋ New message', () => openCompose(), 'primary');
const syncButton = button('↻ Send & receive', () => void action(() => api.sync()));
const search = e('input', 'search');
search.type = 'search';
search.placeholder = 'Search messages';
search.setAttribute('aria-label', 'Search messages');
search.addEventListener('input', () => {
  query = search.value;
  renderMailbox();
});
toolbar.append(
  composeButton,
  syncButton,
  search,
  button('Account', () => accountDialog()),
);
const workspace = e('div', 'workspace'),
  sidebar = e('nav', 'sidebar');
sidebar.setAttribute('aria-label', 'Mail folders and discussions');
const listPanel = e('section', 'message-panel'),
  reader = e('section', 'reader');
reader.setAttribute('aria-label', 'Message reader');
const listHeading = e('div', 'list-heading'),
  messageList = e('div', 'message-list');
messageList.setAttribute('aria-label', 'Messages');
const sortLabel = e('label', 'message-sort', 'Sort ');
const sortMenu = e('select');
sortMenu.setAttribute('aria-label', 'Sort messages');
for (const [value, title] of [
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
]) {
  const option = e('option', '', title);
  option.value = value;
  sortMenu.append(option);
}
sortMenu.value = sortOrder;
sortMenu.addEventListener('change', () => {
  sortOrder = messageSort(sortMenu.value);
  try {
    localStorage.setItem(sortPreference, sortOrder);
  } catch {
    // Sorting still works for this session if preferences cannot be saved.
  }
  renderMailbox();
  reader.scrollTop = 0;
});
sortLabel.append(sortMenu);
listPanel.append(listHeading, messageList);
workspace.append(sidebar, listPanel, reader);
const footer = e('footer', 'statusbar');
footer.setAttribute('role', 'status');
const footerStatus = e('span'),
  footerTime = e('span');
footer.append(footerStatus, footerTime);
app.append(toolbar, workspace, footer);
async function refresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      state = visibleDiscussions(await api.state());
      render();
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
  if (pendingNotification !== undefined) {
    const id = pendingNotification;
    pendingNotification = undefined;
    const message = state.messages.find((m) => m.id === id && m.folder === 'inbox' && !m.internal);
    if (!message || (message.area && !state.areas.some((a) => a.tag === message.area))) {
      notify('That message is no longer available in your Inbox.');
      return;
    }
    folder = message.area ? `area:${message.area}` : 'inbox';
    selection = message.id;
    query = search.value = '';
    unreadOnly = false;
    render();
    if (!message.read) void action(() => api.mark(message.id, { read: true }));
  }
}
function renderRuntime() {
  composeButton.disabled = !state.account;
  syncButton.disabled = !state.account || state.syncing;
  setText(syncButton, state.syncing ? '↻ Connecting…' : '↻ Send & receive');
  footerStatus.className = state.syncing ? 'working' : '';
  setText(footerStatus, `● ${state.status}`);
  setText(
    footerTime,
    state.lastSync
      ? `Last exchange: ${date(state.lastSync)}`
      : 'Offline reading · FidoNet messaging',
  );
  for (const control of reader.querySelectorAll<HTMLButtonElement>('[data-mailbox-change]'))
    control.disabled = state.syncing;
}
function render() {
  renderRuntime();
  renderSidebar();
  renderMailbox();
  renderDiscussions?.();
}
function renderSidebar() {
  const counts = mailboxCounts(state.messages);
  const key = JSON.stringify([
    folder,
    state.account?.provider,
    !!state.account,
    state.areas,
    ['inbox', 'sent', 'drafts', 'outbox', 'starred', 'trash'].map(
      (id) => counts.folders.get(id) || 0,
    ),
    state.areas.map((a) => counts.unreadAreas.get(a.tag) || 0),
  ]);
  if (key === sidebarKey) return;
  sidebarKey = key;
  const scroll = sidebar.scrollTop;
  sidebar.replaceChildren();
  const label = e('div', 'section-label', state.account?.provider || 'RETRODIGITAL BBS');
  sidebar.append(label);
  const folders = [
    ['inbox', 'Inbox'],
    ['sent', 'Sent'],
    ['drafts', 'Drafts'],
    ['outbox', 'Outbox'],
    ['starred', 'Starred'],
    ['trash', 'Trash'],
    ['contacts', 'Contacts'],
  ];
  for (const [id, title] of folders) {
    const count = counts.folders.get(id) || 0;
    const b = button(
      title,
      () => {
        folder = id;
        if (id === 'trash') unreadOnly = false;
        selection = '';
        query = '';
        search.value = '';
        render();
      },
      folder === id ? 'nav-item active' : 'nav-item',
    );
    if (count && id !== 'sent') b.append(e('span', 'count', String(count)));
    sidebar.append(b);
  }
  const discussionHeader = e('div', 'section-label section-spaced', 'DISCUSSIONS');
  sidebar.append(discussionHeader);
  for (const area of state.areas) {
    const count = counts.unreadAreas.get(area.tag) || 0;
    const b = button(
      area.name,
      () => {
        folder = `area:${area.tag}`;
        selection = '';
        render();
      },
      folder === `area:${area.tag}` ? 'nav-item active' : 'nav-item',
    );
    b.title = area.tag;
    if (count) b.append(e('span', 'count', String(count)));
    sidebar.append(b);
  }
  if (state.account)
    sidebar.append(button('＋ Manage discussions', () => areasDialog(), 'nav-item subdued'));
  sidebar.append(
    e('div', 'sidebar-note', 'Independent conversations.\nDelivered through FidoNet.'),
  );
  sidebar.scrollTop = scroll;
}
function renderMailbox() {
  if (!state) return;
  if (!state.account) {
    listHeading.replaceChildren();
    messageList.replaceChildren();
    reader.replaceChildren();
    listHeading.append(e('h1', '', 'Your mailbox'));
    messageList.append(
      e('p', 'empty-copy', 'Your direct messages and discussions will appear here.'),
    );
    const welcome = e('div', 'welcome');
    welcome.append(
      e('div', 'welcome-stamp', 'P'),
      e('p', 'eyebrow', 'RETRODIGITAL BBS PRESENTS'),
      e('h1', '', 'Good conversations.\nA familiar inbox.'),
      e(
        'p',
        '',
        'PacketLark brings FidoNet messages and community discussions together in one simple desktop app.',
      ),
      button(
        'Import your account file',
        () => void action(() => api.importAccount()),
        'primary large',
      ),
      e('p', 'muted', 'Ask your provider for a .packetlark account file.'),
    );
    reader.append(welcome);
    return;
  }
  if (folder === 'contacts') {
    headingKey = '';
    readerKey = '';
    rowCache.clear();
    listHeading.replaceChildren();
    messageList.replaceChildren();
    reader.replaceChildren();
    listHeading.append(
      e('h1', '', 'Contacts'),
      button('Add contact', () => contactDialog(), 'small'),
    );
    for (const c of state.contacts) {
      messageList.append(
        button(
          `${c.name}\n${c.address}`,
          () => openCompose({ to: c.name, toAddress: c.address }),
          'contact-row',
        ),
      );
    }
    reader.append(e('div', 'empty-reader', 'Choose a contact to write a message.'));
    return;
  }
  const area = folder.startsWith('area:') ? folder.slice(5) : '';
  const title = area
    ? state.areas.find((a) => a.tag === area)?.name || area
    : folder[0].toUpperCase() + folder.slice(1);
  const viewKey = JSON.stringify([folder, query, unreadOnly, sortOrder]);
  const changedView = viewKey !== listViewKey;
  if (changedView) {
    rowLimit = 200;
    listViewKey = viewKey;
  }
  const nextHeading = JSON.stringify([title, unreadOnly]);
  if (headingKey !== nextHeading) {
    headingKey = nextHeading;
    listHeading.replaceChildren();
    listHeading.append(e('h1', '', title));
    const filter = button(
      unreadOnly ? 'Unread only ✓' : 'Unread only',
      () => {
        unreadOnly = !unreadOnly;
        renderMailbox();
      },
      'small',
    );
    filter.setAttribute('aria-pressed', String(unreadOnly));
    const controls = e('div', 'list-controls');
    controls.append(filter, sortLabel);
    listHeading.append(controls);
  }
  const term = query.toLowerCase();
  const messages = sortMessages(
    state.messages.filter((m) => {
      const match = area
        ? m.area === area && m.folder === 'inbox'
        : folder === 'starred'
          ? m.starred && m.folder !== 'trash'
          : folder === 'inbox'
            ? m.folder === 'inbox' && !m.area
            : m.folder === folder;
      return (
        match &&
        (!unreadOnly || !m.read) &&
        (!term || `${m.from} ${m.to} ${m.subject} ${m.body}`.toLowerCase().includes(term))
      );
    }),
    sortOrder,
  );
  const children: Node[] = [];
  if (!messages.length)
    children.push(
      e(
        'div',
        'empty-list',
        query
          ? 'No matching messages.'
          : area
            ? 'No posts yet. Send & receive to collect new discussions.'
            : 'Nothing here yet.',
      ),
    );
  const visible = messages.slice(0, rowLimit);
  const visibleIds = new Set(visible.map((m) => m.id));
  for (const id of rowCache.keys()) if (!visibleIds.has(id)) rowCache.delete(id);
  for (const m of visible) {
    const key = JSON.stringify([
      m.from,
      m.to,
      m.folder,
      m.trash?.folder,
      m.subject,
      m.starred,
      m.body.slice(0, 140),
      m.date,
      !!m.error,
    ]);
    let cached = rowCache.get(m.id);
    if (!cached) {
      const node = button('', () => {
        const live = state.messages.find((value) => value.id === m.id);
        if (!live) return;
        selection = live.id;
        if (live.folder === 'drafts') openCompose({ ...live, replyId: live.replyId });
        else if (!live.read) void action(() => api.mark(live.id, { read: true }));
        renderMailbox();
      });
      cached = { key: '', node };
      rowCache.set(m.id, cached);
    }
    const b = cached.node;
    const cls = `message-row ${selection === m.id ? 'selected ' : ''}${!m.read ? 'unread' : ''}`;
    if (b.className !== cls) b.className = cls;
    if (cached.key !== key) {
      cached.key = key;
      const top = e('div', 'row-top');
      top.append(
        e(
          'span',
          'sender',
          (m.folder === 'trash' ? m.trash?.folder : m.folder) === 'inbox' ? m.from : `To: ${m.to}`,
        ),
        e('time', '', date(m.date)),
      );
      b.replaceChildren(
        top,
        e('div', 'subject', `${m.starred ? '★ ' : ''}${m.subject || '(No subject)'}`),
        e('p', 'preview', m.body.slice(0, 140).replace(/\n/g, ' ')),
      );
      if (m.folder === 'outbox')
        b.append(
          e(
            'span',
            m.error ? 'delivery failed' : 'delivery',
            m.error ? 'Needs retry' : 'Queued for next exchange',
          ),
        );
    }
    children.push(b);
  }
  if (messages.length > rowLimit) {
    moreMessages ??= button(
      'Show older messages',
      () => {
        rowLimit += 200;
        renderMailbox();
      },
      'load-more',
    );
    setText(moreMessages, sortOrder === 'newest' ? 'Show older messages' : 'Show newer messages');
    children.push(moreMessages);
  }
  reconcileChildren(messageList, children);
  if (changedView) messageList.scrollTop = 0;
  const selected = messages.find((m) => m.id === selection);
  if (selected) {
    const { thread, responses } = conversation(selected);
    const key = JSON.stringify([
      { ...selected, read: undefined, starred: undefined },
      thread.map((m) => [m.id, m.from, m.body, m.date]),
      responses.map((m) => [m.id, m.from, m.subject]),
    ]);
    if (readerKey !== key) {
      const scroll = readerSelection === selected.id ? reader.scrollTop : 0;
      readerSelection = selected.id;
      readerKey = key;
      reader.replaceChildren();
      renderMessage(selected, thread, responses);
      reader.scrollTop = scroll;
    }
    const star = reader.querySelector<HTMLButtonElement>('[data-message-flag="star"]');
    const read = reader.querySelector<HTMLButtonElement>('[data-message-flag="read"]');
    if (star) setText(star, selected.starred ? '★ Starred' : '☆ Star');
    if (read) setText(read, selected.read ? 'Mark unread' : 'Mark read');
    renderRuntime();
  } else {
    if (readerKey === 'empty') return;
    readerKey = 'empty';
    readerSelection = '';
    reader.replaceChildren();
    const empty = e('div', 'empty-reader');
    empty.append(
      e('div', 'letter-icon', '✉'),
      e('h2', '', 'A little space for conversation.'),
      e('p', '', 'Choose a message to read it.'),
    );
    reader.append(empty);
  }
}
function conversation(m: Message) {
  // Thread only on explicit FTN MSGID/REPLY links within the same area. Never merge by subject.
  const thread: Message[] = [];
  const seen = new Set<string>();
  let current: Message | undefined = m;
  while (current && !seen.has(current.id) && thread.length < 50) {
    thread.unshift(current);
    seen.add(current.id);
    const previous: string = current.replyId;
    current =
      previous && m.folder !== 'trash'
        ? state.messages.find(
            (x) => x.msgid === previous && x.area === m.area && x.folder !== 'trash',
          )
        : undefined;
  }
  const responses = state.messages.filter(
    (x) =>
      m.folder !== 'trash' &&
      x.folder !== 'trash' &&
      m.msgid &&
      x.replyId === m.msgid &&
      x.area === m.area &&
      !seen.has(x.id),
  );
  return {
    thread: sortMessages(thread, sortOrder),
    responses: sortMessages(responses, sortOrder),
  };
}
function renderMessage(m: Message, thread: Message[], responses: Message[]) {
  const head = e('div', 'reader-heading');
  head.append(
    e(
      'span',
      m.area ? 'message-type public' : 'message-type',
      m.area ? `PUBLIC DISCUSSION · ${m.area}` : 'DIRECT MESSAGE',
    ),
    e('h1', '', m.subject || '(No subject)'),
  );
  const info = e('div', 'message-info');
  info.append(
    e('strong', '', m.from),
    e('span', 'address', m.fromAddress),
    e('span', '', `To ${m.to} · ${date(m.date)}`),
  );
  head.append(info);
  const actions = e('div', 'reader-actions');
  if (m.folder === 'trash') {
    actions.append(
      button(
        'Restore',
        () =>
          void action(async () => {
            await api.restoreMessage(m.id);
            selection = '';
            notify(
              m.trash?.folder === 'outbox'
                ? 'Restored to Drafts. Review it before sending again.'
                : 'Message restored.',
            );
          }),
      ),
      button('Delete permanently', () => deletePermanently(m), 'danger'),
    );
  } else if (m.folder !== 'drafts') {
    actions.append(
      button(m.area ? 'Reply to discussion' : 'Reply', () => reply(m, false), 'primary'),
      button(
        m.starred ? '★ Starred' : '☆ Star',
        () =>
          void action(() =>
            api.mark(m.id, { starred: !state.messages.find((x) => x.id === m.id)!.starred }),
          ),
      ),
    );
    if (m.area) actions.append(button('Reply privately', () => reply(m, true)));
    actions.append(
      button(
        m.read ? 'Mark unread' : 'Mark read',
        () =>
          void action(() =>
            api.mark(m.id, { read: !state.messages.find((x) => x.id === m.id)!.read }),
          ),
      ),
      button('Save contact', () => contactDialog(m.from, m.fromAddress)),
      button('Details', () => details(m)),
    );
  } else actions.append(button('Edit draft', () => openCompose({ ...m }), 'primary'));
  if (m.folder !== 'trash')
    actions.append(
      button(
        m.folder === 'drafts' ? 'Delete draft' : 'Delete',
        () =>
          void action(async () => {
            await api.trashMessage(m.id);
            selection = '';
            notify(
              m.folder === 'outbox'
                ? 'Pending send cancelled. Message moved to Trash.'
                : 'Message moved to Trash.',
            );
          }),
        'danger',
      ),
    );
  for (const control of actions.querySelectorAll('button')) {
    if (['★ Starred', '☆ Star'].includes(control.textContent || ''))
      control.dataset.messageFlag = 'star';
    if (['Mark unread', 'Mark read'].includes(control.textContent || ''))
      control.dataset.messageFlag = 'read';
    if (
      ['Delete', 'Delete draft', 'Delete permanently', 'Restore'].includes(
        control.textContent || '',
      )
    ) {
      control.dataset.mailboxChange = '';
      control.disabled = state.syncing;
    }
  }
  head.append(actions);
  reader.append(head);
  if (m.folder === 'trash')
    reader.append(
      e(
        'div',
        'notice',
        m.trash?.folder === 'outbox'
          ? 'This message is in Trash. Its pending send was cancelled; restoring returns it to Drafts.'
          : 'This message is in Trash. Restore it to return it to its original folder.',
      ),
    );
  if (m.folder === 'sent')
    reader.append(
      e(
        'div',
        'notice',
        'Accepted by your provider. This does not confirm delivery or that the recipient has read it.',
      ),
    );
  if (m.error) reader.append(e('div', 'notice warning', m.error));
  for (const part of thread) {
    const article = e('article', 'message-body');
    if (thread.length > 1)
      article.append(e('h2', 'thread-author', `${part.from} · ${date(part.date)}`));
    const text = e('pre', 'body-text', part.body);
    article.append(text);
    reader.append(article);
  }
  if (responses.length) {
    const box = e('div', 'thread-links');
    box.append(e('h2', '', 'Replies'));
    for (const r of responses)
      box.append(
        button(`${r.from} — ${r.subject}`, () => {
          selection = r.id;
          void action(() => api.mark(r.id, { read: true }));
          renderMailbox();
        }),
      );
    reader.append(box);
  }
}
function deletePermanently(message: Message) {
  const { body, close } = dialog('Delete message permanently?');
  body.append(
    e('p', '', `Permanently delete “${message.subject || '(No subject)'}”? This cannot be undone.`),
    button('Cancel', close),
    button(
      'Delete permanently',
      () =>
        void action(async () => {
          await api.deleteMessage(message.id);
          selection = '';
          close();
          notify('Message permanently deleted.');
        }),
      'danger',
    ),
  );
}
function dialog(title: string): {
  box: HTMLDialogElement;
  body: HTMLDivElement;
  close: () => void;
} {
  const box = e('dialog');
  box.setAttribute('aria-label', title);
  const header = e('div', 'dialog-header');
  header.append(e('h2', '', title));
  const body = e('div', 'dialog-body');
  const close = () => {
    box.close();
    box.remove();
  };
  header.append(button('Close', close, 'small'));
  box.append(header, body);
  document.body.append(box);
  box.showModal();
  return { box, body, close };
}
function field(parent: HTMLElement, label: string, value = '', type = 'text') {
  const wrap = e('label', 'field');
  wrap.append(e('span', '', label));
  const input = e('input');
  input.type = type;
  input.value = value;
  wrap.append(input);
  parent.append(wrap);
  return input;
}
function reply(m: Message, privately: boolean) {
  openCompose({
    to: m.from,
    toAddress: m.fromAddress,
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    body: `\n\nOn ${date(m.date)}, ${m.from} wrote:\n${m.body
      .split('\n')
      .map((s) => `> ${s}`)
      .join('\n')}`,
    area: privately ? '' : m.area,
    replyId: m.msgid,
  });
}
function openCompose(initial: Partial<Compose> = {}) {
  if (composer) {
    composer.focus();
    return;
  }
  const p = state.account;
  if (!p) return;
  const currentArea = folder.startsWith('area:') ? folder.slice(5) : '';
  let draftId = initial.id,
    dirty = false,
    removingDraft = false,
    submitting = false,
    saving = Promise.resolve(),
    saveError: unknown;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const { box, body, close } = dialog('New message');
  composer = box;
  box.classList.add('composer');
  const form = e('form');
  form.noValidate = false;
  const areaLabel = e('label', 'field');
  areaLabel.append(e('span', '', 'Send to'));
  const area = e('select');
  area.append(new Option('Direct message', ''));
  for (const a of state.areas) area.append(new Option(`Discussion: ${a.name}`, a.tag));
  area.value = initial.area ?? currentArea;
  areaLabel.append(area);
  form.append(areaLabel);
  const privacy = e('div', 'notice');
  form.append(privacy);
  const row = e('div', 'form-row');
  const to = field(row, 'Recipient name', initial.to || (area.value ? 'All' : ''));
  to.maxLength = 35;
  const addr = field(
    row,
    'FidoNet address',
    initial.toAddress || (area.value ? p.address.replace(/\.\d+(?=@|$)/, '') : ''),
  );
  const names = e('datalist');
  names.id = 'contact-names';
  for (const c of state.contacts) {
    const o = e('option');
    o.value = c.name;
    names.append(o);
  }
  to.setAttribute('list', names.id);
  form.append(names);
  to.addEventListener('change', () => {
    const c = state.contacts.find((c) => c.name === to.value);
    if (c) addr.value = c.address;
  });
  form.append(row);
  const subject = field(form, 'Subject', initial.subject || '');
  subject.maxLength = 71;
  const bodyLabel = e('label', 'field');
  bodyLabel.append(e('span', '', 'Message'));
  const text = e('textarea');
  text.rows = 12;
  text.maxLength = 60000;
  text.value = initial.body || '';
  bodyLabel.append(text);
  form.append(bodyLabel);
  const hint = e('p', 'muted', 'Drafts are saved automatically while you write.');
  form.append(hint);
  const buttons = e('div', 'composer-actions');
  const send = e('button', 'primary', 'Queue message');
  send.type = 'submit';
  const values = (): Compose => ({
    ...(draftId ? { id: draftId } : {}),
    to: to.value,
    toAddress: addr.value,
    subject: subject.value,
    body: text.value,
    area: area.value,
    replyId: initial.replyId || '',
  });
  const save = () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (!dirty) return saving;
    const value = values();
    dirty = false;
    saving = saving.then(async () => {
      try {
        const id = await api.saveDraft({ ...value, ...(draftId ? { id: draftId } : {}) });
        draftId = id;
        saveError = undefined;
        hint.textContent = 'Draft saved.';
      } catch (error) {
        saveError = error;
        dirty = true;
        hint.textContent = 'Draft could not be saved. Keep this window open.';
      }
    });
    return saving;
  };
  const closeSafely = async () => {
    if (removingDraft || submitting) return;
    await save();
    if (saveError) {
      notify(saveError instanceof Error ? saveError.message : 'Draft could not be saved.', true);
      return;
    }
    composer = null;
    close();
    await refresh();
  };
  box.querySelector<HTMLButtonElement>('.dialog-header button')!.onclick = null;
  const oldClose = box.querySelector<HTMLButtonElement>('.dialog-header button')!;
  oldClose.replaceWith(button('Save & close', () => void closeSafely(), 'small'));
  box.addEventListener('cancel', (event) => {
    event.preventDefault();
    void closeSafely();
  });
  const privacyUpdate = () => {
    privacy.textContent = area.value
      ? 'Public discussion: everyone receiving this group can read your post.'
      : 'Direct message: addressed to one person. FidoNet netmail is not end-to-end encrypted.';
    addr.disabled = !!area.value;
    if (area.value) {
      addr.value = p.address.replace(/\.\d+(?=@|$)/, '');
      if (!to.value) to.value = 'All';
    }
  };
  area.addEventListener('change', privacyUpdate);
  privacyUpdate();
  form.addEventListener('input', () => {
    dirty = true;
    hint.textContent = 'Saving draft…';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 900);
  });
  form.addEventListener('change', () => {
    dirty = true;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (removingDraft || submitting) return;
    submitting = true;
    void (async () => {
      send.disabled = true;
      try {
        await save();
        if (saveError) throw saveError;
        await api.queue(values());
        composer = null;
        close();
        notify('Message queued. Use Send & receive to hand it to your provider.');
        await refresh();
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Could not queue message.', true);
        submitting = false;
        send.disabled = false;
      }
    })();
  });
  buttons.append(
    send,
    button(
      'Delete draft',
      () => {
        if (removingDraft || submitting) return;
        removingDraft = true;
        const controls = [
          ...form.querySelectorAll<
            HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
          >('input,select,textarea,button'),
        ];
        const previous = controls.map((control) => control.disabled);
        for (const control of controls) control.disabled = true;
        void (async () => {
          try {
            await save();
            if (saveError) throw saveError;
            if (draftId) await api.trashMessage(draftId);
            composer = null;
            close();
            selection = '';
            notify(draftId ? 'Draft moved to Trash.' : 'Empty draft closed.');
            await refresh();
          } catch (error) {
            notify(error instanceof Error ? error.message : 'Could not delete this draft.', true);
            removingDraft = false;
            controls.forEach((control, i) => {
              control.disabled = previous[i];
            });
          }
        })();
      },
      'danger',
    ),
    button('Save & close', () => void closeSafely()),
  );
  form.append(buttons);
  body.append(form);
  text.focus();
  if (initial.body) text.setSelectionRange(0, 0);
}
function accountDialog() {
  const { body } = dialog('Your account');
  const p = state.account;
  if (!p) {
    body.append(
      e('p', '', 'Import the account file supplied by your provider.'),
      button('Import account', () => void action(() => api.importAccount()), 'primary'),
    );
    notificationPreferences(body);
    return;
  }
  for (const [label, value] of [
    ['Name', p.name],
    ['Provider', p.provider],
    ['Point address', p.address],
    ['Server', `${p.host}:${p.port}`],
    [
      'Transport',
      p.tls ? 'Certificate-verified TLS' : 'CRAM-MD5 authentication; unencrypted message traffic',
    ],
    ['Check interval', `${p.pollMinutes} minutes while PacketLark is open`],
    ['Outgoing encoding', p.charset],
  ]) {
    body.append(e('h3', 'detail-label', label), e('p', '', value));
  }
  body.append(
    e(
      'p',
      'muted',
      'Credentials are protected by your operating system keyring. Mailbox message content is stored locally without encryption.',
    ),
    button('Back up mailbox', () => void action(() => api.backup())),
  );
  notificationPreferences(body);
  if (state.storageWarning)
    body.append(
      e(
        'p',
        'notice warning',
        'Unlock your operating system keyring before importing or using an account.',
      ),
    );
}
function notificationPreferences(body: HTMLElement) {
  const group = e('fieldset', 'notification-settings');
  group.append(e('legend', '', 'Desktop notifications'));
  const settings = state.notifications || defaultNotifications;
  const controls = (['enabled', 'discussions', 'previews'] as const).map((key, i) => {
    const label = e('label', 'notification-option');
    const checkbox = e('input');
    checkbox.type = 'checkbox';
    checkbox.checked = settings[key];
    label.append(
      checkbox,
      e(
        'span',
        '',
        ['Enable desktop notifications', 'Include discussion posts', 'Show sender and subject'][i],
      ),
    );
    group.append(label);
    return checkbox;
  });
  const [enabled, discussions, previews] = controls;
  const update = () => {
    discussions.disabled = previews.disabled = !enabled.checked;
  };
  for (const control of controls)
    control.addEventListener('change', () => {
      const previous = state.notifications || defaultNotifications;
      controls.forEach((checkbox) => {
        checkbox.disabled = true;
      });
      void (async () => {
        try {
          await api.setNotifications({
            enabled: enabled.checked,
            discussions: discussions.checked,
            previews: previews.checked,
          });
          await refresh();
        } catch (error) {
          [enabled.checked, discussions.checked, previews.checked] = [
            previous.enabled,
            previous.discussions,
            previous.previews,
          ];
          notify(
            error instanceof Error ? error.message : 'Could not save notification settings.',
            true,
          );
        } finally {
          enabled.disabled = false;
          update();
        }
      })();
    });
  const test = button(
    'Test notification',
    () =>
      void action(async () => {
        await api.testNotification();
        notify('Test notification requested. Check your desktop notifications.');
      }),
  );
  test.disabled = state.notificationsSupported === false;
  group.append(
    test,
    e(
      'p',
      'muted',
      state.notificationsSupported === false
        ? 'Your desktop notification service is unavailable. Check your operating system notification settings.'
        : 'New mail alerts appear while PacketLark is open in the background. Your operating system controls sound and Do Not Disturb.',
    ),
  );
  update();
  body.append(group);
}
function contactDialog(name = '', address = '') {
  const { body, close } = dialog('Save contact');
  const form = e('form');
  const n = field(form, 'Name', name),
    a = field(form, 'FidoNet address', address);
  n.required = a.required = true;
  const submit = e('button', 'primary', 'Save contact');
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      await api.contact(n.value, a.value);
      close();
    });
  });
  body.append(form);
}
function areasDialog() {
  const { box, body } = dialog('Manage discussions');
  box.classList.add('discussion-browser');
  let busy = false,
    limit = 100;
  body.append(
    e(
      'p',
      'muted',
      'Find conversations offered by your provider. Joining sends a request; the provider confirms it after processing your mail.',
    ),
  );
  const controls = e('div', 'discussion-controls');
  const listRequest = button(
    'Get available discussions',
    () => run(() => api.requestAreaList()),
    'primary',
  );
  const check = button('Check for replies', () => run(() => Promise.resolve()));
  controls.append(listRequest, check);
  const progress = e('p', 'discussion-progress muted');
  progress.setAttribute('role', 'status');
  const filters = e('div', 'form-row');
  const find = field(filters, 'Search discussions', '', 'search');
  find.placeholder = 'Search by name or tag';
  const filterWrap = e('label', 'field');
  filterWrap.append(e('span', '', 'Show'));
  const filter = e('select');
  for (const [value, title] of [
    ['all', 'All discussions'],
    ['joined', 'Joined'],
    ['left', 'Not joined'],
    ['pending', 'Pending requests'],
  ])
    filter.append(new Option(title, value));
  filterWrap.append(filter);
  filters.append(filterWrap);
  const count = e('p', 'muted');
  const results = e('ul', 'discussion-results');
  results.setAttribute('aria-label', 'Available discussions');
  const more = button('Show more discussions', () => {
    limit += 100;
    draw();
  });
  const manual = e('details', 'discussion-manual');
  manual.append(e('summary', '', 'Join or leave using a tag'));
  const tag = field(manual, 'Discussion tag');
  tag.placeholder = 'Enter an exact echo tag';
  manual.append(
    button('Request to join', () => change(tag.value.trim().toUpperCase(), true)),
    button('Request to leave', () => change(tag.value.trim().toUpperCase(), false)),
  );
  body.append(controls, progress, filters, count, results, more, manual);
  function run(fn: () => Promise<unknown>) {
    if (busy || state.syncing) return;
    busy = true;
    draw();
    void action(async () => {
      await fn();
      await refresh();
      await api.sync();
    }).finally(() => {
      busy = false;
      if (box.open) draw();
    });
  }
  function change(value: string, join: boolean) {
    run(() => api.areaCommand(value, join));
  }
  function draw() {
    const directory = state.discussions;
    const outbox = new Set(
      directory.queued ?? state.messages.filter((m) => m.folder === 'outbox').map((m) => m.id),
    );
    const waiting = !!directory.requestId && outbox.has(directory.requestId);
    listRequest.disabled = busy || state.syncing || waiting;
    check.disabled = busy || state.syncing;
    listRequest.textContent = directory.updatedAt
      ? 'Refresh discussions'
      : 'Get available discussions';
    const messages = [
      state.syncing
        ? 'Exchanging mail…'
        : waiting
          ? 'List request queued.'
          : directory.updatedAt &&
              (!directory.requestedAt ||
                Date.parse(directory.updatedAt) >= Date.parse(directory.requestedAt))
            ? 'List received. You can check for more replies or refresh for changes.'
            : directory.requestedAt
              ? 'List requested. Check for replies after your provider processes the request.'
              : 'Get the list to discover discussions you can join.',
    ];
    if (directory.updatedAt)
      messages.push(
        `List last received: ${date(directory.updatedAt)}. Cached entries remain available offline.`,
      );
    if (directory.error) messages.push(directory.error);
    progress.textContent = messages.join(' ');
    progress.classList.toggle('failed', !!directory.error);
    // Existing profile groups and old mailbox areas remain available before the first list reply.
    const entries = new Map<string, Discussion>(
      state.areas.map((a) => [
        a.tag,
        {
          ...a,
          subscription: 'unknown',
          confirmedAt: null,
          pending: null,
          error: '',
        },
      ]),
    );
    for (const entry of directory.entries) entries.set(entry.tag, entry);
    const term = find.value.trim().toLocaleLowerCase();
    const matching = [...entries.values()]
      .filter(
        (a) =>
          (!term || `${a.tag} ${a.name}`.toLocaleLowerCase().includes(term)) &&
          (filter.value === 'all' ||
            (filter.value === 'pending' ? !!a.pending : a.subscription === filter.value)),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.tag.localeCompare(b.tag));
    count.textContent = `${matching.length} discussion${matching.length === 1 ? '' : 's'}${matching.length > limit ? ` · showing ${limit}` : ''}`;
    const focused = results.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.area
      : null;
    const scroll = results.scrollTop;
    results.replaceChildren();
    for (const area of matching.slice(0, limit)) {
      const row = e('li', 'discussion-row');
      const info = e('div', 'discussion-info');
      info.append(e('strong', '', area.name), e('span', 'address muted', area.tag));
      const status = area.pending
        ? `${area.pending.action === 'join' ? 'Join' : 'Leave'} ${outbox.has(area.pending.messageId) ? 'queued' : 'awaiting confirmation'}`
        : area.subscription === 'joined'
          ? 'Joined'
          : area.subscription === 'left'
            ? 'Not joined'
            : 'Subscription not checked';
      const badge = e(
        'span',
        `discussion-badge ${area.pending ? 'pending' : area.subscription}`,
        status,
      );
      info.append(badge);
      if (area.error) info.append(e('span', 'failed', area.error));
      const join = area.pending ? area.pending.action === 'join' : area.subscription !== 'joined';
      const label = `${area.pending ? 'Retry ' : ''}${join ? 'join' : 'leave'}`;
      const control = button(label[0].toUpperCase() + label.slice(1), () => change(area.tag, join));
      control.setAttribute('aria-label', `${label[0].toUpperCase() + label.slice(1)} ${area.tag}`);
      control.dataset.area = area.tag;
      control.disabled =
        busy || state.syncing || !!(area.pending && outbox.has(area.pending.messageId));
      row.append(info, control);
      results.append(row);
    }
    if (!matching.length)
      results.append(
        e(
          'li',
          'empty-list',
          entries.size
            ? 'No matching discussions.'
            : directory.updatedAt
              ? 'Your provider returned no available discussions. Contact your sysop if you expected more.'
              : 'No list yet. Click Get available discussions to request it.',
        ),
      );
    results.scrollTop = scroll;
    if (focused)
      [...results.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.dataset.area === focused)
        ?.focus({ preventScroll: true });
    more.hidden = matching.length <= limit;
    for (const control of manual.querySelectorAll('button'))
      control.disabled = busy || state.syncing;
  }
  find.addEventListener('input', () => {
    limit = 100;
    draw();
  });
  filter.addEventListener('change', () => {
    limit = 100;
    draw();
  });
  renderDiscussions = draw;
  box.addEventListener('close', () => {
    if (renderDiscussions === draw) renderDiscussions = null;
  });
  draw();
}

function details(m: Message) {
  const { body } = dialog('Message details');
  body.append(
    e(
      'p',
      '',
      `Message ID: ${m.msgid || '(not supplied)'}\nReply ID: ${m.replyId || '(none)'}\nFrom: ${m.fromAddress}\nTo: ${m.toAddress}`,
    ),
    e(
      'pre',
      'technical',
      m.raw || 'Outgoing message. Transport headers are generated when queued.',
    ),
  );
}
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'n') {
    event.preventDefault();
    openCompose();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'f' && !composer) {
    event.preventDefault();
    search.focus();
  }
});
if (api) {
  api.onNotification?.((id) => {
    pendingNotification = id;
    void refresh().catch((error) => notify(String(error), true));
  });
  api.onChanged((update?: RuntimeUpdate) => {
    if (state && update && state.revision !== undefined && update.revision < state.revision) return;
    if (state && update && !refreshing && state.revision === update.revision) {
      const changedSync = state.syncing !== update.syncing;
      state = { ...state, syncing: update.syncing, status: update.status || state.status };
      renderRuntime();
      if (changedSync) renderDiscussions?.();
      return;
    }
    refreshTimer ??= setTimeout(() => {
      refreshTimer = undefined;
      void refresh().catch((e) => notify(String(e), true));
    }, 16);
  });
  void refresh().catch((e) => notify(String(e), true));
} else {
  app.replaceChildren(
    e(
      'p',
      'notice warning',
      'Open PacketLark with npm run dev or an installed desktop build. The browser alone cannot access your mailbox.',
    ),
  );
}
