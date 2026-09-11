export const TYPE_LABEL = { word: "单词", phrase: "短语", sentence: "句子" };

export function currentItems(tab, items, due) {
  return tab === "review" ? due : items;
}

export function canExport(list) {
  return Array.isArray(list) && list.length > 0;
}

export function toTxt(list) {
  return list.map((item, i) => {
    const lines = [
      `${i + 1}. [${TYPE_LABEL[item.type] || item.type || "条目"}] ${item.original || ""}`,
      `译文：${item.translation || ""}`
    ];
    if (item.context) lines.push(`语境：${item.context}`);
    if (item.title || item.url) lines.push(`来源：${item.title || ""} ${item.url || ""}`.trim());
    return lines.join("\n");
  }).join("\n\n");
}

export function toMarkdown(list) {
  const body = list.map((item, i) => {
    const bits = [`### ${i + 1}. ${item.original || ""}`, "", `- 类型：${TYPE_LABEL[item.type] || item.type || ""}`, `- 译文：${item.translation || ""}`];
    if (item.context) bits.push(`- 语境：${item.context}`);
    if (item.url) bits.push(`- 来源：[${item.title || item.url}](${item.url})`);
    else if (item.title) bits.push(`- 来源：${item.title}`);
    return bits.join("\n");
  }).join("\n\n");
  return `# Open Immerse 学习中心\n\n共 ${list.length} 条\n\n${body}\n`;
}

export function toPdf(list) {
  const lines = [`Open Immerse 学习中心`, `共 ${list.length} 条`, ""];
  list.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.original || ""}`);
    lines.push(`译文：${item.translation || ""}`);
    if (item.context) lines.push(`语境：${item.context}`);
    if (item.title || item.url) lines.push(`来源：${item.title || ""} ${item.url || ""}`.trim());
    lines.push("");
  });
  return buildSimplePdf(lines);
}

export async function toDocx(list) {
  const paragraphs = [`<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${xml("Open Immerse 学习中心")}</w:t></w:r></w:p>`];
  list.forEach((item, i) => {
    paragraphs.push(p(`${i + 1}. ${item.original || ""}`, true));
    paragraphs.push(p(`译文：${item.translation || ""}`));
    if (item.context) paragraphs.push(p(`语境：${item.context}`));
    if (item.title || item.url) paragraphs.push(p(`来源：${item.title || ""} ${item.url || ""}`.trim()));
    paragraphs.push(p(""));
  });
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs.join("")}<w:sectPr/></w:body>
</w:document>`;
  return zipStore({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/document.xml": document,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  });
}

export async function toPptx(list) {
  const slides = list.length ? list : [{ original: "暂无收藏", translation: "" }];
  const files = {
    "[Content_Types].xml": contentTypes(slides.length),
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    "ppt/presentation.xml": presentationXml(slides.length),
    "ppt/_rels/presentation.xml.rels": presentationRels(slides.length),
    "ppt/slideMasters/slideMaster1.xml": SLIDE_MASTER,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    "ppt/slideLayouts/slideLayout1.xml": SLIDE_LAYOUT,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    "ppt/theme/theme1.xml": THEME
  };
  slides.forEach((item, i) => {
    const n = i + 1;
    files[`ppt/slides/slide${n}.xml`] = slideXml(item, n);
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
  });
  return zipStore(files);
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function p(text, bold = false) {
  return `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function xml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pdfEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function toUtf16BeHex(s) {
  let hex = "";
  for (const ch of Array.from(String(s || ""))) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const u = cp - 0x10000;
      hex += (0xd800 + (u >> 10)).toString(16).padStart(4, "0");
      hex += (0xdc00 + (u & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      hex += cp.toString(16).padStart(4, "0");
    }
  }
  return hex;
}

function buildSimplePdf(lines) {
  const pageW = 595;
  const pageH = 842;
  const size = 12;
  const leading = 16;
  const margin = 48;
  const maxLines = Math.max(1, Math.floor((pageH - margin * 2) / leading));
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines));
  if (!pages.length) pages.push([""]);

  const contents = pages.map((pageLines) => {
    const ops = ["BT", `/F1 ${size} Tf`, `${margin} ${pageH - margin} Td`];
    pageLines.forEach((line, idx) => {
      if (idx) ops.push(`0 ${-leading} Td`);
      if (/[^\x00-\x7F]/.test(line)) {
        ops.push(`/F2 ${size} Tf`);
        ops.push(`<${toUtf16BeHex(line)}> Tj`);
        ops.push(`/F1 ${size} Tf`);
      } else {
        ops.push(`(${pdfEscape(line)}) Tj`);
      }
    });
    ops.push("ET");
    return ops.join("\n");
  });

  const pageNums = contents.map((_, i) => 7 + i * 2);
  const rebuilt = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${contents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>"
  ];
  contents.forEach((stream, i) => {
    const bytes = new TextEncoder().encode(stream);
    rebuilt.push(`<< /Length ${bytes.length} >>\nstream\n${stream}\nendstream`);
    rebuilt.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R /F2 5 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
  });

  const encoder = new TextEncoder();
  const header = "%PDF-1.4\n";
  const chunks = [header];
  const offsets = [0];
  let pos = header.length;
  rebuilt.forEach((body, i) => {
    const obj = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(pos);
    chunks.push(obj);
    pos += encoder.encode(obj).length;
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${rebuilt.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= rebuilt.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(xref, `trailer\n<< /Size ${rebuilt.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return encoder.encode(chunks.join(""));
}

function contentTypes(n) {
  const slides = Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  ${slides}
</Types>`;
}

function presentationXml(n) {
  const ids = Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${ids}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function presentationRels(n) {
  const slides = Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slides}
</Relationships>`;
}

function slideXml(item, index) {
  const title = `${index}. ${item.original || ""}`;
  const body = [`译文：${item.translation || ""}`, item.context ? `语境：${item.context}` : "", item.url || item.title || ""].filter(Boolean).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${shape(2, title, 457200, 228600, 11277600, 1143000, 28, true)}
      ${shape(3, body, 457200, 1600200, 11277600, 4572000, 18, false)}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function shape(id, text, x, y, cx, cy, size, bold) {
  const lines = String(text || "").split(/\n/).map((line) => `<a:p><a:r><a:rPr lang="zh-CN" sz="${size * 100}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="1A1A1A"/></a:solidFill></a:rPr><a:t>${xml(line)}</a:t></a:r></a:p>`).join("");
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${lines || "<a:p/>"}</p:txBody>
  </p:sp>`;
}

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="OpenImmerse">
  <a:themeElements>
    <a:clrScheme name="Office"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1A1A1A"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2><a:accent1><a:srgbClr val="4D7CFF"/></a:accent1><a:accent2><a:srgbClr val="7A5CFF"/></a:accent2><a:accent3><a:srgbClr val="70AD47"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="ED7D31"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`;

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zipStore(map) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(map)) {
    const data = typeof text === "string" ? enc.encode(text) : text;
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, x) => n + x.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, locals.length, true);
  ev.setUint16(10, locals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of locals) {
    out.set(part, p);
    p += part.length;
  }
  for (const part of centrals) {
    out.set(part, p);
    p += part.length;
  }
  out.set(eocd, p);
  return out;
}
