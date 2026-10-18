/**
 * Test-only in-memory Google Drive fake implementing {@link StorageProvider}.
 * Never used in production paths.
 */
import { Readable } from "node:stream";
import type {
  DownloadHandle,
  ProviderFileMeta,
  ProviderQuota,
  ResumableUploadSession,
  StorageProvider,
} from "@/lib/storage/provider";

type FakeObject = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  parents: string[];
  createdTime: number;
  trashed: boolean;
  content: Buffer;
};

export class FakeDriveProvider implements StorageProvider {
  objects = new Map<string, FakeObject>();
  nextId = 1;
  failNext: Error | null = null;
  failDelete = new Map<string, Error>();
  managedFolderId = "folder-1";
  quota: ProviderQuota | null = null;
  identity = { email: "storage@example.com", displayName: "Storage Account" };
  deletedIds: string[] = [];

  private maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async getIdentity() {
    return this.identity;
  }

  async ensureManagedFolder() {
    return { id: this.managedFolderId };
  }

  async createResumableUpload(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    parentId: string;
  }): Promise<ResumableUploadSession> {
    this.maybeFail();
    return {
      uploadUrl: `https://fake.invalid/upload/${this.nextId++}`,
      expiresAt: Date.now() + 55 * 60_000,
      method: "PUT",
      headers: { "Content-Type": input.mimeType },
    };
  }

  /** Simulate the client upload completing at the provider. */
  completeUpload(url: string, opts: { name: string; mimeType: string; sizeBytes: number; parentId?: string }): string {
    const id = `prov-${this.nextId++}`;
    this.objects.set(id, {
      id,
      name: opts.name,
      mimeType: opts.mimeType,
      sizeBytes: opts.sizeBytes,
      parents: [opts.parentId ?? this.managedFolderId],
      createdTime: Date.now(),
      trashed: false,
      content: Buffer.alloc(opts.sizeBytes),
    });
    return id;
  }

  seedObject(obj: Partial<FakeObject> & { id: string }): void {
    this.objects.set(obj.id, {
      name: obj.name ?? "file.bin",
      mimeType: obj.mimeType ?? "application/octet-stream",
      sizeBytes: obj.sizeBytes ?? 100,
      parents: obj.parents ?? [this.managedFolderId],
      createdTime: obj.createdTime ?? Date.now(),
      trashed: obj.trashed ?? false,
      content: Buffer.alloc(obj.sizeBytes ?? 100),
      ...obj,
    } as FakeObject);
  }

  async getFileMeta(providerFileId: string): Promise<ProviderFileMeta | null> {
    this.maybeFail();
    const o = this.objects.get(providerFileId);
    if (!o || o.trashed) return null;
    return {
      id: o.id,
      name: o.name,
      mimeType: o.mimeType,
      sizeBytes: o.sizeBytes,
      parents: o.parents,
      createdTime: o.createdTime,
      trashed: o.trashed,
    };
  }

  async deleteFile(providerFileId: string): Promise<{ deleted: boolean }> {
    const forced = this.failDelete.get(providerFileId);
    if (forced) throw forced;
    this.maybeFail();
    if (this.objects.has(providerFileId)) {
      this.deletedIds.push(providerFileId);
      this.objects.delete(providerFileId);
    }
    return { deleted: true };
  }

  async download(providerFileId: string): Promise<DownloadHandle> {
    this.maybeFail();
    const o = this.objects.get(providerFileId);
    if (!o) throw new Error("not found");
    return {
      stream: Readable.from([o.content]),
      contentType: o.mimeType,
      contentLength: o.sizeBytes,
      fileName: o.name,
      status: 200,
    };
  }

  async getQuota(): Promise<ProviderQuota | null> {
    return this.quota;
  }

  async testOperation(): Promise<void> {
    this.maybeFail();
  }
}
