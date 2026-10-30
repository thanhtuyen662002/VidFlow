// A one-frame, 2x2 RGB movie. Build ISO media boxes at runtime; no binary fixture.
function u32(...values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
}
const box = (name: string, ...data: Buffer[]) => { const body = Buffer.concat(data); return Buffer.concat([u32(body.length + 8), Buffer.from(name), body]); };
const full = (name: string, ...data: Buffer[]) => box(name, u32(0), ...data);
export function runtimeMp4(): Buffer {
  const matrix = u32(65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824);
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomqt  '));
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const sample = Buffer.alloc(78);
  sample.writeUInt16BE(1, 6); sample.writeUInt16BE(2, 24); sample.writeUInt16BE(2, 26);
  sample.writeUInt32BE(72 * 65536, 28); sample.writeUInt32BE(72 * 65536, 32);
  sample.writeUInt16BE(1, 40); sample.writeUInt16BE(24, 74); sample.writeInt16BE(-1, 76);
  const stbl = box('stbl', full('stsd', u32(1), box('raw ', sample)),
    full('stts', u32(1, 1, 1000)), full('stsc', u32(1, 1, 1, 1)),
    full('stsz', u32(12, 1)), full('stco', u32(1, ftyp.length + 8)));
  const minf = box('minf', box('vmhd', u32(1), Buffer.alloc(8)),
    box('dinf', full('dref', u32(1), box('url ', u32(1)))), stbl);
  const mdia = box('mdia', full('mdhd', u32(0, 0, 1000, 1000, 0)),
    full('hdlr', u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('Video\0')), minf);
  const trak = box('trak', box('tkhd', u32(3, 0, 0, 1, 0, 1000), Buffer.alloc(16), matrix, u32(2 * 65536, 2 * 65536)), mdia);
  const moov = box('moov', full('mvhd', u32(0, 0, 1000, 1000, 65536), Buffer.from([1, 0]), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2)), trak);
  return Buffer.concat([ftyp, box('mdat', pixels), moov]);
}
