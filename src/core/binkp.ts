import net from 'node:net';
import tls from 'node:tls';
import { createHmac } from 'node:crypto';
import { address, formatAddress, sameAddress, type Profile } from './model.js';
import { MAX_FILE } from './packet.js';

export const CMD = {
  NUL: 0,
  ADR: 1,
  PWD: 2,
  FILE: 3,
  OK: 4,
  EOB: 5,
  GOT: 6,
  ERR: 7,
  BSY: 8,
  GET: 9,
  SKIP: 10,
} as const;
export type MailFile = { name: string; bytes: Buffer; time: number };
export function frame(command: number | null, data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const size = body.length + (command === null ? 0 : 1);
  if (!size || size > 32767) throw new Error('Invalid BinkP frame length.');
  const h = Buffer.alloc(command === null ? 2 : 3);
  h.writeUInt16BE(size | (command === null ? 0 : 0x8000));
  if (command !== null) h[2] = command;
  return Buffer.concat([h, body]);
}
export async function* readFrames(
  socket: net.Socket,
): AsyncGenerator<{ command: number | null; data: Buffer }> {
  let pending = Buffer.alloc(0);
  for await (const chunk of socket) {
    pending = Buffer.concat([pending, Buffer.from(chunk as Uint8Array)]);
    while (pending.length >= 2) {
      const head = pending.readUInt16BE(),
        size = head & 0x7fff,
        cmd = (head & 0x8000) !== 0;
      if (!size) throw new Error('Peer sent an empty BinkP frame.');
      if (pending.length < size + 2) break;
      const body = pending.subarray(2, 2 + size);
      pending = pending.subarray(2 + size);
      yield { command: cmd ? body[0] : null, data: body.subarray(cmd ? 1 : 0) };
    }
  }
  if (pending.length) throw new Error('Connection ended inside a BinkP frame.');
}
function fileArgs(value: string): { name: string; size: number; time: number; offset: number } {
  const m = /^([^\s]+) (\d+) (\d+)(?: (-?\d+))?$/.exec(value);
  if (!m || !/^[a-zA-Z0-9_.-]{1,100}$/.test(m[1])) throw new Error('Invalid BinkP file offer.');
  const size = +m[2],
    time = +m[3],
    offset = +(m[4] || 0);
  if (
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(time) ||
    !Number.isSafeInteger(offset) ||
    size > MAX_FILE ||
    size < 1
  )
    throw new Error('BinkP file size is invalid or too large.');
  return { name: m[1], size, time, offset };
}
export async function exchange(
  profile: Profile,
  outgoing: MailFile[],
  hooks: {
    receive(file: MailFile): Promise<void>;
    sent(name: string): Promise<void>;
    status(text: string): void;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('Send & receive cancelled.');
  const options = { host: profile.uplink.host, port: profile.uplink.port };
  const socket = profile.uplink.tls
    ? tls.connect({
        ...options,
        servername: net.isIP(options.host) ? undefined : options.host,
        rejectUnauthorized: true,
      })
    : net.connect(options);
  socket.setTimeout(60000, () => socket.destroy(new Error('Provider connection timed out.')));
  const absolute = setTimeout(
    () => socket.destroy(new Error('Session exceeded the five-minute limit.')),
    300000,
  );
  const abort = () => socket.destroy(new Error('Send & receive cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  let authenticated = false,
    identified = false,
    passwordSent = false,
    eobSent = false,
    eobReceived = false,
    complete = false;
  let challenge = '';
  let incoming: { meta: ReturnType<typeof fileArgs>; chunks: Buffer[]; received: number } | null =
    null;
  let discard = false;
  let index = 0,
    generation = 0;
  let txChain = Promise.resolve();
  const write = (data: Buffer): Promise<void> =>
    new Promise((resolve, reject) =>
      socket.write(data, (error) => (error ? reject(error) : resolve())),
    );
  const send = (cmd: number, text = '') => write(frame(cmd, text));
  const current = () => outgoing[index];
  const queueSend = (offset = 0) => {
    const ticket = ++generation,
      f = current();
    txChain = txChain
      .then(async () => {
        if (ticket !== generation) return;
        if (!f) {
          if (!eobSent) {
            await send(CMD.EOB);
            eobSent = true;
          }
          return;
        }
        hooks.status(`Sending message ${index + 1} of ${outgoing.length}…`);
        await send(CMD.FILE, `${f.name} ${f.bytes.length} ${f.time} ${offset}`);
        for (let pos = offset; pos < f.bytes.length; pos += 16384) {
          if (ticket !== generation) return;
          await write(frame(null, f.bytes.subarray(pos, pos + 16384)));
        }
      })
      .catch((error: unknown) => {
        socket.destroy(error instanceof Error ? error : new Error('Transfer failed.'));
      });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const event = profile.uplink.tls ? 'secureConnect' : 'connect';
      const fail = (err: Error) => reject(err);
      socket.once('error', fail);
      socket.once(event, () => {
        socket.off('error', fail);
        resolve();
      });
    });
    hooks.status('Connecting to your provider…');
    await send(CMD.NUL, 'SYS PacketLark');
    await send(CMD.NUL, `ZYZ ${profile.name}`);
    await send(CMD.NUL, 'LOC Internet');
    await send(CMD.NUL, 'VER PacketLark/0.1 binkp/1.0');
    await send(CMD.ADR, formatAddress(address(profile.address), true));
    for await (const f of readFrames(socket)) {
      if (f.command === null) {
        if (!authenticated) throw new Error('Provider sent mail before authentication.');
        if (discard) continue;
        if (!incoming) throw new Error('Unexpected data without a file offer.');
        incoming.received += f.data.length;
        if (incoming.received > incoming.meta.size)
          throw new Error('Provider sent more file data than advertised.');
        incoming.chunks.push(f.data);
        if (incoming.received === incoming.meta.size) {
          const { meta, chunks } = incoming;
          hooks.status('Saving incoming messages…');
          // The application must durably commit before the remote may discard its copy.
          await hooks.receive({ name: meta.name, time: meta.time, bytes: Buffer.concat(chunks) });
          await send(CMD.GOT, `${meta.name} ${meta.size} ${meta.time}`);
          incoming = null;
        }
        continue;
      }
      const text = f.data.toString('utf8');
      if (f.command === CMD.ERR || f.command === CMD.BSY)
        throw new Error(
          f.command === CMD.BSY
            ? 'Your provider is busy. Try again shortly.'
            : `Provider rejected the session: ${text.slice(0, 200)}`,
        );
      if (f.command === CMD.NUL) {
        const m = /\bCRAM-MD5-([a-f0-9]{2,512})\b/i.exec(text);
        if (m && m[1].length % 2 === 0) challenge = m[1];
      } else if (f.command === CMD.ADR) {
        identified = text.split(/\s+/).some((s) => {
          try {
            return sameAddress(s, profile.uplink.address);
          } catch {
            return false;
          }
        });
        if (!identified)
          throw new Error('Provider did not advertise the expected FidoNet address.');
        if (!passwordSent) {
          if (challenge)
            await send(
              CMD.PWD,
              `CRAM-MD5-${createHmac('md5', profile.uplink.sessionPassword).update(Buffer.from(challenge, 'hex')).digest('hex')}`,
            );
          else if (profile.uplink.tls) await send(CMD.PWD, profile.uplink.sessionPassword);
          else
            throw new Error(
              'Provider must offer CRAM-MD5 authentication, or the account must use TLS.',
            );
          passwordSent = true;
        }
      } else if (f.command === CMD.OK) {
        if (!identified || !passwordSent || authenticated)
          throw new Error('Unexpected authentication acknowledgement.');
        authenticated = true;
        hooks.status('Connected. Exchanging messages…');
        queueSend();
      } else {
        if (!authenticated) throw new Error('Unexpected command before authentication.');
        if (f.command === CMD.FILE) {
          if (incoming)
            throw new Error('Provider started a new file before finishing the previous one.');
          const meta = fileArgs(text);
          if (!/\.(pkt|(?:su|mo|tu|we|th|fr|sa)[0-9a-z]|zip)$/i.test(meta.name))
            throw new Error(
              'Provider offered an unsupported attachment. Configure raw packets or ZIP mail bundles.',
            );
          if (meta.offset !== 0) {
            discard = true;
            await send(CMD.GET, `${meta.name} ${meta.size} ${meta.time} 0`);
            continue;
          }
          discard = false;
          incoming = { meta, chunks: [], received: 0 };
        } else if (f.command === CMD.GOT) {
          const ack = fileArgs(text),
            out = current();
          if (
            !out ||
            ack.name !== out.name ||
            ack.size !== out.bytes.length ||
            ack.time !== out.time
          )
            throw new Error('Provider acknowledged an unknown outgoing file.');
          await hooks.sent(out.name);
          index++;
          queueSend();
        } else if (f.command === CMD.GET) {
          const request = fileArgs(text),
            out = current();
          if (
            !out ||
            request.name !== out.name ||
            request.size !== out.bytes.length ||
            request.time !== out.time ||
            request.offset < 0 ||
            request.offset > out.bytes.length
          )
            throw new Error('Invalid file resume request.');
          queueSend(request.offset);
        } else if (f.command === CMD.SKIP)
          throw new Error('Provider deferred an outgoing message. It remains in your Outbox.');
        else if (f.command === CMD.EOB) {
          if (incoming || discard)
            throw new Error('Provider ended a batch with an incomplete incoming file.');
          eobReceived = true;
        } else throw new Error('Provider requested an unsupported BinkP extension.');
      }
      await Promise.resolve();
      if (authenticated && eobReceived && eobSent && index === outgoing.length && !incoming) {
        complete = true;
        break;
      }
    }
    await txChain;
    if (
      !complete &&
      authenticated &&
      eobReceived &&
      eobSent &&
      index === outgoing.length &&
      !incoming
    )
      complete = true;
    if (!complete)
      throw new Error(
        'Connection ended before the mail exchange completed. Unconfirmed messages remain queued.',
      );
    hooks.status('All messages exchanged.');
  } finally {
    clearTimeout(absolute);
    signal?.removeEventListener('abort', abort);
    socket.destroy();
  }
}
