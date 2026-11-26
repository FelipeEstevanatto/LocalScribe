import { describe, expect, test } from 'bun:test';
import { checksumsOffThread } from '../src/checksum-client';
import { checksumsFor } from '../src/file-metadata';

describe('checksums off the main thread', () => {
  test('the worker returns the same checksums as the page', async () => {
    const bytes = new Uint8Array(3_000_017);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 2654435761) >>> 24;
    const blob = new Blob([bytes]);
    expect(await checksumsOffThread(blob)).toEqual(await checksumsFor(blob));
  });
});
