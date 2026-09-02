'use strict';

const path = require('node:path');

function generatedOutputError(filename) {
  const extension = path.extname(String(filename || '')).toLowerCase();
  const error = new Error(`ComfyUI output ${filename || ''} is not a complete ${extension || 'image'} file yet.`);
  error.code = 'comfy_output_not_ready';
  return error;
}

function isCompleteGeneratedImage(filename, buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) return false;
  const bytes = Buffer.from(buffer);
  const extension = path.extname(String(filename || '')).toLowerCase();
  if (extension === '.png') {
    return bytes.length >= 36
      && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.subarray(12, 16).toString('ascii') === 'IHDR'
      && bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii') === 'IEND';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return bytes.length >= 4
      && bytes[0] === 0xff && bytes[1] === 0xd8
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (extension === '.webp') {
    if (bytes.length < 20
      || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
      || bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
      || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
    const firstChunk = bytes.subarray(12, 16).toString('ascii');
    if (!['VP8 ', 'VP8L', 'VP8X'].includes(firstChunk)) return false;
    let offset = 12;
    let chunks = 0;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) return false;
      const payloadBytes = bytes.readUInt32LE(offset + 4);
      const next = offset + 8 + payloadBytes + (payloadBytes & 1);
      if (!Number.isSafeInteger(next) || next > bytes.length) return false;
      chunks += 1;
      offset = next;
    }
    return chunks > 0 && offset === bytes.length;
  }
  return false;
}

function assertCompleteGeneratedImage(filename, buffer) {
  if (!isCompleteGeneratedImage(filename, buffer)) throw generatedOutputError(filename);
  return buffer;
}

module.exports = { assertCompleteGeneratedImage, isCompleteGeneratedImage };
