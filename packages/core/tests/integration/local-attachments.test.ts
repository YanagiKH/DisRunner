import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LocalAttachmentStore,
  parseMultipartBody,
  type LocalUploadFile,
} from '../../src/local-attachments.js';

const boundary = 'DisRunner-file-boundary';
const contentType = `multipart/form-data; boundary=${boundary}`;
const file = (id = '0', text = 'hello'): LocalUploadFile => ({
  id,
  filename: `test-${id}.txt`,
  contentType: 'text/plain',
  data: Buffer.from(text),
});

function multipart(
  parts: readonly { headers: readonly string[]; data: Buffer | string }[],
): Buffer {
  return Buffer.concat([
    ...parts.flatMap((part) => [
      Buffer.from(`--${boundary}\r\n${part.headers.join('\r\n')}\r\n\r\n`),
      Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data),
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

function jsonPart(payload: unknown = { content: 'Hello' }) {
  return {
    headers: [
      'Content-Disposition: form-data; name="payload_json"',
      'Content-Type: application/json',
    ],
    data: JSON.stringify(payload),
  };
}

function filePart(id = '0', data: Buffer | string = 'hello', filename = `test-${id}.txt`) {
  return {
    headers: [
      `Content-Disposition: form-data; name="files[${id}]"; filename="${filename}"`,
      'Content-Type: text/plain',
    ],
    data,
  };
}

function store(options: Partial<ConstructorParameters<typeof LocalAttachmentStore>[0]> = {}) {
  let id = 1000;
  return new LocalAttachmentStore({
    baseUrl: 'http://127.0.0.1:4242',
    generateId: () => String(++id),
    ...options,
  });
}

describe('local SDK multipart uploads', () => {
  it('parses native FormData with binary content and preserves attachment references', async () => {
    const bytes = Uint8Array.from([0, 255, 13, 10, 128, 42]);
    const form = new FormData();
    form.set(
      'payload_json',
      JSON.stringify({
        content: 'An attachment',
        attachments: [{ id: '0', filename: 'image.bin' }],
      }),
    );
    form.set('files[0]', new Blob([bytes], { type: 'application/octet-stream' }), 'image.bin');
    const request = new Request('http://127.0.0.1:4242/upload', { method: 'POST', body: form });
    const parsed = parseMultipartBody(
      request.headers.get('content-type')!,
      Buffer.from(await request.arrayBuffer()),
    );
    expect(parsed.payload).toEqual({
      content: 'An attachment',
      attachments: [{ id: '0', filename: 'image.bin' }],
    });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      id: '0',
      filename: 'image.bin',
      contentType: 'application/octet-stream',
    });
    expect(parsed.files[0]!.data).toEqual(Buffer.from(bytes));
  });

  it('does not split file bytes at a boundary-like prefix and accepts files before payload', () => {
    const bytes = Buffer.from(`binary\0\r\n--${boundary}X\r\nend`, 'utf8');
    const parsed = parseMultipartBody(
      `multipart/form-data; boundary="${boundary}"`,
      multipart([filePart('0', bytes), jsonPart()]),
    );
    expect(parsed.files[0]!.data).toEqual(bytes);
    expect(parsed.payload).toEqual({ content: 'Hello' });
  });

  it('parses a native aiohttp FormData capture with its default text/plain JSON field', () => {
    // Captured from aiohttp 3.14.5 FormData: string payload_json plus a binary file.
    const captured = Buffer.from(
      'LS03NzczOGQ1NjIyYTM0ZWY4YTU0NWE1NTFkZTA5Y2Q1OQ0KQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluOyBjaGFyc2V0PXV0Zi04DQpDb250ZW50LURpc3Bvc2l0aW9uOiBmb3JtLWRhdGE7IG5hbWU9InBheWxvYWRfanNvbiINCg0KeyJjb250ZW50IjogIlB5dGhvbiBmaWxlIiwgImF0dGFjaG1lbnRzIjogW3siaWQiOiAwLCAiZmlsZW5hbWUiOiAic2FtcGxlLmJpbiJ9XX0NCi0tNzc3MzhkNTYyMmEzNGVmOGE1NDVhNTUxZGUwOWNkNTkNCkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtDQpDb250ZW50LURpc3Bvc2l0aW9uOiBmb3JtLWRhdGE7IG5hbWU9ImZpbGVzWzBdIjsgZmlsZW5hbWU9InNhbXBsZS5iaW4iDQoNClB5dGhvbiB1cGxvYWQKAP8NCi0tNzc3MzhkNTYyMmEzNGVmOGE1NDVhNTUxZGUwOWNkNTktLQ0K',
      'base64',
    );
    const parsed = parseMultipartBody(
      'multipart/form-data; boundary=77738d5622a34ef8a545a551de09cd59',
      captured,
    );
    expect(parsed.payload).toEqual({
      content: 'Python file',
      attachments: [{ id: 0, filename: 'sample.bin' }],
    });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      id: '0',
      filename: 'sample.bin',
      contentType: 'application/octet-stream',
    });
    expect(parsed.files[0]!.data).toEqual(
      Buffer.concat([Buffer.from('Python upload\n'), Buffer.from([0, 255])]),
    );
  });

  it('rejects binary or HTML payload_json media types even when the bytes contain valid JSON', () => {
    for (const type of ['application/octet-stream', 'text/html']) {
      const part = jsonPart();
      part.headers[1] = `Content-Type: ${type}`;
      expect(() => parseMultipartBody(contentType, multipart([part, filePart()]))).toThrow(
        'JSON text field',
      );
    }
  });

  it('supports UTF-8 extended filenames and callback data attachment descriptors', () => {
    const part = {
      headers: [
        'Content-Disposition: form-data; name="files[0]"; filename="fallback.txt"; filename*=UTF-8\'\'%E6%B8%AC%E8%A9%A6.txt',
      ],
      data: 'content',
    };
    const parsed = parseMultipartBody(
      contentType,
      multipart([
        jsonPart({ type: 4, data: { attachments: [{ id: 0, filename: '測試.txt' }] } }),
        part,
      ]),
    );
    expect(parsed.files[0]!.filename).toBe('測試.txt');
    expect(parsed.files[0]!.contentType).toBe('application/octet-stream');
  });

  it('validates every upload reference while allowing retained message attachment ids', () => {
    const payload = { attachments: [{ id: '9000' }, { id: 0, filename: 'test-0.txt' }] };
    expect(
      parseMultipartBody(contentType, multipart([jsonPart(payload), filePart()])).files,
    ).toHaveLength(1);
    for (const attachments of [
      [{ id: 0 }, { id: '0' }],
      [{ id: 1 }],
      [{ id: '00' }],
      [{ id: 0, filename: 'different.txt' }],
      [{ id: '9000' }],
      [{ id: '18446744073709551616' }],
      [],
    ])
      expect(() =>
        parseMultipartBody(contentType, multipart([jsonPart({ attachments }), filePart()])),
      ).toThrow();
    expect(() =>
      parseMultipartBody(
        contentType,
        multipart([
          jsonPart({ attachments: [{ id: 0 }], data: { attachments: [{ id: 0 }] } }),
          filePart(),
        ]),
      ),
    ).toThrow();
  });

  it('rejects missing or duplicate parts, ambiguous headers and malformed framing', () => {
    const badBodies = [
      multipart([filePart()]),
      multipart([jsonPart(), jsonPart()]),
      multipart([jsonPart(), filePart(), filePart()]),
      multipart([jsonPart(), filePart('10')]),
      multipart([
        jsonPart(),
        { headers: ['Content-Disposition: form-data; name="unexpected"'], data: 'value' },
      ]),
      multipart([
        jsonPart(),
        { headers: [...filePart().headers, 'Content-Type: text/html'], data: 'value' },
      ]),
      multipart([
        jsonPart(),
        {
          headers: [
            'Content-Disposition: form-data; name="files[0]"; name="files[1]"; filename="x.txt"',
          ],
          data: 'value',
        },
      ]),
      multipart([
        jsonPart(),
        { headers: [...filePart().headers, 'Content-Transfer-Encoding: base64'], data: 'aGVsbG8=' },
      ]),
      multipart([jsonPart(), filePart('0', 'value', '../outside.txt')]),
      multipart([jsonPart(), filePart('0', 'value', 'C:\\outside.txt')]),
      multipart([jsonPart()]).subarray(0, -5),
      Buffer.concat([multipart([jsonPart()]), Buffer.from('unexpected epilogue')]),
      Buffer.from('no boundaries'),
    ];
    for (const body of badBodies) expect(() => parseMultipartBody(contentType, body)).toThrow();
    for (const type of [
      'application/json',
      'multipart/form-data',
      'multipart/form-data; boundary="unterminated',
      `multipart/form-data; boundary=${boundary}; boundary=other`,
    ])
      expect(() => parseMultipartBody(type, multipart([jsonPart()]))).toThrow();
  });

  it('enforces byte, header, payload and file-count limits at their boundaries', () => {
    const body = multipart([jsonPart(), filePart('0', '1234')]);
    expect(
      parseMultipartBody(contentType, body, {
        maxFileBytes: 4,
        maxBodyBytes: body.length,
      }).files[0]!.data.toString(),
    ).toBe('1234');
    expect(() => parseMultipartBody(contentType, body, { maxFileBytes: 3 })).toThrow();
    expect(() =>
      parseMultipartBody(contentType, body, { maxBodyBytes: body.length - 1 }),
    ).toThrow();
    expect(() => parseMultipartBody(contentType, body, { maxHeaderBytes: 10 })).toThrow();
    expect(() => parseMultipartBody(contentType, body, { maxPayloadBytes: 4 })).toThrow();
    expect(() => parseMultipartBody(contentType, Buffer.alloc(8 * 1_048_576 + 1))).toThrow();
    expect(() =>
      parseMultipartBody(
        contentType,
        multipart([jsonPart(), filePart('0', Buffer.alloc(2 * 1_048_576 + 1))]),
      ),
    ).toThrow();
    expect(
      parseMultipartBody(
        contentType,
        multipart([
          jsonPart(),
          ...Array.from({ length: 10 }, (_, index) => filePart(String(index))),
        ]),
      ).files,
    ).toHaveLength(10);
    expect(() =>
      parseMultipartBody(contentType, multipart([jsonPart(), filePart('0'), filePart('1')]), {
        maxFiles: 1,
      }),
    ).toThrow();
    expect(() =>
      parseMultipartBody(contentType, body, { maxFileBytes: 2 * 1_048_576 + 1 }),
    ).toThrow(TypeError);
  });

  it('rejects invalid JSON/UTF-8 without echoing payload bytes in errors', () => {
    for (const data of ['{"secret":"do-not-echo"', '[]', 'null', Buffer.from([0xff])]) {
      const body = multipart([{ ...jsonPart(), data }]);
      expect(() => parseMultipartBody(contentType, body)).toThrow();
      try {
        parseMultipartBody(contentType, body);
      } catch (error) {
        expect((error as Error).message).not.toContain('do-not-echo');
      }
    }
  });
});

