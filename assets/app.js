(function(){
"use strict";

var ASSET_DIR = (function(){
  var s = document.currentScript && document.currentScript.src;
  if(!s) return "supporting files/";
  return s.substring(0, s.lastIndexOf("/") + 1);
})();

var pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = ASSET_DIR + "vendor/pdf.worker.min.js";
var PDFLib = window.PDFLib;
var BUILD = "v32"; // shown in the footer; keep in step with the ?v= cache-buster in index.html

var state = {
  file: null,
  pdf: null,
  pageCount: 0,
  originalSize: 0,
  compressing: false,
  progress: 0,
  targetBytes: 0,
  allowGray: false
};

function $(sel, ctx){ return (ctx||document).querySelector(sel); }
function $$(sel, ctx){ return Array.prototype.slice.call((ctx||document).querySelectorAll(sel)); }
function fmtSize(b){
  if(b < 1024) return b + " B";
  if(b < 1048576) return (b/1024).toFixed(1) + " KB";
  if(b < 1073741824) return (b/1048576).toFixed(1) + " MB";
  return (b/1073741824).toFixed(2) + " GB";
}
function fmtRatio(orig, comp){
  if(!comp || !orig) return "";
  var r = orig / comp;
  return r.toFixed(1) + ":1";
}

function boot(){
  wireUI();
  var bt = $("#buildTag"); if(bt) bt.textContent = "· build " + BUILD;
}

function wireUI(){
  var dropzone = $("#dropzone");
  var fileInput = $("#fileInput");

  dropzone.addEventListener("click", function(){ fileInput.click(); });
  fileInput.addEventListener("change", function(e){
    if(e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });

  ["dragenter","dragover"].forEach(function(ev){
    dropzone.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); dropzone.classList.add("drag"); });
  });
  ["dragleave","drop"].forEach(function(ev){
    dropzone.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); dropzone.classList.remove("drag"); });
  });
  dropzone.addEventListener("drop", function(e){
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if(f) handleFile(f);
  });

  window.addEventListener("dragover", function(e){ e.preventDefault(); });
  window.addEventListener("drop", function(e){ e.preventDefault(); });

  $("#grayscale").addEventListener("change", function(e){
    state.allowGray = e.target.checked;
    updateTargetHint();
  });

  var tgt = $("#targetSize");
  tgt.addEventListener("input", function(){
    state.targetBytes = parseFloat(tgt.value) * 1048576 || 0;
    updateTargetHint();
  });

  // One-click automatic presets: compress to a fixed fraction of the original.
  var AUTO = { low: { frac: 0.6, label: "Low" }, medium: { frac: 0.33, label: "Medium" }, high: { frac: 0.15, label: "High" } };
  $$("[data-auto]").forEach(function(btn){
    btn.addEventListener("click", function(){
      var a = AUTO[btn.getAttribute("data-auto")];
      if(a) startAutoCompress(a.frac, a.label);
    });
  });

  $("#compressBtn").addEventListener("click", startCompress);
  $("#resetBtn").addEventListener("click", resetAll);
  $("#startOverBtn").addEventListener("click", function(){
    resetAll();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// A single "level" scalar in [0,1] maps to a (dpi, quality) pair. The range is
// deliberately wide so the engine can hit almost any target: the floor
// (level 0) is very aggressive (small, grayscale, low-res but still readable),
// the ceiling (level 1) is near-lossless. Below floorLevel() the text
// starts to soften, so we flag it but still deliver the size the user asked for.
// A level maps to the longest-side PIXEL size each page is rendered at, plus a
// JPEG quality. Capping pixels (rather than DPI) bounds the output regardless
// of the PDF's page geometry — a scanned PDF with a huge page box no longer
// renders a giant image. LONG_MIN is tiny (aggressive) but still legible-ish;
// LONG_MAX is crisp. Below floorLevel() the text starts to soften.
// Text pages are stored as 1-bit black & white (see encodePage), so the only
// size lever for them is RESOLUTION — a 1-bit page is razor sharp at any size,
// it just carries less detail as the pixel count drops. The level scalar maps
// to the longest-side pixel size. Photographic pages fall back to JPEG, whose
// quality is tied to the same level but never allowed to go destructive.
var LONG_MIN = 450, LONG_MAX = 2400;
var READABLE_PX = 1050;  // ~90 DPI on A4 — below this, small 1-bit text starts to break up
// The top of the scale is the document's own NATIVE resolution when it is a
// scan (the pixel size of its page images - a 300 dpi scan is 2479x3506 on
// A4), because rendering at exactly that size reproduces the scanner's text
// layer pixel-for-pixel; anything else resamples it. Detected from the sample
// pages in findLevel (state.topPx); LONG_MAX is the floor of that ceiling and
// NATIVE_CAP bounds memory (a 600 dpi scan is rendered at 300).
var NATIVE_CAP = 3600;
// Page-wise allocation. A page's figures score (fraction of glyphs in
// digit-like runs; prose ~0.00-0.01, a statement page ~0.1-0.2) is compared
// with the document's average (state.figDoc, from the sample pages): pages
// with more figures than average get more quality within the same budget,
// running prose gets less. u in [-1, 1] = (score - average) / FIG_SPAN.
var FIG_SPAN = 0.02, FIG_TONE_SHIFT = 0.35, FIG_PX_SHIFT = 0.25;
function figU(f){ var base = state.figDoc || 0, span = Math.max(FIG_SPAN, base); return Math.max(-1, Math.min(1, (f - base) / span)); }   // span scales with the document: a scan whose scores are all small still ranks its pages
// Figures score of a page from its binarised bitmap, cached on the page.
function pageFigures(page, bits, w, h){
  if(page._hcFig != null) return page._hcFig;
  var f = 0; try { f = JB ? JB.figuresScore(bits, w, h) : 0; } catch(e){}
  page._hcFig = f; return f;
}
function topPx(){ return state.topPx || LONG_MAX; }
function floorLevel(){ return (READABLE_PX - LONG_MIN) / (topPx() - LONG_MIN); }
function mulM(m, n){ return [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]]; }
// Resolve a page image object. pdf.js decodes page images asynchronously:
// a plain get() throws while the decode is pending, so wait for it (bounded).
function pageObj(page, id){
  return new Promise(function(res){
    var done = false;
    try { page.objs.get(id, function(v){ done = true; res(v); }); }
    catch(e){ try { var v2 = page.objs.get(id); done = true; res(v2); } catch(e2){ res(null); } }
    setTimeout(function(){ if(!done) res(null); }, 5000);
  });
}
// Long-side pixel count at which this page's largest page image is drawn 1:1
// (0 when the page has no sizeable image, e.g. a vector page). Also records
// the image found (page._hcNativeInfo) for the result's diagnostic line.
async function nativeLongPx(page){
  if(page._hcNative != null) return page._hcNative;
  var best = 0, info = null;
  try {
    var ops = await page.getOperatorList(), O = pdfjsLib.OPS, vp = page.getViewport({ scale: 1 });
    var ctm = [1, 0, 0, 1, 0, 0], stack = [];
    for(var i = 0; i < ops.fnArray.length; i++){
      var f = ops.fnArray[i], g = ops.argsArray[i], cands = [];
      if(f === O.save) stack.push(ctm.slice());
      else if(f === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if(f === O.transform) ctm = mulM(ctm, g);
      else if(f === O.paintImageMaskXObject || f === O.paintInlineImageXObject){ if(g[0]) cands.push({ w: g[0].width, h: g[0].height, kind: f === O.paintImageMaskXObject ? "mask" : "inline image" }); }
      else if(f === O.paintImageMaskXObjectGroup){ (g[0] || []).forEach(function(m){ if(m) cands.push({ w: m.width, h: m.height, kind: "mask" }); }); }
      else if(f === O.paintImageXObject || f === O.paintJpegXObject || f === O.paintImageXObjectRepeat || f === O.paintImageMaskXObjectRepeat){
        var ob = (typeof g[0] === "string") ? await pageObj(page, g[0]) : g[0];
        if(ob) cands.push({ w: ob.width, h: ob.height, kind: f === O.paintImageMaskXObjectRepeat ? "mask" : "image" });
      }
      for(var c = 0; c < cands.length; c++){
        var w = cands[c].w, h = cands[c].h;
        if(!(w > 0 && h > 0)) continue;
        var wPt = Math.hypot(ctm[0], ctm[1]), hPt = Math.hypot(ctm[2], ctm[3]);   // the unit square under the ctm, in points
        if(!(wPt > 1 && hPt > 1) || wPt * hPt < 0.2 * vp.width * vp.height) continue;   // a logo or seal, not the page image
        var sc = Math.max(w / wPt, h / hPt), lp = Math.round(Math.max(vp.width, vp.height) * sc);
        if(lp > best){ best = lp; info = { w: w, h: h, kind: cands[c].kind, longPx: lp }; }
      }
    }
  } catch(e){ console.warn("HyperCompress: native-resolution detection failed on a page", e); }
  page._hcNative = best; page._hcNativeInfo = info;
  return best;
}
// The document's top resolution: the largest native size among the sample
// pages, never below LONG_MAX, never above NATIVE_CAP.
async function documentTopPx(samples){
  var nat = 0, info = null;
  for(var k = 0; k < samples.length; k++){
    var page = await state.pdf.getPage(samples[k]);
    var lp = await nativeLongPx(page);
    if(lp > nat){ nat = lp; info = page._hcNativeInfo; }
  }
  state.nativeLong = nat; state.nativeInfo = info;
  // document average figures score (sample pages, a cheap 1200 px render)
  var fsum = 0, fn = 0;
  for(var k2 = 0; k2 < samples.length; k2++){
    var pg2 = await state.pdf.getPage(samples[k2]);
    if(pg2._hcFig == null){
      var r2 = await renderPage(pg2, 1200), n2 = r2.w * r2.h, A3 = analyseLuma(r2.ctx.getImageData(0, 0, r2.w, r2.h).data, n2);
      var b3 = new Uint8Array(n2); for(var q3 = 0; q3 < n2; q3++) b3[q3] = A3.lum[q3] <= A3.thr ? 1 : 0;
      if(!A3.isPhoto) pageFigures(pg2, b3, r2.w, r2.h); else pg2._hcFig = 0;
      r2.canvas.width = 1; r2.canvas.height = 1;
    }
    fsum += pg2._hcFig; fn++;
  }
  state.figDoc = fn ? fsum / fn : 0;
  console.info("HyperCompress: figures score of the sample pages averages " + state.figDoc.toFixed(3) + " (pages above it get more quality, prose less)");
  state.topPx = nat ? Math.min(NATIVE_CAP, Math.max(LONG_MAX, nat)) : LONG_MAX;
  console.info("HyperCompress: native page image " + (info ? info.w + "x" + info.h + " (" + info.kind + ") -> " + nat + " px long side" : "not found") + "; top resolution " + state.topPx + " px");
  return state.topPx;
}
// The floor is really a LETTER size, not a page width: a page of small print
// (a landscape financial table at 6-7 pt) needs more pixels than a page of
// body text to read equally well. Every page is rendered large enough that
// its text measures at least this many pixels (see textSizePx), up to LONG_MAX.
var MIN_GLYPH_PX = 10;

function levelToSettings(level){
  level = Math.max(0, Math.min(1, level));
  return {
    longPx: Math.round(LONG_MIN + level * (topPx() - LONG_MIN)),
    quality: 0.45 + level * 0.45,   // photo pages only: 0.45 -> 0.90
    minGlyph: MIN_GLYPH_PX,
    grayscale: !!state.allowGray
  };
}

function setTargetDefault(){
  // default target: about half the original, but never below the readable floor
  var mb = Math.max(0.1, Math.round(state.originalSize / 1048576 * 0.5 * 10) / 10);
  $("#targetSize").value = mb;
  state.targetBytes = mb * 1048576;
}

function updateTargetHint(){
  var hint = $("#targetHint");
  if(!hint || !state.originalSize) return;
  var origMb = (state.originalSize / 1048576).toFixed(1);
  var msg = "Original is " + origMb + " MB.";
  if(state.targetBytes && state.targetBytes >= state.originalSize){
    msg += " That's already at or above the original — pick a smaller number to shrink it.";
  } else if(state.targetBytes){
    msg += " We'll compress it to that size. If the target is too small for the text to stay legible, you get the smallest readable version instead — and we tell you.";
  }
  hint.textContent = msg;
}

function handleFile(f){
  if(f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")){
    toast("Please upload a PDF file", "err");
    return;
  }
  state.file = f;
  state.originalSize = f.size;

  $("#uploadArea").classList.add("hidden");
  $("#fileInfo").classList.remove("hidden");
  $("#fileName").textContent = f.name;
  $("#fileSize").textContent = fmtSize(f.size);

  var reader = new FileReader();
  reader.onload = function(e){
    var buf = new Uint8Array(e.target.result);
    pdfjsLib.getDocument({ data: buf }).promise.then(function(pdf){
      state.pdf = pdf;
      state.pageCount = pdf.numPages;
      $("#filePages").textContent = pdf.numPages + " pages";
      $("#controls").classList.remove("hidden");
      setTargetDefault();
      updateTargetHint();
      renderThumbnail(pdf);
    }).catch(function(err){
      toast("Could not read this PDF: " + err.message, "err");
      resetAll();
    });
  };
  reader.readAsArrayBuffer(f);
}

function renderThumbnail(pdf){
  pdf.getPage(1).then(function(page){
    var vp = page.getViewport({ scale: 0.4 });
    var canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    var ctx = canvas.getContext("2d");
    page.render({ canvasContext: ctx, viewport: vp }).promise.then(function(){
      var img = $("#thumbImg");
      img.src = canvas.toDataURL("image/jpeg", 0.7);
      img.classList.remove("hidden");
    });
  });
}

function startCompress(){
  if(state.compressing || !state.pdf) return;
  var target = parseFloat($("#targetSize").value) * 1048576;
  if(!target || target <= 0){ toast("Enter a target size in MB", "err"); return; }
  state.targetBytes = target;

  // Already at or under the target — nothing to compress, keep the original.
  if(state.originalSize <= target){
    showResult(null, { mode: "under", target: target });
    return;
  }
  runCompression(target, { target: target });
}

// One-click preset: compress to a fixed fraction of the original.
function startAutoCompress(frac, label){
  if(state.compressing || !state.pdf) return;
  var target = Math.max(50000, Math.round(state.originalSize * frac));
  runCompression(target, { target: target, autoLabel: label });
}

function setBusy(on){
  state.compressing = on;
  $("#compressBtn").disabled = on;
  $$("[data-auto]").forEach(function(b){ b.disabled = on; });
}

function runCompression(target, meta){
  setBusy(true);
  $("#progressWrap").classList.remove("hidden");
  $("#resultArea").classList.add("hidden");
  setProgress(0, "Starting...");

  compressToTarget(target).then(function(res){
    setBusy(false);
    res.autoLabel = meta.autoLabel;
    showResult(res.blob, res);
  }).catch(function(err){
    setBusy(false);
    console.error("HyperCompress failed:", err);
    var why = (err && (err.message || err.name)) || String(err);
    if(/memory|allocation|array buffer/i.test(why)) why += " — the browser ran out of memory. Close other tabs and try again, or split the PDF into parts.";
    toast("Compression failed: " + why, "err");
    setProgress(0, "Failed — " + why);
  });
}

function setProgress0(pct, label){
  state.progress = pct;
  $("#progressBar").style.width = pct + "%";
  $("#progressLabel").textContent = label || (Math.round(pct) + "%");
}

// ── Scanned-document encoder ─────────────────────────────────────────────────
// JPEG is built for photographs; on text it wastes bytes on sharp edges and
// produces blur or ringing. Scanned text is ~98% white with sharp ink, so each
// text page is binarised to 1 bit (razor sharp at any resolution) and stored
// losslessly with the browser's native deflate — the approach fax and
// professional scan compressors use. Pages that are genuinely photographic are
// detected and kept as JPEG at a sane quality.

var HAS_DEFLATE = typeof CompressionStream !== "undefined";

// Yield to the event loop WITHOUT a timer: Chrome throttles setTimeout in a
// background tab to once a minute after five minutes, which turned a 3-minute
// run into a 30-minute crawl when the user switched tabs. A MessageChannel
// task is not throttled, so a long run keeps full speed in the background.
function yieldNow(){
  return new Promise(function(r){
    if(typeof MessageChannel === "undefined"){ setTimeout(r, 0); return; }
    var ch = new MessageChannel(); ch.port1.onmessage = function(){ r(); }; ch.port2.postMessage(0);
  });
}
// JBIG2 (our own encoder, jbig2enc.js): the codec built for scanned text.
// Every PDF viewer decodes it; a page costs roughly a third of deflate.
var JB = window.JBIG2 || null;
// Verified text mode (textmode.js + bundled Tesseract): when pixels cannot fit
// the target, store verified CHARACTERS as real text and keep the rest as pixels.
var HCT = window.HCText || null;
var HAS_OCR = !!(HCT && JB && typeof Tesseract !== "undefined");
var TEXT_PX = 2000;   // OCR + verification resolution (~190 dpi on A4)

// zlib-format deflate — exactly what PDF's /FlateDecode expects.
async function deflateBytes(u8){
  var cs = new CompressionStream("deflate");
  var w = cs.writable.getWriter();
  w.write(u8); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// Otsu's method: the luminance threshold that best separates ink from paper.
// Adapts per page, so grey or uneven scan backgrounds still binarise cleanly.
function otsuThreshold(hist, total){
  var sum = 0;
  for(var i = 0; i < 256; i++) sum += i * hist[i];
  // When ink and paper are cleanly separated the maximum is a plateau across
  // the whole valley; take its MIDDLE, not its first point, so anti-aliased
  // edge pixels split evenly and thin strokes keep their weight.
  var sumB = 0, wB = 0, best = -1, first = 128, last = 128;
  for(var t = 0; t < 256; t++){
    wB += hist[t]; if(!wB) continue;
    var wF = total - wB; if(!wF) break;
    sumB += t * hist[t];
    var mB = sumB / wB, mF = (sum - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if(between > best){ best = between; first = last = t; }
    else if(between === best){ last = t; }
  }
  return (first + last) >> 1;
}

// Render a page at the given long-side pixel size (never upscaling >2x).
async function renderPage(page, longPx){
  var base = page.getViewport({ scale: 1 });
  var longPt = Math.max(base.width, base.height) || 1;
  var scale = Math.min(longPx / longPt, 5);
  var vp = page.getViewport({ scale: scale });
  var canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  var ctx = canvas.getContext("2d");
  // intent "print": pdf.js then advances the render without requestAnimationFrame,
  // which browsers pause in a hidden tab/pane - a long run keeps going in the background.
  await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
  return { canvas: canvas, ctx: ctx, w: canvas.width, h: canvas.height };
}

// Encode one page: 1-bit deflate for text, JPEG for photographic pages.
// Returns { kind, data, bytes, width?, height? }.
// Luminance analysis shared by the bitmap and text engines: per-page Otsu
// threshold (shading-aware) + photo detection. d = RGBA pixels, n = pixels.
function analyseLuma(d, n){
  var hist = new Uint32Array(256), lum = new Uint8Array(n);
  for(var i = 0, p = 0; i < n; i++, p += 4){
    var v = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8;
    lum[i] = v; hist[v]++;
  }
  // Threshold selection, shading-aware. A plain text page splits cleanly into
  // ink vs paper. A page with shaded cells or header bands has THREE classes
  // (ink, shade, paper) and a single Otsu cut can land on either side of the
  // shade. Text always contrasts with what it sits on, so the shade's own
  // brightness says which way to cut: a LIGHT shade carries dark text — cut
  // below it so it drops to white; a DARK band carries light text — keep it
  // black so that text survives as white-on-black.
  var thr = otsuThreshold(hist, n);
  var dark = 0;
  for(var b0 = 0; b0 <= thr; b0++) dark += hist[b0];
  if(dark / n > 0.12){                       // too much "ink" to be text alone → shading present
    var sub = new Uint32Array(256);
    for(var c0 = 0; c0 <= thr; c0++) sub[c0] = hist[c0];
    var thr2 = otsuThreshold(sub, dark);     // split the dark class into ink vs shade
    var bandN = 0, bandSum = 0, ink2 = 0;
    for(var m = 0; m <= thr; m++){
      if(m <= thr2) ink2 += hist[m]; else { bandN += hist[m]; bandSum += m * hist[m]; }
    }
    var bandMean = bandN ? bandSum / bandN : 0;
    if(bandMean > 128 && ink2 / n >= 0.003) thr = thr2;   // light shade → drop it, keep the dark text
  }
  var near = 0, ink = 0;
  for(var q = Math.max(0, thr - 24); q <= Math.min(255, thr + 24); q++) near += hist[q];
  for(var b = 0; b <= thr; b++) ink += hist[b];
  // Photos put many pixels right at the threshold. A page more than half
  // black is a failed binarisation (or a photo) — keep those as JPEG.
  var isPhoto = (near / n) > 0.12 || (ink / n) > 0.5;
  return { lum: lum, thr: thr, isPhoto: isPhoto, ink: ink / n };
}

async function encodePage(page, s){
  var px = s.longPx, r, w, h, n, img, d, A, bits = null, glyph = 0;
  for(var pass = 0; ; pass++){
    r = await renderPage(page, px);
    w = r.w; h = r.h; n = w * h;
    img = r.ctx.getImageData(0, 0, w, h); d = img.data;
    A = analyseLuma(d, n);
    if(A.isPhoto || !HAS_DEFLATE || !JB || !s.minGlyph) break;
    bits = new Uint8Array(n);
    for(var t0 = 0; t0 < n; t0++) bits[t0] = A.lum[t0] <= A.thr ? 1 : 0;
    // The text-size measure is a flood fill of the whole page; the size
    // search renders the same sample pages at many levels, so measure each
    // page once and scale the score with the resolution (it grows a touch
    // slower than linearly, hence the 0.9) - re-measured only after a bump.
    if(px >= topPx()) break;                                   // cannot be made any larger anyway
    var cache = page._hcGlyph;
    if(cache && pass === 0) glyph = cache.px === px ? cache.g : Math.floor(cache.g * Math.pow(px / cache.px, 0.9));
    else { glyph = JB.textSizePx(bits, w, h); page._hcGlyph = { px: px, g: glyph }; }
    // Small print: render again, larger, until the letters are big enough to
    // read (two tries at most - the measure grows a little slower than the
    // scale, so aim 10% past the mark).
    if(!glyph || glyph >= s.minGlyph || px >= topPx() || pass >= 2) break;
    px = Math.min(topPx(), Math.ceil(px * s.minGlyph / glyph * 1.1));
    r.canvas.width = 1; r.canvas.height = 1; bits = null;
  }
  // Page-wise allocation: a page with more figures than the document's
  // average is rendered a little larger, prose a little smaller (never below
  // the readable floor it was given, never above the top). The sample pages
  // go through the same rule, so the size estimate already includes it.
  if(bits && !A.isPhoto && s.minGlyph && px < topPx()){
    var fig = pageFigures(page, bits, w, h), u = figU(fig);
    if(Math.abs(u) > 0.05){
      // a prose page may be reduced only as far as its letters stay at the
      // readable size (the glyph score grows ~ px^0.9), never below the floor
      var rMin = glyph ? Math.pow(s.minGlyph / glyph, 1 / 0.9) : 1;
      var px2 = Math.round(px * Math.max(rMin, 1 + FIG_PX_SHIFT * u));
      px2 = Math.max(Math.min(px, Math.max(READABLE_PX, px2)), Math.min(topPx(), px2));
      if(Math.abs(px2 - px) >= 24){
        r.canvas.width = 1; r.canvas.height = 1;
        px = px2; r = await renderPage(page, px); w = r.w; h = r.h; n = w * h;
        img = r.ctx.getImageData(0, 0, w, h); d = img.data; A = analyseLuma(d, n);
        bits = new Uint8Array(n); for(var t1 = 0; t1 < n; t1++) bits[t1] = A.lum[t1] <= A.thr ? 1 : 0;
      }
    }
  }
  var lum = A.lum, thr = A.thr, isPhoto = A.isPhoto, ink = A.ink;
  if(isPhoto || !HAS_DEFLATE){
    if(s.grayscale){
      for(var j = 0, pp = 0; j < n; j++, pp += 4){ d[pp] = d[pp + 1] = d[pp + 2] = lum[j]; }
      r.ctx.putImageData(img, 0, 0);
    }
    var blob = await new Promise(function(res){ r.canvas.toBlob(function(b){ res(b); }, "image/jpeg", s.quality); });
    r.canvas.width = 1; r.canvas.height = 1;
    var jp = new Uint8Array(await blob.arrayBuffer());
    return { kind: "jpeg", data: jp, bytes: jp.length, thr: thr, ink: ink, longPx: px };
  }

  r.canvas.width = 1; r.canvas.height = 1;
  if(JB){
    // 1 = ink bitmap for the JBIG2 encoder; its final size is only known once
    // the page is analysed, so bytes is the generic-region cost (the upper
    // bound of what we will store - symbol coding can only make it smaller).
    if(!bits){ bits = new Uint8Array(n); for(var t = 0; t < n; t++) bits[t] = lum[t] <= thr ? 1 : 0; }
    var genSeg = JB.genericRegionSegment(2, bits, w, h);
    return { kind: "jbig2", bits: bits, genSeg: genSeg, width: w, height: h, bytes: genSeg.length + 60, thr: thr, ink: ink, longPx: px, glyph: glyph, fig: page._hcFig || 0 };
  }
  // Fallback without the JBIG2 module: pack to 1 bit per pixel, rows padded
  // to a byte; 1 = white, 0 = ink; stored with deflate.
  var rowBytes = (w + 7) >> 3, packed = new Uint8Array(rowBytes * h);
  for(var y = 0; y < h; y++){
    var ro = y * rowBytes, lo = y * w;
    for(var x = 0; x < w; x++){
      if(lum[lo + x] > thr) packed[ro + (x >> 3)] |= (0x80 >> (x & 7));
    }
  }
  var def = await deflateBytes(packed);
  return { kind: "bilevel", data: def, width: w, height: h, bytes: def.length, thr: thr, ink: ink, longPx: px };
}

// Place a 1-bit deflated bitmap on a pdf-lib page as a true 1-bpc image
// XObject (pdf-lib's own embedPng would expand it to 8-bit RGB).
function drawBilevel(doc, outPage, enc, w, h){
  var N = PDFLib.PDFName, Num = PDFLib.PDFNumber;
  var dict = doc.context.obj({});
  dict.set(N.of("Type"), N.of("XObject"));
  dict.set(N.of("Subtype"), N.of("Image"));
  dict.set(N.of("Width"), Num.of(enc.width));
  dict.set(N.of("Height"), Num.of(enc.height));
  dict.set(N.of("ColorSpace"), N.of("DeviceGray"));
  dict.set(N.of("BitsPerComponent"), Num.of(1));
  dict.set(N.of("Filter"), N.of("FlateDecode"));
  var ref = doc.context.register(PDFLib.PDFRawStream.of(dict, enc.data));
  var name = outPage.node.newXObject("Im", ref);
  outPage.pushOperators(
    PDFLib.pushGraphicsState(),
    PDFLib.concatTransformationMatrix(w, 0, 0, h, 0, 0),
    PDFLib.drawObject(name),
    PDFLib.popGraphicsState()
  );
}

// Place a JBIG2-coded page bitmap as a 1-bpc image XObject. globalsRef (the
// shared symbol dictionary stream) is only attached to symbol-coded pages.
function drawJbig2(doc, outPage, stream, pxW, pxH, w, h, globalsRef, asMask){
  var N = PDFLib.PDFName, Num = PDFLib.PDFNumber;
  var dict = doc.context.obj({});
  dict.set(N.of("Type"), N.of("XObject"));
  dict.set(N.of("Subtype"), N.of("Image"));
  dict.set(N.of("Width"), Num.of(pxW));
  dict.set(N.of("Height"), Num.of(pxH));
  // As an image MASK only the ink is painted (background stays transparent),
  // so the layer can sit on top of typeset text without hiding it.
  if(asMask) dict.set(N.of("ImageMask"), PDFLib.PDFBool.True);
  else dict.set(N.of("ColorSpace"), N.of("DeviceGray"));
  dict.set(N.of("BitsPerComponent"), Num.of(1));
  dict.set(N.of("Filter"), N.of("JBIG2Decode"));
  if(globalsRef){ var dp = doc.context.obj({}); dp.set(N.of("JBIG2Globals"), globalsRef); dict.set(N.of("DecodeParms"), dp); }
  var ref = doc.context.register(PDFLib.PDFRawStream.of(dict, stream));
  var name = outPage.node.newXObject("Im", ref);
  outPage.pushOperators(
    PDFLib.pushGraphicsState(),
    PDFLib.concatTransformationMatrix(w, 0, 0, h, 0, 0),
    PDFLib.drawObject(name),
    PDFLib.popGraphicsState()
  );
}

// -- Tone rung ---------------------------------------------------------------
// A photographic scan (one page image per page, no separate text mask) looks
// harsh as 1-bit black & white: the soft greys of the original are gone. When
// the target leaves room above the 1-bit top, the pages are instead kept as
// JPEG at the scan's own resolution - grayscale unless the page has colour -
// with the quality rising with the budget. t in [0,1] -> quality 0.45..0.92.
var TONE_Q_MIN = 0.35, TONE_Q_MAX = 0.92;
function toneQuality(t){ return +(TONE_Q_MIN + Math.max(0, Math.min(1, t)) * (TONE_Q_MAX - TONE_Q_MIN)).toFixed(3); }
function toneLongPx(){ return Math.min(NATIVE_CAP, Math.max(LONG_MIN, state.nativeLong || LONG_MAX)); }
function toneAvailable(){ return !!(state.nativeInfo && state.nativeInfo.kind === "image" && state.nativeLong > 0); }
async function encodeTone(page, t){
  var r = await renderPage(page, toneLongPx());
  var w = r.w, h = r.h, n = w * h;
  var img = r.ctx.getImageData(0, 0, w, h), d = img.data;
  // colour page? (sampled: a page with a coloured stamp or signature keeps its colour)
  var sat = 0, cnt = 0;
  for(var i = 0; i < n; i += 7){ var p = i * 4, mx = Math.max(d[p], d[p + 1], d[p + 2]), mn = Math.min(d[p], d[p + 1], d[p + 2]); cnt++; if(mx - mn > 48 && mx > 60) sat++; }
  var color = sat / cnt > 0.004;
  // figures score of this page (binarise the render once; cached per page)
  if(page._hcFig == null){
    var A2 = analyseLuma(d, n), bb = new Uint8Array(n);
    for(var b2 = 0; b2 < n; b2++) bb[b2] = A2.lum[b2] <= A2.thr ? 1 : 0;
    pageFigures(page, bb, w, h);
  }
  var tPage = Math.max(0, Math.min(1, t + FIG_TONE_SHIFT * figU(page._hcFig || 0)));
  if(!color){
    for(var j = 0, q = 0; j < n; j++, q += 4){ var v = (d[q] * 77 + d[q + 1] * 151 + d[q + 2] * 28) >> 8; d[q] = d[q + 1] = d[q + 2] = v; }
    r.ctx.putImageData(img, 0, 0);
  }
  var quality = toneQuality(tPage);
  var blob = await new Promise(function(res){ r.canvas.toBlob(function(b){ res(b); }, "image/jpeg", quality); });
  r.canvas.width = 1; r.canvas.height = 1;
  var jp = new Uint8Array(await blob.arrayBuffer());
  return { kind: "jpeg", data: jp, bytes: jp.length, width: w, height: h, longPx: Math.max(w, h), tone: true, color: color, quality: quality, fig: page._hcFig || 0 };
}
async function estimateTone(t, samples, corr){
  var sum = 0;
  for(var k = 0; k < samples.length; k++){
    var page = await state.pdf.getPage(samples[k]);
    sum += (await encodeTone(page, t)).bytes;
    page.cleanup();
  }
  var avg = sum / samples.length;
  return Math.round((avg * state.pageCount * 1.03 + 1500 + state.pageCount * 40) * (corr || 1) * (state.estScale || 1));
}

// -- MRC rung: crisp text + soft background ---------------------------------
// The page's text stays 1-bit at full resolution; underneath it a LOW-RES
// JPEG carries what 1-bit loses - paper tone, stamps, shading, signatures.
// The text is erased from that layer first (using the 1-bit mask), so it
// does not show as grey shadows under the crisp glyphs. m in [0,1] ->
// background long side BG_MIN..min(native,1800) px and JPEG quality 0.45..0.85.
var BG_MIN = 360, BG_MAX_CAP = 1800;
function bgLongPx(m){ var top = Math.min(BG_MAX_CAP, state.nativeLong || BG_MAX_CAP); return Math.round(BG_MIN + Math.max(0, Math.min(1, m)) * (top - BG_MIN)); }
function bgQuality(m){ return +(0.45 + Math.max(0, Math.min(1, m)) * 0.40).toFixed(3); }
function mrcAvailable(){ return !!(state.nativeLong > 0 && JB); }
async function encodeBackground(page, m, textBits, tw, th){
  var r = await renderPage(page, bgLongPx(m));
  var w = r.w, h = r.h, n = w * h;
  var img = r.ctx.getImageData(0, 0, w, h), d = img.data;
  var sat = 0, cnt = 0;
  for(var i = 0; i < n; i += 5){ var p = i * 4, mx = Math.max(d[p], d[p + 1], d[p + 2]), mn = Math.min(d[p], d[p + 1], d[p + 2]); cnt++; if(mx - mn > 48 && mx > 60) sat++; }
  var color = sat / cnt > 0.004;
  // 1. which background pixels are under text (any ink in the matching block of the full-res mask, padded by one background pixel)
  var masked = new Uint8Array(n);
  if(textBits){
    var sx = tw / w, sy = th / h, padX = Math.ceil(sx), padY = Math.ceil(sy);
    for(var y = 0; y < h; y++){
      var ty0 = Math.max(0, Math.floor(y * sy) - padY), ty1 = Math.min(th, Math.ceil((y + 1) * sy) + padY);
      for(var x = 0; x < w; x++){
        var tx0 = Math.max(0, Math.floor(x * sx) - padX), tx1 = Math.min(tw, Math.ceil((x + 1) * sx) + padX), hit = 0;
        for(var yy = ty0; yy < ty1 && !hit; yy++){ var row = yy * tw; for(var xx = tx0; xx < tx1; xx++){ if(textBits[row + xx]){ hit = 1; break; } } }
        masked[y * w + x] = hit;
      }
    }
  }
  // 2. fill the masked pixels with the mean of the unmasked pixels of their block (paper), so the layer holds only what is not text
  var B = 12, ch = color ? 3 : 1;
  var lum = null;
  if(!color){ lum = new Uint8Array(n); for(var j = 0, q = 0; j < n; j++, q += 4) lum[j] = (d[q] * 77 + d[q + 1] * 151 + d[q + 2] * 28) >> 8; }
  var paper = [235, 235, 235], hist = new Uint32Array(256);
  for(var k = 0; k < n; k++) if(!masked[k]) hist[color ? d[k * 4 + 1] : lum[k]]++;
  var acc = 0, tot = n; for(var v = 255; v >= 0; v--){ acc += hist[v]; if(acc > tot * 0.3){ paper = [v, v, v]; break; } }
  var lastFill = paper.slice();
  for(var by = 0; by < h; by += B){
    for(var bx = 0; bx < w; bx += B){
      var s0 = 0, s1 = 0, s2 = 0, c = 0, y1 = Math.min(h, by + B), x1 = Math.min(w, bx + B);
      for(var yb = by; yb < y1; yb++) for(var xb = bx; xb < x1; xb++){ var ii = yb * w + xb; if(masked[ii]) continue; if(color){ s0 += d[ii * 4]; s1 += d[ii * 4 + 1]; s2 += d[ii * 4 + 2]; } else s0 += lum[ii]; c++; }
      var fill = c >= 8 ? (color ? [Math.round(s0 / c), Math.round(s1 / c), Math.round(s2 / c)] : [Math.round(s0 / c), 0, 0]) : lastFill;
      lastFill = fill;
      for(var yc = by; yc < y1; yc++) for(var xc = bx; xc < x1; xc++){ var i2 = yc * w + xc; if(masked[i2]){ if(color){ d[i2 * 4] = fill[0]; d[i2 * 4 + 1] = fill[1]; d[i2 * 4 + 2] = fill[2]; } else lum[i2] = fill[0]; } }
    }
  }
  if(!color){ for(var j2 = 0, q2 = 0; j2 < n; j2++, q2 += 4){ d[q2] = d[q2 + 1] = d[q2 + 2] = lum[j2]; } }
  r.ctx.putImageData(img, 0, 0);
  var quality = bgQuality(m);
  var blob = await new Promise(function(res){ r.canvas.toBlob(function(b){ res(b); }, "image/jpeg", quality); });
  r.canvas.width = 1; r.canvas.height = 1;
  var jp = new Uint8Array(await blob.arrayBuffer());
  return { data: jp, bytes: jp.length, width: w, height: h, longPx: Math.max(w, h), color: color, quality: quality };
}
async function estimateMrc(m, samples, corr){
  var sum = 0, sTop = levelToSettings(1);
  for(var k = 0; k < samples.length; k++){
    var page = await state.pdf.getPage(samples[k]);
    var e = await encodePage(page, sTop);
    sum += e.bytes;
    if(e.kind === "jbig2"){ var bg = await encodeBackground(page, m, e.bits, e.width, e.height); sum += bg.bytes; }
    page.cleanup();
  }
  var avg = sum / samples.length;
  return Math.round((avg * state.pageCount * 1.03 + 1500 + state.pageCount * 40) * (corr || 1) * (state.estScale || 1));
}

// Spread of sample pages used to estimate the whole-document size cheaply.
function samplePageList(){
  var n = state.pageCount;
  var count = Math.min(n, 7);
  if(count >= n){
    var all = [];
    for(var i = 1; i <= n; i++) all.push(i);
    return all;
  }
  var out = [];
  for(var k = 0; k < count; k++){
    out.push(1 + Math.round(k * (n - 1) / (count - 1)));
  }
  return out;
}

// Estimate the full output size at a quality level by compressing a few
// representative pages and extrapolating across the whole document.
async function estimateTotal(level, samples, corr){
  var s = levelToSettings(level);
  var sum = 0;
  for(var k = 0; k < samples.length; k++){
    var page = await state.pdf.getPage(samples[k]);
    sum += (await encodePage(page, s)).bytes;
    page.cleanup();
  }
  var avg = sum / samples.length;
  // Image payload dominates; add ~3% PDF structural overhead + a small base.
  // state.estScale: calibration knob for testing the closed loop (default 1).
  return Math.round((avg * state.pageCount * 1.03 + 1500 + state.pageCount * 40) * (corr || 1) * (state.estScale || 1));
}

// Binary-search the highest (best-quality) level whose estimated size fits the
// target. If even the most aggressive floor can't reach the target, we still
// return the floor (the smallest we can make it) rather than giving up.
async function findLevel(target, corr){
  corr = corr || 1;
  var samples = samplePageList();
  var aim = target * 0.97; // small margin so the real pass rarely overshoots; the closed loop corrects a miss

  // The engine never goes below the READABLE floor: a target that would need
  // smaller pages than that is answered with the smallest readable file and an
  // honest message, not with smudged text that hits the number.
  setProgress(5, "Analysing the document...");
  await documentTopPx(samples);
  var estFloor = await estimateTotal(floorLevel(), samples, corr);
  if(estFloor > target){
    return { level: floorLevel(), reachable: false, belowReadable: false, floorEstimate: estFloor, estimate: estFloor, textMode: HAS_OCR };
  }
  setProgress(12, "Finding the best quality for your target...");
  var estTop = await estimateTotal(1, samples, corr);
  if(estTop <= aim){
    // The 1-bit ladder's top fits. For a photographic scan, spend what is
    // left on keeping the scan's own tones (JPEG at native resolution): find
    // the highest quality whose estimate fits; if even the lowest does not,
    // stay with 1-bit at full resolution.
    if(toneAvailable()){
      setProgress(13, "Checking whether the scan's own tones fit your target...");
      var estT0 = await estimateTone(0, samples, corr);
      if(estT0 <= aim){
        var estT1 = await estimateTone(1, samples, corr);
        if(estT1 <= aim) return { level: 1, tone: true, reachable: true, belowReadable: false, estimate: estT1 };
        var tlo = 0, thi = 1, tbest = 0, tbestEst = estT0;
        for(var ti = 0; ti < 6; ti++){
          var tmid = (tlo + thi) / 2;
          setProgress(14 + ti * 3, "Finding the best quality for your target...");
          var estM = await estimateTone(tmid, samples, corr);
          if(estM <= aim){ tbest = tmid; tbestEst = estM; tlo = tmid; } else { thi = tmid; }
        }
        return { level: tbest, tone: true, reachable: true, belowReadable: false, estimate: tbestEst };
      }
    }
    // Crisp text + a soft background layer: the rung between 1-bit and
    // full tone. Fits far more often (a 450 px background is ~10-15 KB).
    if(mrcAvailable()){
      setProgress(13, "Checking whether a soft background layer fits your target...");
      var estM0 = await estimateMrc(0, samples, corr);
      if(estM0 <= aim){
        var estM1 = await estimateMrc(1, samples, corr);
        if(estM1 <= aim) return { level: 1, mrc: true, reachable: true, belowReadable: false, estimate: estM1 };
        var mlo = 0, mhi = 1, mbest = 0, mbestEst = estM0;
        for(var mi = 0; mi < 6; mi++){
          var mmid = (mlo + mhi) / 2;
          setProgress(14 + mi * 3, "Finding the best background quality for your target...");
          var estMM = await estimateMrc(mmid, samples, corr);
          if(estMM <= aim){ mbest = mmid; mbestEst = estMM; mlo = mmid; } else { mhi = mmid; }
        }
        return { level: mbest, mrc: true, reachable: true, belowReadable: false, estimate: mbestEst };
      }
      // even the softest background does not fit: say what it would need
      return { level: 1, reachable: true, belowReadable: false, estimate: estTop, toneNeed: estM0 };
    }
    return { level: 1, reachable: true, belowReadable: false, estimate: estTop };
  }

  var lo = floorLevel(), hi = 1, best = floorLevel(), bestEst = estFloor;
  for(var it = 0; it < 7; it++){
    var mid = (lo + hi) / 2;
    setProgress(14 + it * 3, "Finding the best quality for your target...");
    var est = await estimateTotal(mid, samples, corr);
    if(est <= aim){ best = mid; bestEst = est; lo = mid; } else { hi = mid; }
  }
  return { level: best, reachable: true, belowReadable: false, estimate: bestEst };
}

// The estimate comes from a few sample pages coded as plain bitmaps; the real
// pass shares one glyph dictionary across the whole document and can come out
// far smaller (a 3.5 MB target once produced 1.3 MB). So: run, measure, and
// if the result leaves a big part of the budget unused (or overshoots it),
// recalibrate the estimate by the measured ratio and run again at the level
// the budget really pays for. At most two re-runs.
function setProgress(p, label){ return setProgress0(p, passPrefix && label ? passPrefix + label : label); }
var passPrefix = "";
async function compressToTarget(target){
  var corr = 1, result = null, best = null;
  for(var attempt = 0; attempt < 3; attempt++){
    passPrefix = attempt ? "Pass " + (attempt + 1) + " - using your full size budget. " : "";
    var search = await findLevel(target, corr);
    if(search.textMode){ passPrefix = ""; return textModeCompress(target, search); }
    result = await compressPass(target, search);
    result.passes = attempt + 1;
    var actual = result.blob.size, est = search.estimate || actual;
    if(!best || (actual <= target && (best.blob.size > target || result.level > best.level)) || (best.blob.size > target && actual < best.blob.size)) best = result;
    var under = actual < target * 0.9 && search.level < 1 - 1e-6;   // more than 10% of the budget unused -> re-run at the level it pays for
    var over = actual > target && search.level > floorLevel() + 1e-6;
    if(!(under || over) || attempt === 2 || !(est > 0)) break;
    corr *= actual / est;
    console.info("HyperCompress: pass " + (attempt + 1) + " produced " + actual + " bytes against an estimate of " + est + " - re-running at the level the target pays for (calibration x" + corr.toFixed(2) + ")");
  }
  passPrefix = "";
  setProgress(100, "Done!");                   // drop the "Pass N" prefix from the final label
  return best || result;
}

var toneSawColor = false, allocUp = 0, allocDown = 0;
async function compressPass(target, search){
  var s = levelToSettings(search.mrc ? 1 : search.level);   // the MRC text layer is always at the top
  toneSawColor = false; allocUp = 0; allocDown = 0;
  var pdf = state.pdf;
  var totalPages = pdf.numPages;
  var outDoc = await PDFLib.PDFDocument.create();
  var srcDoc = null, copied = 0;

  // PASS 1 - render, binarise and analyse every page. Text pages are split
  // into glyphs that go into ONE dictionary shared by the whole document
  // (every distinct letter shape is stored once), plus a per-page list of
  // where each glyph sits. Only the compact results are kept per page.
  var dict = JB ? new JB.Dictionary({ exactOnly: true }) : null;
  var plan = new Array(totalPages);
  for(var i = 1; i <= totalPages; i++){
    setProgress(35 + (i - 1) / totalPages * 45, "Reading page " + i + " of " + totalPages + "...");
    var page = null;
    try {
      page = await pdf.getPage(i);
      var enc = search.tone ? await encodeTone(page, search.level) : await encodePage(page, s);
      var origVP = page.getViewport({ scale: 1 });
      if(enc.color) toneSawColor = true;
      var uu = figU(enc.fig || 0); if(uu > 0.05) allocUp++; else if(uu < -0.05) allocDown++;
      var item = { w: origVP.width, h: origVP.height, enc: enc };
      if(enc.kind === "jbig2"){
        if(search.mrc){ item.bg = await encodeBackground(page, search.level, enc.bits, enc.width, enc.height); if(item.bg.color) toneSawColor = true; }
        item.an = JB.analysePage(enc.bits, enc.width, enc.height, dict);
        enc.bits = null;                                   // the bitmap is no longer needed
      }
      plan[i - 1] = item;
    } catch(pageErr){
      // One page the renderer can't handle must not sink a 700-page run:
      // carry that page over from the original file untouched instead.
      console.warn("HyperCompress: page " + i + " could not be re-encoded, copying the original", pageErr);
      plan[i - 1] = { copy: true };
    }
    // pdf.js caches every decoded image it has drawn (a scanned page's
    // background alone is ~9 MB decoded). Across hundreds of pages that
    // exhausts memory, so release each page's decoded resources at once.
    if(page) page.cleanup();
    if(i % 50 === 0){ try { await pdf.cleanup(); } catch(e){} }
    if(i % 3 === 0){ await yieldNow(); }
  }

  // PASS 2 - write the shared dictionary once, then each page. A page is
  // stored symbol-coded when that is smaller than coding it as one bitmap
  // (its share of the dictionary counted), else as the plain lossless bitmap.
  var G = null, globalsRef = null, perSym = 0, symPages = 0, genPages = 0;
  if(dict && dict.syms.length){
    setProgress(81, "Building the shared glyph dictionary (" + dict.syms.length + " shapes)...");
    await yieldNow();
    G = JB.buildGlobals(dict, 1);                     // measured: one-offs are cheaper in the dictionary than drawn in place
    perSym = G.numSyms ? G.globals.length / G.numSyms : 0;   // bytes one shape costs in the dictionary
    // Decide per page first (symbol stream + the dictionary bytes of the
    // shapes it introduced, vs the plain bitmap), then keep in the dictionary
    // only the shapes the symbol-coded pages really use.
    var used = new Uint8Array(dict.syms.length), anyUsed = false;
    for(var d0 = 0; d0 < totalPages; d0++){
      var pl = plan[d0]; if(!pl || pl.copy || pl.enc.kind !== "jbig2" || !pl.an.quads.length) continue;
      var probe = JB.buildPage(pl.enc.width, pl.enc.height, pl.an, G);
      pl.useSym = probe.length + pl.an.newSyms * perSym < pl.enc.genSeg.length + 60;
      if(pl.useSym){ anyUsed = true; var qq = pl.an.quads; for(var u = 0; u < qq.length; u += 4) used[qq[u]] = 1; }
      if(d0 % 10 === 0) await yieldNow();
    }
    G = anyUsed ? JB.buildGlobals(dict, 1, used) : null;
    if(G && G.numSyms){ globalsRef = outDoc.context.register(PDFLib.PDFRawStream.of(outDoc.context.obj({}), G.globals)); }
  }
  for(var j = 0; j < totalPages; j++){
    setProgress(82 + j / totalPages * 15, "Writing page " + (j + 1) + " of " + totalPages + "...");
    var it = plan[j];
    if(it.copy){
      if(!srcDoc) srcDoc = await PDFLib.PDFDocument.load(new Uint8Array(await state.file.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
      var cp = await outDoc.copyPages(srcDoc, [j]);
      outDoc.addPage(cp[0]); copied++;
      continue;
    }
    var outPage = outDoc.addPage([it.w, it.h]), e = it.enc;
    if(it.bg){ var bgImg = await outDoc.embedJpg(it.bg.data); outPage.drawImage(bgImg, { x: 0, y: 0, width: it.w, height: it.h }); }
    if(e.kind === "jbig2"){
      var stream = null;
      var useGlobals = false;
      if(G && it.useSym){
        stream = JB.buildPage(e.width, e.height, it.an, G); symPages++; useGlobals = G.numSyms > 0;
      }
      if(!stream){
        var head = JB.pageInfoSegment(1, e.width, e.height);
        stream = new Uint8Array(head.length + e.genSeg.length); stream.set(head, 0); stream.set(e.genSeg, head.length);
        genPages++;
      }
      drawJbig2(outDoc, outPage, stream, e.width, e.height, it.w, it.h, useGlobals ? globalsRef : null, !!it.bg);   // over a background the text is a transparent mask
    } else if(e.kind === "bilevel"){
      drawBilevel(outDoc, outPage, e, it.w, it.h);
    } else {
      var img = await outDoc.embedJpg(e.data);
      outPage.drawImage(img, { x: 0, y: 0, width: it.w, height: it.h });
    }
    plan[j] = null;
    if(j % 10 === 0){ await yieldNow(); }
  }
  if(copied) console.warn("HyperCompress: " + copied + " page(s) were copied from the original unchanged.");
  console.info("HyperCompress: " + symPages + " symbol-coded page(s), " + genPages + " bitmap-coded, dictionary " + (G ? G.numSyms + " shapes / " + Math.round(G.globals.length / 1024) + " KB" : "none"));

  setProgress(97, "Assembling PDF...");
  var outBytes = await outDoc.save();
  setProgress(100, "Done!");

  return {
    blob: new Blob([outBytes], { type: "application/pdf" }),
    reachable: search.reachable,
    belowReadable: search.belowReadable,
    level: search.level,
    target: target,
    settings: s,
    mrc: !!search.mrc, bgPx: search.mrc ? bgLongPx(search.level) : 0, bgQ: search.mrc ? bgQuality(search.level) : 0,
    allocUp: allocUp, allocDown: allocDown, toneNeed: search.toneNeed || 0, tone: !!search.tone, toneQ: search.tone ? toneQuality(search.level) : 0, toneLongPx: search.tone ? toneLongPx() : 0, toneColor: !!(search.tone && toneSawColor)
  };
}

// Verified text mode. Each page: render at OCR resolution, binarise, OCR,
// verify every word (confidence + re-rendered shape + per-digit discrimination),
// typeset the verified words as real text, and keep everything else (rules,
// seals, signatures, unverified words) as a JBIG2 bitmap at the readable floor.
async function textModeCompress(target, search){
  var pdf = state.pdf, totalPages = pdf.numPages;
  var outDoc = await PDFLib.PDFDocument.create();
  var fontR = outDoc.embedStandardFont(PDFLib.StandardFonts.TimesRoman);
  var fontB = outDoc.embedStandardFont(PDFLib.StandardFonts.TimesRomanBold);
  var s = levelToSettings(floorLevel());
  setProgress(20, "Starting text recognition (the first page takes a little longer)...");
  var ocr = await HCT.createOcrWorker(ASSET_DIR);
  var srcDoc = null, copied = 0, tot = { words: 0, accepted: 0, textPages: 0, otherPages: 0, rejConf: 0, rejShape: 0, rejDigit: 0, rejPunct: 0 };
  var t0 = Date.now();
  var dict = new JB.Dictionary({ exactOnly: true }), pending = [];   // leftover pixels of every page share one glyph dictionary

  // Stage 1 for a page: render, threshold, and (for text pages) start OCR.
  // Returned promise-bearing job lets the next page's OCR overlap this one's
  // verification and encoding.
  async function prepare(i){
    var page = await pdf.getPage(i);
    var origVP = page.getViewport({ scale: 1 });
    var r = await renderPage(page, TEXT_PX);
    var w = r.w, h = r.h, n = w * h;
    var A = analyseLuma(r.ctx.getImageData(0, 0, w, h).data, n);
    var job = { i: i, page: page, origVP: origVP, w: w, h: h, photo: A.isPhoto };
    if(A.isPhoto){ r.canvas.width = 1; r.canvas.height = 1; return job; }
    var bits = new Uint8Array(n);
    for(var t = 0; t < n; t++) bits[t] = A.lum[t] <= A.thr ? 1 : 0;
    job.bits = bits;
    job.glyph = JB.textSizePx(bits, w, h);     // how small the print is, at the OCR resolution
    job.ocr = ocr.recognize(r.canvas).then(function(res){ r.canvas.width = 1; r.canvas.height = 1; return res; }, function(err){ r.canvas.width = 1; r.canvas.height = 1; throw err; });
    return job;
  }
  // Stage 2: verify, typeset, encode the residual, add the page.
  async function finish(job){
    var origVP = job.origVP, outPage;
    if(job.photo){
      var enc = await encodePage(job.page, s);
      outPage = outDoc.addPage([origVP.width, origVP.height]);
      if(enc.kind === "jpeg"){ var jimg = await outDoc.embedJpg(enc.data); outPage.drawImage(jimg, { x: 0, y: 0, width: origVP.width, height: origVP.height }); }
      else if(enc.kind === "jbig2"){ var head = JB.pageInfoSegment(1, enc.width, enc.height); var st = new Uint8Array(head.length + enc.genSeg.length); st.set(head, 0); st.set(enc.genSeg, head.length); drawJbig2(outDoc, outPage, st, enc.width, enc.height, origVP.width, origVP.height, null); }
      else drawBilevel(outDoc, outPage, enc, origVP.width, origVP.height);
      tot.otherPages++;
      return;
    }
    var res = await job.ocr, w = job.w, h = job.h;
    var ver = HCT.verifyWords(res.data, job.bits, w, h);
    var accepted = ver.words.filter(function(wd){ try { (wd.bold ? fontB : fontR).encodeText(wd.text); return true; } catch(e){ return false; } });
    tot.words += ver.stats.words; tot.accepted += accepted.length; tot.rejConf += ver.stats.rejConf; tot.rejShape += ver.stats.rejShape; tot.rejDigit += ver.stats.rejDigit; tot.rejPunct += ver.stats.rejPunct || 0;
    // Leftover pixels (unverified words, rules, seals) are kept at the
    // readable floor - raised for small print so its letters still measure
    // MIN_GLYPH_PX, up to the OCR resolution itself.
    var srcLong = Math.max(w, h), outLong = s.longPx;
    if(job.glyph && job.glyph < MIN_GLYPH_PX) outLong = Math.max(outLong, Math.ceil(srcLong * MIN_GLYPH_PX / job.glyph * 1.1));
    outLong = Math.min(srcLong, outLong);
    var outW = Math.max(1, Math.round(w * outLong / srcLong)), outH = Math.max(1, Math.round(h * outLong / srcLong));
    var resid = HCT.residualBitmap(job.bits, w, h, accepted, outW, outH);
    job.bits = null;
    outPage = outDoc.addPage([origVP.width, origVP.height]);
    if(accepted.length){
      var pageFonts = { R: { obj: fontR, name: outPage.node.newFontDictionary("F1", fontR.ref) }, B: { obj: fontB, name: outPage.node.newFontDictionary("F2", fontB.ref) } };
      HCT.typeset(PDFLib, outDoc, outPage, accepted, pageFonts, origVP.width / w, origVP.height / h, origVP.height);
    }
    if(resid.ink){
      var an = JB.analysePage(resid.bits, outW, outH, dict);
      pending.push({ page: outPage, an: an, outW: outW, outH: outH, w: origVP.width, h: origVP.height });
    }
    tot.textPages++;
  }
  async function copyOriginal(i){
    if(!srcDoc) srcDoc = await PDFLib.PDFDocument.load(new Uint8Array(await state.file.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
    var cp = await outDoc.copyPages(srcDoc, [i - 1]);
    outDoc.addPage(cp[0]); copied++;
  }

  var ahead = (ocr.size || 1) > 1 ? 1 : 0;      // how many pages to keep in flight ahead of the one being finished
  var queue = [];
  for(var k = 1; k <= Math.min(totalPages, 1 + ahead); k++){ try { queue.push(prepare(k)); } catch(e){ queue.push(Promise.reject(e)); } }
  for(var i = 1; i <= totalPages; i++){
    var done = i - 1, elapsed = (Date.now() - t0) / 1000, eta = done ? Math.round(elapsed / done * (totalPages - done)) : 0;
    setProgress(20 + (i - 1) / totalPages * 77, "Recognising page " + i + " of " + totalPages + (done ? "... about " + (eta >= 90 ? Math.round(eta / 60) + " min" : eta + " s") + " left" : "..."));
    var job = null, pagesDone = outDoc.getPageCount();
    try {
      job = await queue.shift();
      await finish(job);
    } catch(pageErr){
      console.warn("HyperCompress: page " + i + " could not be re-encoded in text mode, copying the original", pageErr);
      while(outDoc.getPageCount() > pagesDone){ try { outDoc.removePage(outDoc.getPageCount() - 1); } catch(e){ break; } }
      try { await copyOriginal(i); } catch(e2){ console.error(e2); }
    }
    if(job && job.page) job.page.cleanup();
    var nxt = i + 1 + ahead;
    if(nxt <= totalPages){ try { queue.push(prepare(nxt)); } catch(e){ queue.push(Promise.reject(e)); } }
    if(i % 25 === 0){ try { await pdf.cleanup(); } catch(e){} }
    await yieldNow();
  }
  await HCT.terminateOcr();
  // Leftover-pixel layers: one shared dictionary, then each page's symbol +
  // rules stream, painted as a mask over the text.
  if(pending.length){
    setProgress(97, "Writing the leftover-pixel layers (" + dict.syms.length + " shapes)...");
    await yieldNow();
    var G = JB.buildGlobals(dict, 1), globalsRef = null;
    if(G.numSyms) globalsRef = outDoc.context.register(PDFLib.PDFRawStream.of(outDoc.context.obj({}), G.globals));
    for(var p = 0; p < pending.length; p++){
      var pd = pending[p], usesSyms = pd.an.quads.length > 0 && G.numSyms > 0;
      var stream = JB.buildPage(pd.outW, pd.outH, pd.an, G);
      drawJbig2(outDoc, pd.page, stream, pd.outW, pd.outH, pd.w, pd.h, usesSyms ? globalsRef : null, true);
      pending[p] = null;
      if(p % 20 === 0) await yieldNow();
    }
  }
  console.info("HyperCompress text mode: " + tot.textPages + " text page(s), " + tot.otherPages + " image page(s), " + tot.accepted + " of " + tot.words + " words verified (rejected: confidence " + tot.rejConf + ", shape " + tot.rejShape + ", digit " + tot.rejDigit + ", punctuation " + tot.rejPunct + ")" + (copied ? ", " + copied + " copied unchanged" : "") + " in " + Math.round((Date.now() - t0) / 1000) + " s");
  setProgress(98, "Assembling PDF...");
  var outBytes = await outDoc.save();
  setProgress(100, "Done!");
  return {
    blob: new Blob([outBytes], { type: "application/pdf" }),
    reachable: true, belowReadable: false, textMode: true, verified: tot,
    level: floorLevel(), target: target, settings: s
  };
}

function showResult(blob, meta){
  meta = meta || {};
  var origSize = state.originalSize;
  var target = meta.target || state.targetBytes || 0;

  // Original already met the target — nothing was compressed.
  if(meta.mode === "under"){
    finishResult(state.file, origSize, {
      title: "Already small enough",
      note: "This PDF is " + fmtSize(origSize) + ", already at or under your target, so the original is kept — there is nothing to compress.",
      reduction: "0% (kept original)",
      keepOriginal: true
    });
    return;
  }

  var compSize = blob.size;
  var pct = Math.round((1 - compSize / origSize) * 100);
  var opts;
  var ni = state.nativeInfo;
  var diag = "Build " + BUILD + " · " + state.pageCount + " pages · scan image " + (ni ? ni.w + "×" + ni.h + " px (" + ni.kind + ")" : "not found") + " · native " + (state.nativeLong || 0) + " px · top " + topPx() + " px"
    + (meta.tone ? " · stored at " + meta.toneLongPx + " px" : (meta.settings ? " · stored at " + meta.settings.longPx + " px" : "")) + (typeof meta.level === "number" ? " · level " + meta.level.toFixed(2) : "") + (meta.passes ? " · passes " + meta.passes : "") + (meta.textMode ? " · text mode" : "") + (meta.tone ? " · tone JPEG q" + meta.toneQ.toFixed(2) + (meta.toneColor ? " colour" : " gray") + " @ " + meta.toneLongPx + " px" : "") + (meta.mrc ? " · background JPEG q" + meta.bgQ.toFixed(2) + (meta.toneColor ? " colour" : " gray") + " @ " + meta.bgPx + " px" : "") + ((meta.allocUp || meta.allocDown) ? " · figures pages up " + meta.allocUp + ", prose pages down " + meta.allocDown : "");

  if(compSize >= origSize){
    // Rasterising this PDF can't beat it even at the most aggressive setting —
    // only happens for a file that is already tiny / pure vector. Keep the
    // original (the genuinely smaller file) and say so plainly.
    var perPage = state.pageCount ? fmtSize(origSize / state.pageCount) : "";
    opts = {
      title: "Already as small as a readable copy can be",
      note: "This PDF is " + fmtSize(origSize) + " for " + state.pageCount + " pages (about " + perPage + " a page) — already smaller than the smallest READABLE re-rendering we can make (" + fmtSize(compSize) + "). "
        + (target ? "Your " + fmtSize(target) + " target would need about " + fmtSize(target / Math.max(1, state.pageCount)) + " a page, which no compressor can do while keeping the text legible. " : "")
        + "The original is kept unchanged.",
      reduction: "0% (kept original)",
      keepOriginal: true
    };
    finishResult(state.file, origSize, opts);
    return;
  }

  var auto = meta.autoLabel;
  if(meta.textMode){
    var v = meta.verified || {}, pctV = v.words ? Math.round(v.accepted / v.words * 100) : 0;
    var how = "Text mode: the page images could not reach this size, so every word that passed verification (" + pctV + "% of " + v.words + " words — OCR confidence, re-rendered shape and a per-digit check) is stored as real, searchable text; everything else — rules, seals, signatures and any unverified word — is kept as the original pixels.";
    opts = compSize <= target
      ? { title: auto ? "Compressed — " + auto + " (text mode)" : "Compressed to your target — text mode", note: "Done — now " + fmtSize(compSize) + " (" + pct + "% smaller)" + (auto ? ". " : ", under your " + fmtSize(target) + " target. ") + how, reduction: pct + "% smaller" }
      : { title: "Smallest readable version — text mode — " + fmtSize(compSize), note: "Even as verified text this PDF is " + fmtSize(compSize) + " (" + pct + "% smaller), above your " + fmtSize(target) + " target — that is the character count of the document itself. " + how, reduction: pct + "% smaller" };
    finishResult(blob, compSize, opts);
    return;
  }
  var softNote = " The resolution was lowered to reach this size, so the text is softer — raise the target a little if you want it crisper.";

  if(compSize <= target && !meta.belowReadable && meta.mrc){
    var fullM = meta.level >= 1 - 1e-6;
    opts = {
      title: fullM ? "Compressed — full quality" : (auto ? "Compressed — " + auto : "Compressed to your target"),
      note: "Done — now " + fmtSize(compSize) + " (" + pct + "% smaller)" + (auto ? ". " : ", under your " + fmtSize(target) + " target. ")
        + "The text is stored crisp in black & white at full resolution, and your target left room to keep the scan’s look underneath it: paper tone, stamps, shading and signatures are kept as a soft " + (meta.toneColor ? "colour" : "grayscale") + " background layer (" + meta.bgPx + " px on its long side, quality " + Math.round(meta.bgQ * 100) + "%)."
        + (fullM ? " That is the sharpest background this rung offers; a much larger target would keep whole pages as photographic JPEG instead." : " A larger target sharpens the background; a smaller one eventually drops it and keeps black & white only."),
      reduction: pct + "% smaller"
    };
  } else if(compSize <= target && !meta.belowReadable && meta.tone){
    var full = meta.level >= 1 - 1e-6, qpct = Math.round(meta.toneQ * 100);
    opts = {
      title: full ? "Compressed — full quality" : (auto ? "Compressed — " + auto : "Compressed to your target"),
      note: "Done — now " + fmtSize(compSize) + " (" + pct + "% smaller)" + (auto ? ". " : ", under your " + fmtSize(target) + " target. ")
        + "Your target left room to keep the scan's own tones: every page is stored as " + (meta.toneColor ? "colour" : "grayscale") + " JPEG at the scan's native resolution (" + meta.toneLongPx + " px on its long side) at quality " + qpct + "%"
        + (full ? " — near-lossless, so a larger target would not change it." : ". A larger target buys a higher JPEG quality; a smaller one eventually switches to crisp 1-bit black & white.")
        + (meta.allocUp ? " Pages with more figures (" + meta.allocUp + ") were given a higher quality than the text pages within the same budget." : ""),
      reduction: pct + "% smaller"
    };
  } else if(compSize <= target && !meta.belowReadable){
    // Well under the target? Say why, so a 3 MB target that yields 1.9 MB is
    // not read as unused budget: at the top level every page is already at
    // the maximum resolution, and a bigger target cannot buy anything more.
    var slack = "";
    if(!auto && target && compSize < target * 0.8){
      if(meta.level >= 1 - 1e-6){
        slack = " This is the full-quality version in black & white — every page is stored at the maximum resolution (" + ((meta.settings && meta.settings.longPx) || topPx()) + " px on its long side).";
        if(meta.toneNeed && meta.toneNeed < origSize) slack += " Keeping the scan’s look (paper tone, stamps, shading under the crisp text) would need a target of about " + fmtSize(meta.toneNeed * 1.08) + " — set that and run again if you prefer it.";
        else slack += " A larger target would not change it.";
      }
      else slack = " The engine ran " + (meta.passes || 1) + " pass" + ((meta.passes || 1) > 1 ? "es" : "") + " to use as much of your target as its size estimate allowed.";
    }
    opts = {
      title: auto ? "Compressed — " + auto : (slack && meta.level >= 1 - 1e-6 ? "Compressed — full quality" : "Compressed to your target"),
      note: "Done — now " + fmtSize(compSize) + " (" + pct + "% smaller)" + (auto ? ", with the text kept sharp." : ", under your " + fmtSize(target) + " target, with the text kept sharp.") + slack
        + (meta.allocUp && meta.level < 1 - 1e-6 ? " Pages with more figures (" + meta.allocUp + ") were rendered at a higher resolution than the text pages within the same budget." : ""),
      reduction: pct + "% smaller"
    };
  } else if(compSize <= target && meta.belowReadable){
    opts = {
      title: auto ? "Compressed — " + auto : "Compressed to your target",
      note: (auto ? "Done — now " + fmtSize(compSize) + " (" + pct + "% smaller)." : "Hit your " + fmtSize(target) + " target (now " + fmtSize(compSize) + ", " + pct + "% smaller).") + softNote,
      reduction: pct + "% smaller"
    };
  } else {
    // Readable floor is still above the target: deliver the smallest READABLE
    // file and say plainly why the number wasn't reached.
    var why = auto
      ? "The " + auto + " preset would have pushed the text past legibility, so we stopped at the readable limit. "
      : "Your " + fmtSize(target) + " target works out to about " + fmtSize(target / Math.max(1, state.pageCount)) + " a page across " + state.pageCount + " pages — below what any compressor can do while the text stays legible. ";
    opts = {
      title: auto ? "Compressed — " + auto + " (readable limit)" : "Smallest readable version — " + fmtSize(compSize),
      note: why + "This is the smallest this PDF can be with every page still readable: " + fmtSize(compSize) + " (" + pct + "% smaller). Use Preview to check it before downloading.",
      reduction: pct + "% smaller"
    };
  }
  opts.diag = diag;
  finishResult(blob, compSize, opts);
}

function finishResult(blob, outSize, opts){
  var origSize = state.originalSize;
  $("#progressWrap").classList.add("hidden");
  $("#resultArea").classList.remove("hidden");

  $("#resultTitle").textContent = opts.title;
  var note = $("#resultNote");
  if(opts.note){ note.textContent = opts.note; note.classList.remove("hidden"); }
  else { note.classList.add("hidden"); }
  var dg = $("#resultDiag");
  if(!dg){ dg = document.createElement("p"); dg.id = "resultDiag"; dg.style.cssText = "font-size:12px;color:#8a8f98;margin:6px 0 0;text-align:center;word-break:break-word"; note.parentNode.insertBefore(dg, note.nextSibling); }
  dg.textContent = opts.diag || ""; dg.classList.toggle("hidden", !opts.diag);

  $("#resultOriginal").textContent = fmtSize(origSize);
  $("#resultCompressed").textContent = fmtSize(outSize);
  $("#resultRatio").textContent = fmtRatio(origSize, outSize);
  $("#resultReduction").textContent = opts.reduction;

  $("#resultBar").style.width = Math.max(2, Math.min(100, (outSize / origSize) * 100)) + "%";

  var btn = $("#downloadBtn");
  var keep = !!opts.keepOriginal;
  btn.textContent = keep ? "⬇ Download original PDF" : "⬇ Download compressed PDF";
  btn.onclick = function(){
    var name = state.file.name.replace(/\.pdf$/i, "") + (keep ? ".pdf" : "_compressed.pdf");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Preview: open the exact file that would be downloaded in a new tab, using
  // the browser's own PDF viewer, so it can be checked before saving.
  if(state.previewUrl){ URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  var pv = $("#previewBtn");
  pv.textContent = keep ? "👁 Preview original" : "👁 Preview";
  pv.onclick = function(){
    if(!state.previewUrl) state.previewUrl = URL.createObjectURL(blob);
    var w = window.open(state.previewUrl, "_blank");
    if(!w) toast("Your browser blocked the preview tab — allow pop-ups for this site and try again", "err");
  };
}

function resetAll(){
  state.file = null;
  state.pdf = null;
  state.pageCount = 0;
  state.originalSize = 0;
  state.compressing = false;
  state.progress = 0;

  $("#uploadArea").classList.remove("hidden");
  $("#fileInfo").classList.add("hidden");
  $("#controls").classList.add("hidden");
  $("#progressWrap").classList.add("hidden");
  $("#resultArea").classList.add("hidden");
  $("#thumbImg").classList.add("hidden");
  $("#thumbImg").src = "";
  $("#compressBtn").disabled = false;
  if(state.previewUrl){ URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  state.targetBytes = 0;
  state.allowGray = false;
  var tgt = $("#targetSize"); if(tgt) tgt.value = "";
  var gray = $("#grayscale"); if(gray) gray.checked = false;
  var hint = $("#targetHint"); if(hint) hint.textContent = "";
}

var _toastTimer;
function toast(msg, cls){
  var el = $("#toast");
  el.textContent = msg;
  el.className = "toast show " + (cls || "");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function(){ el.className = "toast"; }, 4000);
}

// Test hook (same convention as the other dashboards' window.__xbrl / __mca).
window.__hc = { JB: JB, encodePage: encodePage, encodeBackground: encodeBackground, estimateMrc: estimateMrc, encodeTone: encodeTone, estimateTone: estimateTone, toneQuality: toneQuality, nativeLongPx: nativeLongPx, documentTopPx: documentTopPx, floorLevel: floorLevel, topPx: topPx, samplePageList: samplePageList, drawBilevel: drawBilevel, deflateBytes: deflateBytes,
  otsuThreshold: otsuThreshold, levelToSettings: levelToSettings, state: state };

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();
