import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { analyzeArtifactAudioFrequencies } from './support/browser-audio-analysis';
import { createEditorProject, monitorPageFailures, readTimelineTime } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';
import { probeMediaArtifact } from './support/media-probe';

test.describe('real export round trip', () => {
  test('decodes both visual clips and audio, then reimports the exported WebM', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    // Headless Chromium exposes the File System Access API inconsistently across platforms. The
    // bounded fallback gives Playwright a real download whose bytes can be decoded and reimported;
    // streaming/backpressure ownership remains covered by deterministic unit tests.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    });

    await createEditorProject(page, 'Export round trip');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles([
      mediaFixtures.videoA,
      mediaFixtures.videoB,
      mediaFixtures.audio,
    ]);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(1);

    // The exported graph contains linked audio from the second clip plus detached video audio and
    // the imported WAV as independently editable contributors.
    await page.getByTestId('timeline-video-clip').first().click({ button: 'right' });
    await page.getByTestId('separate-audio-action').click();
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(2);

    await page.getByTitle('Exportar video con subtítulos').click();
    await page.getByRole('button', { name: 'WebM (VP9)' }).click();
    await expect(page.getByLabel('Include timeline audio')).toBeChecked();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar', exact: true }).first().click();
    const download = await downloadPromise;
    const outputPath = await download.path();
    if (!outputPath) throw new Error('Playwright did not retain the exported artifact.');
    const artifact = await readFile(outputPath);
    const artifactBytes = Array.from(artifact);

    const probe = await probeMediaArtifact(outputPath);
    const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
    expect(videoStream).toMatchObject({ codec_name: 'vp9', width: 320, height: 180 });
    expect(audioStream).toMatchObject({ codec_name: 'opus', sample_rate: '48000' });
    expect(Number.parseFloat(probe.format.duration)).toBeGreaterThan(3.8);
    expect(Number.parseFloat(probe.format.duration)).toBeLessThan(4.2);

    // Each synthetic source owns a distinct frequency. Measuring the decoded PCM proves that the
    // first interval contains both detached video audio and the imported WAV, while the second
    // interval contains the still-linked audio of the blue clip. A merely present or silent Opus
    // stream cannot satisfy these contributor-specific assertions.
    const [firstAudioInterval, secondAudioInterval] = await analyzeArtifactAudioFrequencies(
      page,
      artifactBytes,
      [
        { startSeconds: 0.25, durationSeconds: 1.5, frequenciesHz: [440, 660, 880] },
        { startSeconds: 2.25, durationSeconds: 1.5, frequenciesHz: [440, 660, 880] },
      ],
    );
    expect(firstAudioInterval.rms).toBeGreaterThan(0.01);
    expect(firstAudioInterval.magnitudes['440']).toBeGreaterThan(0.01);
    expect(firstAudioInterval.magnitudes['880']).toBeGreaterThan(0.01);
    expect(firstAudioInterval.magnitudes['440']).toBeGreaterThan(firstAudioInterval.magnitudes['660'] * 4);
    expect(firstAudioInterval.magnitudes['880']).toBeGreaterThan(firstAudioInterval.magnitudes['660'] * 4);
    expect(secondAudioInterval.rms).toBeGreaterThan(0.01);
    expect(secondAudioInterval.magnitudes['660']).toBeGreaterThan(0.01);
    expect(secondAudioInterval.magnitudes['660']).toBeGreaterThan(secondAudioInterval.magnitudes['440'] * 4);
    expect(secondAudioInterval.magnitudes['660']).toBeGreaterThan(secondAudioInterval.magnitudes['880'] * 4);

    const pixels = await page.evaluate(async (bytes) => {
      const video = document.createElement('video');
      video.muted = true;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(video.error ?? new Error('Export decode failed.')), { once: true });
      });
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The browser could not create a probe canvas.');

      const sample = async (time: number) => {
        const seeked = new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }));
        video.currentTime = time;
        await seeked;
        context.drawImage(video, 0, 0);
        return Array.from(context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data.slice(0, 3));
      };
      const result = {
        duration: video.duration,
        red: await sample(0.75),
        blue: await sample(2.75),
      };
      URL.revokeObjectURL(url);
      return result;
    }, artifactBytes);
    expect(pixels.duration).toBeGreaterThan(3.8);
    expect(pixels.red[0]).toBeGreaterThan(pixels.red[1] * 1.8);
    expect(pixels.red[0]).toBeGreaterThan(pixels.red[2] * 1.8);
    expect(pixels.blue[2]).toBeGreaterThan(pixels.blue[0] * 2);
    expect(pixels.blue[2]).toBeGreaterThan(pixels.blue[1] * 1.5);

    await createEditorProject(page, 'Reimported export');
    // Playwright stores downloads under an extensionless UUID. Recreate the browser File with the
    // exported name and MIME type so reimport validates the same metadata as a user-selected WebM.
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles({
      name: 'waptions-export.webm',
      mimeType: 'video/webm',
      buffer: artifact,
    });
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await page.getByTitle('Fit timeline to view').click();
    await expect(page.getByTestId('linked-video-waveform'))
      .toHaveAttribute('data-waveform-state', 'ready', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Play timeline' }).click();
    await expect.poll(() => readTimelineTime(page), { timeout: 15_000 }).toBeGreaterThan(0.35);
    await page.getByRole('button', { name: 'Pause timeline' }).click();

    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });
});
