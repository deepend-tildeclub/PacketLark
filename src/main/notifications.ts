import type { NotificationConstructorOptions } from 'electron';
import { notificationMarkup, windowsToast, type MailNotice } from '../core/notifications.js';

export interface NativeNotice {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  show(): void;
  close(): void;
}

/** Keep OS failures outside the mail transaction and retain live click handlers. */
export class DesktopNotifications {
  private active = new Set<NativeNotice>();
  constructor(
    private native: {
      supported(): boolean;
      create(options: NotificationConstructorOptions): NativeNotice;
      open(messageId: string): void;
      platform: NodeJS.Platform;
      icon?: string;
    },
  ) {}
  supported(): boolean {
    try {
      return this.native.supported();
    } catch {
      return false;
    }
  }
  show(notice: MailNotice): boolean {
    if (!this.supported()) return false;
    let notification: NativeNotice | undefined;
    try {
      notification = this.native.create({
        title: notice.title,
        body: this.native.platform === 'linux' ? notificationMarkup(notice.body) : notice.body,
        icon: this.native.icon,
        ...(this.native.platform === 'win32'
          ? {
              groupId: 'packetlark-mail',
              toastXml: windowsToast(notice),
            }
          : {}),
      });
      const current = notification;
      const forget = () => {
        this.active.delete(current);
      };
      current.on('click', () => {
        try {
          this.native.open(notice.messageId);
        } catch {
          /* The window may be closing. */
        }
        forget();
      });
      current.on('close', forget);
      current.on('failed', forget);
      this.active.add(current);
      // Some notification daemons never emit close. Bound retained native handles.
      while (this.active.size > 20) {
        const oldest = this.active.values().next().value!;
        this.active.delete(oldest);
        try {
          oldest.close();
        } catch {
          /* Notification cleanup must not affect mail. */
        }
      }
      current.show();
      return true;
    } catch {
      if (notification) this.active.delete(notification);
      return false;
    }
  }
  close(): void {
    for (const notification of this.active) {
      try {
        notification.close();
      } catch {
        /* The OS service may already be gone. */
      }
    }
    this.active.clear();
  }
}
