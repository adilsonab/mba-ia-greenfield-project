import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VIDEO_PROCESSING_QUEUE } from './video-processing/video-processing.constants';
import { WorkerModule } from './worker.module';

/** Entrypoint of the `video-worker` Compose service — no HTTP server. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('VideoWorker').log(
    `Video worker started — consuming queue "${VIDEO_PROCESSING_QUEUE}"`,
  );
}

void bootstrap();
