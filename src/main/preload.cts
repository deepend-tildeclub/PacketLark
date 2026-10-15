import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../core/model.js';
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
  sync: () => call('sync'),
  saveDraft: (v) => call('draft', v),
  queue: (v) => call('queue', v),
  mark: (id, patch) => call('mark', id, patch),
  removeDraft: (id) => call('removeDraft', id),
  trashMessage: (id) => call('trashMessage', id),
  restoreMessage: (id) => call('restoreMessage', id),
  deleteMessage: (id) => call('deleteMessage', id),
  contact: (name, address) => call('contact', name, address),
  areaCommand: (tag, subscribe) => call('area', tag, subscribe),
  requestAreaList: () => call('areaList'),
  backup: () => call('backup'),
  onChanged(cb) {
    const listener = () => cb();
    ipcRenderer.on('changed', listener);
    return () => ipcRenderer.removeListener('changed', listener);
  },
};
contextBridge.exposeInMainWorld('packetlark', api);
