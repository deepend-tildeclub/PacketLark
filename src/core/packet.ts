import { createHash, randomBytes, randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import { unzipSync } from 'fflate';
import {
  address,
  formatAddress,
  sameAddress,
  type Compose,
  type Message,
  type Profile,
} from './model.js';

export const MAX_FILE = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const word = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function ftnDate(d = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())} ${months[d.getMonth()]} ${two(d.getFullYear() % 100)}  ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
function decodeDate(s: string, zone?: string): string {
  const m = /^(\d{2}) ([A-Za-z]{3}) (\d{2}) {2}(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return s;
  const month = months.indexOf(m[2]);
  if (month < 0) return s;
  const year = +m[3] + (+m[3] >= 80 ? 1900 : 2000);
  if (zone && /^[+-]\d{4}$/.test(zone)) {
    const minutes = (+zone.slice(1, 3) * 60 + +zone.slice(3)) * (zone[0] === '-' ? -1 : 1);
    return new Date(
      Date.UTC(year, month, +m[1], +m[4], +m[5], +m[6]) - minutes * 60000,
    ).toISOString();
  }
  return new Date(year, month, +m[1], +m[4], +m[5], +m[6]).toISOString();
}
export function newMsgId(profile: Profile): string {
  return `${formatAddress(address(profile.address))} ${randomBytes(4).toString('hex')}`;
}
function encoded(value: string, encoding: string, limit?: number): Buffer {
  const b = iconv.encode(value, encoding);
  if (iconv.decode(b, encoding) !== value)
    throw new Error(
      `Some characters cannot be sent using ${encoding}. Ask your provider about UTF-8.`,
    );
  if (limit && b.length > limit)
    throw new Error(
      `A message header exceeds ${limit} encoded bytes. Shorten the name or subject.`,
    );
  return Buffer.concat([b, Buffer.from([0])]);
}
export function buildPacket(
  profile: Profile,
  msg: Compose,
  msgid: string,
  when = new Date(),
): Buffer {
  const from = address(profile.address),
    boss = address(profile.uplink.address),
    to = address(msg.toAddress);
  if (to.domain !== from.domain)
    throw new Error('This account can send only within its configured FTN network.');
  const h = Buffer.alloc(58);
  const fields: [number, number][] = [
    [0, from.node],
    [2, boss.node],
    [4, when.getFullYear()],
    [6, when.getMonth()],
    [8, when.getDate()],
    [10, when.getHours()],
    [12, when.getMinutes()],
    [14, when.getSeconds()],
    [18, 2],
    [20, from.point ? 65535 : from.net],
    [22, boss.net],
    [34, from.zone],
    [36, boss.zone],
    [38, from.net],
    [40, 0x100],
    [44, 1],
    [46, from.zone],
    [48, boss.zone],
    [50, from.point],
    [52, boss.point],
  ];
  for (const [offset, value] of fields) h.writeUInt16LE(value, offset);
  // 0xffff is the unregistered FTN product identifier; don't impersonate an existing mailer.
  h[24] = 0xff;
  h[42] = 0xff;
  Buffer.from(profile.uplink.packetPassword, 'ascii').copy(h, 26, 0, 8);
  const lines: string[] = [];
  if (msg.area) lines.push(`AREA:${msg.area}`);
  else {
    lines.push(`\x01INTL ${to.zone}:${to.net}/${to.node} ${from.zone}:${from.net}/${from.node}`);
    if (from.point) lines.push(`\x01FMPT ${from.point}`);
    if (to.point) lines.push(`\x01TOPT ${to.point}`);
  }
  lines.push(`\x01MSGID: ${msgid}`);
  if (msg.replyId) lines.push(`\x01REPLY: ${msg.replyId}`);
  const offset = -when.getTimezoneOffset(),
    abs = Math.abs(offset);
  lines.push(
    `\x01CHRS: ${profile.charset} ${profile.charset === 'UTF-8' ? '4' : '2'}`,
    '\x01PID: PacketLark 0.1',
    `\x01TZUTC: ${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`,
  );
  // Prevent typed control/AREA/SEEN-BY lines from becoming routing metadata.
  const body = msg.body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((s) => (/^(AREA:|SEEN-BY:| \* Origin:|---(?: |$))/.test(s) ? ` ${s}` : s))
    .join('\r');
  lines.push(body);
  if (msg.area) {
    const suffix = ` (${formatAddress(from)})`;
    let origin = profile.provider;
    while (iconv.encode(` * Origin: ${origin}${suffix}`, profile.charset).length > 79)
      origin = Array.from(origin).slice(0, -1).join('');
    lines.push('--- PacketLark 0.1', ` * Origin: ${origin}${suffix}`);
    // A terminal point must not claim its boss has already routed this post.
    // The boss tosser adds network routing lines when it exports the message.
    if (!from.point)
      lines.push(`SEEN-BY: ${from.net}/${from.node}`, `\x01PATH: ${from.net}/${from.node}`);
  }
  const encoding = profile.charset;
  return Buffer.concat([
    h,
    word(2),
    word(from.node),
    word(to.node),
    word(from.net),
    word(to.net),
    word(msg.area ? 0 : 1),
    word(0),
    Buffer.from(ftnDate(when) + '\0', 'ascii'),
    encoded(msg.to, encoding, 35),
    encoded(profile.name, encoding, 35),
    encoded(msg.subject, encoding, 71),
    encoded(lines.join('\r') + '\r', encoding),
    word(0),
  ]);
}

export function parsePacket(bytes: Buffer, profile: Profile): Message[] {
  if (bytes.length < 60 || bytes.length > MAX_FILE || bytes.readUInt16LE(18) !== 2)
    throw new Error('Invalid or unsupported FTN packet.');
  const u = (o: number) => bytes.readUInt16LE(o);
  const plus = u(44) === ((u(40) >> 8) | ((u(40) & 255) << 8)) && (u(44) & 1) !== 0;
  if (!plus)
    throw new Error(
      'This point client requires Type-2+ packets. Set PacketType=2+ on the provider.',
    );
  const local = address(profile.address),
    boss = address(profile.uplink.address);
  const origin = {
    zone: u(46) || u(34),
    net: u(20) === 65535 ? u(38) : u(20),
    node: u(0),
    point: u(50),
    domain: local.domain,
  };
  const dest = { zone: u(48) || u(36), net: u(22), node: u(2), point: u(52), domain: local.domain };
  if (
    !sameAddress(formatAddress(origin, true), profile.uplink.address) ||
    !sameAddress(formatAddress(dest, true), profile.address)
  )
    throw new Error('Packet envelope is not from your provider to this point.');
  const password = bytes.subarray(26, 34).toString('ascii').replace(/\0.*$/s, '');
  if (password.toUpperCase() !== profile.uplink.packetPassword.toUpperCase())
    throw new Error('Packet password mismatch.');
  let pos = 58;
  const result: Message[] = [];
  const take = (max: number): Buffer => {
    const end = bytes.indexOf(0, pos);
    if (end < pos || end - pos > max) throw new Error('Truncated or oversized FTN message field.');
    const b = bytes.subarray(pos, end);
    pos = end + 1;
    return b;
  };
  let terminated = false;
  while (pos + 2 <= bytes.length) {
    const type = bytes.readUInt16LE(pos);
    pos += 2;
    if (!type) {
      terminated = true;
      break;
    }
    if (type !== 2 || pos + 12 > bytes.length || result.length >= 10000)
      throw new Error('Invalid message record.');
    const on = bytes.readUInt16LE(pos),
      dn = bytes.readUInt16LE(pos + 2),
      onet = bytes.readUInt16LE(pos + 4),
      dnet = bytes.readUInt16LE(pos + 6);
    pos += 12;
    const date = take(19).toString('ascii'),
      toBytes = take(35),
      fromBytes = take(35),
      subjectBytes = take(71),
      bodyBytes = take(256 * 1024);
    const ascii = bodyBytes.toString('latin1');
    const chrs = /\x01CHRS:\s*([\w-]+)/i.exec(ascii)?.[1] || 'CP437';
    const enc = chrs.toUpperCase() === 'UTF-8' || chrs.toUpperCase() === 'UTF8' ? 'utf8' : chrs;
    if (!iconv.encodingExists(enc))
      throw new Error(`Unsupported message encoding: ${chrs}. Packet retained by provider.`);
    const raw = iconv.decode(bodyBytes, enc).replace(/\r\n?/g, '\n');
    const lines = raw.split('\n');
    const area = /^AREA:([^\s]+)$/.exec(lines[0])?.[1] || '';
    const intl = /^\x01INTL\s+(\d+:\d+\/\d+)\s+(\d+:\d+\/\d+)/m.exec(raw);
    const originLine = /^ \* Origin:.*\((\d+:\d+\/\d+(?:\.\d+)?(?:@[\w.-]+)?)\)\s*$/m.exec(
      raw,
    )?.[1];
    let fromAddr = formatAddress({
      zone: boss.zone,
      net: onet,
      node: on,
      point: 0,
      domain: local.domain,
    });
    let toAddr = formatAddress({
      zone: local.zone,
      net: dnet,
      node: dn,
      point: 0,
      domain: local.domain,
    });
    if (area && originLine) fromAddr = originLine;
    if (!area && intl) {
      toAddr = intl[1];
      fromAddr = intl[2];
    }
    const fmpt = /^\x01FMPT\s+(\d+)/m.exec(raw)?.[1],
      topt = /^\x01TOPT\s+(\d+)/m.exec(raw)?.[1];
    if (!area && fmpt) fromAddr += `.${fmpt}`;
    if (!area && topt) toAddr += `.${topt}`;
    if (!area && !sameAddress(toAddr, profile.address))
      throw new Error('Direct message is addressed to another point.');
    const msgid = /^\x01MSGID:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    const replyId = /^\x01REPLY:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    const body = lines
      .filter(
        (line, i) => !(i === 0 && area) && !line.startsWith('\x01') && !line.startsWith('SEEN-BY:'),
      )
      .join('\n')
      .trim();
    const hash = createHash('sha256')
      .update(
        `${area}\0${msgid || Buffer.concat([fromBytes, toBytes, subjectBytes, bodyBytes]).toString('base64')}\0${fromAddr}`,
      )
      .digest('hex');
    result.push({
      id: hash,
      msgid,
      replyId,
      from: iconv.decode(fromBytes, enc),
      fromAddress: fromAddr,
      to: iconv.decode(toBytes, enc),
      toAddress: toAddr,
      subject: iconv.decode(subjectBytes, enc),
      body,
      raw,
      area,
      date: decodeDate(date, /^\x01TZUTC:\s*([+-]\d{4})/m.exec(raw)?.[1]),
      folder: 'inbox',
      read: false,
      starred: false,
      error: '',
      packetName: '',
    });
  }
  if (!terminated || pos !== bytes.length)
    throw new Error('Packet terminator is missing or trailing data is present.');
  return result;
}

export function unpackMail(file: Buffer, profile: Profile): Message[] {
  if (file.length > MAX_FILE) throw new Error('Incoming file exceeds the 16 MiB limit.');
  if (file[0] !== 0x50 || file[1] !== 0x4b) return parsePacket(file, profile);
  let total = 0,
    count = 0;
  const unpacked = unzipSync(file, {
    filter: (entry) => {
      // Nothing is extracted to disk. Still reject unexpected paths and oversized archives before inflate.
      if (!/^[\w-]+\.pkt$/i.test(entry.name))
        throw new Error('ZIP contains an unsupported entry. Only flat .pkt bundles are accepted.');
      total += entry.originalSize;
      count++;
      if (total > MAX_EXPANDED || count > 1000 || entry.originalSize > MAX_FILE)
        throw new Error('ZIP expansion limit exceeded.');
      return true;
    },
  });
  if (!count) throw new Error('Empty mail bundle.');
  return Object.values(unpacked).flatMap((b) => parsePacket(Buffer.from(b), profile));
}

export function draftMessage(profile: Profile, c: Compose, id: string = randomUUID()): Message {
  return {
    id,
    msgid: newMsgId(profile),
    replyId: c.replyId,
    from: profile.name,
    fromAddress: profile.address,
    to: c.to,
    toAddress: c.toAddress,
    subject: c.subject,
    body: c.body,
    raw: '',
    area: c.area,
    date: new Date().toISOString(),
    folder: 'drafts',
    read: true,
    starred: false,
    error: '',
    packetName: '',
  };
}
