import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { address, formatAddress, profileSchema, composeSchema } from '../src/core/model.js';
import { buildPacket, parsePacket, unpackMail } from '../src/core/packet.js';
import { profile, compose, incomingPacket } from './fixtures.js';

describe('FTN accounts and wire packets', () => {
  it('validates and normalizes a point account', () => {
    expect(profileSchema.parse(profile)).toEqual(profile);
    expect(formatAddress(address('1:123/456.100@FIDONET'), true)).toBe(profile.address);
  });
  it('imports original RetroPost account files after the PacketLark rename', () => {
    const legacy = { ...profile, format: 'retropost-account' };
    expect(profileSchema.parse(legacy).address).toBe(profile.address);
    expect(() => profileSchema.parse({ ...profile, format: 'unrecognized-account' })).toThrow();
  });
  it.each(['0:1/2', '1:65536/2', '1:1/2.-1', '1:1/2@bad domain'])(
    'rejects invalid address %s',
    (s) => expect(() => address(s)).toThrow(),
  );
  it('requires a matching boss node and point', () => {
    expect(() => profileSchema.parse({ ...profile, address: '1:999/456.100' })).toThrow();
    expect(() => profileSchema.parse({ ...profile, address: profile.uplink.address })).toThrow();
  });
  it('rejects control-line injection in composition', () => {
    expect(() => composeSchema.parse({ ...compose, body: 'Hello\n\x01TOPT 3' })).toThrow();
  });
  it('writes a 58-byte Type-2+ header with point and auxnet fields', () => {
    const pkt = buildPacket(profile, compose, '1:123/456.100 deadbeef');
    expect(pkt.readUInt16LE(18)).toBe(2);
    expect(pkt.readUInt16LE(20)).toBe(65535);
    expect(pkt.readUInt16LE(38)).toBe(123);
    expect(pkt.readUInt16LE(50)).toBe(100);
    expect(pkt.readUInt16LE(52)).toBe(0);
    expect(pkt.readUInt16LE(40)).toBe(0x100);
    expect(pkt.readUInt16LE(44)).toBe(1);
    expect(pkt.toString('utf8')).toContain('\x01TOPT 9\r');
    expect(pkt.toString('utf8')).toContain('\x01FMPT 100\r');
  });
  it('reads a direct message addressed to the point', () => {
    const [m] = parsePacket(incomingPacket(), profile);
    expect(m.toAddress).toBe('1:123/456.100');
    expect(m.fromAddress).toBe('1:123/456');
    expect(m.body).toContain('Hello from PacketLark.\nSecond line.');
    expect(m.msgid).toBe('1:123/456 abcdef01');
  });
  it('supports UTF-8 names and content', () => {
    const [m] = parsePacket(incomingPacket({ body: 'Café — hello 🌲' }), profile);
    expect(m.body).toBe('Café — hello 🌲');
  });
  it('reads CP437 messages when explicitly declared', () => {
    const server = {
      ...profile,
      charset: 'CP437' as const,
      name: 'Sysop',
      address: profile.uplink.address,
      uplink: { ...profile.uplink, address: profile.address },
    };
    const packet = buildPacket(
      server,
      { ...compose, toAddress: profile.address, body: 'Café' },
      '1:123/456 dead0001',
    );
    expect(parsePacket(packet, profile)[0].body).toBe('Café');
  });
  it('rejects characters that would silently corrupt legacy encodings', () =>
    expect(() =>
      buildPacket({ ...profile, charset: 'CP437' }, { ...compose, body: 'Hello 🌲' }, 'id'),
    ).toThrow('cannot be sent'));
  it('uses the origin line for an echomail sender, preserving point identity', () => {
    const [m] = parsePacket(incomingPacket({ area: 'TEST', body: 'Discussion text' }), profile);
    expect(m.area).toBe('TEST');
    expect(m.fromAddress).toBe('1:123/456');
    expect(m.body).not.toContain('\x01');
    expect(m.raw).toContain('SEEN-BY:');
  });
  it('prevents typed routing lines from becoming metadata', () => {
    const pkt = buildPacket(
      profile,
      { ...compose, body: 'AREA:FAKE\nSEEN-BY: 1/2\n * Origin: Fake (1:1/1)' },
      'id',
    );
    expect(pkt.toString()).toContain('\r AREA:FAKE\r SEEN-BY:');
  });
  it('leaves routing to the boss when a terminal point originates echomail', () => {
    const pkt = buildPacket(profile, { ...compose, area: 'TEST' }, 'id').toString();
    expect(pkt).not.toContain('\x01PATH:');
    expect(pkt).not.toContain('\rSEEN-BY:');
    expect(pkt).toContain('(1:123/456.100)');
  });
  it('keeps the origin line within 79 encoded bytes', () => {
    const pkt = buildPacket(
      { ...profile, provider: 'é'.repeat(80) },
      { ...compose, area: 'TEST' },
      'id',
    ).toString();
    const origin = pkt.split('\r').find((s) => s.startsWith(' * Origin:'))!;
    expect(Buffer.byteLength(origin)).toBeLessThanOrEqual(79);
  });
  it('rejects wrong packet passwords', () => {
    const b = incomingPacket();
    b[26] = 88;
    expect(() => parsePacket(b, profile)).toThrow('password');
  });
  it('rejects packets for another point', () => {
    const b = incomingPacket();
    b.writeUInt16LE(101, 52);
    expect(() => parsePacket(b, profile)).toThrow('envelope');
  });
  it('rejects misrouted individual netmail inside a correctly addressed envelope', () =>
    expect(() => parsePacket(incomingPacket({ toAddress: '1:123/456.101' }), profile)).toThrow(
      'another point',
    ));
  it('rejects truncated packets and unexpected trailing data', () => {
    const b = incomingPacket();
    expect(() => parsePacket(b.subarray(0, b.length - 1), profile)).toThrow();
    expect(() => parsePacket(Buffer.concat([b, Buffer.from([1])]), profile)).toThrow();
  });
  it('accepts ZIP mail bundles without extracting files', () => {
    const zip = Buffer.from(zipSync({ 'mail.pkt': incomingPacket() }));
    expect(unpackMail(zip, profile)).toHaveLength(1);
  });
  it('rejects archive traversal and unrelated attachments', () => {
    for (const name of ['../mail.pkt', 'payload.exe', 'nested/mail.pkt']) {
      expect(() => unpackMail(Buffer.from(zipSync({ [name]: strToU8('bad') })), profile)).toThrow(
        'unsupported entry',
      );
    }
  });
  it('rejects archive bombs before inflating their contents', () => {
    const zip = Buffer.from(zipSync({ 'huge.pkt': new Uint8Array(17 * 1024 * 1024) }));
    expect(() => unpackMail(zip, profile)).toThrow('limit');
  });
});
