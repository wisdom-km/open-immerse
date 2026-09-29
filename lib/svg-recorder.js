/**
 * Recording Canvas2D context for pdf.js 4.10.38.
 *
 * Glyph outlines arrive as `new Path2D(svgPath)` (pdf.js getPathGenerator).
 * Installing the recording Path2D before pdf.js loads keeps those commands
 * readable. Each fill/stroke becomes one element in canvas space.
 * Calls we do not implement are counted, never dropped silently.
 */

const IDENTITY = [1, 0, 0, 1, 0, 0];

function cloneOp(op) {
  return { ...op };
}

export function applyMatrix(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]
  ];
}

/** CTM' = CTM × M, matching CanvasRenderingContext2D.transform. */
export function multiplyMatrix(left, right) {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ];
}

export function matrixScale(matrix) {
  const sx = Math.hypot(matrix[0], matrix[1]);
  const sy = Math.hypot(matrix[2], matrix[3]);
  return (sx + sy) / 2 || 1;
}

function matrixFrom(value) {
  if (!value) return IDENTITY.slice();
  if (Array.isArray(value)) {
    if (value.length >= 6 && value.length < 16) {
      return [value[0], value[1], value[2], value[3], value[4], value[5]];
    }
    if (value.length >= 16) {
      return [value[0], value[1], value[4], value[5], value[12], value[13]];
    }
  }
  if (typeof value.a === "number") {
    return [value.a, value.b, value.c, value.d, value.e, value.f];
  }
  return IDENTITY.slice();
}

const NUMBER_RE = "[+-]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][+-]?\\d+)?";
const PATH_TOKEN = new RegExp(`([MLHVCSQTAZ])|(${NUMBER_RE})`, "gi");
const PATH_ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * pdf.js serializes glyph outlines as absolute M/L/Q/C/Z with spaces
 * between numbers and no space between a command and its first number.
 */
export function parseSvgPath(d) {
  const tokens = [];
  const source = String(d || "");
  PATH_TOKEN.lastIndex = 0;
  let match = PATH_TOKEN.exec(source);
  while (match) {
    tokens.push(match[1] ? match[1].toUpperCase() : match[2]);
    match = PATH_TOKEN.exec(source);
  }
  const ops = [];
  let index = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  const pushXY = (type, x, y) => {
    cx = x;
    cy = y;
    ops.push({ t: type, x, y });
  };
  while (index < tokens.length) {
    if (/^[A-Z]$/.test(tokens[index])) {
      cmd = tokens[index];
      index += 1;
    }
    if (!cmd) break;
    if (cmd === "Z") {
      ops.push({ t: "Z" });
      continue;
    }
    const arity = PATH_ARITY[cmd];
    if (!arity || index + arity > tokens.length) break;
    const args = [];
    for (let k = 0; k < arity; k += 1) args.push(Number(tokens[index + k]));
    index += arity;
    if (args.some((n) => !Number.isFinite(n))) break;
    if (cmd === "M") pushXY("M", args[0], args[1]);
    else if (cmd === "L") pushXY("L", args[0], args[1]);
    else if (cmd === "H") pushXY("L", args[0], cy);
    else if (cmd === "V") pushXY("L", cx, args[0]);
    else if (cmd === "C") {
      ops.push({ t: "C", x1: args[0], y1: args[1], x2: args[2], y2: args[3], x: args[4], y: args[5] });
      cx = args[4];
      cy = args[5];
    } else if (cmd === "Q") {
      ops.push({ t: "Q", x1: args[0], y1: args[1], x: args[2], y: args[3] });
      cx = args[2];
      cy = args[3];
    } else if (cmd === "S" || cmd === "T" || cmd === "A") {
      ops.push({ t: "UNSUPPORTED", cmd });
    }
    if (cmd === "M") cmd = "L";
  }
  return ops;
}

