import type { Compose, Profile } from '../src/core/model.js';
import { buildPacket } from '../src/core/packet.js';
export const profile: Profile = {
  format: 'packetlark-account',
  version: 1,
  provider: 'RetroDigital BBS',
  name: 'Test Person',
  address: '1:123/456.100@fidonet',
  uplink: {
    address: '1:123/456@fidonet',
    host: '127.0.0.1',
    port: 24554,
    tls: false,
    sessionPassword: 'TESTSESSION',
    packetPassword: 'TESTPKT',
    areaFixPassword: 'TESTAREA',
  },
  areas: [{ tag: 'TEST', name: 'Test discussion' }],
  pollMinutes: 10,
  charset: 'UTF-8',
};
export const compose: Compose = {
  to: 'Other Person',
  toAddress: '1:234/567.9',
  subject: 'A real message',
  body: 'Hello from PacketLark.\nSecond line.',
  area: '',
  replyId: '',
};
export function incomingPacket(
  overrides: Partial<Compose> = {},
  charset: Profile['charset'] = profile.charset,
  chrs?: string,
): Buffer {
  const server: Profile = {
    ...profile,
    name: 'BBS Sysop',
    charset,
    address: profile.uplink.address,
    uplink: { ...profile.uplink, address: profile.address },
  };
  const packet = buildPacket(
    server,
    { ...compose, to: profile.name, toAddress: profile.address, ...overrides },
    '1:123/456 abcdef01',
    new Date(2026, 9, 14, 18, 0, 0),
  );
  if (!chrs) return packet;
  // Replace only the ASCII kludge; preserve the encoded header fields and message bytes.
  const start = packet.indexOf(Buffer.from('\x01CHRS: '));
  const end = packet.indexOf(13, start);
  return Buffer.concat([
    packet.subarray(0, start),
    Buffer.from(`\x01CHRS: ${chrs}`),
    packet.subarray(end),
  ]);
}
