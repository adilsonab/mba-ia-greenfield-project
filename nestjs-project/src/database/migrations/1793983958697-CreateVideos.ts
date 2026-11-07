import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1793983958697 implements MigrationInterface {
  name = 'CreateVideos1793983958697';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('awaiting_upload', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(100) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'awaiting_upload', "processing_error" text, "original_file_name" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "declared_size_bytes" bigint NOT NULL, "size_bytes" bigint, "storage_key" character varying(255) NOT NULL, "thumbnail_key" character varying(255), "upload_id" character varying(255), "duration_seconds" numeric(12,3), "width" integer, "height" integer, "video_codec" character varying(50), "audio_codec" character varying(50), "bitrate" bigint, "container_format" character varying(100), "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
