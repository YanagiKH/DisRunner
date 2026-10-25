import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { DiscordApiError } from './interactions.js';

export interface MultipartLimits {
  readonly maxBodyBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxHeaderBytes?: number;
  readonly maxPayloadBytes?: number;
}

export interface LocalUploadFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
}

export interface ParsedMultipartBody {
  readonly payload: Record<string, unknown>;
  readonly files: readonly LocalUploadFile[];
}

export interface LocalAttachmentMetadata {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly content_type: string;
  readonly url: string;
  readonly proxy_url: string;
  readonly sha256: string;
}

export interface PreparedAttachments {
  readonly attachments: readonly LocalAttachmentMetadata[];
  readonly byUploadId: Readonly<Record<string, LocalAttachmentMetadata>>;
  commit(): void;
  rollback(): void;
}

interface RetainedAttachment {
  readonly metadata: LocalAttachmentMetadata;
  readonly data: Buffer;
}

const MAX_BODY_BYTES = 8 * 1_048_576;
const MAX_FILE_BYTES = 2 * 1_048_576;
const MAX_FILES = 10;
const MAX_HEADER_BYTES = 16_384;
const MAX_PAYLOAD_BYTES = 1_048_576;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u;
const UPLOAD_ID = /^(?:0|[1-9])$/u;
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/u;
const MAX_SNOWFLAKE = 18_446_744_073_709_551_615n;

