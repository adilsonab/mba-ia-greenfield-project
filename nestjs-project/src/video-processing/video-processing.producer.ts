import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {}

  /**
   * Publishes `video.process`. `jobId = videoId`, so enqueueing the same video
   * twice while the job exists is ignored by BullMQ (phase-03-videos/TD-12).
   */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId });
  }
}
