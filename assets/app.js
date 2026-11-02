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
var BUILD = "v9"; // shown in the footer; keep in step with the ?v= cache-buster in index.html

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
// the ceiling (level 1) is near-lossless. Below READABLE_FLOOR_LEVEL the text
// starts to soften, so we flag it but still deliver the size the user asked for.
// A level maps to the longest-side PIXEL size each page is rendered at, plus a
// JPEG quality. Capping pixels (rather than DPI) bounds the output regardless
// of the PDF's page geometry — a scanned PDF with a huge page box no longer
// renders a giant image. LONG_MIN is tiny (aggressive) but still legible-ish;
// LONG_MAX is crisp. Below READABLE_FLOOR_LEVEL the text starts to soften.
// Text pages are stored as 1-bit black & white (see encodePage), so the only
// size lever for them is RESOLUTION — a 1-bit page is razor sharp at any size,
// it just carries less detail as the pixel count drops. The level scalar maps
// to the longest-side pixel size. Photographic pages fall back to JPEG, whose
// quality is tied to the same level but never allowed to go destructive.
var LONG_MIN = 450, LONG_MAX = 2400;
var READABLE_PX = 1050;  // ~90 DPI on A4 — below this, small 1-bit text starts to break up
var READABLE_FLOOR_LEVEL = (READABLE_PX - LONG_MIN) / (LONG_MAX - LONG_MIN);

