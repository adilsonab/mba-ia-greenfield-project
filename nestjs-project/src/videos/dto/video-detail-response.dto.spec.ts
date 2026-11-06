import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from '../entities/video.entity';
import { toVideoDetailResponse } from './video-detail-response.dto';

const INTERNAL_FIELDS = [
  'id',
  'channel_id',
  'channel',
  'storage_key',
  'thumbnail_key',
  'upload_id',
  'declared_size_bytes',
  'metadata',
];

function readyVideo(): Video {
  return Object.assign(new Video(), {
    id: 'video-1',
    public_id: 'pubVideo001',
    channel_id: 'channel-1',
    title: 'aula',
    status: VideoStatus.DRAFT,
    processing_status: VideoProcessingStatus.READY,
    processing_error: null,
    original_file_name: 'aula.mp4',
    content_type: 'video/mp4',
    declared_size_bytes: 1048576,
    size_bytes: 1048576,
    storage_key: 'videos/video-1/original',
    thumbnail_key: 'videos/video-1/thumbnail.jpg',
    upload_id: null,
    duration_seconds: 3,
    width: 1920,
    height: 1080,
    video_codec: 'h264',
    audio_codec: 'aac',
    bitrate: 286269,
    container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
    metadata: { streams: [] },
    created_at: new Date('2026-11-06T10:00:00Z'),
    updated_at: new Date('2026-11-06T10:05:00Z'),
  });
}

describe('toVideoDetailResponse', () => {
  it('should expose status, metadata and the thumbnail URL', () => {
    const result = toVideoDetailResponse(readyVideo(), 'https://s/thumb');

    expect(result).toEqual({
      public_id: 'pubVideo001',
      title: 'aula',
      status: 'draft',
      processing_status: 'ready',
      processing_error: null,
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 1048576,
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 286269,
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      thumbnail_url: 'https://s/thumb',
      created_at: '2026-11-06T10:00:00.000Z',
      updated_at: '2026-11-06T10:05:00.000Z',
    });
  });

  it('should never include internal fields', () => {
    const result = toVideoDetailResponse(readyVideo(), null);

    for (const field of INTERNAL_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it('should return thumbnail_url null when no thumbnail exists', () => {
    expect(toVideoDetailResponse(readyVideo(), null).thumbnail_url).toBeNull();
  });
});
