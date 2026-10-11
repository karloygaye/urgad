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

export function saveBase64File(input: { contentBase64?: string; fileName?: string; mimeType?: string }): {
  storedName: string;
  mimeType: string;
  sizeBytes: number;
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
  };
}