export function transformOps(ops, matrix) {
  const point = (x, y) => applyMatrix(matrix, x, y);
  return (ops || []).map((op) => {
    if (op.t === "Z" || op.t === "UNSUPPORTED") return cloneOp(op);
    if (op.t === "M" || op.t === "L") {
      const [x, y] = point(op.x, op.y);
      return { t: op.t, x, y };
    }
    if (op.t === "C") {
      const [x1, y1] = point(op.x1, op.y1);
      const [x2, y2] = point(op.x2, op.y2);
      const [x, y] = point(op.x, op.y);
      return { t: "C", x1, y1, x2, y2, x, y };
    }
    if (op.t === "Q") {
      const [x1, y1] = point(op.x1, op.y1);
      const [x, y] = point(op.x, op.y);
      return { t: "Q", x1, y1, x, y };
    }
    return cloneOp(op);
  });
}

export function bboxOfOps(ops) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    any = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const op of ops || []) {
    if (op.t === "M" || op.t === "L") add(op.x, op.y);
    else if (op.t === "C") {
      add(op.x1, op.y1);
      add(op.x2, op.y2);
      add(op.x, op.y);
    } else if (op.t === "Q") {
      add(op.x1, op.y1);
      add(op.x, op.y);
    }
  }
  if (!any) return null;
  return [minX, minY, maxX, maxY];
}

export function formatPathNumber(value) {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10000) / 10000;
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

export function serializeOps(ops) {
  let d = "";
  for (const op of ops || []) {
    if (op.t === "M" || op.t === "L") d += `${op.t}${formatPathNumber(op.x)} ${formatPathNumber(op.y)}`;
    else if (op.t === "C") {
      d += `C${formatPathNumber(op.x1)} ${formatPathNumber(op.y1)} ${formatPathNumber(op.x2)} ${formatPathNumber(op.y2)} ${formatPathNumber(op.x)} ${formatPathNumber(op.y)}`;
    } else if (op.t === "Q") {
      d += `Q${formatPathNumber(op.x1)} ${formatPathNumber(op.y1)} ${formatPathNumber(op.x)} ${formatPathNumber(op.y)}`;
    } else if (op.t === "Z") d += "Z";
  }
  return d;
}

function RecordingPath2DBase(Native) {
  const Base = Native || class {};
  return class RecordingPath2D extends Base {
    static __oiRecording = true;

    constructor(arg) {
      if (Native) {
        if (typeof arg === "string") super(arg);
        else if (arg instanceof Base || arg instanceof Native) super(arg);
        else super();
      } else {
        super();
      }
      this._source = typeof arg === "string" ? "glyph" : "path";
      if (typeof arg === "string") this._ops = parseSvgPath(arg);
      else if (arg && Array.isArray(arg._ops)) {
        this._ops = arg._ops.map(cloneOp);
        if (arg._source === "glyph") this._source = "glyph";
      } else this._ops = [];
    }

    addPath(path, transform) {
      if (Native && path instanceof Native) {
        try { super.addPath(path, transform); } catch { /* ops below are the source of truth */ }
      }
      const matrix = matrixFrom(transform);
      const ops = path && Array.isArray(path._ops) ? transformOps(path._ops, matrix) : [];
      if (!ops.length && path && path instanceof Native) this._unreadable = true;
      this._ops.push(...ops);
      if (path && path._source === "glyph") this._source = "glyph";
    }

    rect(x, y, w, h) {
      if (Native) super.rect(x, y, w, h);
      this.moveTo(x, y);
      this.lineTo(x + w, y);
      this.lineTo(x + w, y + h);
      this.lineTo(x, y + h);
      this.closePath();
    }

    moveTo(x, y) {
      if (Native && Native.prototype.moveTo) super.moveTo(x, y);
      this._ops.push({ t: "M", x, y });
    }

    lineTo(x, y) {
      if (Native && Native.prototype.lineTo) super.lineTo(x, y);
      this._ops.push({ t: "L", x, y });
    }

    bezierCurveTo(x1, y1, x2, y2, x, y) {
      if (Native && Native.prototype.bezierCurveTo) super.bezierCurveTo(x1, y1, x2, y2, x, y);
      this._ops.push({ t: "C", x1, y1, x2, y2, x, y });
    }

    quadraticCurveTo(x1, y1, x, y) {
      if (Native && Native.prototype.quadraticCurveTo) super.quadraticCurveTo(x1, y1, x, y);
      this._ops.push({ t: "Q", x1, y1, x, y });
    }

    closePath() {
      if (Native && Native.prototype.closePath) super.closePath();
      this._ops.push({ t: "Z" });
    }
  };
}

