import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import {
  THUMBNAIL_FRAME_RATIO,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_MIN_DURATION_SECONDS,
} from './media.constants';

const execFileAsync = promisify(execFile);

/** Frame timestamp: 10% of the duration, or 0s for clips shorter than 1s (phase-03-videos/TD-07). */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (!durationSeconds || durationSeconds < THUMBNAIL_MIN_DURATION_SECONDS) {
    return 0;
  }
  return Number((durationSeconds * THUMBNAIL_FRAME_RATIO).toFixed(3));
}

@Injectable()
export class ThumbnailService {
  /** Writes one JPEG frame to `outputPath` via ffmpeg (execFile, no shell). */
  async extractFrame(
    inputPath: string,
    outputPath: string,
    durationSeconds: number | null,
  ): Promise<void> {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-ss',
      String(thumbnailTimestamp(durationSeconds)),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=min(${THUMBNAIL_MAX_WIDTH}\\,iw):-2`,
      '-q:v',
      '2',
      outputPath,
    ]);
  }
}
