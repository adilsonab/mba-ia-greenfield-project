import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  VIDEO_ALLOWED_CONTENT_TYPES,
  VIDEO_FILE_NAME_MAX_LENGTH,
  VIDEO_MAX_SIZE_BYTES,
  VIDEO_TITLE_MAX_LENGTH,
  type VideoContentType,
} from '../videos.constants';

export class StartUploadDto {
  /** Original file name, e.g. `aula.mp4` — reused for the download `Content-Disposition`. */
  @IsString()
  @Length(1, VIDEO_FILE_NAME_MAX_LENGTH)
  file_name: string;

  /** Declared MIME type; one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`. */
  @IsIn(VIDEO_ALLOWED_CONTENT_TYPES)
  content_type: VideoContentType;

  /** Declared file size in bytes (1 to 10737418240 — 10 GiB). Drives the multipart plan. */
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SIZE_BYTES)
  size_bytes: number;

  /** Optional title; defaults to the file name without its extension. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, VIDEO_TITLE_MAX_LENGTH)
  title?: string;
}
