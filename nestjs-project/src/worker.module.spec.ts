import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from './video-processing/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the processor and without any HTTP controller', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    const controllerCount = [...module.get(ModulesContainer).values()].reduce(
      (total, m) => total + m.controllers.size,
      0,
    );
    expect(controllerCount).toBe(0);
    await module.close();
  }, 30000);
});
