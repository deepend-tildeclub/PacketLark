/** Remove FTN framing without moving the first or last column of the artwork. */
export function visibleMessageBody(raw: string): string {
  return raw
    .split('\n')
    .filter(
      (line, index) =>
        !(index === 0 && /^AREA:[^\s]+$/.test(line)) &&
        !line.startsWith('\x01') &&
        !line.startsWith('SEEN-BY:'),
    )
    .join('\n')
    .replace(/\n$/, '');
}

const controlStart = /\x1b(?:\[|[78])|\x9b/;
const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
export const hasAnsi = (body: string) => controlStart.test(body);
export const hasArt = (body: string) => hasAnsi(body) || /[\u2500-\u259f]{3}/u.test(body);

type Control = (command: string, params: string) => void;

// Only CSI and the two cursor save/restore escapes can affect the art. Skip whole
// control strings so hyperlinks, clipboard commands, titles and other payloads stay inert.
function scan(input: string, text: (chunk: string) => void, command?: Control) {
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    if (!control.test(input[i])) continue;
    if (start < i) text(input.slice(start, i));
    const next = input[i + 1];
    if ((input[i] === '\x1b' && next === '[') || input[i] === '\x9b') {
      if (input[i] === '\x1b') i++;
      const begin = i + 1;
      while (input[i + 1] && /[\x20-\x3f]/.test(input[i + 1])) i++;
      const final = input[i + 1];
      if (final && /[\x40-\x7e]/.test(final)) {
        if (i - begin < 80) command?.(final, input.slice(begin, i + 1));
        i++;
      }
    } else if (
      (input[i] === '\x1b' && next && ']P^_X'.includes(next)) ||
      /[\x90\x98\x9d\x9e\x9f]/.test(input[i])
    ) {
      if (input[i] === '\x1b') i++;
      while (++i < input.length) {
        if (input[i] === '\x07' || input[i] === '\x9c') break;
        if (input[i] === '\x1b' && input[i + 1] === '\\') {
          i++;
          break;
        }
      }
    } else if (input[i] === '\x1b' && next && /[\x20-\x7e]/.test(next)) {
      if (next === '7' || next === '8') command?.(next, '');
      while (input[i + 1] && /[\x20-\x2f]/.test(input[i + 1])) i++;
      if (input[i + 1] && /[\x30-\x7e]/.test(input[i + 1])) i++;
    } else if (input[i] === '\b') command?.('backspace', '');
    start = i + 1;
  }
  if (start < input.length) text(input.slice(start));
}

export function plainMessageText(body: string): string {
  if (!control.test(body)) return body;
  const chunks: string[] = [];
  scan(body, (chunk) => chunks.push(chunk));
  return chunks.join('');
}

const palette = [
  '#000000',
  '#aa0000',
  '#00aa00',
  '#aa5500',
  '#0000aa',
  '#aa00aa',
  '#00aaaa',
  '#aaaaaa',
  '#555555',
  '#ff5555',
  '#55ff55',
  '#ffff55',
  '#5555ff',
  '#ff55ff',
  '#55ffff',
  '#ffffff',
];
const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
function indexedColor(i: number) {
  if (i < 16) return palette[i];
  if (i >= 232) {
    const grey = 8 + (i - 232) * 10;
    return rgb(grey, grey, grey);
  }
  const n = i - 16;
  const component = (c: number) => (c === 0 ? 0 : c * 40 + 55);
  return rgb(component(Math.floor(n / 36)), component(Math.floor(n / 6) % 6), component(n % 6));
}
type Color = string | number;
type Style = { foreground?: string; background?: string; underline?: boolean };
export type ArtRun = Style & { text: string };
type Cell = { char: string; style: Style };

const columns = 80;
const rows = 512;
const maxInput = 256 * 1024;
const maxErase = columns * rows * 4;