export function installRecordingPath2D(native) {
  if (typeof native === "function") globalThis.__oiNativePath2D = native;
  else if (globalThis.Path2D && globalThis.Path2D.__oiRecording) return globalThis.Path2D;
  else if (typeof globalThis.Path2D === "function") globalThis.__oiNativePath2D = globalThis.Path2D;
  const Path = RecordingPath2DBase(globalThis.__oiNativePath2D || null);
  globalThis.Path2D = Path;
  return Path;
}

installRecordingPath2D();

function nearWhite(color) {
  return Boolean(color && color.r >= 250 && color.g >= 250 && color.b >= 250);
}

function coversCanvas(bbox, width, height) {
  if (!bbox) return false;
  const area = Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
  return area >= width * height * 0.8;
}

export class SvgRecorder {
  constructor(width, height, options = {}) {
    this.width = width;
    this.height = height;
    this.measure = options.measure || null;
    this.ctm = IDENTITY.slice();
    this.stack = [];
    this.path = [];
    this.clips = [];
    this.elements = [];
    this.unsupported = Object.create(null);
    this.nextId = 1;
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.miterLimit = 10;
    this.lineDash = [];
    this.lineDashOffset = 0;
    this.globalCompositeOperation = "source-over";
    this.font = "10px sans-serif";
    this.filter = "none";
    this.fillRule = "nonzero";
    this.imageSmoothingEnabled = true;
    this.shadowBlur = 0;
    this.shadowColor = "rgba(0, 0, 0, 0)";
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.textAlign = "start";
    this.textBaseline = "alphabetic";
    this.direction = "ltr";
    const recorder = this;
    this.canvas = {
      get width() { return recorder.width; },
      set width(value) { recorder.width = Number(value) || 0; },
      get height() { return recorder.height; },
      set height(value) { recorder.height = Number(value) || 0; }
    };
  }

  noteUnsupported(name) {
    const key = String(name || "unknown");
    this.unsupported[key] = (this.unsupported[key] || 0) + 1;
  }

  unsupportedCounts() {
    return { ...this.unsupported };
  }

  save() {
    this.stack.push({
      ctm: this.ctm.slice(),
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      miterLimit: this.miterLimit,
      lineDash: this.lineDash.slice(),
      lineDashOffset: this.lineDashOffset,
      globalCompositeOperation: this.globalCompositeOperation,
      font: this.font,
      filter: this.filter,
      fillRule: this.fillRule,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      clips: this.clips.slice()
    });
  }

  restore() {
    const saved = this.stack.pop();
    if (!saved) return;
    this.ctm = saved.ctm;
    this.fillStyle = saved.fillStyle;
    this.strokeStyle = saved.strokeStyle;
    this.globalAlpha = saved.globalAlpha;
    this.lineWidth = saved.lineWidth;
    this.lineCap = saved.lineCap;
    this.lineJoin = saved.lineJoin;
    this.miterLimit = saved.miterLimit;
    this.lineDash = saved.lineDash;
    this.lineDashOffset = saved.lineDashOffset;
    this.globalCompositeOperation = saved.globalCompositeOperation;
    this.font = saved.font;
    this.filter = saved.filter;
    this.fillRule = saved.fillRule;
    this.imageSmoothingEnabled = saved.imageSmoothingEnabled;
    this.clips = saved.clips;
  }

  transform(a, b, c, d, e, f) {
    this.ctm = multiplyMatrix(this.ctm, [a, b, c, d, e, f]);
  }

  setTransform(a, b, c, d, e, f) {
    if (a && typeof a === "object") {
      this.ctm = matrixFrom(a);
      return;
    }
    this.ctm = [a, b, c, d, e, f];
  }

  resetTransform() {
    this.ctm = IDENTITY.slice();
  }

