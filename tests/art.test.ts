import { expect, it } from 'vitest';
import { hasArt, plainMessageText, renderAnsi } from '../src/core/art.js';

const text = (source: string) => renderAnsi(source).lines.map((l) => l.map((r) => r.text).join(''));

it('keeps normal prose detection quiet, and detects common DOS block and box drawings', () => {
  expect(hasArt('Hello, Mike!')).toBe(false);
  expect(hasArt('  ╔══╗\n  ╚══╝')).toBe(true);
  expect(hasArt('\x1b[1;36mANSI')).toBe(true);
});

it('renders DOS bright colors, iCE backgrounds, extended colors, and resets', () => {
  expect(renderAnsi('\x1b[1;36;5;44m┌\x1b[0m!\x1b[38;2;1;2;3;48;5;244m.').lines).toEqual([
    [
      { text: '┌', foreground: '#55ffff', background: '#5555ff', underline: false },
      { text: '!', foreground: '#aaaaaa', background: '#000000', underline: false },
      { text: '.', foreground: 'rgb(1, 2, 3)', background: 'rgb(128, 128, 128)', underline: false },
    ],
  ]);
});

it('places glyphs at cursor positions, clears, saves and restores position', () => {
  expect(text('discard me\x1b[2J\x1b[2;4H├\x1b[s\x1b[1;2H┌\x1b[u─')).toEqual([' ┌', '   ├─']);
  expect(text('ABCDE\x1b[3D\x1b[K').at(0)?.trimEnd()).toBe('AB');
});

it('wraps DOS art at 80 columns without adding a blank row before a line break', () => {
  const row = '─'.repeat(80);
  expect(text(`${row}\nX`)).toEqual([row, 'X']);
  expect(text(`${row}X`)).toEqual([row, 'X']);
});

it('ignores terminal titles, links, clipboard and private commands and gives clean reply text', () => {
  const body =
    '\x1b]52;c;clipboard\x07\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x07' +
    '\x1bPignored\x1b\\\x1b[?1049h\x1b[31m literal <script>\x1b[0m';
  expect(plainMessageText(body)).toBe('link literal <script>');
  expect(text(body)).toEqual(['link literal <script>']);
  expect(plainMessageText('hello\x1b]52;unterminated')).toBe('hello');
});

it('bounds huge cursor jumps and long graphics while retaining readable text', () => {
  const body = '\x1b[99999999;99999999HX\x1b[Hvisible';
  expect(renderAnsi(body)).toMatchObject({ limited: true });
  expect(text(body)).toEqual(['visible']);
  expect(renderAnsi('X'.repeat(300000)).lines).toHaveLength(512);
  expect(plainMessageText(body)).toBe('Xvisible');
});
