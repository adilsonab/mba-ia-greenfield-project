import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { bigintNumberTransformer } from '../../common/transformers/bigint-number.transformer';

/** Publication axis — Phase 04 adds `published` (phase-03-videos/TD-11). */
export enum VideoStatus {
  DRAFT = 'draft',
}

/** Processing axis (phase-03-videos/TD-11). */
export enum VideoProcessingStatus {
  AWAITING_UPLOAD = 'awaiting_upload',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.AWAITING_UPLOAD,
  })
  processing_status: VideoProcessingStatus;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_file_name: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintNumberTransformer })
  declared_size_bytes: number;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  size_bytes: number | null;

  @Column({ type: 'varchar', length: 255 })
  storage_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: bigintNumberTransformer,
  })
  bitrate: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container_format: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // Owning side only (Data Model: "No inverse side added to Channel in this
  // phase"), matching RefreshToken/VerificationToken → User. An inverse
  // @OneToMany on Channel would force every test DataSource that registers
  // Channel to also register Video.
  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
