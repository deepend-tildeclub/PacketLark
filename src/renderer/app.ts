import type { Api, Compose, Message, State } from '../core/model.js';
import './style.css';
declare global {
  interface Window {
    packetlark: Api;
  }
}
const api = window.packetlark;
let state: State,
  folder = 'inbox',
  selection = '',
  query = '',
  unreadOnly = false;
let composer: HTMLDialogElement | null = null,
  refreshing = false,
  refreshAgain = false;
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
function date(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
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
listPanel.append(listHeading, messageList);
workspace.append(sidebar, listPanel, reader);
const footer = e('footer', 'statusbar');
footer.setAttribute('role', 'status');
app.append(toolbar, workspace, footer);
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      state = await api.state();
      render();
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
}
function render() {
  composeButton.disabled = !state.account;
  syncButton.disabled = !state.account || state.syncing;
  syncButton.textContent = state.syncing ? '↻ Connecting…' : '↻ Send & receive';
  footer.replaceChildren(
    e('span', state.syncing ? 'working' : '', `${state.syncing ? '● ' : '● '}${state.status}`),
    e(
      'span',
      '',
      state.lastSync
        ? `Last exchange: ${date(state.lastSync)}`
        : 'Offline reading · FidoNet messaging',
    ),
  );
  sidebar.replaceChildren();
  const label = e('div', 'section-label', state.account?.provider || 'RETRODIGITAL BBS');
  sidebar.append(label);
  const folders = [
    ['inbox', 'Inbox'],
    ['sent', 'Sent'],
    ['drafts', 'Drafts'],
    ['outbox', 'Outbox'],
    ['starred', 'Starred'],
    ['contacts', 'Contacts'],
  ];
  for (const [id, title] of folders) {
    const count = state.messages.filter((m) =>
      id === 'starred'
        ? m.starred
        : id === 'inbox'
          ? m.folder === 'inbox' && !m.area && !m.read
          : m.folder === id,
    ).length;
    const b = button(
      title,
      () => {
        folder = id;
        selection = '';
        query = '';
        search.value = '';
        renderMailbox();
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
    const count = state.messages.filter(
      (m) => m.area === area.tag && m.folder === 'inbox' && !m.read,
    ).length;
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
  renderMailbox();
}
function renderMailbox() {
  if (!state) return;
  listHeading.replaceChildren();
  messageList.replaceChildren();
  reader.replaceChildren();
  if (!state.account) {
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
  listHeading.append(filter);
  const messages = state.messages
    .filter((m) => {
      const match = area
        ? m.area === area && m.folder === 'inbox'
        : folder === 'starred'
          ? m.starred
          : folder === 'inbox'
            ? m.folder === 'inbox' && !m.area
            : m.folder === folder;
      return (
        match &&
        (!unreadOnly || !m.read) &&
        (!query ||
          `${m.from} ${m.to} ${m.subject} ${m.body}`.toLowerCase().includes(query.toLowerCase()))
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!messages.length)
    messageList.append(
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
  for (const m of messages) {
    const b = button(
      '',
      () => {
        selection = m.id;
        if (m.folder === 'drafts') openCompose({ ...m, replyId: m.replyId });
        else void action(() => api.mark(m.id, { read: true }));
        renderMailbox();
      },
      `message-row ${selection === m.id ? 'selected ' : ''}${!m.read ? 'unread' : ''}`,
    );
    const top = e('div', 'row-top');
    top.append(
      e('span', 'sender', m.folder === 'inbox' ? m.from : `To: ${m.to}`),
      e('time', '', date(m.date)),
    );
    b.append(
      top,
      e('div', 'subject', `${m.starred ? '★ ' : ''}${m.subject || '(No subject)'}`),
      e('p', 'preview', m.body.replace(/\n/g, ' ').slice(0, 140)),
    );
    if (m.folder === 'outbox')
      b.append(
        e(
          'span',
          m.error ? 'delivery failed' : 'delivery',
          m.error ? 'Needs retry' : 'Queued for next exchange',
        ),
      );
    messageList.append(b);
  }
  const selected = state.messages.find((m) => m.id === selection);
  if (selected) renderMessage(selected);
  else {
    const empty = e('div', 'empty-reader');
    empty.append(
      e('div', 'letter-icon', '✉'),
      e('h2', '', 'A little space for conversation.'),
      e('p', '', 'Choose a message to read it.'),
    );
    reader.append(empty);
  }
}
function renderMessage(m: Message) {
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
  if (m.folder !== 'drafts') {
    actions.append(
      button(m.area ? 'Reply to discussion' : 'Reply', () => reply(m, false), 'primary'),
      button(
        m.starred ? '★ Starred' : '☆ Star',
        () => void action(() => api.mark(m.id, { starred: !m.starred })),
      ),
    );
    if (m.area) actions.append(button('Reply privately', () => reply(m, true)));
    actions.append(
      button(
        m.read ? 'Mark unread' : 'Mark read',
        () => void action(() => api.mark(m.id, { read: !m.read })),
      ),
      button('Save contact', () => contactDialog(m.from, m.fromAddress)),
      button('Details', () => details(m)),
    );
  } else
    actions.append(
      button('Edit draft', () => openCompose({ ...m }), 'primary'),
      button('Delete draft', () => void action(() => api.removeDraft(m.id))),
    );
  head.append(actions);
  reader.append(head);
  if (m.folder === 'sent')
    reader.append(
      e(
        'div',
        'notice',
        'Accepted by your provider. This does not confirm delivery or that the recipient has read it.',
      ),
    );
  if (m.error) reader.append(e('div', 'notice warning', m.error));
  // Thread only on explicit FTN MSGID/REPLY links within the same area. Never merge by subject.
  const thread: Message[] = [];
  const seen = new Set<string>();
  let current: Message | undefined = m;
  while (current && !seen.has(current.id) && thread.length < 50) {
    thread.unshift(current);
    seen.add(current.id);
    const previous: string = current.replyId;
    current = previous
      ? state.messages.find((x) => x.msgid === previous && x.area === m.area)
      : undefined;
  }
  for (const part of thread) {
    const article = e('article', 'message-body');
    if (thread.length > 1)
      article.append(e('h2', 'thread-author', `${part.from} · ${date(part.date)}`));
    const text = e('pre', 'body-text', part.body);
    article.append(text);
    reader.append(article);
  }
  const responses = state.messages.filter(
    (x) => m.msgid && x.replyId === m.msgid && x.area === m.area && !seen.has(x.id),
  );
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
        send.disabled = false;
      }
    })();
  });
  buttons.append(
    send,
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
  if (state.storageWarning)
    body.append(
      e(
        'p',
        'notice warning',
        'Unlock your operating system keyring before importing or using an account.',
      ),
    );
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
  const { body, close } = dialog('Manage discussions');
  body.append(
    e(
      'p',
      '',
      'Join or leave by discussion tag. Requests travel as messages; your provider’s reply confirms the result. New groups appear when their first post arrives.',
    ),
  );
  const input = field(body, 'Discussion tag', '');
  input.placeholder = 'SYNCHRONET';
  body.append(
    button(
      'Request to join',
      () =>
        void action(async () => {
          await api.areaCommand(input.value.trim().toUpperCase(), true);
          close();
        }),
      'primary',
    ),
    button(
      'Request to leave',
      () =>
        void action(async () => {
          await api.areaCommand(input.value.trim().toUpperCase(), false);
          close();
        }),
    ),
  );
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
  api.onChanged(() => {
    void refresh().catch((e) => notify(String(e), true));
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
