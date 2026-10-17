import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const MAX_BYTES = 6 * 1024 * 1024;

export function ensureUploadDir(): void {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export function toNodeBuffer(value: unknown): Buffer | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  if (value instanceof Uint8Array) return value.byteLength ? Buffer.from(value) : null;
  if (Array.isArray(value) && value.length && typeof value[0] === 'number') return Buffer.from(value);
  if (typeof value === 'string' && value.startsWith('\\x') && value.length > 4) {
    try {
      const buf = Buffer.from(value.slice(2), 'hex');
      return buf.length ? buf : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function diskPathFor(storedName: unknown): string | null {
  if (!storedName) return null;
  const file = path.join(UPLOAD_DIR, path.basename(String(storedName)));
  return file.startsWith(UPLOAD_DIR) ? file : null;
}

export function readDiskFile(storedName: unknown): Buffer | null {
  const file = diskPathFor(storedName);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const buf = fs.readFileSync(file);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** Octets du justificatif : colonne Postgres/sqlite d’abord, disque ensuite. */
export function resolveFileBytes(storedName: unknown, fileBytes: unknown): Buffer | null {
  return toNodeBuffer(fileBytes) || readDiskFile(storedName);
}

export function saveBase64File(input: { contentBase64?: string; fileName?: string; mimeType?: string }): {
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
} {
  const raw = String(input?.contentBase64 || '').trim();
  if (!raw) {
    const err: any = new Error('Fichier requis.');
    err.status = 422;
    throw err;
  }
  const b64 = (raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 8) {
    const err: any = new Error('Fichier illisible.');
    err.status = 422;
    throw err;
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) {
    const err: any = new Error('Fichier vide.');
    err.status = 422;
    throw err;
  }
  if (buf.length > MAX_BYTES) {
    const err: any = new Error('Fichier trop volumineux (6 Mo maximum).');
    err.status = 422;
    throw err;
  }
  ensureUploadDir();
  const original = String(input.fileName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'document';
  const storedName = uuidv4() + '_' + original;
  const dest = path.join(UPLOAD_DIR, storedName);
  if (!dest.startsWith(UPLOAD_DIR)) {
    const err: any = new Error('Nom de fichier refusé.');
    err.status = 422;
    throw err;
  }
  fs.writeFileSync(dest, buf);
  return {
    storedName,
    mimeType: String(input.mimeType || 'application/octet-stream').slice(0, 120),
    sizeBytes: buf.length,
    bytes: buf,
  };
}
