/* HyperCompress - JBIG2 encoder (ITU-T T.88), arithmetic (MQ) coding only.
 *
 * Why this exists: no browser can ENCODE JBIG2, yet every PDF viewer can
 * decode it, and it is the only standard codec that can store a scanned text
 * page in a few KB. We implement the three pieces a text scan needs:
 *   - generic region    (any 1-bit bitmap, template 0, optional TPGDON)
 *   - symbol dictionary (each distinct glyph bitmap stored ONCE, shared across
 *     all pages through the PDF's /JBIG2Globals stream)
 *   - text region       (each glyph on a page = a symbol id + a position)
 * Mirrors the decoding procedures pdf.js implements, so pdf.js is the
 * round-trip oracle in tests.
 *
 * Bitmaps everywhere: Uint8Array of 0/1 per pixel, row-major, 1 = BLACK.
 */
(function(root, factory){
  if(typeof module === "object" && module.exports) module.exports = factory();
  else root.JBIG2 = factory();
})(typeof self !== "undefined" ? self : this, function(){
"use strict";

// -- MQ arithmetic encoder (T.88 Annex E software conventions; the same
//    flowcharts jbig2enc implements, whose output pdf.js decodes) ----------
var QE = [0x5601,0x3401,0x1801,0x0AC1,0x0521,0x0221,0x5601,0x5401,0x4801,0x3801,0x3001,0x2401,0x1C01,0x1601,0x5601,0x5401,0x5101,0x4801,0x3801,0x3401,0x3001,0x2801,0x2401,0x2201,0x1C01,0x1801,0x1601,0x1401,0x1201,0x1101,0x0AC1,0x09C1,0x08A1,0x0521,0x0441,0x02A1,0x0221,0x0141,0x0111,0x0085,0x0049,0x0025,0x0015,0x0009,0x0005,0x0001,0x5601];
var NMPS = [1,2,3,4,5,38,7,8,9,10,11,12,13,29,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,45,46];
var NLPS = [1,6,9,12,29,33,6,14,14,14,17,18,20,21,14,14,15,16,17,18,19,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,46];
var SWITCH = [1,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];

function Contexts(n){ this.i = new Uint8Array(n); this.mps = new Uint8Array(n); }

function MQEncoder(){
  this.a = 0x8000; this.c = 0; this.ct = 12; this.bp = -1; this.b = 0;
  this.out = []; this.chunk = new Uint8Array(65536); this.n = 0;
}
MQEncoder.prototype.emit = function(){
  if(this.n === this.chunk.length){ this.out.push(this.chunk); this.chunk = new Uint8Array(65536); this.n = 0; }
  this.chunk[this.n++] = this.b;
};
MQEncoder.prototype.byteout = function(){
  if(this.b === 0xff){ this.rblock(); return; }
  if(this.c < 0x8000000){ this.lblock(); return; }
  this.b += 1;
  if(this.b !== 0xff){ this.lblock(); return; }
  this.c &= 0x7ffffff;
  this.rblock();
};
MQEncoder.prototype.rblock = function(){
  if(this.bp >= 0) this.emit();
  this.b = (this.c >>> 20) & 0xff; this.bp++; this.c &= 0xfffff; this.ct = 7;
};
MQEncoder.prototype.lblock = function(){
  if(this.bp >= 0) this.emit();
  this.b = (this.c >>> 19) & 0xff; this.bp++; this.c &= 0x7ffff; this.ct = 8;
};
MQEncoder.prototype.encode = function(cx, idx, d){
  var i = cx.i[idx], mps = cx.mps[idx], qe = QE[i];
  if(d === mps){                                   // CODEMPS
    this.a -= qe;
    if((this.a & 0x8000) === 0){
      if(this.a < qe) this.a = qe; else this.c += qe;
      cx.i[idx] = NMPS[i];
    } else { this.c += qe; return; }
  } else {                                         // CODELPS
    this.a -= qe;
    if(this.a < qe) this.c += qe; else this.a = qe;
    if(SWITCH[i]) cx.mps[idx] = 1 - mps;
    cx.i[idx] = NLPS[i];
  }
  do {                                             // RENORME
    this.a <<= 1; this.c = (this.c << 1) >>> 0; this.ct--;
    if(this.ct === 0) this.byteout();
  } while((this.a & 0x8000) === 0);
};
MQEncoder.prototype.finish = function(){
  var tempc = (this.c + this.a) >>> 0;             // SETBITS
  this.c = (this.c | 0xffff) >>> 0;
  if(this.c >= tempc) this.c = (this.c - 0x8000) >>> 0;
  this.c = (this.c << this.ct) >>> 0; this.byteout();
  this.c = (this.c << this.ct) >>> 0; this.byteout();
  this.emit();
  if(this.b !== 0xff){ this.b = 0xff; this.emit(); }
  this.b = 0xac; this.emit();
  var total = this.n, k; for(k = 0; k < this.out.length; k++) total += this.out[k].length;
  var res = new Uint8Array(total), off = 0;
  for(k = 0; k < this.out.length; k++){ res.set(this.out[k], off); off += this.out[k].length; }
  res.set(this.chunk.subarray(0, this.n), off);
  return res;
};

// -- Integer arithmetic encoding procedure (Annex A) ------------------------
// cx: Contexts(512). value === null encodes OOB.
function encodeInt(mq, cx, value){
  var prev = 1;
  function bit(b){ mq.encode(cx, prev, b); prev = prev < 256 ? ((prev << 1) | b) : ((((prev << 1) | b) & 511) | 256); }
  function bits(v, n){ for(var k = n - 1; k >= 0; k--) bit((v >>> k) & 1); }
  if(value === null){ bit(1); bit(0); bits(0, 2); return; }
  var s = value < 0 ? 1 : 0, v = Math.abs(value);
  bit(s);
  if(v < 4){ bit(0); bits(v, 2); }
  else if(v < 20){ bit(1); bit(0); bits(v - 4, 4); }
  else if(v < 84){ bit(1); bit(1); bit(0); bits(v - 20, 6); }
  else if(v < 340){ bit(1); bit(1); bit(1); bit(0); bits(v - 84, 8); }
  else if(v < 4436){ bit(1); bit(1); bit(1); bit(1); bit(0); bits(v - 340, 12); }
  else { bit(1); bit(1); bit(1); bit(1); bit(1); bits(v - 4436, 32); }
}
// Symbol id: a fixed-length code of codeLen bits, each bit coded in the
// context of the bits so far (Annex A.3).
function encodeIAID(mq, cx, codeLen, id){
  var prev = 1;
  for(var k = codeLen - 1; k >= 0; k--){ var b = (id >>> k) & 1; mq.encode(cx, prev, b); prev = (prev << 1) | b; }
}

// -- Generic region coding, template 0, nominal AT pixels (6.2.5.7) --------
// Context bit order (MSB first): row-2 x-2..x+2, row-1 x-3..x+3, row x-4..x-1.
// Per pixel the context slides: drop bit 15 (row-2 x-2), bit 10 (row-1 x-3)
// and bit 3 (row-0 x-4), shift, then bring in row-2 x+3, row-1 x+4, this px.
var TPGD_CTX = 0x9B25, SLIDE_MASK = 0x7BF7;
function encodeGeneric(mq, cx, bm, w, h, tpgdon){
  var ltp = 0, y, x, p;
  for(y = 0; y < h; y++){
    var r0 = y * w, r1 = r0 - w, r2 = r0 - 2 * w;
    if(tpgdon){
      var same = 0;
      if(y > 0){ same = 1; for(x = 0; x < w; x++) if(bm[r0 + x] !== bm[r1 + x]){ same = 0; break; } }
      mq.encode(cx, TPGD_CTX, same ^ ltp);
      ltp = same;
      if(same) continue;
    }
    var ctx = 0;
    if(y >= 2){ ctx |= bm[r2] << 13; if(w > 1) ctx |= bm[r2 + 1] << 12; if(w > 2) ctx |= bm[r2 + 2] << 11; }
    if(y >= 1){ ctx |= bm[r1] << 7; if(w > 1) ctx |= bm[r1 + 1] << 6; if(w > 2) ctx |= bm[r1 + 2] << 5; if(w > 3) ctx |= bm[r1 + 3] << 4; }
    for(x = 0; x < w; x++){
      p = bm[r0 + x];
      mq.encode(cx, ctx, p);
      ctx = ((ctx & SLIDE_MASK) << 1)
          | (y >= 2 && x + 3 < w ? bm[r2 + x + 3] << 11 : 0)
          | (y >= 1 && x + 4 < w ? bm[r1 + x + 4] << 4 : 0)
          | p;
    }
  }
}

// -- Segment / byte helpers --------------------------------------------------
function Bytes(){ this.a = []; }
Bytes.prototype.u8 = function(v){ this.a.push(v & 0xff); return this; };
Bytes.prototype.u16 = function(v){ this.a.push((v >>> 8) & 0xff, v & 0xff); return this; };
Bytes.prototype.u32 = function(v){ this.a.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; };
Bytes.prototype.bytes = function(u8){ for(var k = 0; k < u8.length; k++) this.a.push(u8[k]); return this; };
Bytes.prototype.done = function(){ return new Uint8Array(this.a); };

// Segment header (7.2). Segment numbers stay <= 256 so references are 1 byte.
function segment(num, type, referred, page, data){
  var b = new Bytes();
  b.u32(num).u8(type).u8(referred.length << 5);
  for(var k = 0; k < referred.length; k++) b.u8(referred[k]);
  b.u8(page).u32(data.length).bytes(data);
  return b.done();
}
function regionInfo(b, w, h){ b.u32(w).u32(h).u32(0).u32(0).u8(0); }   // at (0,0), combine OR
var AT_T0 = [3, -1, -3, -1, 2, -2, -2, -2];
function writeAT(b){ for(var k = 0; k < 8; k++) b.u8(AT_T0[k]); }

// Page information segment (7.4.8)
function pageInfoSegment(num, w, h){
  var b = new Bytes(); b.u32(w).u32(h).u32(0).u32(0).u8(1).u16(0);
  return segment(num, 48, [], 1, b.done());
}
// Immediate lossless generic region (type 38) for a whole-page bitmap
function genericRegionSegment(num, bm, w, h){
  var mq = new MQEncoder(), cx = new Contexts(1 << 16);
  encodeGeneric(mq, cx, bm, w, h, true);
  var data = mq.finish(), b = new Bytes();
  regionInfo(b, w, h); b.u8(0x08); writeAT(b); b.bytes(data);
  return segment(num, 38, [], 1, b.done());
}

// Symbol dictionary (7.4.3 / 6.5): symbols = [{bm,w,h}] in the order they
// will be numbered (caller sorts by height class). Returns the segment.
function symbolDictionarySegment(num, symbols){
  var mq = new MQEncoder(), cx = new Contexts(1 << 16);
  var IADH = new Contexts(512), IADW = new Contexts(512), IAEX = new Contexts(512);
  var hc = 0, k = 0, n = symbols.length;
  while(k < n){
    var H = symbols[k].h;
    encodeInt(mq, IADH, H - hc); hc = H;
    var wPrev = 0;
    while(k < n && symbols[k].h === H){
      var s = symbols[k];
      encodeInt(mq, IADW, s.w - wPrev); wPrev = s.w;
      encodeGeneric(mq, cx, s.bm, s.w, s.h, false);
      k++;
    }
    encodeInt(mq, IADW, null);                       // OOB ends the height class
  }
  encodeInt(mq, IAEX, 0);                            // no non-exported run first
  encodeInt(mq, IAEX, n);                            // then export all
  var data = mq.finish(), b = new Bytes();
  b.u16(0); writeAT(b); b.u32(n).u32(n); b.bytes(data);
  return segment(num, 0, [], 1, b.done());
}

// Text region (7.4.4 / 6.4): instances = [{id,x,y,w}] with TOPLEFT corners.
var LOG_STRIPS = 3, STRIPS = 1 << LOG_STRIPS;
function symCodeLen(numSyms){ var n = 0; while((1 << n) < numSyms) n++; return n; }   // pdf.js: ceil(log2)
function textRegionSegment(num, dictSeg, w, h, quads, numSyms){
  var codeLen = symCodeLen(numSyms), count = quads.length >> 2;
  var mq = new MQEncoder();
  var IADT = new Contexts(512), IAFS = new Contexts(512), IADS = new Contexts(512), IAIT = new Contexts(512), IAID = new Contexts(1 << (codeLen + 1));
  var strips = {}, keys = [];
  for(var k = 0; k < count; k++){
    var ins = { id: quads[4 * k], x: quads[4 * k + 1], y: quads[4 * k + 2], w: quads[4 * k + 3] }, sk = Math.floor(ins.y / STRIPS);
    if(!strips[sk]){ strips[sk] = []; keys.push(sk); }
    strips[sk].push(ins);
  }
  keys.sort(function(a, b){ return a - b; });
  encodeInt(mq, IADT, 0);                            // STRIPT = 0
  var stripT = 0, firstS = 0;
  for(var q = 0; q < keys.length; q++){
    var list = strips[keys[q]]; list.sort(function(a, b){ return a.x - b.x; });
    encodeInt(mq, IADT, keys[q] - stripT); stripT = keys[q];
    var curS = 0;
    for(var j = 0; j < list.length; j++){
      var it = list[j];
      if(j === 0){ encodeInt(mq, IAFS, it.x - firstS); firstS = it.x; curS = it.x; }
      else { encodeInt(mq, IADS, it.x - curS); curS = it.x; }
      encodeInt(mq, IAIT, it.y - stripT * STRIPS);   // 0..STRIPS-1
      encodeIAID(mq, IAID, codeLen, it.id);
      curS += it.w - 1;
    }
    encodeInt(mq, IADS, null);                       // OOB: end of strip
  }
  var data = mq.finish(), b = new Bytes();
  regionInfo(b, w, h);
  b.u16((LOG_STRIPS << 2) | (1 << 4));               // arith, no refine, TOPLEFT, OR, offset 0
  b.u32(count); b.bytes(data);
  return segment(num, 6, [dictSeg], 1, b.done());
}

// -- Page analysis: connected components, glyph-safe matching --------------
function components(bits, W, H){
  var seen = new Uint8Array(W * H), out = [], stack = new Int32Array(W * H), sp;
  for(var i = 0; i < W * H; i++){
    if(!bits[i] || seen[i]) continue;
    var x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0, pix = [];
    sp = 0; stack[sp++] = i; seen[i] = 1;
    while(sp){
      var p = stack[--sp], x = p % W, y = (p - x) / W; pix.push(p); n++;
      if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
      for(var dy = -1; dy <= 1; dy++){ var yy = y + dy; if(yy < 0 || yy >= H) continue;
        for(var dx = -1; dx <= 1; dx++){ var xx = x + dx; if(xx < 0 || xx >= W) continue;
          var q = yy * W + xx; if(bits[q] && !seen[q]){ seen[q] = 1; stack[sp++] = q; } } }
    }
    var w = x1 - x0 + 1, h = y1 - y0 + 1, bm = new Uint8Array(w * h);
    for(var t = 0; t < pix.length; t++){ var pp = pix[t], px = pp % W, py = (pp - px) / W; bm[(py - y0) * w + (px - x0)] = 1; }
    out.push({ x: x0, y: y0, w: w, h: h, n: n, bm: bm });
  }
  return out;
}
// How big is the text on this bitmap, in pixels? The 60th percentile of the
// larger side of every text-like connected component (specks and rules
// excluded). Orientation-independent, so a landscape table scanned sideways
// measures the same as upright text. ~10 px is the smallest size that reads
// cleanly in 1-bit; 7 px (a 1050 px A4 page) visibly breaks small print.
function textSizePx(bits, W, H){
  var seen = new Uint8Array(W * H), stack = new Int32Array(W * H), sizes = [], sp;
  for(var i = 0; i < W * H; i++){
    if(!bits[i] || seen[i]) continue;
    var x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    sp = 0; stack[sp++] = i; seen[i] = 1;
    while(sp){
      var p = stack[--sp], x = p % W, y = (p - x) / W; n++;
      if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
      for(var dy = -1; dy <= 1; dy++){ var yy = y + dy; if(yy < 0 || yy >= H) continue;
        for(var dx = -1; dx <= 1; dx++){ var xx = x + dx; if(xx < 0 || xx >= W) continue;
          var q = yy * W + xx; if(bits[q] && !seen[q]){ seen[q] = 1; stack[sp++] = q; } } }
    }
    var w = x1 - x0 + 1, h = y1 - y0 + 1, mx = Math.max(w, h), mn = Math.min(w, h);
    if(n < 4 || mx < 2 || mx > 80 || mx > 4 * mn) continue;   // speck, rule, or a big graphic
    sizes.push(mx);
  }
  if(sizes.length < 20) return 0;                               // not a text page - nothing to size
  sizes.sort(function(u, v){ return u - v; });
  return sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.6))];
}
// Bounding boxes of the text-like connected components (no per-glyph bitmaps).
function componentBoxes(bits, W, H){
  var seen = new Uint8Array(W * H), stack = new Int32Array(W * H), out = [], sp;
  for(var i = 0; i < W * H; i++){
    if(!bits[i] || seen[i]) continue;
    var x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    sp = 0; stack[sp++] = i; seen[i] = 1;
    while(sp){
      var p = stack[--sp], x = p % W, y = (p - x) / W; n++;
      if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
      for(var dy = -1; dy <= 1; dy++){ var yy = y + dy; if(yy < 0 || yy >= H) continue;
        for(var dx = -1; dx <= 1; dx++){ var xx = x + dx; if(xx < 0 || xx >= W) continue;
          var q = yy * W + xx; if(bits[q] && !seen[q]){ seen[q] = 1; stack[sp++] = q; } } }
    }
    var w = x1 - x0 + 1, h = y1 - y0 + 1, mx = Math.max(w, h), mn = Math.min(w, h);
    if(n < 4 || mx < 3 || mx > 80 || mx > 4 * mn + 2) continue;
    out.push({ x: x0, y: y0, w: w, h: h });
  }
  return out;
}
// How much of this page is FIGURES? Glyphs are grouped into lines and words;
// a word of >= 3 glyphs counts as a number when its glyphs are uniform in
// width (a narrow "1" allowed), share one height, sit in the page's tall
// glyph class (digits are cap-height, prose is mostly x-height) and, when
// long, carry comma/point separators. Returns the fraction of glyphs in such
// words (prose ~0.00-0.01, a balance sheet ~0.1-0.2). Run upright and
// rotated, so a sideways table scores too.
// Tolerances carry a PIXEL floor: at 150 dpi a digit is ~12 px tall, so a
// purely relative 12% band (1.4 px) flips with one pixel of scanner grain on
// a bounding box - the same table page scored 0.054 or 0.025 depending on
// the noise. opts.hPx / opts.wPx (default 2) are the floors.
function figuresScoreBoxes(cs, opts){
  opts = opts || {}; var hPx = opts.hPx != null ? opts.hPx : 2, wPx = opts.wPx != null ? opts.wPx : 2;
  if(cs.length < 20) return { f: 0, words: 0, numWords: 0 };
  var hs = cs.map(function(c){ return c.h; }).sort(function(u, v){ return u - v; }), mh = hs[hs.length >> 1], hc = hs[Math.floor(hs.length * 0.85)];
  cs.sort(function(u, v){ return (u.y + u.h / 2) - (v.y + v.h / 2); });
  var lines = [], cur = null;
  for(var k = 0; k < cs.length; k++){ var c = cs[k], cy = c.y + c.h / 2; if(cur && Math.abs(cy - cur.cy) <= mh * 0.6){ cur.items.push(c); cur.cy = (cur.cy * (cur.items.length - 1) + cy) / cur.items.length; } else { cur = { cy: cy, items: [c] }; lines.push(cur); } }
  var glyphs = 0, numGlyphs = 0, words = 0, numWords = 0;
  function med(arr){ var s = arr.slice().sort(function(u, v){ return u - v; }); return s[s.length >> 1]; }
  for(var li = 0; li < lines.length; li++){
    var items = lines[li].items; items.sort(function(u, v){ return u.x - v.x; });
    var word = [items[0]];
    var flush = function(){
      var g = word.filter(function(c){ return c.h >= mh * 0.55; }); words++; glyphs += g.length;
      if(g.length >= 3){
        var mw = med(g.map(function(c){ return c.w; })), mhh = med(g.map(function(c){ return c.h; }));
        var okW = g.filter(function(c){ return Math.abs(c.w - mw) <= Math.max(wPx, 0.3 * mw) || c.w < 0.6 * mw; }).length / g.length;
        var okH = g.filter(function(c){ return Math.abs(c.h - mhh) <= Math.max(hPx, 0.12 * mhh); }).length / g.length;
        var seps = word.length - g.length;
        if(okW >= 0.8 && okH >= 0.85 && mhh >= 0.85 * hc && mw < mhh * 0.95 && (g.length <= 12 || seps > 0)){ numWords++; numGlyphs += g.length; }
      }
    };
    for(var i = 1; i < items.length; i++){ var pv = items[i - 1], it = items[i]; if(it.x - (pv.x + pv.w) > mh * 0.45){ flush(); word = [it]; } else word.push(it); }
    flush();
  }
  return { f: glyphs ? numGlyphs / glyphs : 0, words: words, numWords: numWords };
}
function figuresScore(bits, W, H, opts){
  var cs = componentBoxes(bits, W, H);
  var up = figuresScoreBoxes(cs.map(function(c){ return { x: c.x, y: c.y, w: c.w, h: c.h }; }), opts);
  var rot = figuresScoreBoxes(cs.map(function(c){ return { x: c.y, y: c.x, w: c.h, h: c.w }; }), opts);
  return (rot.numWords > up.numWords * 1.5 && rot.f > up.f) ? rot.f : up.f;
}
var NB4 = [[1,0],[-1,0],[0,1],[0,-1]];
// Number of enclosed white regions (holes): 4-connected background not
// touching the bbox border. A 6 has one, an 8 two, a 3 none.
function holeCount(bm, w, h){
  var W = w + 2, H = h + 2, seen = new Uint8Array(W * H), stack = new Int32Array(W * H), holes = 0, sp, p, x, y, k, xx, yy, q;
  function inkAt(X, Y){ return (X >= 1 && Y >= 1 && X <= w && Y <= h) ? bm[(Y - 1) * w + (X - 1)] : 0; }
  function flood(start){
    sp = 0; stack[sp++] = start; seen[start] = 1;
    while(sp){ p = stack[--sp]; x = p % W; y = (p - x) / W;
      for(k = 0; k < 4; k++){ xx = x + NB4[k][0]; yy = y + NB4[k][1]; if(xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        q = yy * W + xx; if(!seen[q] && !inkAt(xx, yy)){ seen[q] = 1; stack[sp++] = q; } } }
  }
  flood(0);                                           // the outside
  for(var i = 0; i < W * H; i++){
    var ix = i % W, iy = (i - ix) / W;
    if(seen[i] || inkAt(ix, iy)) continue;
    holes++; flood(i);
  }
  return holes;
}
// Differing pixels between two same-size bitmaps and their largest
// 8-connected blob (bails out early once a limit is exceeded).
function xorStats(a, b, w, h, limitBlob, limitCount){
  var n = w * h, diff = 0, k;
  for(k = 0; k < n; k++) if(a[k] !== b[k]){ diff++; if(diff > limitCount) return { diff: diff, maxBlob: 99 }; }
  if(!diff) return { diff: 0, maxBlob: 0 };
  var seen = new Uint8Array(n), maxBlob = 0, stack = [];
  for(k = 0; k < n; k++){
    if(a[k] === b[k] || seen[k]) continue;
    var size = 0; stack.push(k); seen[k] = 1;
    while(stack.length){ var p = stack.pop(), x = p % w, y = (p - x) / w; size++;
      for(var dy = -1; dy <= 1; dy++) for(var dx = -1; dx <= 1; dx++){ var xx = x + dx, yy = y + dy; if(xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var q = yy * w + xx; if(!seen[q] && a[q] !== b[q]){ seen[q] = 1; stack.push(q); } } }
    if(size > maxBlob){ maxBlob = size; if(maxBlob > limitBlob) return { diff: diff, maxBlob: maxBlob }; }
  }
  return { diff: diff, maxBlob: maxBlob };
}

// A shared, document-wide glyph dictionary. match() returns {id, x, y, w}:
// the prototype to draw and where, or null-free new entry.
// "Glyph-safe": two shapes are the same glyph only if their boxes differ by
// at most one pixel each way, they enclose the same number of holes, and the
// pixels that differ are scattered single specks (scanner noise) - never a
// stroke. Tiny marks (periods, commas, colons) must match exactly.
function Dictionary(opts){
  opts = opts || {};
  this.maxBlob = opts.maxBlob || 2;         // largest connected differing blob allowed
  this.maxFrac = opts.maxFrac || 0.08;      // largest fraction of differing pixels
  this.exactBelow = opts.exactBelow || 24;  // glyphs with fewer pixels than this: exact only
  this.boxTol = opts.boxTol || 1;           // allowed box-size jitter in pixels
  // DEFAULT IS EXACT-ONLY. Measured on real scans at ~100 dpi: even an 8% /
  // 2-pixel-blob tolerance let an n become a u and a t lose its bar on the
  // 5-7 px lower-case glyphs. A substitution engine is only safe when the
  // replacement is pixel-identical, so tolerant matching must be opted into.
  this.exactOnly = opts.exactOnly !== false;
  this.syms = []; this.buckets = {};
}
// Compare prototype s and candidate c inside their union box, trying the few
// 1-pixel placements; returns {diff, maxBlob, sx, sy, cx, cy} of the best fit.
function alignedXor(s, c, limitBlob, limitCount){
  var W = Math.max(s.w, c.w), H = Math.max(s.h, c.h), best = null;
  function range(n){ var r = []; for(var i = 0; i <= n; i++) r.push(i); return r; }
  var sxs = range(W - s.w), sys = range(H - s.h), cxs = range(W - c.w), cys = range(H - c.h);
  var A = new Uint8Array(W * H), B = new Uint8Array(W * H);
  for(var i1 = 0; i1 < sxs.length; i1++) for(var j1 = 0; j1 < sys.length; j1++) for(var i2 = 0; i2 < cxs.length; i2++) for(var j2 = 0; j2 < cys.length; j2++){
    var sx = sxs[i1], sy = sys[j1], cx = cxs[i2], cy = cys[j2], y, x;
    A.fill(0); B.fill(0);
    for(y = 0; y < s.h; y++) for(x = 0; x < s.w; x++) A[(y + sy) * W + x + sx] = s.bm[y * s.w + x];
    for(y = 0; y < c.h; y++) for(x = 0; x < c.w; x++) B[(y + cy) * W + x + cx] = c.bm[y * c.w + x];
    var st = xorStats(A, B, W, H, limitBlob, limitCount);
    if(!best || st.diff < best.diff){ best = { diff: st.diff, maxBlob: st.maxBlob, sx: sx, sy: sy, cx: cx, cy: cy }; }
    if(best.diff === 0) return best;
  }
  return best;
}
Dictionary.prototype.match = function(c){
  var area = c.w * c.h, holes = holeCount(c.bm, c.w, c.h);
  var exact = this.exactOnly || area < this.exactBelow, limitCount = exact ? 0 : Math.max(2, Math.round(area * this.maxFrac));
  var dws = [0], dhs = [0];
  if(!exact){ for(var t = 1; t <= this.boxTol; t++){ dws.push(-t, t); dhs.push(-t, t); } }
  for(var a = 0; a < dws.length; a++) for(var b = 0; b < dhs.length; b++){
    var key = (c.w + dws[a]) + "x" + (c.h + dhs[b]) + ":" + holes, list = this.buckets[key];
    if(!list) continue;
    for(var k = 0; k < list.length; k++){
      var s = this.syms[list[k]], st;
      if(s.w === c.w && s.h === c.h){
        st = xorStats(s.bm, c.bm, c.w, c.h, this.maxBlob, limitCount); st.sx = st.sy = st.cx = st.cy = 0;
      } else st = alignedXor(s, c, this.maxBlob, limitCount);
      if(st.diff === 0 || (!exact && st.diff <= limitCount && st.maxBlob <= this.maxBlob)){
        var x = c.x - st.cx + st.sx, y = c.y - st.cy + st.sy;
        if(x < 0 || y < 0) continue;
        s.uses++; return { id: list[k], x: x, y: y, w: s.w };
      }
    }
  }
  var key0 = c.w + "x" + c.h + ":" + holes;
  if(!this.buckets[key0]) this.buckets[key0] = [];
  var id = this.syms.length;
  this.syms.push({ bm: c.bm, w: c.w, h: c.h, uses: 1 });
  this.buckets[key0].push(id);
  return { id: id, x: c.x, y: c.y, w: c.w };
};

// Analyse one binarised page: split into glyph instances (dictionary ids) and
// a residual bitmap of everything too big to be a glyph (rules, boxes, seals).
function analysePage(bits, W, H, dict, opts){
  opts = opts || {};
  var maxGlyph = opts.maxGlyph || Math.max(48, Math.round(Math.max(W, H) * 0.06));
  var comps = components(bits, W, H), instances = [], residual = null, residualPx = 0, newSyms = 0, before = dict.syms.length;
  for(var k = 0; k < comps.length; k++){
    var c = comps[k];
    if(c.w > maxGlyph || c.h > maxGlyph){
      if(!residual) residual = new Uint8Array(W * H);
      for(var y = 0; y < c.h; y++) for(var x = 0; x < c.w; x++) if(c.bm[y * c.w + x]){ residual[(c.y + y) * W + c.x + x] = 1; residualPx++; }
      continue;
    }
    instances.push(dict.match(c));
  }
  var quads = new Int32Array(instances.length * 4);
  for(var q = 0; q < instances.length; q++){ var it = instances[q]; quads[4 * q] = it.id; quads[4 * q + 1] = it.x; quads[4 * q + 2] = it.y; quads[4 * q + 3] = it.w; }
  var residualSeg = residual ? genericRegionSegment(3, residual, W, H) : null;
  return { quads: quads, residualSeg: residualSeg, residualPx: residualPx, glyphs: instances.length, bigParts: comps.length - instances.length, newSyms: dict.syms.length - before,
           residual: opts.keepResidual ? residual : null };
}

// -- Document assembly -------------------------------------------------------
// Finalise: order the dictionary by height class (the id space the text
// regions must use), build the globals stream, then each page's stream.
// minUses: a shape used fewer times than this stays OUT of the dictionary
// (remap -1) and is drawn in place by buildPage - cheaper for one-offs, and
// it keeps the symbol id code short for everything else.
// used (optional): Uint8Array flag per shape id - only flagged shapes are kept.
function buildGlobals(dict, minUses, used){
  minUses = minUses || 1;
  var order = [];
  for(var i = 0; i < dict.syms.length; i++) if(dict.syms[i].uses >= minUses && (!used || used[i])) order.push(i);
  order.sort(function(a, b){ var A = dict.syms[a], B = dict.syms[b]; return A.h - B.h || A.w - B.w || a - b; });
  var remap = new Int32Array(dict.syms.length).fill(-1), sorted = [];
  for(var k = 0; k < order.length; k++){ remap[order[k]] = k; sorted.push(dict.syms[order[k]]); }
  var seg = sorted.length ? symbolDictionarySegment(0, sorted) : null;
  return { globals: seg, remap: remap, numSyms: sorted.length, dict: dict };
}
function concat(parts){
  var total = 0, k; for(k = 0; k < parts.length; k++) total += parts[k].length;
  var out = new Uint8Array(total), off = 0;
  for(k = 0; k < parts.length; k++){ out.set(parts[k], off); off += parts[k].length; }
  return out;
}
function buildPage(W, H, analysis, globals){
  var parts = [pageInfoSegment(1, W, H)], q = analysis.quads, k;
  var nIn = 0; for(k = 0; k < q.length; k += 4) if(globals.remap[q[k]] >= 0) nIn++;
  if(nIn && globals.numSyms){
    var ins = new Int32Array(nIn * 4), p = 0;
    for(k = 0; k < q.length; k += 4){ var id = globals.remap[q[k]]; if(id < 0) continue; ins[p++] = id; ins[p++] = q[k + 1]; ins[p++] = q[k + 2]; ins[p++] = q[k + 3]; }
    parts.push(textRegionSegment(2, 0, W, H, ins, globals.numSyms));
  }
  if(nIn * 4 < q.length){                           // one-off shapes drawn in place
    var bm = new Uint8Array(W * H), syms = globals.dict.syms;
    for(k = 0; k < q.length; k += 4){
      if(globals.remap[q[k]] >= 0) continue;
      var sy = syms[q[k]], x0 = q[k + 1], y0 = q[k + 2];
      for(var y = 0; y < sy.h; y++){ var yy = y0 + y; if(yy < 0 || yy >= H) continue;
        for(var x = 0; x < sy.w; x++){ var xx = x0 + x; if(xx >= 0 && xx < W && sy.bm[y * sy.w + x]) bm[yy * W + xx] = 1; } }
    }
    parts.push(genericRegionSegment(4, bm, W, H));
  }
  if(analysis.residualSeg) parts.push(analysis.residualSeg);
  return concat(parts);
}
// Whole page as one generic region (no dictionary) - for pages that are not
// text, and as the plain lossless path.
function buildGenericPage(bits, W, H){
  return concat([pageInfoSegment(1, W, H), genericRegionSegment(2, bits, W, H)]);
}

return {
  MQEncoder: MQEncoder, Contexts: Contexts, encodeInt: encodeInt, encodeIAID: encodeIAID, encodeGeneric: encodeGeneric,
  components: components, textSizePx: textSizePx, componentBoxes: componentBoxes, figuresScore: figuresScore, holeCount: holeCount, xorStats: xorStats, Dictionary: Dictionary, analysePage: analysePage,
  buildGlobals: buildGlobals, buildPage: buildPage, buildGenericPage: buildGenericPage,
  symbolDictionarySegment: symbolDictionarySegment, textRegionSegment: textRegionSegment, genericRegionSegment: genericRegionSegment, pageInfoSegment: pageInfoSegment
};
});
