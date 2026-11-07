import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

/**
 * Root BullMQ connection to Redis (phase-03-videos/TD-05). Host is the Compose
 * service name from `queueConfig`, never localhost. Shared by the API
 * (AppModule), the worker (WorkerModule) and test modules.
 */
export function queueRootModule(): DynamicModule {
  return BullModule.forRootAsync({
    inject: [queueConfig.KEY],
    useFactory: (config: ConfigType<typeof queueConfig>) => ({
      connection: { host: config.host, port: config.port },
    }),
  });
}
