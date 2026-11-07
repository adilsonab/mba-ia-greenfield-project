import {
  createFixtureDir,
  type FixtureDir,
  generateCorruptFile,
  generateVideoFixture,
} from '../test/video-fixture';
import { MediaProbeService } from './media-probe.service';
import { UnsupportedMediaError } from './media.types';

describe('MediaProbeService (integration — real ffprobe)', () => {
  const probe = new MediaProbeService();
  let fixtures: FixtureDir;

  beforeAll(async () => {
    fixtures = await createFixtureDir();
  });

  afterAll(async () => {
    await fixtures.cleanup();
  });

  it('should extract duration, dimensions and codecs from a 3s 1920x1080 H.264 + AAC file', async () => {
    const file = await generateVideoFixture(fixtures.path, 'full.mp4');

    const result = await probe.probe(file);

    expect(result.duration_seconds).toBeCloseTo(3, 1);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.video_codec).toBe('h264');
    expect(result.audio_codec).toBe('aac');
    expect(result.container_format).toContain('mp4');
    expect(result.bitrate).toBeGreaterThan(0);
    expect(result.raw).toHaveProperty('streams');
  });

  it('should report audio_codec null for a file without audio', async () => {
    const file = await generateVideoFixture(fixtures.path, 'silent.mp4', {
      audio: false,
    });

    const result = await probe.probe(file);

    expect(result.audio_codec).toBeNull();
    expect(result.video_codec).toBe('h264');
  });

  it('should throw UnsupportedMediaError for a corrupt file', async () => {
    const file = await generateCorruptFile(fixtures.path, 'corrupt.mp4');

    await expect(probe.probe(file)).rejects.toBeInstanceOf(
      UnsupportedMediaError,
    );
  });
});
