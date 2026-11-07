import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VideoFixtureOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** Adds an AAC sine-wave audio track (default true). */
  audio?: boolean;
  /**
   * Forces a constant bitrate so the file is at least this big — used to get
   * multipart uploads with 2+ parts (every part but the last must be ≥ 5 MiB).
   */
  minSizeBytes?: number;
}

/** Temporary directory holding generated fixtures; call `cleanup()` in afterAll. */
export interface FixtureDir {
  path: string;
  cleanup: () => Promise<void>;
}

export async function createFixtureDir(): Promise<FixtureDir> {
  const path = await mkdtemp(join(tmpdir(), 'video-fixture-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Generates an H.264 (+ optional AAC) MP4 with ffmpeg's lavfi test sources. */
export async function generateVideoFixture(
  dir: string,
  fileName: string,
  options: VideoFixtureOptions = {},
): Promise<string> {
  const {
    durationSeconds = 3,
    width = 1920,
    height = 1080,
    audio = true,
    minSizeBytes,
  } = options;
  const output = join(dir, fileName);

  const args = [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=30`,
  ];
  if (audio) {
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=1000:duration=${durationSeconds}`,
    );
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');

  if (minSizeBytes) {
    // CBR with filler data: x264 pads the stream up to the requested bitrate.
    const bitsPerSecond = Math.ceil(
      ((minSizeBytes * 8) / durationSeconds) * 1.15,
    );
    args.push(
      '-b:v',
      String(bitsPerSecond),
      '-minrate',
      String(bitsPerSecond),
      '-maxrate',
      String(bitsPerSecond),
      '-bufsize',
      String(bitsPerSecond),
      '-x264-params',
      'nal-hrd=cbr:force-cfr=1',
    );
  }
  if (audio) {
    args.push('-c:a', 'aac', '-shortest');
  }
  args.push(output);

  await execFileAsync('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 });

  if (minSizeBytes) {
    const { size } = await stat(output);
    if (size < minSizeBytes) {
      throw new Error(
        `Fixture ${fileName} is ${size} bytes, below the requested ${minSizeBytes}`,
      );
    }
  }
  return output;
}

/** Random bytes with a video file name — not a decodable media file. */
export async function generateCorruptFile(
  dir: string,
  fileName: string,
  sizeBytes = 4096,
): Promise<string> {
  const output = join(dir, fileName);
  await writeFile(output, randomBytes(sizeBytes));
  return output;
}
