import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import test from 'node:test';
import {
  createTerminationController,
  runTerminationAwareCleanup,
} from './process-lifecycle.mjs';

function findInstalledSignalHandler(signal, previousHandlers) {
  const handler = process.listeners(signal).find((candidate) => !previousHandlers.includes(candidate));
  assert.ok(handler, `The termination controller did not install its ${signal} handler.`);
  return handler;
}

async function exerciseCleanupSignal({ signal, expectedExitCode, cleanup }) {
  const previousExitCode = process.exitCode;
  const previousHandlers = process.listeners(signal);
  const controller = createTerminationController();
  const signalHandler = findInstalledSignalHandler(signal, previousHandlers);

  try {
    process.exitCode = 0;
    await runTerminationAwareCleanup(controller, async () => cleanup(signalHandler));
    assert.equal(controller.requestedSignal, signal);
    assert.equal(process.exitCode, expectedExitCode);
    assert.deepEqual(process.listeners(signal), previousHandlers);
  } finally {
    // dispose() is idempotent and keeps this test isolated if an assertion interrupts finalization.
    controller.dispose();
    process.exitCode = previousExitCode;
  }
}

test('E2E-style nested cleanup preserves SIGTERM status received after the child exits', async () => {
  await exerciseCleanupSignal({
    signal: 'SIGTERM',
    expectedExitCode: 143,
    cleanup: async (signalHandler) => {
      await Promise.resolve();
      signalHandler();
      // Model the wrapper's second awaited cleanup after the Next.js server has closed.
      await Promise.resolve();
    },
  });
});

test('build-style cleanup preserves SIGINT status received after the child exits', async () => {
  await exerciseCleanupSignal({
    signal: 'SIGINT',
    expectedExitCode: 130,
    cleanup: async (signalHandler) => {
      signalHandler();
      await Promise.resolve();
    },
  });
});

class ControlledChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 42_424;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

async function exercisePendingOrActiveSignal(phase) {
  const previousHandlers = process.listeners('SIGTERM');
  const controller = createTerminationController();
  const signalHandler = findInstalledSignalHandler('SIGTERM', previousHandlers);
  const child = new ControlledChild();

  try {
    if (phase === 'pre-spawn') signalHandler();
    if (phase === 'preparation') {
      await Promise.resolve();
      signalHandler();
      await Promise.resolve();
    }
    const childResult = controller.waitForChild(child);
    if (phase === 'active-child') signalHandler();
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    assert.deepEqual(await childResult, { code: null, signal: 'SIGTERM' });
  } finally {
    controller.dispose();
  }
}

test('forwards a termination requested before child spawn when the child becomes owned', async () => {
  await exercisePendingOrActiveSignal('pre-spawn');
});

test('forwards a termination requested during preparation when the child becomes owned', async () => {
  await exercisePendingOrActiveSignal('preparation');
});

test('forwards termination immediately while a child is active', async () => {
  await exercisePendingOrActiveSignal('active-child');
});
