import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Channel } from '../../src/channels/entities/channel.entity';
import { User } from '../../src/users/entities/user.entity';

export interface AuthenticatedUser {
  userId: string;
  channelId: string;
  accessToken: string;
}

let counter = 0;

/**
 * Registers a user through the real API, marks the e-mail as confirmed in the
 * database (the confirmation flow itself is covered by test/auth.e2e-spec.ts)
 * and logs in to obtain an access token.
 */
export async function createAuthenticatedUser(
  app: INestApplication<App>,
  prefix = 'videos',
): Promise<AuthenticatedUser> {
  const email = `${prefix}_${Date.now()}_${++counter}@example.com`;
  const password = 'password123';
  const server = app.getHttpServer();

  const registered = await request(server)
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  const userId = (registered.body as { id: string }).id;

  const dataSource = app.get(DataSource);
  await dataSource.getRepository(User).update(userId, { is_confirmed: true });
  const channel = await dataSource
    .getRepository(Channel)
    .findOneByOrFail({ user_id: userId });

  const login = await request(server)
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    userId,
    channelId: channel.id,
    accessToken: (login.body as { access_token: string }).access_token,
  };
}
