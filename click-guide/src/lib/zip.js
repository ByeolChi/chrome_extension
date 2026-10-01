/* 의존성 없는 최소 ZIP 라이터 (store 방식, 압축 없음).
 * 스크린샷은 이미 JPEG 로 압축돼 있어 재압축 이득이 거의 없다.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, day };
}

class Writer {
  constructor() { this.chunks = []; this.length = 0; }
  push(u8) { this.chunks.push(u8); this.length += u8.length; }
  u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff, true); this.push(b); }
  u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); this.push(b); }
  blob(type) { return new Blob(this.chunks, { type: type || 'application/zip' }); }
}

/**
 * files: [{ name: 'a/b.txt', data: Uint8Array }]
 * 반환: Blob (application/zip)
 */
export function createZip(files, date) {
  const enc = new TextEncoder();
  const w = new Writer();
  const central = [];
  const { time, day } = dosTime(date);

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const offset = w.length;

    w.u32(0x04034b50);          // local file header
    w.u16(20);                  // version needed
    w.u16(0x0800);              // flags: UTF-8 이름
    w.u16(0);                   // method: store
    w.u16(time); w.u16(day);
    w.u32(crc); w.u32(data.length); w.u32(data.length);
    w.u16(nameBytes.length); w.u16(0);
    w.push(nameBytes);
    w.push(data);

    central.push({ nameBytes, crc, size: data.length, offset });
  }

  const cdStart = w.length;
  for (const c of central) {
    w.u32(0x02014b50);
    w.u16(20); w.u16(20);
    w.u16(0x0800); w.u16(0);
    w.u16(time); w.u16(day);
    w.u32(c.crc); w.u32(c.size); w.u32(c.size);
    w.u16(c.nameBytes.length); w.u16(0); w.u16(0);
    w.u16(0); w.u16(0); w.u32(0);
    w.u32(c.offset);
    w.push(c.nameBytes);
  }
  const cdSize = w.length - cdStart;

  w.u32(0x06054b50);
  w.u16(0); w.u16(0);
  w.u16(central.length); w.u16(central.length);
  w.u32(cdSize); w.u32(cdStart);
  w.u16(0);

  return w.blob();
}