function levelToSettings(level){
  level = Math.max(0, Math.min(1, level));
  return {
    longPx: Math.round(LONG_MIN + level * (LONG_MAX - LONG_MIN)),
    quality: 0.45 + level * 0.45,   // photo pages only: 0.45 -> 0.90
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
    msg += " We'll compress it to that size. If the target is so small the text would blur, we'll get as close as we can and tell you.";
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

function setProgress(pct, label){
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
  var scale = Math.min(longPx / longPt, 2);
  var vp = page.getViewport({ scale: scale });
  var canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  var ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas: canvas, ctx: ctx, w: canvas.width, h: canvas.height };
}

// Encode one page: 1-bit deflate for text, JPEG for photographic pages.
// Returns { kind, data, bytes, width?, height? }.
async function encodePage(page, s){
  var r = await renderPage(page, s.longPx);
  var w = r.w, h = r.h, n = w * h;
  var img = r.ctx.getImageData(0, 0, w, h), d = img.data;
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

  if(isPhoto || !HAS_DEFLATE){
    if(s.grayscale){
      for(var j = 0, pp = 0; j < n; j++, pp += 4){ d[pp] = d[pp + 1] = d[pp + 2] = lum[j]; }
      r.ctx.putImageData(img, 0, 0);
    }
    var blob = await new Promise(function(res){ r.canvas.toBlob(function(b){ res(b); }, "image/jpeg", s.quality); });
    r.canvas.width = 1; r.canvas.height = 1;
    var jp = new Uint8Array(await blob.arrayBuffer());
    return { kind: "jpeg", data: jp, bytes: jp.length, thr: thr, ink: ink / n };
  }

  // Pack to 1 bit per pixel, rows padded to a byte; 1 = white, 0 = ink.
  var rowBytes = (w + 7) >> 3, packed = new Uint8Array(rowBytes * h);
  for(var y = 0; y < h; y++){
    var ro = y * rowBytes, lo = y * w;
    for(var x = 0; x < w; x++){
      if(lum[lo + x] > thr) packed[ro + (x >> 3)] |= (0x80 >> (x & 7));
    }
  }
  r.canvas.width = 1; r.canvas.height = 1;
  var def = await deflateBytes(packed);
  return { kind: "bilevel", data: def, width: w, height: h, bytes: def.length, thr: thr, ink: ink / n };
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

// Spread of sample pages used to estimate the whole-document size cheaply.
function samplePageList(){
  var n = state.pageCount;
  var count = Math.min(n, 5);
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
async function estimateTotal(level, samples){
  var s = levelToSettings(level);
  var sum = 0;
  for(var k = 0; k < samples.length; k++){
    var page = await state.pdf.getPage(samples[k]);
    sum += (await encodePage(page, s)).bytes;
    page.cleanup();
  }
  var avg = sum / samples.length;
  // Image payload dominates; add ~3% PDF structural overhead + a small base.
  return Math.round(avg * state.pageCount * 1.03 + 1500 + state.pageCount * 40);
}

// Binary-search the highest (best-quality) level whose estimated size fits the
// target. If even the most aggressive floor can't reach the target, we still
// return the floor (the smallest we can make it) rather than giving up.
async function findLevel(target){
  var samples = samplePageList();
  var aim = target * 0.95; // margin so the real pass rarely overshoots

  setProgress(5, "Analysing the document...");
  var estFloor = await estimateTotal(0, samples);
  if(estFloor > target){
    // Target is below even our most compressed rendering — deliver the floor.
    return { level: 0, reachable: false, belowReadable: true };
  }
  setProgress(12, "Finding the best quality for your target...");
  var estTop = await estimateTotal(1, samples);
  if(estTop <= aim){
    return { level: 1, reachable: true, belowReadable: false };
  }

  var lo = 0, hi = 1, best = 0;
  for(var it = 0; it < 7; it++){
    var mid = (lo + hi) / 2;
    setProgress(14 + it * 3, "Finding the best quality for your target...");
    var est = await estimateTotal(mid, samples);
    if(est <= aim){ best = mid; lo = mid; } else { hi = mid; }
  }
  return { level: best, reachable: true, belowReadable: best < READABLE_FLOOR_LEVEL };
}

async function compressToTarget(target){
  var search = await findLevel(target);
  var s = levelToSettings(search.level);
  var pdf = state.pdf;
  var totalPages = pdf.numPages;
  var outDoc = await PDFLib.PDFDocument.create();
  var srcDoc = null, copied = 0;

  for(var i = 1; i <= totalPages; i++){
    setProgress(35 + (i - 1) / totalPages * 60, "Compressing page " + i + " of " + totalPages + "...");
    var page = null;
    try {
      page = await pdf.getPage(i);
      var enc = await encodePage(page, s);
      var origVP = page.getViewport({ scale: 1 });
      var outPage = outDoc.addPage([origVP.width, origVP.height]);
      if(enc.kind === "bilevel"){
        drawBilevel(outDoc, outPage, enc, origVP.width, origVP.height);
      } else {
        var img = await outDoc.embedJpg(enc.data);
        outPage.drawImage(img, { x: 0, y: 0, width: origVP.width, height: origVP.height });
      }
    } catch(pageErr){
      // One page the renderer can't handle must not sink a 700-page run:
      // carry that page over from the original file untouched instead.
      console.warn("HyperCompress: page " + i + " could not be re-encoded, copying the original", pageErr);
      if(!srcDoc){
        srcDoc = await PDFLib.PDFDocument.load(new Uint8Array(await state.file.arrayBuffer()), { ignoreEncryption: true, updateMetadata: false });
      }
      var cp = await outDoc.copyPages(srcDoc, [i - 1]);
      outDoc.addPage(cp[0]);
      copied++;
    }
    // pdf.js caches every decoded image it has drawn (a scanned page's
    // background alone is ~9 MB decoded). Across hundreds of pages that
    // exhausts memory and the run dies with "Compression failed", so release
    // each page's decoded resources as soon as it has been encoded.
    if(page) page.cleanup();
    if(i % 50 === 0){ try { await pdf.cleanup(); } catch(e){} }
    if(i % 5 === 0){ await new Promise(function(r){ setTimeout(r, 0); }); }
  }
  if(copied) console.warn("HyperCompress: " + copied + " page(s) were copied from the original unchanged.");

  setProgress(97, "Assembling PDF...");
  var outBytes = await outDoc.save();
  setProgress(100, "Done!");

  return {
    blob: new Blob([outBytes], { type: "application/pdf" }),
    reachable: search.reachable,
    belowReadable: search.belowReadable,
    level: search.level,
    target: target,
    settings: s
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

  if(compSize >= origSize){
    // Rasterising this PDF can't beat it even at the most aggressive setting —
    // only happens for a file that is already tiny / pure vector. Keep the
    // original (the genuinely smaller file) and say so plainly.
    opts = {
      title: "Can't shrink this one further",
      note: "This PDF is already so compact that re-rendering it would only make it larger, so the original is kept. It's already near the limit for a readable document.",
      reduction: "0% (kept original)",
      keepOriginal: true
    };
    finishResult(state.file, origSize, opts);
    return;
  }

  var auto = meta.autoLabel;
  var softNote = " The resolution was lowered to reach this size, so the text is softer — raise the target a little if you want it crisper.";

  if(compSize <= target && !meta.belowReadable){
    opts = {
      title: auto ? "Compressed — " + auto : "Compressed to your target",
      note: "Done — now " + fmtSize(compSize) + " (" + pct + "% smaller)" + (auto ? ", with the text kept sharp." : ", under your " + fmtSize(target) + " target, with the text kept sharp."),
      reduction: pct + "% smaller"
    };
  } else if(compSize <= target && meta.belowReadable){
    opts = {
      title: auto ? "Compressed — " + auto : "Compressed to your target",
      note: (auto ? "Done — now " + fmtSize(compSize) + " (" + pct + "% smaller)." : "Hit your " + fmtSize(target) + " target (now " + fmtSize(compSize) + ", " + pct + "% smaller).") + softNote,
      reduction: pct + "% smaller"
    };
  } else {
    // Floor still above target: the smallest we can make it.
    opts = {
      title: "Compressed as far as it'll go",
      note: "This is the smallest we can make this PDF: " + fmtSize(compSize) + " (" + pct + "% smaller). Going smaller would turn the pages into unreadable smudges, so we stopped here.",
      reduction: pct + "% smaller"
    };
  }
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
window.__hc = { encodePage: encodePage, drawBilevel: drawBilevel, deflateBytes: deflateBytes,
  otsuThreshold: otsuThreshold, levelToSettings: levelToSettings, state: state };

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();
