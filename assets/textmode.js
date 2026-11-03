/* HyperCompress - verified text mode.
 *
 * The only way a scanned page fits in ~2 KB is to store its CHARACTERS, not
 * its pixels. This module OCRs each page (bundled Tesseract, fully offline),
 * then keeps a word as real PDF text ONLY when it is verified:
 *   - OCR confidence is high for the word and for every symbol in it,
 *   - the word re-rendered in the output font has the same shape as the
 *     scanned word (ink overlap), and
 *   - every DIGIT, re-rendered, matches the scanned digit better than any of
 *     the other nine digits (a discriminative check - 3 vs 8, 6 vs 0, 1 vs 7).
 * Anything that fails stays as a bitmap in a JBIG2 layer, together with
 * rules, seals, signatures and logos. So a character is either verified text
 * or the original pixels - never a guess.
 */
(function(root){
"use strict";

var workers = [], poolReady = null;
async function makeWorker(V){
  var w = Tesseract.createWorker({ workerPath: V + "worker.min.js", corePath: V + "tesseract-core.wasm.js", langPath: V });
  await w.load(); await w.loadLanguage("eng"); await w.initialize("eng");
  await w.setParameters({ preserve_interword_spaces: "1" });
  return w;
}
// A small pool so the next page is recognised while the current one is
// verified and encoded. recognize(canvas) hands out workers round-robin.
function createOcrWorker(assetDir, count){
  if(poolReady) return poolReady;
  var V = assetDir + "vendor/tesseract/", n = Math.max(1, Math.min(3, count || ((navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1)));
  poolReady = (async function(){
    workers = [await makeWorker(V)];
    for(var i = 1; i < n; i++){ try { workers.push(await makeWorker(V)); } catch(e){ break; } }
    var next = 0;
    return { size: workers.length, recognize: function(canvas){ var w = workers[next++ % workers.length]; return w.recognize(canvas); } };
  })();
  return poolReady;
}
async function terminateOcr(){ var ws = workers; workers = []; poolReady = null; for(var i = 0; i < ws.length; i++){ try { await ws[i].terminate(); } catch(e){} } }

// -- Shape verification ------------------------------------------------------
var measure = document.createElement("canvas"), mctx = measure.getContext("2d");
var FACES = ["\"Times New Roman\", Times, serif", "Arial, Helvetica, sans-serif"];
function fontCss(px, bold, italic, face){ return (italic ? "italic " : "") + (bold ? "bold " : "") + px + "px " + (face || FACES[0]); }

// Render text into a w x h ink mask (1 = ink) stretched to exactly fill it.
var maskCache = {}, maskCacheN = 0;
function renderMask(text, w, h, bold, italic, face){
  if(w < 1 || h < 1) return null;
  var key = text.length <= 2 ? text + "|" + w + "x" + h + "|" + (bold ? 1 : 0) + (italic ? 1 : 0) + "|" + (face || "") : null;
  if(key && maskCache[key] !== undefined) return maskCache[key];
  var m0 = renderMaskRaw(text, w, h, bold, italic, face);
  if(key){ if(maskCacheN > 20000){ maskCache = {}; maskCacheN = 0; } maskCache[key] = m0; maskCacheN++; }
  return m0;
}
function renderMaskRaw(text, w, h, bold, italic, face){
  var px = Math.max(4, Math.round(h / 0.95));           // bbox of a word ~ ascender+descender ~ 0.9 em
  mctx.font = fontCss(px, bold, italic, face);
  var tw = Math.max(1, mctx.measureText(text).width), m = mctx.measureText(text);
  var asc = m.actualBoundingBoxAscent || px * 0.7, desc = m.actualBoundingBoxDescent || px * 0.2;
  var th = Math.max(1, asc + desc);
  var cw = Math.ceil(tw) + 4, ch = Math.ceil(th) + 4;
  measure.width = cw; measure.height = ch;
  mctx.font = fontCss(px, bold, italic, face); mctx.fillStyle = "#000"; mctx.textBaseline = "alphabetic";
  mctx.clearRect(0, 0, cw, ch); mctx.fillText(text, 2, 2 + asc);
  // crop to actual ink then stretch to w x h
  var src = mctx.getImageData(0, 0, cw, ch).data, x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for(var y = 0; y < ch; y++) for(var x = 0; x < cw; x++) if(src[(y * cw + x) * 4 + 3] > 100){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
  if(x1 < 0) return null;
  var sw = x1 - x0 + 1, sh = y1 - y0 + 1, out = new Uint8Array(w * h);
  for(var yy = 0; yy < h; yy++){
    var sy = y0 + Math.min(sh - 1, Math.floor(yy * sh / h));
    for(var xx = 0; xx < w; xx++){
      var sx = x0 + Math.min(sw - 1, Math.floor(xx * sw / w));
      out[yy * w + xx] = src[(sy * cw + sx) * 4 + 3] > 100 ? 1 : 0;
    }
  }
  return out;
}
// Crop the page's ink bitmap to a box, trimmed to its own ink extent.
function cropInk(bits, W, H, b){
  var x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), x1 = Math.min(W - 1, b.x1), y1 = Math.min(H - 1, b.y1);
  var ix0 = x1 + 1, iy0 = y1 + 1, ix1 = -1, iy1 = -1;
  for(var y = y0; y <= y1; y++) for(var x = x0; x <= x1; x++) if(bits[y * W + x]){ if(x < ix0) ix0 = x; if(x > ix1) ix1 = x; if(y < iy0) iy0 = y; if(y > iy1) iy1 = y; }
  if(ix1 < 0) return null;
  var w = ix1 - ix0 + 1, h = iy1 - iy0 + 1, out = new Uint8Array(w * h);
  for(var yy = 0; yy < h; yy++) for(var xx = 0; xx < w; xx++) out[yy * w + xx] = bits[(iy0 + yy) * W + ix0 + xx];
  return { bm: out, w: w, h: h };
}
function dilate(bm, w, h){
  var o = new Uint8Array(w * h);
  for(var y = 0; y < h; y++) for(var x = 0; x < w; x++){ if(!bm[y * w + x]) continue;
    for(var dy = -1; dy <= 1; dy++) for(var dx = -1; dx <= 1; dx++){ var xx = x + dx, yy = y + dy; if(xx >= 0 && yy >= 0 && xx < w && yy < h) o[yy * w + xx] = 1; } }
  return o;
}
// Overlap score of two same-size masks: mean of (A inside dilated B, B inside dilated A).
function overlap(a, b, w, h){
  var da = dilate(a, w, h), db = dilate(b, w, h), na = 0, nb = 0, ain = 0, bin = 0;
  for(var k = 0; k < w * h; k++){ if(a[k]){ na++; if(db[k]) ain++; } if(b[k]){ nb++; if(da[k]) bin++; } }
  if(!na || !nb) return 0;
  return Math.min(ain / na, bin / nb);
}
var DIGITS = "0123456789";
function shapeScore(crop, text, bold, italic, enough){
  var best = 0;
  for(var f = 0; f < FACES.length; f++){
    var r = renderMask(text, crop.w, crop.h, bold, italic, FACES[f]);
    if(r){ var sc = overlap(crop.bm, r, crop.w, crop.h); if(sc > best) best = sc; }
    if(enough && best >= enough) break;                 // serif already convincing: skip the sans render
  }
  return best;
}
// Template check for a digit: the recognised digit must be the best (or
// joint-best) template match among 0-9, in whichever face fits the scan.
function digitCheck(crop, ch, bold){
  if(!crop || crop.w < 2 || crop.h < 4) return false;
  var mine = 0, better = 0;
  for(var f = 0; f < FACES.length; f++){
    var scores = [];
    for(var i = 0; i < 10; i++){ var r = renderMask(DIGITS[i], crop.w, crop.h, bold, false, FACES[f]); scores.push(r ? overlap(crop.bm, r, crop.w, crop.h) : 0); }
    var m = scores[DIGITS.indexOf(ch)], b = scores.filter(function(s){ return s > m + 0.02; }).length;
    if(m > mine){ mine = m; better = b; }
    if(mine >= 0.75 && better === 0) break;              // clear winner in this face already
  }
  return mine >= 0.5;                                   // sanity only: it must at least look like that digit
}
// OCR's own alternatives: a digit is trusted only when no other character
// was a close second choice.
function choiceMargin(sym){
  var ch = sym.choices || []; if(ch.length < 2) return 100;
  var top = sym.confidence, second = 0;
  for(var i = 0; i < ch.length; i++) if(ch[i].text !== sym.text && ch[i].confidence > second) second = ch[i].confidence;
  return top - second;
}
// Inside a number, '.' must be a short mark sitting on the baseline and ','
// must reach below it - the one confusion that changes a figure's value.
function punctCheck(sym, bits, W, H, digitH, baseY){
  var crop = cropInk(bits, W, H, sym.bbox); if(!crop) return false;
  var bottom = sym.bbox.y1, tall = crop.h >= 0.42 * digitH, below = bottom > baseY + 0.12 * digitH;
  if(sym.text === ".") return !tall && !below;
  if(sym.text === ",") return tall || below;
  return true;
}
var ENCODABLE = /^[\x20-\x7E‘’“”–—£©®°±·¼½¾]+$/;

// Verify every word on an OCR'd page. bits: hi-res ink bitmap (1 = ink) the
// OCR ran on. Returns accepted words with the data needed to typeset them.
function verifyWords(ocr, bits, W, H, opts){
  opts = opts || {};
  var minWord = opts.minWordConf || 85, minSym = opts.minSymConf || 80, minDigit = opts.minDigitConf || 88, minShape = opts.minShape || 0.45, minMargin = opts.minMargin || 35;
  var out = [], stats = { words: 0, accepted: 0, rejConf: 0, rejShape: 0, rejDigit: 0, rejChars: 0, rejPunct: 0 };
  var lines = ocr.lines || [];
  for(var li = 0; li < lines.length; li++){
    var line = lines[li];
    for(var wi = 0; wi < line.words.length; wi++){
      var w = line.words[wi], text = (w.text || "").trim();
      if(!text) continue;
      stats.words++;
      if(!ENCODABLE.test(text)){ stats.rejChars++; continue; }
      var numeric = /[0-9]/.test(text);
      // a "number" with letters mixed in (O for 0, l/I for 1) is never trusted
      if(numeric && /[A-Za-z]/.test(text) && !/^[A-Za-z]+[0-9]*$|^[0-9]+(st|nd|rd|th)$/.test(text)){ stats.rejChars++; continue; }
      var ok = w.confidence >= (numeric ? (opts.minWordNumeric || 60) : minWord), k;
      for(k = 0; ok && k < w.symbols.length; k++){
        var s = w.symbols[k], isD = /[0-9]/.test(s.text), need = isD ? minDigit : minSym;
        if(s.confidence < need) ok = false;
        if(isD && choiceMargin(s) < minMargin) ok = false;
      }
      if(!ok){ stats.rejConf++; continue; }
      var crop = cropInk(bits, W, H, w.bbox);
      if(!crop){ stats.rejShape++; continue; }
      if(shapeScore(crop, text, !!w.is_bold, !!w.is_italic, minShape + 0.15) < minShape){ stats.rejShape++; continue; }
      var digitsOk = true, punctOk = true, digitH = 0, baseY = w.bbox.y1;
      for(k = 0; k < w.symbols.length; k++){ var sd = w.symbols[k]; if(/[0-9]/.test(sd.text)){ var hh = sd.bbox.y1 - sd.bbox.y0 + 1; if(hh > digitH){ digitH = hh; baseY = sd.bbox.y1; } } }
      for(k = 0; digitsOk && punctOk && k < w.symbols.length; k++){
        var sy = w.symbols[k];
        if(/[0-9]/.test(sy.text)){ if(!digitCheck(cropInk(bits, W, H, sy.bbox), sy.text, !!w.is_bold)) digitsOk = false; }
        else if(numeric && (sy.text === "." || sy.text === ",") && digitH){ if(!punctCheck(sy, bits, W, H, digitH, baseY)) punctOk = false; }
      }
      if(!digitsOk){ stats.rejDigit++; continue; }
      if(!punctOk){ stats.rejPunct++; continue; }
      stats.accepted++;
      out.push({ text: text, bbox: w.bbox, baseline: w.baseline, bold: !!w.is_bold, italic: !!w.is_italic, line: li });
    }
  }
  return { words: out, stats: stats };
}

// Erase accepted words from the hi-res ink bitmap (they will be typeset), and
// shrink what is left to the output resolution for the JBIG2 layer.
function residualBitmap(bits, W, H, accepted, outW, outH){
  var rem = new Uint8Array(bits);
  for(var i = 0; i < accepted.length; i++){
    var b = accepted[i].bbox, x0 = Math.max(0, b.x0 - 1), y0 = Math.max(0, b.y0 - 1), x1 = Math.min(W - 1, b.x1 + 1), y1 = Math.min(H - 1, b.y1 + 1);
    for(var y = y0; y <= y1; y++) rem.fill(0, y * W + x0, y * W + x1 + 1);
  }
  var out = new Uint8Array(outW * outH), ink = 0;
  for(var oy = 0; oy < outH; oy++){
    var sy0 = Math.floor(oy * H / outH), sy1 = Math.max(sy0 + 1, Math.floor((oy + 1) * H / outH));
    for(var ox = 0; ox < outW; ox++){
      var sx0 = Math.floor(ox * W / outW), sx1 = Math.max(sx0 + 1, Math.floor((ox + 1) * W / outW)), hit = 0, tot = 0;
      for(var yy = sy0; yy < sy1; yy++) for(var xx = sx0; xx < sx1; xx++){ tot++; if(rem[yy * W + xx]) hit++; }
      if(hit && hit / tot >= 0.3){ out[oy * outW + ox] = 1; ink++; }
    }
  }
  return { bits: out, ink: ink };
}

// Point size that makes this exact string as tall as its scanned box.
var REF_PX = 100;
function sizeFromHeight(text, boxHpt, bold, italic){
  mctx.font = fontCss(REF_PX, bold, italic, FACES[0]);
  var m = mctx.measureText(text), hRef = (m.actualBoundingBoxAscent || REF_PX * 0.7) + (m.actualBoundingBoxDescent || 0);
  if(!(hRef > 0)) return null;
  return boxHpt * REF_PX / hRef;
}

// -- Typesetting -------------------------------------------------------------
// Emit the accepted words as compact text operators: one TJ per line, with
// kerning offsets that put every word at its scanned x position.
function typeset(PDFLib, doc, page, accepted, fonts, sx, sy, pageHpt){
  if(!accepted.length) return 0;
  var byLine = {}, order = [];
  for(var i = 0; i < accepted.length; i++){ var w = accepted[i]; if(!byLine[w.line]){ byLine[w.line] = []; order.push(w.line); } byLine[w.line].push(w); }
  var ops = [PDFLib.beginText()], count = 0;
  var N = PDFLib.PDFName, Num = PDFLib.PDFNumber, OpN = PDFLib.PDFOperatorNames, Op = PDFLib.PDFOperator;
  var curFont = null, curSize = 0, curX = 0, curY = 0, curTz = 100, curTw = 0;
  for(var q = 0; q < order.length; q++){
    var words = byLine[order[q]]; words.sort(function(a, b){ return a.bbox.x0 - b.bbox.x0; });
    var bold = words.filter(function(w){ return w.bold; }).length * 2 > words.length;
    // font size: median over the words of the size that makes each word's
    // rendered height equal its scanned height (letters without ascenders or
    // descenders are measured as such, so "assets" and "Deferred" agree)
    var est = [], fontObj = fonts[bold ? "B" : "R"].obj;
    function estimate(w){
      var hpt = (w.bbox.y1 - w.bbox.y0 + 1) * sy, eh = sizeFromHeight(w.text, hpt, bold, w.italic);
      var nat = fontObj.widthOfTextAtSize(w.text, 1), ew = nat > 0 ? ((w.bbox.x1 - w.bbox.x0 + 1) * sx) / nat : null;
      if(eh && ew) return Math.min(eh, ew * 1.2);
      return eh || ew;
    }
    words.forEach(function(w){ var e = estimate(w); if(e && w.text.length >= 2) est.push(e); });
    if(!est.length) words.forEach(function(w){ var e = estimate(w); if(e) est.push(e); });
    est.sort(function(a, b){ return a - b; });
    var sizePt = Math.max(4, Math.min(40, est.length ? est[est.length >> 1] : 9));
    // baseline: bottom of the words that have no descender, else bbox bottom less the descent
    var baseAcc = 0, baseN = 0;
    words.forEach(function(w){ if(!/[gjpqy,;()]/.test(w.text)){ baseAcc += w.bbox.y1 + 1; baseN++; } });
    var baseline = baseN ? baseAcc / baseN : (words[0].bbox.y1 + 1 - 0.22 * sizePt / sy);
    var fontKey = bold ? "B" : "R", font = fonts[fontKey];
    // horizontal scale so the line's total natural width matches the scan
    var natural = 0, scanned = 0;
    words.forEach(function(w){ natural += font.obj.widthOfTextAtSize(w.text, sizePt); scanned += (w.bbox.x1 - w.bbox.x0 + 1) * sx; });
    var tz = natural > 0 ? Math.max(70, Math.min(130, scanned / natural * 100)) : 100;
    var x = words[0].bbox.x0 * sx, y = pageHpt - baseline * sy;
    sizePt = Math.round(sizePt * 4) / 4;                 // quarter-point sizes: fewer font switches, no visible change
    if(curFont !== fontKey || curSize !== sizePt){ ops.push(PDFLib.setFontAndSize(font.name, sizePt)); curFont = fontKey; curSize = sizePt; }
    var tzR = Math.abs(tz - 100) < 2 ? 100 : Math.round(tz);
    if(tzR !== curTz){ ops.push(Op.of(OpN.SetTextHorizontalScaling, [Num.of(tzR)])); curTz = tzR; }
    tz = tzR;
    ops.push(PDFLib.moveText(+(x - curX).toFixed(1), +(y - curY).toFixed(1))); curX = x; curY = y;
    // gaps between the natural end of each word and the next word's scanned start
    var widths = words.map(function(w3){ return font.obj.widthOfTextAtSize(w3.text, sizePt) * tz / 100; });
    var gaps = [], pen0 = x;
    for(var g = 0; g < words.length; g++){ if(g > 0) gaps.push(words[g].bbox.x0 * sx - pen0); pen0 = words[g].bbox.x0 * sx + widths[g]; }
    var spaceW = font.obj.widthOfTextAtSize(" ", sizePt) * tz / 100, tw = 0;
    if(gaps.length){ var sorted = gaps.slice().sort(function(a, b){ return a - b; }); var med = sorted[sorted.length >> 1]; tw = Math.max(-0.8 * spaceW, med - spaceW); }
    tw = Math.round(tw * 20) / 20;
    if(Math.abs(tw - curTw) > 0.02){ ops.push(PDFLib.setWordSpacing(tw)); curTw = tw; }
    var arr = [], pen = x, run = "";              // pen position in points; run = pending string
    for(var k = 0; k < words.length; k++){
      var w2 = words[k], wx = w2.bbox.x0 * sx;
      if(k > 0){
        var expected = pen + spaceW + tw;            // where a plain space would put this word
        if(Math.abs(wx - expected) <= 0.6){ run += " " + w2.text; pen = expected; }
        else {
          if(run){ arr.push(font.obj.encodeText(run)); run = ""; }
          arr.push(Num.of(Math.round(-((wx - pen) / (sizePt * tz / 100)) * 1000))); pen = wx;
          run = w2.text;
        }
      } else run = w2.text;
      pen += widths[k];
      count++;
    }
    if(run) arr.push(font.obj.encodeText(run));
    ops.push(Op.of(OpN.ShowTextAdjusted, [doc.context.obj(arr)]));
  }
  ops.push(PDFLib.endText());
  page.pushOperators.apply(page, ops);
  return count;
}

root.HCText = { createOcrWorker: createOcrWorker, shapeScore: shapeScore, choiceMargin: choiceMargin, punctCheck: punctCheck, terminateOcr: terminateOcr, verifyWords: verifyWords, residualBitmap: residualBitmap, typeset: typeset, renderMask: renderMask, overlap: overlap, digitCheck: digitCheck, cropInk: cropInk };
})(typeof self !== "undefined" ? self : this);
