import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  createFixtureDir,
  type FixtureDir,
  generateVideoFixture,
} from '../test/video-fixture';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('ThumbnailService (integration — real ffmpeg)', () => {
  const thumbnails = new ThumbnailService();
  const probe = new MediaProbeService();
  let fixtures: FixtureDir;

  beforeAll(async () => {
    fixtures = await createFixtureDir();
  });

  afterAll(async () => {
    await fixtures.cleanup();
  });

  it('should produce a JPEG scaled down to 1280px wide from a 1920x1080 video', async () => {
    const video = await generateVideoFixture(fixtures.path, 'hd.mp4');
    const output = join(fixtures.path, 'hd.jpg');

    await thumbnails.extractFrame(video, output, 3);

    const bytes = await readFile(output);
    expect(bytes.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
    const image = await probe.probe(output);
    expect(image.width).toBe(1280);
    expect(image.height).toBe(720);
  });

  it('should keep the original width when the video is narrower than 1280px', async () => {
    const video = await generateVideoFixture(fixtures.path, 'small.mp4', {
      width: 640,
      height: 360,
    });
    const output = join(fixtures.path, 'small.jpg');

    await thumbnails.extractFrame(video, output, 3);

    const image = await probe.probe(output);
    expect(image.width).toBe(640);
  });

  it('should produce a JPEG from a clip shorter than 1s (frame at 0s)', async () => {
    const video = await generateVideoFixture(fixtures.path, 'short.mp4', {
      durationSeconds: 0.5,
    });
    const output = join(fixtures.path, 'short.jpg');

    await thumbnails.extractFrame(video, output, 0.5);

    const bytes = await readFile(output);
    expect(bytes.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
  });
});