/** Parse the multipart subset emitted by the supported SDKs without decoding file bytes. */
export function parseMultipartBody(
  contentType: string,
  raw: Buffer,
  limits: MultipartLimits = {},
): ParsedMultipartBody {
  const maxBodyBytes = boundedLimit(
    limits.maxBodyBytes,
    MAX_BODY_BYTES,
    MAX_BODY_BYTES,
    'maxBodyBytes',
  );
  const maxFileBytes = boundedLimit(
    limits.maxFileBytes,
    MAX_FILE_BYTES,
    MAX_FILE_BYTES,
    'maxFileBytes',
  );
  const maxFiles = boundedLimit(limits.maxFiles, MAX_FILES, MAX_FILES, 'maxFiles');
  const maxHeaderBytes = boundedLimit(
    limits.maxHeaderBytes,
    MAX_HEADER_BYTES,
    MAX_HEADER_BYTES,
    'maxHeaderBytes',
  );
  const maxPayloadBytes = boundedLimit(
    limits.maxPayloadBytes,
    MAX_PAYLOAD_BYTES,
    MAX_PAYLOAD_BYTES,
    'maxPayloadBytes',
  );
  if (!Buffer.isBuffer(raw)) throw invalid('Multipart body must contain bytes.');
  if (raw.byteLength > maxBodyBytes) throw tooLarge('Multipart body exceeds its byte limit.');
  const media = parseParameters(contentType, 2048);
  if (media.value.toLowerCase() !== 'multipart/form-data')
    throw invalid('Expected multipart/form-data.');
  const boundary = media.parameters.get('boundary');
  if (
    boundary === undefined ||
    boundary.length < 1 ||
    boundary.length > 70 ||
    !/^[0-9A-Za-z'()+_,\-./:=? ]+$/u.test(boundary) ||
    boundary.endsWith(' ')
  )
    throw invalid('Multipart boundary is missing or invalid.');
  const opening = Buffer.from(`--${boundary}\r\n`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  if (!raw.subarray(0, opening.length).equals(opening))
    throw invalid('Multipart body has an invalid opening boundary.');
  const files: LocalUploadFile[] = [];
  const ids = new Set<string>();
  let payload: Record<string, unknown> | undefined;
  let position = opening.length;
  let parts = 0;
  while (position < raw.length) {
    if (++parts > maxFiles + 1) throw invalid('Multipart body has too many parts.');
    const headerEnd = raw.indexOf('\r\n\r\n', position);
    if (headerEnd < 0 || headerEnd - position > maxHeaderBytes)
      throw invalid('Multipart part headers are missing or too large.');
    const headers = parseHeaders(raw.subarray(position, headerEnd));
    const disposition = parseParameters(headers.get('content-disposition') ?? '', maxHeaderBytes);
    if (disposition.value.toLowerCase() !== 'form-data')
      throw invalid('Multipart parts require a form-data disposition.');
    const name = disposition.parameters.get('name');
    const bodyStart = headerEnd + 4;
    const bodyEnd = nextDelimiter(raw, delimiter, bodyStart);
    if (bodyEnd < 0) throw invalid('Multipart part is missing its closing boundary.');
    const data = raw.subarray(bodyStart, bodyEnd);
    if (headers.has('content-transfer-encoding'))
      throw invalid('Encoded multipart file parts are not supported.');
    if (name === 'payload_json') {
      if (
        payload !== undefined ||
        disposition.parameters.has('filename') ||
        disposition.parameters.has('filename*')
      )
        throw invalid('Multipart body requires exactly one payload_json part.');
      if (data.length > maxPayloadBytes)
        throw tooLarge('Multipart JSON payload exceeds its byte limit.');
      const partType = headers.get('content-type');
      if (
        partType !== undefined &&
        !['application/json', 'text/plain'].includes(
          parseParameters(partType, 256).value.toLowerCase(),
        )
      )
        throw invalid('payload_json must contain a JSON text field.');
      if (!isUtf8(data)) throw invalid('Multipart JSON payload must be UTF-8.');
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString('utf8'));
      } catch {
        throw invalid('Multipart JSON payload is invalid.');
      }
      if (!isRecord(decoded)) throw invalid('Multipart JSON payload must be an object.');
      payload = decoded;
    } else {
      const match = /^files\[(0|[1-9])\]$/u.exec(name ?? '');
      if (match === null)
        throw invalid('Multipart file fields must use files[0] through files[9].');
      const id = match[1]!;
      if (ids.has(id)) throw invalid('Multipart file upload ids must be unique.');
      ids.add(id);
      if (files.length >= maxFiles) throw invalid('Multipart body has too many files.');
      if (data.byteLength > maxFileBytes) throw tooLarge('Attachment exceeds its file byte limit.');
      const encodedName = disposition.parameters.get('filename*');
      let filename = disposition.parameters.get('filename');
      if (encodedName !== undefined) {
        if (!/^utf-8''/iu.test(encodedName)) throw invalid('Extended filenames must use UTF-8.');
        try {
          filename = decodeURIComponent(encodedName.slice(7));
        } catch {
          throw invalid('Extended filename is invalid.');
        }
      }
      files.push({
        id,
        filename: validateFilename(filename),
        contentType: validateContentType(headers.get('content-type') ?? 'application/octet-stream'),
        data: Buffer.from(data),
      });
    }
    position = bodyEnd + delimiter.length;
    if (raw.subarray(position, position + 2).equals(Buffer.from('--'))) {
      position += 2;
      if (raw.subarray(position, position + 2).equals(Buffer.from('\r\n'))) position += 2;
      if (position !== raw.length) throw invalid('Multipart body has unexpected trailing data.');
      if (payload === undefined) throw invalid('Multipart body requires a payload_json part.');
      validateReferences(payload, files);
      return { payload, files };
    }
    position += 2; // nextDelimiter checked the CRLF beginning the next part.
  }
  throw invalid('Multipart body has no final boundary.');
}

/** Session-owned attachment bytes. Prepared batches reserve capacity until committed or rolled back. */
export class LocalAttachmentStore {
  readonly #baseUrl: string | (() => string);
  readonly #generateId: () => string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #maxFileBytes: number;
  readonly #files = new Map<string, RetainedAttachment>();
  readonly #pending = new Map<symbol, readonly RetainedAttachment[]>();
  readonly #reservedIds = new Set<string>();
  #bytes = 0;
  #reservedBytes = 0;
  #reservedFiles = 0;

