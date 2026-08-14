// CRC-32 (IEEE 802.3), the checksum both PNG chunks and ZIP entries use.
//
// Needed for *writing*, not reading: stripping a PNG chunk leaves every other
// chunk's checksum untouched, but rebuilding a DOCX means writing new entries
// with correct CRCs or the file will not open.

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
