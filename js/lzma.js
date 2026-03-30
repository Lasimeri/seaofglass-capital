// LZMA compress/decompress stub
// TODO: vendor lzma-web here for production

export async function compress(data, level = 1) {
  // Placeholder: wrap data with a simple header
  // Will be replaced with real LZMA once the library is vendored
  const header = new Uint8Array([0x4C, 0x5A]); // "LZ" magic
  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
}

export async function decompress(data) {
  // Check for our stub header
  if (data[0] === 0x4C && data[1] === 0x5A) {
    return data.slice(2);
  }
  // Real LZMA data would be handled here
  throw new Error('LZMA decompression not yet implemented');
}
