# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Object storage (MinIO):** `docker compose exec storage mc ready local` — expect `The cluster 'local' is ready` (the image has no curl; `docker compose ps` also shows `healthy`)
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started — consuming queue "video-processing"`

`video-worker` is part of the infrastructure (it has no HTTP port): `docker compose up -d` starts it together with `db`, `storage` and `redis`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP sink, ports `1025` (SMTP) and `8025` (web UI)
- `storage` — MinIO (S3-compatible, Chainguard image pinned by digest), ports `9000` (S3 API) and `9001` (console), credentials `S3_ACCESS_KEY`/`S3_SECRET_KEY`, single bucket `S3_BUCKET` created on API boot. Network alias `storage.localhost` (see "Videos pipeline")
- `redis` — Redis 7, port `6379`, backend of the BullMQ queue `video-processing`
- `video-worker` — same image and codebase as the API, no HTTP; runs `npm run start:worker:dev` and consumes the `video-processing` queue with FFmpeg/ffprobe (installed in `Dockerfile.dev`)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Restart the worker after editing worker code (see "Videos pipeline")
docker compose restart video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker from source (what the video-worker service runs)
npm run start:worker                     # Video worker from the compiled build (dist/worker.js)
npm run openapi:export                   # Regenerate openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

**Video e2e precondition:** `storage`, `redis` and `video-worker` must be running. `test/videos-pipeline.e2e-spec.ts` uploads real files and polls `GET /videos/:publicId` until the worker marks them `ready`/`failed` (90 s polling, `testTimeout` 120 s in `test/jest-e2e.json`); without the worker it times out. The other video e2e suites complete the multipart through `StorageService` and set `ready` directly in the DB, so they never race the running worker.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share the codebase: `src/main.ts` (HTTP API, `AppModule`) and `src/worker.ts` (video worker, `WorkerModule`, `createApplicationContext` without HTTP)

## Videos pipeline

- **Modules:** `src/videos/` (entity, endpoints, upload rules), `src/storage/` (S3 client: multipart, presign, head/get/put/delete), `src/video-processing/` (BullMQ producer, processor, queue modules), `src/media/` (ffprobe/ffmpeg via `execFile`, no shell)
- **Upload never passes through the API:** `POST /videos` returns one presigned `UploadPart` URL per part (`VIDEO_UPLOAD_PART_SIZE_BYTES`, default 64 MiB, S3 minimum 5 MiB); the client PUTs bytes straight to the storage and calls `POST /videos/:publicId/upload/complete` with the ETags. Max size 10 GiB
- **Storage keys:** one bucket, per-video keys `videos/<videoId>/original` and `videos/<videoId>/thumbnail.jpg` (`src/storage/storage.constants.ts`)
- **Queue:** BullMQ queue `video-processing`, job `video.process` with payload `{ videoId }`, `jobId = videoId`, 3 attempts with exponential backoff (10 s). Invalid media throws `UnrecoverableError` (no retry) and ends `failed` with `processing_error`
- **Status:** `status` (publication, `draft` in this phase) and `processing_status` (`awaiting_upload → processing → ready | failed`)
- **S3 client config:** `forcePathStyle: true` and `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` — without the latter, AWS SDK v3 adds CRC32 checksums that break presigned `UploadPart`

### `storage.localhost` — documented exception to the service-name rule

Server-side S3 calls use the service name (`S3_ENDPOINT=http://storage:9000`). Presigned URLs are signed against `S3_PUBLIC_ENDPOINT=http://storage.localhost:9000` **only**, because a signed URL embeds its host and must work in two places: browsers resolve `*.localhost` to `127.0.0.1` (port `9000` is published) and containers resolve it to the `storage` service through the Compose network alias. Never use `storage.localhost` for server-side calls.

**curl caveat:** inside containers, `curl http://storage.localhost:9000/...` returns `000` — curl hard-wires every `*.localhost` name to `127.0.0.1` (RFC 6761) without asking DNS. Node `fetch`/`http` (what the tests use) resolve the alias correctly. To probe with curl, pass `--resolve storage.localhost:9000:<storage container IP>`.

### Worker reload on Windows hosts

`start:worker:dev` uses `node --watch`, but Docker Desktop does not propagate file-change events from Windows bind mounts into Linux containers. On Windows, run `docker compose restart video-worker` after changing worker code (`src/worker*.ts`, `src/video-processing/`, `src/media/`, `src/storage/`). Linux/macOS hosts reload automatically.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
