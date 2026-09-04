import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import env from '../config/env.js';
import { badRequest } from '../utils/http-error.js';
import { MAX_DOCUMENT_BYTES } from '../services/documents.service.js';

fs.mkdirSync(env.storage.templates, { recursive: true });
fs.mkdirSync(env.storage.tmp, { recursive: true });

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, env.storage.templates),
  filename: (_req, file, cb) => {
    // Never trust the client-supplied name on disk.
    const ext = path.extname(file.originalname).toLowerCase() || '.docx';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

export const uploadTemplate = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.docx') {
      return cb(badRequest('Only .docx templates are supported'));
    }
    if (file.mimetype !== DOCX_MIME && file.mimetype !== 'application/octet-stream') {
      return cb(badRequest(`Unexpected content type "${file.mimetype}" for a .docx file`));
    }
    return cb(null, true);
  },
}).single('file');

/**
 * Client paperwork: a signed PDF, a spreadsheet, occasionally a zip.
 *
 * Its own uploader because the ceiling is the feature's, not this file's — the limit is imported
 * from the service that owns the rule so the request cap and the stored-size check cannot
 * disagree, which is how you get a generic 413 instead of a sentence explaining the limit.
 *
 * No `fileFilter`: a client sends what a client sends, and the safety here is in how the download
 * serves it back rather than in guessing which extensions are acceptable.
 */
export const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
}).single('file');

/** In-memory upload used for imports (JSON/CSV) that never touch disk. */
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
}).single('file');

export default uploadTemplate;
