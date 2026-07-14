import { spawn } from 'node:child_process';
// ffprobe-static is a development-only CommonJS package without TypeScript declarations.
// @ts-expect-error The runtime export is validated before the binary is used.
import ffprobeStatic from 'ffprobe-static';

interface ProbedStream {
  codec_type: 'audio' | 'video';
  codec_name: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeOutput {
  format: { duration: string };
  streams: ProbedStream[];
}


/** Probes an exported artifact with the repository-pinned binary used for fixture verification. */
export async function probeMediaArtifact(filePath: string): Promise<FfprobeOutput> {
  const ffprobePath = (ffprobeStatic as { path?: unknown }).path;
  if (typeof ffprobePath !== 'string') {
    throw new Error('ffprobe-static did not expose its repository-local executable.');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels',
      '-of', 'json',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as FfprobeOutput);
    });
  });
}