  translate(x, y) {
    this.transform(1, 0, 0, 1, x, y);
  }

  scale(x, y) {
    this.transform(x, 0, 0, y, 0, 0);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.transform(c, s, -s, c, 0, 0);
  }

  getTransform() {
    const [a, b, c, d, e, f] = this.ctm;
    if (typeof DOMMatrix === "function") return new DOMMatrix([a, b, c, d, e, f]);
    const self = this;
    return {
      a, b, c, d, e, f,
      invertSelf() {
        const det = a * d - b * c;
        if (!det) return this;
        const ia = d / det;
        const ib = -b / det;
        const ic = -c / det;
        const id = a / det;
        const ie = (c * f - d * e) / det;
        const iff = (b * e - a * f) / det;
        this.a = ia;
        this.b = ib;
        this.c = ic;
        this.d = id;
        this.e = ie;
        this.f = iff;
        self.noteUnsupported("MiniMatrix.invertSelf");
        return this;
      }
    };
  }

  beginPath() {
    this.path = [];
  }

  moveTo(x, y) {
    // Canvas transforms coordinates when they enter the current path.
    // A later CTM change (pdf.js rescaleAndStroke scales after the path
    // exists, so a hairline becomes 1px) must not move those points.
    const [tx, ty] = applyMatrix(this.ctm, x, y);
    this.path.push({ t: "M", x: tx, y: ty });
  }

