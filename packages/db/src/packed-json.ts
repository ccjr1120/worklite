import { deflateSync, inflateSync } from 'node:zlib';
import { customType } from 'drizzle-orm/sqlite-core';

const PREFIX = 'worklite:z1:';
/** Reads both historical JSON and losslessly packed immutable payloads. */
export function unpackJson<T>(value: string): T {
  return JSON.parse(
    value.startsWith(PREFIX)
      ? inflateSync(Buffer.from(value.slice(PREFIX.length), 'base64')).toString('utf8')
      : value,
  ) as T;
}
export function packJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length < 2048) return json;
  const packed = PREFIX + deflateSync(json).toString('base64');
  return packed.length < json.length ? packed : json;
}
export const packedJson = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType: () => 'text',
    toDriver: packJson,
    fromDriver: (value) => unpackJson<T>(value),
  })(name);

export function packText(value: string): string {
  if (value.length < 2048 && !value.startsWith(PREFIX)) return value;
  const packed = PREFIX + deflateSync(value).toString('base64');
  return packed.length < value.length || value.startsWith(PREFIX) ? packed : value;
}
export function unpackText(value: string): string {
  return value.startsWith(PREFIX)
    ? inflateSync(Buffer.from(value.slice(PREFIX.length), 'base64')).toString('utf8')
    : value;
}
export const packedText = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => 'text',
    toDriver: packText,
    fromDriver: unpackText,
  })(name);

/** Keep the event discriminator directly queryable by old/new SQLite connections. */
export const packedEventJson = (name: string) =>
  customType<{ data: unknown; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => {
      const json = JSON.stringify(value);
      if (json.length < 2048) return json;
      const encoded = deflateSync(json).toString('base64');
      const kind = value && typeof value === 'object' && 'kind' in value ? value.kind : null;
      const packed = JSON.stringify({ kind, $workliteZ1: encoded });
      return packed.length < json.length ? packed : json;
    },
    fromDriver: (value) => {
      const decoded = unpackJson<unknown>(value);
      if (
        decoded &&
        typeof decoded === 'object' &&
        '$workliteZ1' in decoded &&
        typeof decoded.$workliteZ1 === 'string'
      )
        return unpackJson(PREFIX + decoded.$workliteZ1);
      return decoded;
    },
  })(name);
