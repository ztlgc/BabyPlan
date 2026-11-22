import { lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 私有媒体磁盘适配器。对象键只由服务端生成，调用方不能传入任意文件路径。
 * 生产环境应把根目录挂载到非网页目录并限制进程账户权限。
 */
export class LocalPrivateMediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(objectKey: string): string {
    if (!objectKey || objectKey.includes('\0') || isAbsolute(objectKey)) {
      throw new Error('无效的私有对象键');
    }
    const target = resolve(this.root, objectKey);
    const rel = relative(this.root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('私有对象路径越界');
    return target;
  }

  async write(objectKey: string, data: Buffer): Promise<void> {
    const target = this.pathFor(objectKey);
    await rejectLinkedPath(target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
    }
  }

  async read(objectKey: string): Promise<Buffer> {
    const target = this.pathFor(objectKey);
    await rejectLinkedPath(target);
    return readFile(target);
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(objectKey))).isFile();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async size(objectKey: string): Promise<number | null> {
    try {
      return (await stat(this.pathFor(objectKey))).size;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    const target = this.pathFor(objectKey);
    await rejectLinkedPath(target);
    try {
      await unlink(target);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async deleteTree(objectKey: string): Promise<void> {
    const target = this.pathFor(objectKey);
    await rejectLinkedPath(target);
    await rm(target, { recursive: true, force: true });
  }

  async deleteObjectWithTemporaryCopies(objectKey: string): Promise<void> {
    const target = this.pathFor(objectKey);
    await this.delete(objectKey);
    try {
      const prefix = target.slice(dirname(target).length + 1) + '.';
      for (const entry of await readdir(dirname(target))) {
        if (entry.startsWith(prefix) && /^[a-f0-9-]{36}\.tmp$/.test(entry.slice(prefix.length))) {
          await unlink(resolve(dirname(target), entry)).catch(error => { if (!isMissing(error)) throw error; });
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function rejectLinkedPath(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await rejectLinkedPath(parent);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('私有存储不能经过符号链接');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
