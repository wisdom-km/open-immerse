import { gzipSync } from "node:zlib";

function octal(value, length) {
  const text = Number(value).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  const buf = Buffer.alloc(length);
  buf.write(text, 0, "ascii");
  return buf;
}

export function ustarHeader({ name = "", size = 0, type = "0", prefix = "" } = {}) {
  const buf = Buffer.alloc(512);
  buf.write(String(name).slice(0, 100), 0, "binary");
  octal(0o644, 8).copy(buf, 100);
  octal(0, 8).copy(buf, 108);
  octal(0, 8).copy(buf, 116);
  octal(size, 12).copy(buf, 124);
  octal(0, 12).copy(buf, 136);
  buf.fill(0x20, 148, 156);
  buf.write(type, 156, "ascii");
  buf.write("ustar", 257, "ascii");
  buf.write("00", 263, "ascii");
  if (prefix) buf.write(String(prefix).slice(0, 155), 345, "binary");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function pad(body) {
  const data = Buffer.from(body);
  const extra = (512 - (data.length % 512)) % 512;
  return extra ? Buffer.concat([data, Buffer.alloc(extra)]) : data;
}

export function tarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body || "");
    chunks.push(ustarHeader({
      name: entry.name,
      size: body.length,
      type: entry.type || "0",
      prefix: entry.prefix || ""
    }));
    if (body.length) chunks.push(pad(body));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

export function paxRecord(key, value) {
  const rest = ` ${key}=${value}\n`;
  let len = rest.length + 1;
  let record = `${len}${rest}`;
  while (record.length !== len) {
    len = record.length;
    record = `${len}${rest}`;
  }
  return record;
}
