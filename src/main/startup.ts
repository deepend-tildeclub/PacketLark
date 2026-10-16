import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../core/store.js';
const marker = '# PacketLark managed autostart\n';
export function desktopExec(executable: string): string {
  if (/[\r\n\0]/.test(executable) || !path.isAbsolute(executable))
    throw new Error('The application path cannot be used for sign-in startup.');
  // Desktop Entry string escaping is applied before Exec argument unquoting.
  return `"${executable.replace(/[\\`"$]/g, '\\$&')}" --background`
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '%%');
}
export class LoginStartup {
  constructor(
    private host: {
      platform: string;
      packaged: boolean;
      executable: string;
      configHome: string;
      login: { read(): boolean; write(enabled: boolean): void };
    },
  ) {}
  supported(): boolean {
    return this.host.packaged && ['win32', 'linux'].includes(this.host.platform);
  }
  private file(): string {
    return path.join(this.host.configHome, 'autostart', 'packetlark.desktop');
  }
  enabled(): boolean {
    if (!this.supported()) return false;
    try {
      if (this.host.platform === 'win32') return this.host.login.read();
      if (fs.lstatSync(this.file()).isSymbolicLink()) return false;
      const text = fs.readFileSync(this.file(), 'utf8');
      return (
        text.startsWith(marker) &&
        !/^\s*(?:Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/im.test(text)
      );
    } catch {
      return false;
    }
  }
  set(enabled: boolean): void {
    if (!this.supported()) {
      if (enabled)
        throw new Error('Start at sign-in is available in installed Windows and Linux builds.');
      return;
    }
    if (this.host.platform === 'win32') {
      this.host.login.write(enabled);
      return;
    }
    const file = this.file();
    let exists = false;
    try {
      const stat = fs.lstatSync(file);
      exists = true;
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        !fs.readFileSync(file, 'utf8').startsWith(marker)
      )
        throw new Error('An existing autostart entry is not managed by PacketLark.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!enabled) {
      if (exists) fs.unlinkSync(file);
      return;
    }
    atomicWrite(
      file,
      Buffer.from(
        `${marker}[Desktop Entry]\nType=Application\nVersion=1.0\nName=PacketLark\nComment=Check for new messages\nExec=${desktopExec(this.host.executable)}\nTerminal=false\n`,
      ),
    );
  }
}
