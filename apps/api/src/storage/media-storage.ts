import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { config } from '../config';

/** Where selfies and document images live. Production will use S3 with KMS encryption. */
export abstract class MediaStorage {
  abstract put(key: string, data: Buffer): Promise<void>;
  abstract get(key: string): Promise<Buffer>;
}

@Injectable()
export class LocalMediaStorage extends MediaStorage {
  private readonly root = resolve(config.storageDir);

  async put(key: string, data: Buffer) {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string) {
    return readFile(this.resolveKey(key));
  }

  private resolveKey(key: string) {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return path;
  }
}
