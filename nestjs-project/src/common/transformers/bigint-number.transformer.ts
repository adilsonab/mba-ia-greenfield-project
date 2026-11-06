import type { ValueTransformer } from 'typeorm';

/**
 * `pg` returns `bigint` and `numeric` columns as strings to avoid precision
 * loss. The values stored by this project (byte sizes up to 10 GiB, bitrates,
 * durations) are far below `Number.MAX_SAFE_INTEGER`, so they are mapped to
 * plain numbers at the entity boundary.
 */
export const bigintNumberTransformer: ValueTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};
