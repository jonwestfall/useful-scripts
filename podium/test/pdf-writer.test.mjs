// podium/test/pdf-writer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdf } from '../assets/js/pdf-writer.js';

test('createPdf generates valid multi-page PDF bytes', async () => {
  // Create dummy 1x1 JPEG byte sequence or small dummy bytes for testing
  const dummyJpeg1 = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0xFF, 0xD9]);
  const dummyJpeg2 = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0xFF, 0xD9]);

  const pages = [
    { width: 1920, height: 1080, data: dummyJpeg1 },
    { width: 1920, height: 1080, data: dummyJpeg2 },
  ];

  const meta = {
    title: 'PSY 101 Lecture Notes',
    course: 'psy101',
    room: 'auditorium',
    date: new Date('2026-09-20T10:00:00Z'),
  };

  const blob = createPdf(pages, meta);
  assert.equal(blob.type, 'application/pdf');

  const buf = Buffer.from(await blob.arrayBuffer());
  const text = buf.toString('latin1');

  // Verify header
  assert.ok(text.startsWith('%PDF-1.4'), 'Header must be %PDF-1.4');

  // Verify Catalog & Pages count
  assert.ok(text.includes('/Type /Catalog'), 'Catalog object present');
  assert.ok(text.includes('/Type /Pages'), 'Pages root object present');
  assert.ok(text.includes('/Count 2'), 'Page count is 2');

  // Verify Page objects
  assert.ok(text.includes('/Type /Page'), 'Page objects present');
  assert.ok(text.includes('/Filter /DCTDecode'), 'DCTDecode image filter present');

  // Verify Info dict
  assert.ok(text.includes('/Title (PSY 101 Lecture Notes)'), 'Title included in metadata');
  assert.ok(text.includes('/Author (Podium)'), 'Author included in metadata');

  // Verify xref and trailer
  assert.ok(text.includes('xref\n0 10\n'), 'xref table has correct size');
  assert.ok(text.includes('startxref\n'), 'startxref present');
  assert.ok(text.endsWith('%%EOF\n'), 'File ends with %%EOF');
});
