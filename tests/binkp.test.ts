import net from 'node:net';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { CMD, exchange, frame, readFrames, type MailFile } from '../src/core/binkp.js';
import { parsePacket } from '../src/core/packet.js';
import { profile, incomingPacket } from './fixtures.js';

async function server(run: (socket: net.Socket) => Promise<void>) {
  const errors: unknown[] = [];
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
    void run(s).catch((e) => {
      errors.push(e);
      s.destroy();
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as net.AddressInfo).port;
  return {
    port,
    errors,
    close: async () => {
      for (const s of sockets) s.destroy();
      srv.close();
      await once(srv, 'close');
    },
  };
}
const challenge = '0123456789abcdef';
function hello(s: net.Socket, addr = profile.uplink.address) {
  s.write(
    Buffer.concat([
      frame(CMD.NUL, `OPT CRAM-MD5-${challenge}`),
      frame(CMD.NUL, 'VER Mock/1.0 binkp/1.0'),
      frame(CMD.ADR, addr),
    ]),
  );
}
const hooks = { receive: async () => {}, sent: async () => {}, status: () => {} };
describe('real TCP BinkP sessions', () => {
  it('authenticates with a byte-decoded challenge, imports mail, then acknowledges the committed file', async () => {
    const data = incomingPacket(),
      events: string[] = [];
    const mock = await server(async (s) => {
      hello(s);
      for await (const f of readFrames(s)) {
        if (f.command === CMD.PWD) {
          expect(f.data.toString()).toBe(
            `CRAM-MD5-${createHmac('md5', profile.uplink.sessionPassword).update(Buffer.from(challenge, 'hex')).digest('hex')}`,
          );
          s.write(frame(CMD.OK, 'secure'));
          s.write(frame(CMD.FILE, `test.pkt ${data.length} 123 0`));
          // Fragment the wire across both BinkP headers and payloads.
          const wire = frame(null, data);
          s.write(wire.subarray(0, 1));
          s.write(wire.subarray(1, 7));
          s.write(wire.subarray(7));
        }
        if (f.command === CMD.GOT) {
          events.push('ack');
          s.write(frame(CMD.EOB, ''));
        }
        if (f.command === CMD.EOB && events.includes('ack')) s.end();
      }
    });
    try {
      await exchange({ ...profile, uplink: { ...profile.uplink, port: mock.port } }, [], {
        ...hooks,
        receive: async (file) => {
          expect(parsePacket(file.bytes, profile)).toHaveLength(1);
          await new Promise((r) => setTimeout(r, 10));
          events.push('committed');
        },
      });
      expect(events).toEqual(['committed', 'ack']);
      expect(mock.errors).toEqual([]);
    } finally {
      await mock.close();
    }
  });
  it('does not acknowledge a packet when durable import fails', async () => {
    let ack = false;
    const data = incomingPacket(),
      mock = await server(async (s) => {
        hello(s);
        for await (const f of readFrames(s)) {
          if (f.command === CMD.PWD) {
            s.write(frame(CMD.OK, 'secure'));
            s.write(frame(CMD.FILE, `bad.pkt ${data.length} 123 0`));
            s.write(frame(null, data));
          }
          if (f.command === CMD.GOT) ack = true;
        }
      });
    try {
      await expect(
        exchange({ ...profile, uplink: { ...profile.uplink, port: mock.port } }, [], {
          ...hooks,
          receive: async () => {
            throw new Error('Disk full');
          },
        }),
      ).rejects.toThrow('Disk full');
      expect(ack).toBe(false);
    } finally {
      await mock.close();
    }
  });
  it('marks an outgoing file sent only on an exact matching GOT', async () => {
    const bytes = Buffer.from('outgoing packet'),
      file: MailFile = { name: '12345678.pkt', bytes, time: 100 };
    let sent = '';
    const mock = await server(async (s) => {
      hello(s);
      let got = 0;
      for await (const f of readFrames(s)) {
        if (f.command === CMD.PWD) s.write(frame(CMD.OK, 'secure'));
        if (f.command === null) {
          got += f.data.length;
          if (got === bytes.length) s.write(frame(CMD.GOT, `${file.name} ${bytes.length} 100`));
        }
        if (f.command === CMD.EOB) {
          s.write(frame(CMD.EOB, ''));
          s.end();
        }
      }
    });
    try {
      await exchange({ ...profile, uplink: { ...profile.uplink, port: mock.port } }, [file], {
        ...hooks,
        sent: async (name) => {
          sent = name;
        },
      });
      expect(sent).toBe(file.name);
      expect(mock.errors).toEqual([]);
    } finally {
      await mock.close();
    }
  });
  it('keeps an unacknowledged outgoing file queued after disconnect', async () => {
    let sent = false;
    const mock = await server(async (s) => {
      hello(s);
      for await (const f of readFrames(s)) {
        if (f.command === CMD.PWD) s.write(frame(CMD.OK, 'secure'));
        if (f.command === null) s.end();
      }
    });
    try {
      await expect(
        exchange(
          { ...profile, uplink: { ...profile.uplink, port: mock.port } },
          [{ name: '12345678.pkt', bytes: Buffer.from('test'), time: 100 }],
          {
            ...hooks,
            sent: async () => {
              sent = true;
            },
          },
        ),
      ).rejects.toThrow();
      expect(sent).toBe(false);
    } finally {
      await mock.close();
    }
  });
  it('rejects an unexpected provider address before sending a password', async () => {
    let password = false;
    const mock = await server(async (s) => {
      hello(s, '1:999/999');
      for await (const f of readFrames(s)) if (f.command === CMD.PWD) password = true;
    });
    try {
      await expect(
        exchange({ ...profile, uplink: { ...profile.uplink, port: mock.port } }, [], hooks),
      ).rejects.toThrow('expected FidoNet address');
      expect(password).toBe(false);
    } finally {
      await mock.close();
    }
  });
  it('refuses to send the session password on a plain connection without CRAM', async () => {
    const mock = await server(async (s) => {
      s.write(frame(CMD.ADR, profile.uplink.address));
      for await (const received of readFrames(s)) {
        if (received.command === CMD.PWD) throw new Error('Password leaked');
      }
    });
    try {
      await expect(
        exchange({ ...profile, uplink: { ...profile.uplink, port: mock.port } }, [], hooks),
      ).rejects.toThrow('CRAM-MD5');
    } finally {
      await mock.close();
    }
  });
  it('supports cancellation without waiting for the session timeout', async () => {
    const mock = await server(async () => {}),
      controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    try {
      await expect(
        exchange(
          { ...profile, uplink: { ...profile.uplink, port: mock.port } },
          [],
          hooks,
          controller.signal,
        ),
      ).rejects.toThrow('cancelled');
    } finally {
      await mock.close();
    }
  });
});
