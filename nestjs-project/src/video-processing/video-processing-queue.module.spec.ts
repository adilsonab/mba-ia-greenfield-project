import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import videosConfig from '../config/videos.config';
import { queueRootModule } from './queue-root.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingQueueModule', () => {
  it('should register the video-processing queue with retry defaults and expose the producer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videosConfig],
        }),
        queueRootModule(),
        VideoProcessingQueueModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    await module.close();
  });

  it('should handle queue connection errors instead of leaving them unhandled', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videosConfig],
        }),
        queueRootModule(),
        VideoProcessingQueueModule,
      ],
    }).compile();
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    // An EventEmitter `error` without listeners throws — that is what crashed
    // the process (and, in the suite, the next test file) on Redis disconnect.
    expect(queue.listenerCount('error')).toBeGreaterThan(0);
    expect(() =>
      queue.emit('error', new Error('Connection is closed.')),
    ).not.toThrow();
    expect(logged).toHaveBeenCalledWith(
      `Queue ${VIDEO_PROCESSING_QUEUE} error: Connection is closed.`,
    );

    logged.mockRestore();
    await module.close();
  });
});
