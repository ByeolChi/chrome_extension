/* 의존성 없는 최소 ZIP 리더 (백업 가져오기용).
 * 이 확장이 만든 ZIP(store) 과, 압축 도구로 다시 묶은 ZIP(deflate) 을 읽는다.
 * ZIP64·암호화·분할 ZIP 은 지원하지 않는다. 항목마다 CRC 를 검사해 손상된 파일을 걸러 낸다.
 */
import { crc32 } from './zip.js';

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/**
 * input: Blob(File) | ArrayBuffer | Uint8Array
 * 반환: { names, has(name), read(name) → Promise<Uint8Array> }
 */
export async function readZip(input) {
  const buf = input instanceof Uint8Array
    ? input
    : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 22) throw new Error('ZIP 파일이 아닙니다.');

  // 중앙 디렉터리 끝(EOCD)은 파일 끝에서부터 찾는다 (뒤에 최대 65535바이트 주석이 붙을 수 있다)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 파일이 아닙니다.');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 형식은 지원하지 않습니다.');
  if (cdOffset >= buf.length) throw new Error('ZIP 목록이 손상되었습니다.');

  const dec = new TextDecoder('utf-8');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== CEN) throw new Error('ZIP 목록이 손상되었습니다.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // 폴더 항목
    if (flags & 1) throw new Error('암호가 걸린 ZIP 은 열 수 없습니다.');
    entries.set(name, { method, crc, csize, usize, off });
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`ZIP 안에 ${name} 이(가) 없습니다.`);
      if (e.off + 30 > buf.length || dv.getUint32(e.off, true) !== LOC) throw new Error(`${name}: 손상된 항목입니다.`);
      const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
      if (start + e.csize > buf.length) throw new Error(`${name}: 파일이 잘려 있습니다.`);
      const raw = buf.subarray(start, start + e.csize);
      let data;
      if (e.method === 0) data = raw;
      else if (e.method === 8) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error(`${name}: 지원하지 않는 압축 방식입니다 (${e.method}).`);
      if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`${name}: 내용이 손상되었습니다 (CRC 불일치).`);
      return data;
    }
  };
}
