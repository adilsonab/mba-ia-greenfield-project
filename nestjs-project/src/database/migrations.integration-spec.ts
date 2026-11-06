import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1793983958697 } from './migrations/1793983958697-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Postgres enum types outlive DROP TABLE; they must be dropped explicitly or
// re-running the migrations against an already-migrated DB fails.
const VIDEO_TYPES = ['videos_status_enum', 'videos_processing_status_enum'];
const MANAGED_TYPES = ['verification_tokens_type_enum', ...VIDEO_TYPES];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1793983958697,
        ],
      },
    );

    await dataSource.initialize();

    await Promise.all([
      ...MANAGED_TABLES.map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
      dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`),
    ]);

    await Promise.all(
      MANAGED_TYPES.map((type) =>
        dataSource.query(`DROP TYPE IF EXISTS "public"."${type}"`),
      ),
    );
  });

  afterAll(async () => {
    // The last test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    // destroy() runs in finally so a failure here never leaves an open
    // connection that keeps Jest hanging.
    try {
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
  });

  const existingTypes = async (types: string[]): Promise<string[]> => {
    const rows = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[]) ORDER BY typname`,
      [types],
    );
    return rows.map((r) => r.typname);
  };

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
    expect(await existingTypes(VIDEO_TYPES)).toEqual([
      'videos_processing_status_enum',
      'videos_status_enum',
    ]);
  });

  it('should revert the last migration and remove the videos table and its enum types', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
    expect(await existingTypes(VIDEO_TYPES)).toEqual([]);
  });

  it('should re-apply the reverted migration cleanly', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations.map((m) => m.name)).toEqual([
      'CreateVideos1793983958697',
    ]);
    expect(await existingTypes(VIDEO_TYPES)).toHaveLength(2);

    // Leave the last migration undone again so afterAll exercises the same
    // restore path the other tests rely on.
    await dataSource.undoLastMigration();
  });
});
