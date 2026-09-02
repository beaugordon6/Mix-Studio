'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertCompleteGeneratedImage, isCompleteGeneratedImage } = require('../lib/generated-output-validation');

function webp(chunks) {
  const encoded = chunks.map(({ type, payload }) => {
    const data = Buffer.from(payload);
    const chunk = Buffer.alloc(8 + data.length + (data.length & 1));
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32LE(data.length, 4);
    data.copy(chunk, 8);
    return chunk;
  });
  const body = Buffer.concat([Buffer.from('WEBP'), ...encoded]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('accepts complete PNG, JPEG, and WebP signatures', () => {
  const png = Buffer.alloc(36);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12, 'ascii');
  png.write('IEND', png.length - 8, 'ascii');
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const completeWebp = webp([{ type: 'VP8L', payload: Buffer.from([1, 2, 3]) }]);
  assert.equal(isCompleteGeneratedImage('one.png', png), true);
  assert.equal(isCompleteGeneratedImage('two.jpeg', jpeg), true);
  assert.equal(isCompleteGeneratedImage('three.webp', completeWebp), true);
});

test('rejects truncated or structurally incomplete WebP containers', () => {
  const complete = webp([
    { type: 'VP8X', payload: Buffer.alloc(10) },
    { type: 'ANIM', payload: Buffer.from([1, 2, 3, 4]) },
  ]);
  const wrongDeclaredSize = Buffer.from(complete);
  wrongDeclaredSize.writeUInt32LE(complete.length + 10, 4);
  const incompleteChunk = Buffer.from(complete.subarray(0, complete.length - 2));
  incompleteChunk.writeUInt32LE(incompleteChunk.length - 8, 4);

  for (const content of [
    Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP'),
    wrongDeclaredSize,
    incompleteChunk,
    webp([{ type: 'JUNK', payload: Buffer.from([1]) }]),
  ]) {
    assert.equal(isCompleteGeneratedImage('truncated.webp', content), false);
    assert.throws(() => assertCompleteGeneratedImage('truncated.webp', content), {
      code: 'comfy_output_not_ready',
    });
  }
});

test('rejects HTTP error bodies, truncated images, and unsupported extensions', () => {
  for (const [filename, content] of [
    ['error.png', Buffer.from('{"error":"not ready"}')],
    ['short.jpg', Buffer.from([0xff, 0xd8, 1, 2])],
    ['wrong.webp', Buffer.from('RIFF1234NOPEpayload')],
    ['unknown.gif', Buffer.from('GIF89a')],
  ]) {
    assert.equal(isCompleteGeneratedImage(filename, content), false);
    assert.throws(() => assertCompleteGeneratedImage(filename, content), { code: 'comfy_output_not_ready' });
  }
});