  lineTo(x, y) {
    const [tx, ty] = applyMatrix(this.ctm, x, y);
    this.path.push({ t: "L", x: tx, y: ty });
  }

  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    const [x1, y1] = applyMatrix(this.ctm, cp1x, cp1y);
    const [x2, y2] = applyMatrix(this.ctm, cp2x, cp2y);
    const [tx, ty] = applyMatrix(this.ctm, x, y);
    this.path.push({ t: "C", x1, y1, x2, y2, x: tx, y: ty });
  }

  quadraticCurveTo(cpx, cpy, x, y) {
    const [x1, y1] = applyMatrix(this.ctm, cpx, cpy);
    const [tx, ty] = applyMatrix(this.ctm, x, y);
    this.path.push({ t: "Q", x1, y1, x: tx, y: ty });
  }

  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  closePath() {
    this.path.push({ t: "Z" });
  }

  setLineDash(segments) {
    this.lineDash = Array.from(segments || [], (n) => Number(n) || 0);
  }

  getLineDash() {
    return this.lineDash.slice();
  }

  _opsFrom(path) {
    if (path && Array.isArray(path._ops)) {
      if (path._ops.some((op) => op.t === "UNSUPPORTED")) this.noteUnsupported("path.arc");
      if (path._unreadable) this.noteUnsupported("Path2D.unreadable");
      return { ops: path._ops.map(cloneOp), source: path._source || "path", space: "user" };
    }
    if (path) {
      this.noteUnsupported("Path2D.unreadable");
      return { ops: [], source: "path" };
    }
    return { ops: this.path.map(cloneOp), source: "path", space: "device" };
  }

  _remember(op, ops, source, style, space = "user") {
    if (!ops.length || ops.every((item) => item.t === "Z")) return;
    // Path2D is transformed at paint time. The current path already is.
    const canvasOps = space === "device" ? ops.map(cloneOp) : transformOps(ops, this.ctm);
    const bbox = bboxOfOps(canvasOps);
    if (!bbox) return;
    const scale = matrixScale(this.ctm);
    const composite = this.globalCompositeOperation || "source-over";
    if (composite !== "source-over") this.noteUnsupported(`composite:${composite}`);
    if (this.filter && this.filter !== "none") this.noteUnsupported("filter");
    if (this.shadowBlur) this.noteUnsupported("shadowBlur");
    let provenance = source === "glyph" ? "glyph" : "path";
    if (op === "fill" && style.color && nearWhite(style.color) && coversCanvas(bbox, this.width, this.height)) {
      provenance = "background";
    }
    const clips = [];
    for (const clip of this.clips) {
      if (!clipContains(clip.bbox, bbox)) clips.push(clip);
    }
    this.elements.push({
      id: this.nextId,
      op,
      provenance,
      d: serializeOps(canvasOps),
      bbox: bbox.slice(),
      fill: op === "fill" ? style.css : null,
      stroke: op === "stroke" ? style.css : null,
      lineWidth: op === "stroke" ? (Number(this.lineWidth) || 1) * scale : 0,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      miterLimit: this.miterLimit,
      dash: this.lineDash.map((segment) => segment * scale),
      dashOffset: this.lineDashOffset * scale,
      alpha: this.globalAlpha,
      fillRule: style.fillRule || "nonzero",
      composite,
      clips
    });
    this.nextId += 1;
  }

  _style(kind, fillRule) {
    const raw = kind === "stroke" ? this.strokeStyle : this.fillStyle;
    const color = normalizePaint(raw);
    if (raw && typeof raw === "object") this.noteUnsupported(kind === "stroke" ? "strokeStyle.object" : "fillStyle.object");
    else if (typeof raw === "string" && raw !== "transparent" && !color) this.noteUnsupported(`${kind}Style.unparsed`);
    return { color, css: color ? color.css : "transparent", fillRule: fillRule || this.fillRule || "nonzero" };
  }

  fill(pathOrRule, rule) {
    let path = null;
    let fillRule = this.fillRule || "nonzero";
    if (typeof pathOrRule === "string") fillRule = pathOrRule;
    else if (pathOrRule) {
      path = pathOrRule;
      if (typeof rule === "string") fillRule = rule;
    }
    const { ops, source, space } = this._opsFrom(path);
    const style = this._style("fill", fillRule);
    if (this.globalAlpha === 0 || (style.color && style.color.a === 0)) return;
    if (!style.color) style.css = "#000000";
    this._remember("fill", ops, source, style, space);
  }

  stroke(path) {
    const explicit = path && typeof path !== "string" ? path : null;
    const { ops, source, space } = this._opsFrom(explicit);
    const style = this._style("stroke");
    if (this.globalAlpha === 0 || (style.color && style.color.a === 0)) return;
    if (!style.color) style.css = "#000000";
    this._remember("stroke", ops, source, style, space);
  }

  clip(pathOrRule, rule) {
    let path = null;
    let fillRule = "nonzero";
    if (typeof pathOrRule === "string") fillRule = pathOrRule === "evenodd" ? "evenodd" : "nonzero";
    else if (pathOrRule) {
      path = pathOrRule;
      if (rule === "evenodd") fillRule = "evenodd";
    }
    const { ops, space } = this._opsFrom(path);
    const canvasOps = space === "device" ? ops : transformOps(ops, this.ctm);
    const bbox = bboxOfOps(canvasOps);
    if (!bbox) return;
    this.clips = this.clips.concat({
      d: serializeOps(canvasOps),
      rule: fillRule,
      bbox
    });
  }

  fillRect(x, y, w, h) {
    const ops = [
      { t: "M", x, y },
      { t: "L", x: x + w, y },
      { t: "L", x: x + w, y: y + h },
      { t: "L", x, y: y + h },
      { t: "Z" }
    ];
    const style = this._style("fill");
    if (!style.color || this.globalAlpha === 0) return;
    this._remember("fill", ops, "path", style);
  }

  strokeRect(x, y, w, h) {
    const saved = this.path;
    this.path = [];
    this.rect(x, y, w, h);
    this.stroke();
    this.path = saved;
  }

  clearRect() {
    this.noteUnsupported("clearRect");
  }

  fillText(text, x, y) {
    this.noteUnsupported("fillText");
    const width = this.measureText(text).width || 0;
    const size = fontSizeOf(this.font);
    const origin = applyMatrix(this.ctm, x, y);
    const scale = matrixScale(this.ctm);
    this.elements.push({
      id: this.nextId,
      op: "fillText",
      provenance: "text",
      synthetic: true,
      d: "",
      bbox: [origin[0], origin[1] - size * scale, origin[0] + width * scale, origin[1]],
      fill: null,
      stroke: null,
      lineWidth: 0,
      alpha: this.globalAlpha,
      fillRule: "nonzero",
      composite: this.globalCompositeOperation,
      clips: this.clips.slice(),
      textBytes: String(text ?? "").length
    });
    this.nextId += 1;
  }

  strokeText() {
    this.noteUnsupported("strokeText");
  }

  measureText(text) {
    if (this.measure && typeof this.measure.measureText === "function") {
      this.measure.font = this.font;
      return this.measure.measureText(String(text ?? ""));
    }
    return { width: String(text ?? "").length * fontSizeOf(this.font) * 0.5 };
  }

  drawImage(image, a, b, c, d, e, f, g, h) {
    let dx;
    let dy;
    let dw;
    let dh;
    if (e === undefined) {
      dx = a;
      dy = b;
      dw = c === undefined ? imageWidth(image) : c;
      dh = d === undefined ? imageHeight(image) : d;
    } else {
      dx = e;
      dy = f;
      dw = g;
      dh = h;
    }
    const corners = [
      applyMatrix(this.ctm, dx, dy),
      applyMatrix(this.ctm, dx + dw, dy),
      applyMatrix(this.ctm, dx, dy + dh),
      applyMatrix(this.ctm, dx + dw, dy + dh)
    ];
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    this.elements.push({
      id: this.nextId,
      op: "drawImage",
      provenance: "image",
      d: "",
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      fill: null,
      stroke: null,
      lineWidth: 0,
      alpha: this.globalAlpha,
      fillRule: "nonzero",
      composite: this.globalCompositeOperation,
      clips: this.clips.slice()
    });
    this.nextId += 1;
  }

  createLinearGradient() {
    this.noteUnsupported("createLinearGradient");
    return { addColorStop() {} };
  }

  createRadialGradient() {
    this.noteUnsupported("createRadialGradient");
    return { addColorStop() {} };
  }

  createPattern() {
    this.noteUnsupported("createPattern");
    return {};
  }

  getImageData() {
    this.noteUnsupported("getImageData");
    return { data: new Uint8ClampedArray(0), width: 0, height: 0 };
  }
}

