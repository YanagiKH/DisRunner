import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

export class RegularFileError extends Error {
  public constructor(public readonly code: 'unsafe-path' | 'conflict') {
    super(
      code === 'unsafe-path'
        ? 'Files must be regular files, not links or directories.'
        : 'The file changed while it was being opened.',
    );
    this.name = 'RegularFileError';
  }
}

export async function openRegularFile(
  filePath: string,
): Promise<{ handle: FileHandle; info: Stats }> {
  let handle: FileHandle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (hasCode(error, 'ELOOP') || hasCode(error, 'EISDIR'))
      throw new RegularFileError('unsafe-path');
    let current;
    try {
      current = await lstat(filePath);
    } catch {
      throw error;
    }
    if (!current.isFile() || current.isSymbolicLink()) throw new RegularFileError('unsafe-path');
    if (hasCode(error, 'ENOENT')) throw new RegularFileError('conflict');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new RegularFileError('unsafe-path');
    let current;
    try {
      current = await lstat(filePath);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) throw new RegularFileError('conflict');
      throw error;
    }
    if (!current.isFile() || current.isSymbolicLink()) throw new RegularFileError('unsafe-path');
    if (current.ino !== info.ino || current.dev !== info.dev)
      throw new RegularFileError('conflict');
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function hashRegularFile(filePath: string, limit: number): Promise<string | null> {
  const { handle, info } = await openRegularFile(filePath);
  try {
    if (info.size > limit) return null;
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(65_536);
    let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, limit + 1 - count),
        count,
      );
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > limit) return null;
      digest.update(chunk.subarray(0, bytesRead));
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