describe('LocalAttachmentStore', () => {
  it('publishes bytes only on commit and gives SDK-shaped metadata with a verified digest', () => {
    const attachments = store();
    const source = file();
    const batch = attachments.prepare([source]);
    expect(batch.byUploadId['0']).toEqual(batch.attachments[0]);
    const metadata = batch.attachments[0]!;
    expect(metadata).toEqual({
      id: '1001',
      filename: 'test-0.txt',
      size: 5,
      content_type: 'text/plain',
      url: 'http://127.0.0.1:4242/attachments/1001',
      proxy_url: 'http://127.0.0.1:4242/attachments/1001',
      sha256: createHash('sha256').update('hello').digest('hex'),
    });
    expect(attachments.get(metadata.id)).toBeUndefined();
    expect(attachments.stats()).toEqual({ files: 0, bytes: 0, pendingFiles: 1, pendingBytes: 5 });
    source.data.fill(0);
    batch.commit();
    batch.commit();
    batch.rollback();
    expect(attachments.get(metadata.id)!.data.toString()).toBe('hello');
    const copied = attachments.get(metadata.id)!;
    copied.data.fill(0);
    expect(attachments.get(metadata.id)!.data.toString()).toBe('hello');
    expect(attachments.stats()).toEqual({ files: 1, bytes: 5, pendingFiles: 0, pendingBytes: 0 });
  });

  it('rolls failed message preparation back without consuming capacity or publishing bytes', () => {
    const attachments = store({ maxBytes: 5, maxFiles: 1 });
    const batch = attachments.prepare([file()]);
    expect(() => attachments.prepare([file()])).toThrow('storage is full');
    expect(attachments.stats()).toEqual({ files: 0, bytes: 0, pendingFiles: 1, pendingBytes: 5 });
    batch.rollback();
    batch.rollback();
    expect(() => batch.commit()).toThrow();
    expect(attachments.stats()).toEqual({ files: 0, bytes: 0, pendingFiles: 0, pendingBytes: 0 });
    const next = attachments.prepare([file()]);
    next.commit();
    expect(attachments.get(next.attachments[0]!.id)!.data.toString()).toBe('hello');
  });

  it('rejects malformed files, duplicate upload/generated ids and remote URLs without mutations', () => {
    const attachments = store({ generateId: () => '1000' });
    expect(() => attachments.prepare([file(), file()])).toThrow();
    expect(() => attachments.prepare([file('0'), file('1')])).toThrow();
    expect(attachments.stats()).toEqual({ files: 0, bytes: 0, pendingFiles: 0, pendingBytes: 0 });
    const batch = attachments.prepare([file()]);
    expect(() => attachments.prepare([file('1')])).toThrow();
    batch.commit();
    expect(() => attachments.prepare([file('1')])).toThrow();
    expect(() => store({ baseUrl: 'https://discord.com' })).toThrow();
    expect(() => store({ baseUrl: 'http://localhost:4242' })).toThrow();
    expect(() => store({ baseUrl: 'http://user:pass@127.0.0.1:4242' })).toThrow();
    expect(() => store({ baseUrl: 'http://127.0.0.1:4242/path' })).toThrow();
    expect(() => store().prepare([{ ...file(), filename: '../outside' }])).toThrow();
    expect(() => store().prepare([{ ...file(), contentType: 'invalid' }])).toThrow();
  });

  it('clears per-session data and invalidates unsettled batches', () => {
    const attachments = store();
    const committed = attachments.prepare([file()]);
    committed.commit();
    const pending = attachments.prepare([file()]);
    attachments.clear();
    expect(attachments.stats()).toEqual({ files: 0, bytes: 0, pendingFiles: 0, pendingBytes: 0 });
    expect(attachments.get(committed.attachments[0]!.id)).toBeUndefined();
    expect(() => pending.commit()).toThrow();
    expect(() => pending.rollback()).not.toThrow();
    const next = attachments.prepare([file()]);
    next.commit();
    expect(attachments.stats().files).toBe(1);
  });

  it('imports project-local files with spaces and Unicode, bounded size and no traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'DisRunner attachments '));
    try {
      await mkdir(join(root, 'fixtures'));
      await writeFile(join(root, 'fixtures', '測試 file.txt'), 'Local fixture');
      const attachments = store();
      const batch = await attachments.addFile(root, 'fixtures/測試 file.txt', 'text/plain');
      expect(batch.attachments[0]!.filename).toBe('測試 file.txt');
      batch.commit();
      expect(attachments.get(batch.attachments[0]!.id)!.data.toString()).toBe('Local fixture');
      for (const relative of [
        '../outside.txt',
        '/etc/passwd',
        'C:\\outside.txt',
        'https://example.com/file.txt',
        '\\server\\file',
      ])
        await expect(attachments.addFile(root, relative)).rejects.toThrow();
      await writeFile(join(root, 'large.bin'), Buffer.alloc(2 * 1_048_576 + 1));
      await expect(attachments.addFile(root, 'large.bin')).rejects.toThrow('byte limit');
      expect(attachments.stats()).toEqual({
        files: 1,
        bytes: 13,
        pendingFiles: 0,
        pendingBytes: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlink escapes and final symlink files',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'DisRunner attachment root '));
      const outside = await mkdtemp(join(tmpdir(), 'DisRunner attachment outside '));
      try {
        await writeFile(join(outside, 'private.txt'), 'Do not import');
        await writeFile(join(root, 'inside.txt'), 'Inside');
        await symlink(outside, join(root, 'linked-directory'), 'dir');
        await symlink(join(outside, 'private.txt'), join(root, 'linked-file.txt'));
        await symlink(join(root, 'inside.txt'), join(root, 'internal-link.txt'));
        const attachments = store();
        for (const relative of [
          'linked-directory/private.txt',
          'linked-file.txt',
          'internal-link.txt',
        ])
          await expect(attachments.addFile(root, relative)).rejects.toThrow();
        expect(attachments.stats()).toEqual({
          files: 0,
          bytes: 0,
          pendingFiles: 0,
          pendingBytes: 0,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
});
