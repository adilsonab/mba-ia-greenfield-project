import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { ResumeUploadResponseDto } from './dto/resume-upload-response.dto';
import { StartUploadDto } from './dto/start-upload.dto';
import { StartUploadResponseDto } from './dto/start-upload-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft in the caller's channel and returns the multipart upload plan: one presigned UploadPart URL per part. The client uploads the bytes directly to object storage — no file bytes go through the API.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload plan issued',
    type: StartUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (size above 10 GiB, unsupported type, …)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: StartUploadDto,
  ): Promise<StartUploadResponseDto> {
    return this.videosService.startUpload(user.sub, dto);
  }

  @Get(':publicId/upload')
  @ApiOperation({
    summary: 'Resume a video upload',
    description:
      'Lists the parts already stored and issues fresh presigned URLs only for the missing ones, so an interrupted upload can continue where it stopped.',
  })
  @ApiParam({ name: 'publicId', description: 'Video public id (11 chars)' })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts and URLs for the missing ones',
    type: ResumeUploadResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not in progress',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description: 'The storage no longer has the multipart upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async resumeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<ResumeUploadResponseDto> {
    return this.videosService.resumeUpload(user.sub, publicId);
  }
}
