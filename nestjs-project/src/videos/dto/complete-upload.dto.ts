import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { S3_MAX_PARTS } from '../videos.constants';

export class CompletedPartDto {
  /** Part number from the upload plan (1–10000). */
  @IsInt()
  @Min(1)
  @Max(S3_MAX_PARTS)
  part_number: number;

  /** `ETag` header returned by the storage on that part's `PUT`. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every part of the plan with the ETag the storage returned for it. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(S3_MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