  public constructor(options: {
    readonly baseUrl: string | (() => string);
    readonly generateId?: () => string;
    readonly maxBytes?: number;
    readonly maxFiles?: number;
    readonly maxFileBytes?: number;
  }) {
    this.#baseUrl = options.baseUrl;
    if (typeof this.#baseUrl === 'string') localBaseUrl(this.#baseUrl);
    else if (typeof this.#baseUrl !== 'function')
      throw new TypeError('baseUrl must be a loopback URL or a URL provider.');
    this.#generateId =
      options.generateId ?? (() => (randomBytes(8).readBigUInt64BE() || 1n).toString());
    this.#maxBytes = boundedLimit(options.maxBytes, 64 * 1_048_576, 256 * 1_048_576, 'maxBytes');
    this.#maxFiles = boundedLimit(options.maxFiles, 1024, 10_000, 'maxFiles');
    this.#maxFileBytes = boundedLimit(
      options.maxFileBytes,
      MAX_FILE_BYTES,
      MAX_FILE_BYTES,
      'maxFileBytes',
    );
  }

  public prepare(files: readonly LocalUploadFile[]): PreparedAttachments {
    if (!Array.isArray(files) || files.length > MAX_FILES)
      throw invalid('An upload batch supports at most 10 files.');
    if (files.length === 0)
      return Object.freeze({
        attachments: Object.freeze([]),
        byUploadId: Object.freeze({}),
        commit: () => undefined,
        rollback: () => undefined,
      });
    const baseUrl = localBaseUrl(
      typeof this.#baseUrl === 'function' ? this.#baseUrl() : this.#baseUrl,
    );
    const retained: RetainedAttachment[] = [];
    const byUploadId: Record<string, LocalAttachmentMetadata> = {};
    const generated = new Set<string>();
    let bytes = 0;
    for (const file of files) {
      if (
        !isRecord(file) ||
        typeof file.id !== 'string' ||
        !UPLOAD_ID.test(file.id) ||
        Object.hasOwn(byUploadId, file.id)
      )
        throw invalid('Upload ids must be unique indices from 0 through 9.');
      if (!Buffer.isBuffer(file.data) || file.data.byteLength > this.#maxFileBytes)
        throw tooLarge('Attachment exceeds its file byte limit.');
      const filename = validateFilename(file.filename);
      const contentType = validateContentType(file.contentType);
      bytes += file.data.byteLength;
      if (
        this.#bytes + this.#reservedBytes + bytes > this.#maxBytes ||
        this.#files.size + this.#reservedFiles + retained.length + 1 > this.#maxFiles
      )
        throw new DiscordApiError(507, 0, 'Local attachment storage is full.');
      const id = this.#generateId();
      if (
        typeof id !== 'string' ||
        !SNOWFLAKE.test(id) ||
        BigInt(id) > MAX_SNOWFLAKE ||
        this.#files.has(id) ||
        this.#reservedIds.has(id) ||
        generated.has(id)
      )
        throw invalid('Attachment id generator must return unique positive unsigned 64-bit ids.');
      generated.add(id);
      const metadata = Object.freeze({
        id,
        filename,
        size: file.data.byteLength,
        content_type: contentType,
        url: `${baseUrl}/attachments/${id}`,
        proxy_url: `${baseUrl}/attachments/${id}`,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      });
      retained.push({ metadata, data: Buffer.from(file.data) });
      byUploadId[file.id] = metadata;
    }
    const reservation = Symbol('attachment-batch');
    this.#pending.set(reservation, retained);
    this.#reservedBytes += bytes;
    this.#reservedFiles += retained.length;
    for (const id of generated) this.#reservedIds.add(id);
    let status: 'pending' | 'committed' | 'rolled-back' = 'pending';
    const release = (): boolean => {
      if (!this.#pending.delete(reservation)) return false;
      this.#reservedBytes -= bytes;
      this.#reservedFiles -= retained.length;
      for (const id of generated) this.#reservedIds.delete(id);
      return true;
    };
    return Object.freeze({
      attachments: Object.freeze(retained.map((file) => file.metadata)),
      byUploadId: Object.freeze(byUploadId),
      commit: (): void => {
        if (status === 'committed') return;
        if (status !== 'pending')
          throw invalid('A rolled back attachment batch cannot be committed.');
        if (!release()) throw invalid('Attachment batch no longer belongs to this session.');
        for (const file of retained) this.#files.set(file.metadata.id, file);
        this.#bytes += bytes;
        status = 'committed';
      },
      rollback: (): void => {
        if (status !== 'pending') return;
        release();
        status = 'rolled-back';
      },
    });
  }

  public get(
    id: string,
  ): { readonly metadata: LocalAttachmentMetadata; readonly data: Buffer } | undefined {
    const file = this.#files.get(id);
    return file === undefined
      ? undefined
      : { metadata: { ...file.metadata }, data: Buffer.from(file.data) };
  }

  /** Import a bounded file within the selected project; the caller still commits the batch. */
  public async addFile(
    root: string,
    relativePath: string,
    contentType = 'application/octet-stream',
  ): Promise<PreparedAttachments> {
    if (typeof relativePath !== 'string' || relativePath.length > 4096 || hasControl(relativePath))
      throw invalid('Attachment path is invalid.');
    const relative = relativePath.replaceAll('\\', '/');
    if (
      relative === '' ||
      path.posix.isAbsolute(relative) ||
      path.win32.isAbsolute(relative) ||
      relative.includes(':') ||
      relative.split('/').includes('..')
    )
      throw invalid('Attachment path must remain within the project.');
    const canonicalRoot = await realpath(root);
    if (!(await lstat(canonicalRoot)).isDirectory())
      throw invalid('Attachment project root must be a directory.');
    const source = path.resolve(canonicalRoot, relative);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
      throw invalid('Attachment source must be a regular file, not a link.');
    const canonicalSource = await realpath(source);
    const contained = path.relative(canonicalRoot, canonicalSource);
    if (
      contained === '' ||
      contained.startsWith(`..${path.sep}`) ||
      contained === '..' ||
      path.isAbsolute(contained)
    )
      throw invalid('Attachment path must remain within the project.');
    const handle = await open(canonicalSource, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== sourceInfo.ino || opened.dev !== sourceInfo.dev)
        throw invalid('Attachment file changed while it was being opened.');
      if (opened.size > this.#maxFileBytes)
        throw tooLarge('Attachment exceeds its file byte limit.');
      const buffer = Buffer.alloc(this.#maxFileBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, size);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      if (size > this.#maxFileBytes) throw tooLarge('Attachment exceeds its file byte limit.');
      return this.prepare([
        { id: '0', filename: path.basename(source), contentType, data: buffer.subarray(0, size) },
      ]);
    } finally {
      await handle.close();
    }
  }

  public stats(): {
    readonly files: number;
    readonly bytes: number;
    readonly pendingFiles: number;
    readonly pendingBytes: number;
  } {
    return {
      files: this.#files.size,
      bytes: this.#bytes,
      pendingFiles: this.#reservedFiles,
      pendingBytes: this.#reservedBytes,
    };
  }

  public clear(): void {
    this.#files.clear();
    this.#pending.clear();
    this.#reservedIds.clear();
    this.#bytes = 0;
    this.#reservedBytes = 0;
    this.#reservedFiles = 0;
  }
}

function validateReferences(
  payload: Record<string, unknown>,
  files: readonly LocalUploadFile[],
): void {
  const data = payload['data'];
  const rootAttachments = payload['attachments'];
  const callbackAttachments = isRecord(data) ? data['attachments'] : undefined;
  if (rootAttachments !== undefined && callbackAttachments !== undefined)
    throw invalid('Multipart attachments must have one message target.');
  const attachments = rootAttachments !== undefined ? rootAttachments : callbackAttachments;
  if (attachments === undefined) return;
  if (!Array.isArray(attachments) || attachments.length > MAX_FILES)
    throw invalid('Message attachments must be an array of at most 10 entries.');
  const seen = new Set<string>();
  const byId = new Map(files.map((file) => [file.id, file]));
  for (const attachment of attachments) {
    if (!isRecord(attachment)) throw invalid('Attachment descriptors must be objects.');
    const value = attachment['id'];
    const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    if (
      typeof id !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,19})$/u.test(id) ||
      BigInt(id) > MAX_SNOWFLAKE ||
      seen.has(id)
    )
      throw invalid('Attachment descriptor ids must be unique decimal ids.');
    seen.add(id);
    const file = byId.get(id);
    if (UPLOAD_ID.test(id) && file === undefined)
      throw invalid('Attachment descriptor references a missing upload.');
    if (
      file !== undefined &&
      attachment['filename'] !== undefined &&
      attachment['filename'] !== file.filename
    )
      throw invalid('Attachment descriptor filename must match its upload.');
  }
  if (files.some((file) => !seen.has(file.id)))
    throw invalid('Every uploaded file must have an attachment descriptor.');
}

function parseHeaders(source: Buffer): Map<string, string> {
  if (!isUtf8(source)) throw invalid('Multipart headers must contain UTF-8 text.');
  const headers = new Map<string, string>();
  const lines = source.toString('utf8').split('\r\n');
  if (lines.length > 32) throw invalid('Multipart part has too many headers.');
  for (const line of lines) {
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (colon <= 0 || !HEADER_TOKEN.test(key) || headers.has(key) || hasControl(value))
      throw invalid('Multipart part headers are invalid or duplicated.');
    headers.set(key, value);
  }
  return headers;
}

function parseParameters(
  source: string,
  maximum: number,
): { value: string; parameters: Map<string, string> } {
  if (typeof source !== 'string' || source.length > maximum || hasControl(source))
    throw invalid('Multipart header value is invalid.');
  let index = source.indexOf(';');
  const value = (index < 0 ? source : source.slice(0, index)).trim();
  const parameters = new Map<string, string>();
  if (index < 0) return { value, parameters };
  while (index < source.length) {
    index++;
    while (source[index] === ' ') index++;
    const nameStart = index;
    while (index < source.length && source[index] !== '=' && source[index] !== ';') index++;
    const name = source.slice(nameStart, index).trim().toLowerCase();
    if (source[index] !== '=' || !HEADER_TOKEN.test(name) || parameters.has(name))
      throw invalid('Multipart header parameters are invalid or duplicated.');
    index++;
    let parameter = '';
    if (source[index] === '"') {
      index++;
      let closed = false;
      while (index < source.length) {
        const character = source[index++];
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === '\\') {
          if (index >= source.length) throw invalid('Multipart quoted header is incomplete.');
          parameter += source[index++];
        } else parameter += character;
      }
      if (!closed) throw invalid('Multipart quoted header is incomplete.');
      while (source[index] === ' ') index++;
      if (index < source.length && source[index] !== ';')
        throw invalid('Multipart quoted header has unexpected data.');
    } else {
      const end = source.indexOf(';', index);
      parameter = source.slice(index, end < 0 ? source.length : end).trim();
      index = end < 0 ? source.length : end;
      if (!HEADER_TOKEN.test(parameter)) throw invalid('Multipart header parameter is invalid.');
    }
    parameters.set(name, parameter);
  }
  return { value, parameters };
}

function nextDelimiter(raw: Buffer, delimiter: Buffer, start: number): number {
  let position = raw.indexOf(delimiter, start);
  while (position >= 0) {
    const after = position + delimiter.length;
    if (
      (raw[after] === 13 && raw[after + 1] === 10) ||
      (raw[after] === 45 && raw[after + 1] === 45)
    )
      return position;
    position = raw.indexOf(delimiter, position + delimiter.length);
  }
  return -1;
}

function localBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Attachment baseUrl must be an absolute loopback HTTP URL.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    !['', '/'].includes(url.pathname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new TypeError(
      'Attachment baseUrl must use http://127.0.0.1 with a bound port and no credentials.',
    );
  return url.origin;
}

function validateFilename(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    Buffer.byteLength(value) > 255 ||
    hasControl(value) ||
    value === '.' ||
    value === '..' ||
    /[/\\:]/u.test(value)
  )
    throw invalid('Attachment filename must be a plain filename of at most 255 UTF-8 bytes.');
  return value;
}

function validateContentType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || hasControl(value))
    throw invalid('Attachment content type is invalid.');
  const type = parseParameters(value, 256).value;
  const [major, minor, ...extra] = type.split('/');
  if (
    major === undefined ||
    minor === undefined ||
    extra.length !== 0 ||
    !HEADER_TOKEN.test(major) ||
    !HEADER_TOKEN.test(minor)
  )
    throw invalid('Attachment content type must be a MIME type.');
  return value;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new TypeError(`${name} must be an integer from 1 through ${maximum}.`);
  return limit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
function invalid(message: string): DiscordApiError {
  return new DiscordApiError(400, 50035, message);
}
function tooLarge(message: string): DiscordApiError {
  return new DiscordApiError(413, 40005, message);
}
