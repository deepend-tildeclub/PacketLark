import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import type { State } from '../core/model.js';
export function unreadCount(state: State): number {
  const areas = new Set(state.areas.map((a) => a.tag));
  return state.messages.filter(
    (m) => m.folder === 'inbox' && !m.read && !m.internal && (!m.area || areas.has(m.area)),
  ).length;
}
/** BGRA pixels for a small opaque unread indicator; no native graphics addon. */
export function unreadDot(): Buffer {
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 49) continue;
      const i = (y * 16 + x) * 4;
      pixels[i] = 46;
      pixels[i + 1] = 54;
      pixels[i + 2] = 180;
      pixels[i + 3] = 255;
    }
  return pixels;
}
interface TrayHandle {
  setToolTip(value: string): void;
  setContextMenu(value: unknown): void;
  setImage(value: NativeImage): void;
  on(event: string, listener: () => void): unknown;
  destroy(): void;
  isDestroyed(): boolean;
}
export class DesktopTray {
  private tray?: TrayHandle;
  private key = '';
  constructor(
    private host: {
      create(): TrayHandle;
      menu(items: MenuItemConstructorOptions[]): unknown;
      normal: NativeImage;
      unread: NativeImage;
      open(): void;
      sync(): void;
      quit(): void;
    },
  ) {}
  get available(): boolean {
    try {
      return !!this.tray && !this.tray.isDestroyed();
    } catch {
      return false;
    }
  }
  start(): boolean {
    if (this.available) return true;
    this.close();
    try {
      this.tray = this.host.create();
      this.tray.on('click', this.host.open);
      this.tray.on('double-click', this.host.open);
      this.key = '';
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  update(count: number, syncing: boolean, account: boolean): void {
    if (!this.available) return;
    const key = JSON.stringify([count, syncing, account]);
    if (this.key === key) return;
    try {
      const label = count
        ? `${count} unread message${count === 1 ? '' : 's'}`
        : 'No unread messages';
      this.tray!.setToolTip(`PacketLark — ${label}${syncing ? ' — Connecting…' : ''}`);
      this.tray!.setImage(count ? this.host.unread : this.host.normal);
      this.tray!.setContextMenu(
        this.host.menu([
          { label, enabled: false },
          { type: 'separator' },
          { label: 'Open PacketLark', click: this.host.open },
          {
            label: syncing ? 'Connecting…' : 'Send & receive',
            enabled: account && !syncing,
            click: this.host.sync,
          },
          { type: 'separator' },
          { label: 'Quit PacketLark', click: this.host.quit },
        ]),
      );
      this.key = key;
    } catch {
      this.close();
    }
  }
  close(): void {
    try {
      this.tray?.destroy();
    } catch {
      /* The desktop may already be gone. */
    }
    this.tray = undefined;
    this.key = '';
  }
}
