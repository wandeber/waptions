import { expect, test, type Page } from '@playwright/test';

const PROJECT_NAVIGATION_TIMEOUT = 15_000;
const MAXIMUM_EXPECTED_BACKING_WIDTH = 8_192;

/** Builds a small, deterministic PCM fixture without relying on developer-local media files. */
function createSilentWaveFile(durationSeconds: number, sampleRate = 8_000): Buffer {
  const channelCount = 1;
  const bytesPerSample = 2;
  const dataSize = durationSeconds * sampleRate * channelCount * bytesPerSample;
  const file = Buffer.alloc(44 + dataSize);

  file.write('RIFF', 0, 'ascii');
  file.writeUInt32LE(36 + dataSize, 4);
  file.write('WAVE', 8, 'ascii');
  file.write('fmt ', 12, 'ascii');
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(channelCount, 22);
  file.writeUInt32LE(sampleRate, 24);
  file.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  file.writeUInt16LE(channelCount * bytesPerSample, 32);
  file.writeUInt16LE(bytesPerSample * 8, 34);
  file.write('data', 36, 'ascii');
  file.writeUInt32LE(dataSize, 40);
  return file;
}

/** Records a tiny real WebM so the editor accepts the synthetic audio in the same import batch. */
async function createBrowserVideoFile(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const mimeType = 'video/webm;codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      throw new Error(`The browser cannot create the ${mimeType} waveform test fixture.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser cannot create a fixture canvas.');

    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.addEventListener('error', () => reject(new Error('The browser failed to record the fixture.')), { once: true });
    });

    recorder.start();
    for (let frame = 0; frame < 5; frame += 1) {
      context.fillStyle = frame % 2 === 0 ? '#2563eb' : '#16a34a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()));
  });
  return Buffer.from(bytes);
}

test.describe('bounded timeline waveform rendering', () => {
  test.use({ deviceScaleFactor: 2 });

  test('keeps a long high-zoom clip at full CSS width with a bounded backing canvas', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByPlaceholder('Nombre del proyecto...').fill(`Bounded waveform ${Date.now()}`);
    await page.getByRole('button', { name: 'Crear' }).click();
    await expect(page).toHaveURL(/\/editor\//, { timeout: PROJECT_NAVIGATION_TIMEOUT });

    const mediaInput = page.locator('input[type="file"][accept="video/*,audio/*"]');
    await mediaInput.setInputFiles([
      {
        name: 'seed-video.webm',
        mimeType: 'video/webm',
        buffer: await createBrowserVideoFile(page),
      },
      {
        name: 'long-silence.wav',
        mimeType: 'audio/wav',
        buffer: createSilentWaveFile(70),
      },
    ]);

    const audioClip = page.getByTestId('timeline-audio-clip');
    await expect(audioClip).toHaveCount(1, { timeout: 30_000 });
    const waveform = audioClip.locator('canvas');
    await expect(waveform).toHaveAttribute('data-waveform-state', 'ready', { timeout: 60_000 });

    // A silent source still paints its one-pixel baseline at the bottom edge. The center remains
    // transparent, proving that the compact waveform is bottom-origin rather than symmetric.
    const baselinePixels = await waveform.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The waveform canvas has no 2D context.');
      const x = Math.floor(canvas.width / 2);
      const centerAlpha = context.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data[3];
      const bottomAlpha = context.getImageData(x, canvas.height - 1, 1, 1).data[3];
      return { centerAlpha, bottomAlpha };
    });
    expect(baselinePixels.centerAlpha).toBe(0);
    expect(baselinePixels.bottomAlpha).toBeGreaterThan(0);

    for (let step = 0; step < 15; step += 1) {
      await page.getByTitle('Zoom in').click();
    }

    await expect.poll(async () => waveform.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return {
        backingWidth: canvas.width,
        state: canvas.dataset.waveformState,
      };
    })).toEqual({
      backingWidth: MAXIMUM_EXPECTED_BACKING_WIDTH,
      state: 'ready',
    });
    const geometry = await waveform.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return {
        backingWidth: canvas.width,
        cssWidth: canvas.getBoundingClientRect().width,
      };
    });
    expect(geometry.cssWidth).toBeGreaterThan(60_000);
    expect(geometry.cssWidth).toBeGreaterThan(geometry.backingWidth);
  });
});
