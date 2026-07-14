import assert from 'node:assert/strict';
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
