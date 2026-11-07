/** Queue and job names (### Events/Messages → video.process). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'video.process';

/** Minimal payload — the worker loads everything else from the database. */
export interface VideoProcessJobData {
  videoId: string;
}
