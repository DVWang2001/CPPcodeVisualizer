// 瀏覽器沒有 Node 的 Buffer：插樁器只用到 from / byteLength / subarray().toString()，這裡補一個最小版本。
export class Buffer extends Uint8Array {
  toString() { return new TextDecoder().decode(this); }
  static from(s) { const e = new TextEncoder().encode(s); const b = new Buffer(e.length); b.set(e); return b; }
  static byteLength(s) { return new TextEncoder().encode(s).length; }
}
