import { mapProbeOutput } from './media-probe.service';
import { UnsupportedMediaError } from './media.types';
import { thumbnailTimestamp } from './thumbnail.service';

describe('mapProbeOutput', () => {
  const ffprobeSample = {
    format: {
      duration: '3.000000',
      bit_rate: '286269',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  };

  it('should map duration, dimensions, codecs, bitrate and container from ffprobe JSON', () => {
    const result = mapProbeOutput(ffprobeSample);

    expect(result).toEqual({
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 286269,
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      raw: ffprobeSample,
    });
  });

  it('should return audio_codec null when the file has no audio stream', () => {
    const result = mapProbeOutput({
      ...ffprobeSample,
      streams: [ffprobeSample.streams[0]],
    });

    expect(result.audio_codec).toBeNull();
    expect(result.video_codec).toBe('h264');
  });

  it('should return null for missing or non-numeric format fields', () => {
    const result = mapProbeOutput({
      format: { duration: 'N/A' },
      streams: [{ codec_type: 'video', codec_name: 'vp9' }],
    });

    expect(result.duration_seconds).toBeNull();
    expect(result.bitrate).toBeNull();
    expect(result.container_format).toBeNull();
    expect(result.width).toBeNull();
  });

  it('should throw UnsupportedMediaError when there is no video stream', () => {
    expect(() =>
      mapProbeOutput({
        format: ffprobeSample.format,
        streams: [{ codec_type: 'audio', codec_name: 'aac' }],
      }),
    ).toThrow(UnsupportedMediaError);
  });
});

describe('thumbnailTimestamp', () => {
  it('should pick 10% of the duration', () => {
    expect(thumbnailTimestamp(30)).toBe(3);
    expect(thumbnailTimestamp(4.5)).toBe(0.45);
    // Millisecond precision for ffmpeg -ss; 3.025 * 0.1 is 0.30249… in IEEE 754.
    expect(thumbnailTimestamp(3.025)).toBeCloseTo(0.3025, 2);
  });

  it('should fall back to 0s for clips shorter than 1s or unknown duration', () => {
    expect(thumbnailTimestamp(0.5)).toBe(0);
    expect(thumbnailTimestamp(null)).toBe(0);
  });
});
