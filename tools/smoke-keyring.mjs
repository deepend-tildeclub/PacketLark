import assert from 'node:assert/strict';
import { Message, Variant, sessionBus } from '@jellybrick/dbus-next';
import { secretServiceAvailable, unlockSecretService } from '../dist/main/secret-service.js';

const address = 'org.freedesktop.secrets';
const item = '/org/freedesktop/secrets/collection/login/1';
const collection = '/org/freedesktop/secrets/collection/login';
const prompt = '/org/freedesktop/secrets/prompt/1';
const bus = sessionBus();
let locked = true;
let dismiss = true;
let promptCount = 0;
let owner;
let lastTarget;
let existing = true;
try {
  await bus.requestName(address);
  bus.addMethodHandler((msg) => {
    const reply = (signature, body) => bus.send(Message.newMethodReturn(msg, signature, body));
    switch (msg.member) {
      case 'ReadAlias':
        reply('o', [collection]);
        return true;
      case 'SearchItems':
        reply(
          'aoao',
          existing && msg.body[0].application === 'retropost'
            ? [locked ? [] : [item], locked ? [item] : []]
            : [[], []],
        );
        return true;
      case 'Get':
        if (msg.path !== item && msg.path !== collection) return false;
        assert.equal(
          msg.body[0],
          `org.freedesktop.Secret.${msg.path === item ? 'Item' : 'Collection'}`,
        );
        reply('v', [new Variant('b', locked)]);
        return true;
      case 'Unlock':
        assert.deepEqual(msg.body, [[existing ? item : collection]]);
        lastTarget = msg.body[0][0];
        owner = msg.sender;
        reply('aoo', [[], prompt]);
        return true;
      case 'Prompt':
        assert.equal(msg.sender, owner);
        assert.equal(msg.path, prompt);
        promptCount++;
        if (!dismiss) locked = false;
        reply('', []);
        bus.send(
          Message.newSignal(prompt, 'org.freedesktop.Secret.Prompt', 'Completed', 'bv', [
            dismiss,
            new Variant('ao', dismiss ? [] : [lastTarget]),
          ]),
        );
        return true;
      default:
        return false;
    }
  });
  assert.equal(await secretServiceAvailable(), true);
  assert.equal(await unlockSecretService(['PacketLark', 'retropost']), 'cancelled');
  assert.equal(promptCount, 1);
  dismiss = false;
  assert.equal(await unlockSecretService(['PacketLark', 'retropost']), 'ready');
  assert.equal(promptCount, 2);
  assert.equal(await unlockSecretService(['PacketLark', 'retropost']), 'ready');
  assert.equal(promptCount, 2);
  existing = false;
  locked = true;
  assert.equal(await unlockSecretService(['PacketLark', 'retropost']), 'ready');
  assert.equal(lastTarget, collection);
  assert.equal(promptCount, 3);
  await bus.releaseName(address);
  assert.equal(await secretServiceAvailable(), false);
  assert.equal(await unlockSecretService(['retropost']), 'unavailable');
  console.log(
    'Secret Service unlock, cancellation, retry and missing-service smoke checks passed.',
  );
} finally {
  bus.disconnect();
}
