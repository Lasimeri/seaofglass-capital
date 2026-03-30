// Standalone deflate compression module (CompressionStream API)

export async function compress(data) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(data);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function decompress(data) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(data);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
