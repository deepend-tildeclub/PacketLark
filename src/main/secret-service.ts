import type { Message, MessageBus, MessageLike } from '@jellybrick/dbus-next';

const service = 'org.freedesktop.secrets';
const root = '/org/freedesktop/secrets';
const serviceInterface = 'org.freedesktop.Secret.Service';
const promptInterface = 'org.freedesktop.Secret.Prompt';
const dbus = 'org.freedesktop.DBus';
const pathPattern = /^\/(?:[a-zA-Z0-9_]+\/)*[a-zA-Z0-9_]+$/;

type Call = (message: MessageLike) => Promise<Message>;
export type UnlockResult = 'ready' | 'cancelled' | 'unavailable';

function timed<T>(task: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The desktop keyring did not respond.'));
    }, ms);
    void task.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    }
  });
}

async function onSession<T>(
  work: (bus: MessageBus, call: Call, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { Message, sessionBus } = await import('@jellybrick/dbus-next');
  const bus = sessionBus();
  const controller = new AbortController();
  bus.on('error', () => controller.abort(new Error('The desktop session bus is unavailable.')));
  async function call(message: MessageLike) {
    controller.signal.throwIfAborted();
    const reply = await timed(bus.call(new Message(message)), 4000, controller.signal);
    if (!reply) throw new Error('The desktop keyring did not respond.');
    return reply;
  }
  try {
    return await work(bus, call, controller.signal);
  } finally {
    controller.abort();
    bus.disconnect();
  }
}

function request(member: string, signature: string, body: unknown[]): MessageLike {
  return { destination: service, path: root, interface: serviceInterface, member, signature, body };
}

export async function secretServiceAvailable(): Promise<boolean> {
  try {
    await onSession(async (_bus, call) => call(request('ReadAlias', 's', ['default'])));
    return true;
  } catch {
    return false;
  }
}

async function displayPrompt(
  bus: MessageBus,
  call: Call,
  sender: string,
  path: string,
  signal: AbortSignal,
) {
  if (!/^:[a-zA-Z0-9_.-]+$/.test(sender) || !pathPattern.test(path))
    throw new Error('The desktop keyring returned an invalid prompt.');
  let complete!: (unlocked: boolean) => void;
  const completed = new Promise<boolean>((resolve) => (complete = resolve));
  const listener = (message: Message) => {
    if (
      message.type === 4 && // SIGNAL
      message.sender === sender &&
      message.path === path &&
      message.interface === promptInterface &&
      message.member === 'Completed'
    )
      complete(message.body[0] === false);
  };
  bus.on('message', listener);
  try {
    // Prompt objects belong to this connection. Subscribe before asking the service to show it.
    await call({
      destination: dbus,
      path: '/org/freedesktop/DBus',
      interface: dbus,
      member: 'AddMatch',
      signature: 's',
      body: [
        `type='signal',sender='${sender}',path='${path}',interface='${promptInterface}',member='Completed'`,
      ],
    });
    await call({
      destination: sender,
      path,
      interface: promptInterface,
      member: 'Prompt',
      signature: 's',
      body: [''], // The desktop owns the prompt; no X11 or Wayland window ID is required.
    });
    return await timed(completed, 180000, signal);
  } finally {
    bus.off('message', listener);
  }
}

export async function unlockSecretService(applications: string[]): Promise<UnlockResult> {
  try {
    return await onSession(async (bus, call, signal) => {
      let item: string | undefined;
      for (const application of new Set(applications)) {
        const { body } = await call(request('SearchItems', 'a{ss}', [{ application }]));
        const [open, locked] = body;
        if (!Array.isArray(open) || !Array.isArray(locked))
          throw new Error('Invalid SearchItems reply.');
        if (open.length) return 'ready';
        item = locked.find((p) => typeof p === 'string' && pathPattern.test(p));
        if (item) break;
      }
      const objectInterface = item
        ? 'org.freedesktop.Secret.Item'
        : 'org.freedesktop.Secret.Collection';
      if (!item) {
        const {
          body: [collection],
        } = await call(request('ReadAlias', 's', ['default']));
        // The native backend can create the first default collection when needed.
        if (collection === '/') return 'ready';
        if (typeof collection !== 'string' || !pathPattern.test(collection))
          throw new Error('Invalid keyring collection.');
        item = collection;
      }
      const isLocked = async () => {
        const {
          body: [locked],
        } = await call({
          destination: service,
          path: item,
          interface: 'org.freedesktop.DBus.Properties',
          member: 'Get',
          signature: 'ss',
          body: [objectInterface, 'Locked'],
        });
        if (
          typeof locked !== 'object' ||
          !locked ||
          !('value' in locked) ||
          typeof locked.value !== 'boolean'
        )
          throw new Error('Invalid keyring lock state.');
        return locked.value;
      };
      if (!(await isLocked())) return 'ready';
      const {
        body: [, prompt],
        sender,
      } = await call(request('Unlock', 'ao', [[item]]));
      if (prompt !== '/') {
        if (typeof prompt !== 'string') throw new Error('Invalid keyring unlock reply.');
        if (!(await displayPrompt(bus, call, sender, prompt, signal))) return 'cancelled';
      }
      return (await isLocked()) ? 'cancelled' : 'ready';
    });
  } catch {
    return 'unavailable';
  }
}
