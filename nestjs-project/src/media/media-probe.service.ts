import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import { type ProbeResult, UnsupportedMediaError } from './media.types';

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string; format_name?: string };
  streams?: FfprobeStream[];
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Maps ffprobe JSON to the typed metadata; pure, so it is unit-testable. */
export function mapProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new UnsupportedMediaError('No video stream found');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  const bitrate = toNumber(output.format?.bit_rate);

  return {
    duration_seconds: toNumber(output.format?.duration),
    width: video.width ?? null,
    height: video.height ?? null,
    video_codec: video.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    bitrate: bitrate === null ? null : Math.round(bitrate),
    container_format: output.format?.format_name ?? null,
    raw: output as Record<string, unknown>,
  };
}

@Injectable()
export class MediaProbeService {
  /** Runs ffprobe through execFile with an argument array — no shell (phase-03-videos/TD-07). */
  async probe(filePath: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      ));
    } catch (error) {
      // ffprobe exits non-zero for unreadable / corrupt input.
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new UnsupportedMediaError(
        stderr || (error as Error).message || 'ffprobe failed',
      );
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      throw new UnsupportedMediaError('ffprobe returned invalid JSON');
    }
    return mapProbeOutput(parsed);
  }
}