/** Static ANSI-BBS display. There is no live terminal, output channel, or animation. */
export function renderAnsi(body: string): { lines: ArtRun[][]; limited: boolean } {
  const screen: (Cell | undefined)[][] = [];
  let x = 0,
    y = 0,
    saved = [0, 0],
    wrap = false;
  let foreground: Color = 7,
    background: Color = 0;
  let bright = false,
    brightBackground = false,
    underline = false,
    reverse = false,
    hidden = false;
  let style: Style = {};
  let limited = body.length > maxInput;
  let erased = 0;
  const color = (tone: Color, high: boolean) =>
    typeof tone === 'number' ? palette[tone < 8 && high ? tone + 8 : tone] : tone;
  const setStyle = () => {
    const fg = color(foreground, bright),
      bg = color(background, brightBackground);
    style = {
      foreground: hidden ? (reverse ? fg : bg) : reverse ? bg : fg,
      background: reverse ? fg : bg,
      underline,
    };
  };
  const move = (row: number, col: number) => {
    limited ||= row >= rows;
    x = Math.max(0, Math.min(columns - 1, col));
    // Excess rows are discarded; explicit cursor moves can return to the visible display.
    y = Math.max(0, Math.min(rows, row));
    wrap = false;
  };
  const write = (char: string) => {
    if (wrap) move(y + 1, 0);
    if (y < rows) (screen[y] ??= [])[x] = { char, style };
    if (x < columns - 1) x++;
    else wrap = true;
  };
  const text = (chunk: string) => {
    for (const char of chunk) {
      if (char === '\n') move(y + 1, 0);
      else if (char === '\r') move(y, 0);
      else if (char === '\t') move(y, Math.floor(x / 8 + 1) * 8);
      else write(char);
    }
  };
  const sgr = (params: number[]) => {
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) {
        foreground = 7;
        background = 0;
        bright = brightBackground = underline = reverse = hidden = false;
      } else if (p === 1 || p === 22) bright = p === 1;
      else if (p === 4 || p === 24) underline = p === 4;
      else if (p === 5 || p === 6 || p === 25) brightBackground = p !== 25;
      else if (p === 7 || p === 27) reverse = p === 7;
      else if (p === 8 || p === 28) hidden = p === 8;
      else if (p >= 30 && p <= 37) foreground = p - 30;
      else if (p >= 40 && p <= 47) background = p - 40;
      else if (p >= 90 && p <= 97) foreground = p - 82;
      else if (p >= 100 && p <= 107) background = p - 92;
      else if (p === 39) foreground = 7;
      else if (p === 49) background = 0;
      else if (p === 38 || p === 48) {
        const mode = params[++i];
        const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
        const values = params.slice(i + 1, i + 1 + count);
        i += count;
        if (!count || values.length !== count || values.some((n) => n > 255)) continue;
        const value = count === 1 ? indexedColor(values[0]) : rgb(values[0], values[1], values[2]);
        if (p === 38) foreground = value;
        else background = value;
      }
    }
    setStyle();
  };
  const erase = (row: number, start: number, end: number) => {
    if (row >= rows) return;
    erased += end - start;
    if (erased > maxErase) {
      limited = true;
      return;
    }
    const line = (screen[row] ??= []);
    const blank = { char: ' ', style };
    for (let col = start; col < end; col++) line[col] = blank;
  };
  scan(body.slice(0, maxInput), text, (command, raw) => {
    if (!/^[\d;]*$/.test(raw)) return; // no private modes or device commands
    const p = raw.split(';').map(Number);
    const n = p[0] || 1;
    switch (command) {
      case 'm':
        sgr(p);
        break;
      case 'A':
        move(y - n, x);
        break;
      case 'B':
        move(y + n, x);
        break;
      case 'C':
        move(y, x + n);
        break;
      case 'D':
        move(y, x - n);
        break;
      case 'E':
        move(y + n, 0);
        break;
      case 'F':
        move(y - n, 0);
        break;
      case 'G':
        move(y, n - 1);
        break;
      case 'd':
        move(n - 1, x);
        break;
      case 'H':
      case 'f':
        move(n - 1, (p[1] || 1) - 1);
        break;
      case '7':
      case 's':
        saved = [y, x];
        break;
      case '8':
      case 'u':
        move(saved[0], saved[1]);
        break;
      case 'backspace':
        move(y, x - (wrap ? 0 : 1));
        break;
      case 'K':
        if (p[0] <= 2) erase(y, p[0] === 0 ? x : 0, p[0] === 1 ? x + 1 : columns);
        break;
      case 'J':
        if (p[0] === 2) {
          screen.length = 0;
          move(0, 0); // Common BBS clear-screen convention.
        } else if (p[0] === 0) {
          screen.length = Math.min(screen.length, y + 1);
          erase(y, x, columns);
        } else if (p[0] === 1 && erased <= maxErase) {
          for (let row = 0; row < Math.min(y, rows); row++) erase(row, 0, columns);
          erase(y, 0, x + 1);
        }
        break;
    }
  });
  const base: Style = {};
  return {
    lines: Array.from(screen, (line) => {
      const runs: ArtRun[] = [];
      let previous: Style | undefined;
      for (const cell of line || []) {
        const current = cell?.style || base;
        const char = cell?.char ?? ' ';
        if (previous === current) runs[runs.length - 1].text += char;
        else runs.push({ ...current, text: char });
        previous = current;
      }
      return runs;
    }),
    limited,
  };
}