function fontSizeOf(font) {
  const match = String(font || "").match(/(\d+(?:\.\d+)?)px/);
  return match ? Number(match[1]) : 10;
}

function imageWidth(image) {
  return Number(image && (image.width || image.videoWidth || image.naturalWidth)) || 0;
}

function imageHeight(image) {
  return Number(image && (image.height || image.videoHeight || image.naturalHeight)) || 0;
}

function clipContains(outer, inner) {
  if (!outer || !inner) return false;
  const slack = 0.75;
  return outer[0] <= inner[0] + slack && outer[1] <= inner[1] + slack &&
    outer[2] >= inner[2] - slack && outer[3] >= inner[3] - slack;
}

function normalizePaint(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text || text === "transparent") return null;
  if (text === "black") return { r: 0, g: 0, b: 0, a: 1, css: "#000000" };
  if (text === "white") return { r: 255, g: 255, b: 255, a: 1, css: "#ffffff" };
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].split("").map((ch) => ch + ch).join("") : hex[1];
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return { r, g, b, a: 1, css: `#${raw}` };
  }
  const rgb = text.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/);
  if (!rgb) return null;
  const r = clampByte(rgb[1]);
  const g = clampByte(rgb[2]);
  const b = clampByte(rgb[3]);
  const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (!(a > 0)) return null;
  const css = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return { r, g, b, a, css };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function toHex(value) {
  return clampByte(value).toString(16).padStart(2, "0");
}

export function createRecordingContext(width, height, options) {
  const recorder = new SvgRecorder(width, height, options);
  return new Proxy(recorder, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      if (value !== undefined || prop in target) return value;
      if (prop === "then") return undefined;
      return () => {
        target.noteUnsupported(String(prop));
      };
    },
    set(target, prop, value, receiver) {
      if (typeof prop === "string" && !(prop in target)) target.noteUnsupported(`set ${prop}`);
      return Reflect.set(target, prop, value, receiver);
    }
  });
}
