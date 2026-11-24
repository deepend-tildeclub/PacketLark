import { contextBridge, ipcRenderer } from 'electron';
import type { Api, RuntimeUpdate } from '../core/model.js';
async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(name, ...args)) as {
    ok: boolean;
    value: T;
    error?: string;
  };
  if (!result.ok) throw new Error(result.error || 'The operation failed.');
  return result.value;
}
const api: Api = {
  state: () => call('state'),
  importAccount: () => call('import'),
  setupAccount: (value) => call('setupAccount', value),
  sync: (id) => call('sync', id),
  syncAll: () => call('syncAll'),
  selectAccount: (id) => call('selectAccount', id),
  pauseAccount: (id, paused) => call('pauseAccount', id, paused),
  updateConnection: (value, id) => call('updateConnection', value, id),
  restoreMailbox: (id) => call('restoreMailbox', id),
  cancelDiscussionRequests: (id) => call('cancelDiscussionRequests', id),
  allUnread: (order, offset) => call('allUnread', order, offset),
  saveDraft: (v, id) => call('draft', v, id),
  queue: (v, id) => call('queue', v, id),
  mark: (id, patch, account) => call('mark', id, patch, account),
  removeDraft: (id, account) => call('removeDraft', id, account),
  trashMessage: (id, account) => call('trashMessage', id, account),
  restoreMessage: (id, account) => call('restoreMessage', id, account),
  deleteMessage: (id, account) => call('deleteMessage', id, account),
  contact: (name, address, account) => call('contact', name, address, account),
  areaCommand: (tag, subscribe, account) => call('area', tag, subscribe, account),
  requestAreaList: (account) => call('areaList', account),
  backup: (account) => call('backup', account),
  setNotifications: (value) => call('notifications', value),
  testNotification: () => call('testNotification'),
  setReading: (value) => call('reading', value),
  setDesktop: (value) => call('desktop', value),
  setCheckOnStartup: (value) => call('setCheckOnStartup', value),
  markConversationRead: (id, account) => call('markConversationRead', id, account),
  onPrepareQuit(cb) {
    const listener = (_event: Electron.IpcRendererEvent, token: unknown) => {
      if (
        typeof token !== 'string' ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(token)
      )
        return;
      void Promise.resolve()
        .then(cb)
        .catch(() => false)
        .then((saved) => call('finishQuit', token, saved === true))
        .catch(() => {});
    };
    ipcRenderer.on('desktop:prepareQuit', listener);
    return () => ipcRenderer.removeListener('desktop:prepareQuit', listener);
  },
  onNotification(cb) {
    const listener = (_event: Electron.IpcRendererEvent, id: unknown, account: unknown) => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
      if (account === undefined) cb(id);
      else if (
        typeof account === 'string' &&
        /^(?:primary|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(account)
      )
        cb(id, account);
    };
    ipcRenderer.on('notification:open', listener);
    return () => ipcRenderer.removeListener('notification:open', listener);
  },
  onChanged(cb) {
    const listener = (_event: Electron.IpcRendererEvent, update?: RuntimeUpdate) => cb(update);
    ipcRenderer.on('changed', listener);
    return () => ipcRenderer.removeListener('changed', listener);
  },
};
contextBridge.exposeInMainWorld('packetlark', api);
