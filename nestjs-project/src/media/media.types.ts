/** Typed metadata persisted on the video row (validation.md AMB-1). */
export interface ProbeResult {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
  container_format: string | null;
  /** Full raw ffprobe output (`-show_format -show_streams`). */
  raw: Record<string, unknown>;
}

/**
 * The file cannot be processed as a video (unreadable, corrupt, or without a
 * video stream). Retrying will never succeed (phase-03-videos/TD-12).
 */
export class UnsupportedMediaError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsupportedMediaError';
  }
}
