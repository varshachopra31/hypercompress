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
var LONG_MIN = 150, LONG_MAX = 2100, Q_MIN = 0.06, Q_MAX = 0.92;
var READABLE_FLOOR_LEVEL = 0.31; // ~755px long side / quality 0.33 — below this, text softens

function levelToSettings(level){
  level = Math.max(0, Math.min(1, level));
  return {
    longPx: Math.round(LONG_MIN + level * (LONG_MAX - LONG_MIN)),
    quality: Q_MIN + level * (Q_MAX - Q_MIN),
    // Grayscale when the user opts in, or automatically in the aggressive zone
    // where it roughly halves the size while text stays perfectly readable.
    grayscale: !!state.allowGray || level < READABLE_FLOOR_LEVEL
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
    toast("Compression failed: " + err.message, "err");
    setProgress(0, "Failed");
  });
}

function setProgress(pct, label){
  state.progress = pct;
  $("#progressBar").style.width = pct + "%";
  $("#progressLabel").textContent = label || (Math.round(pct) + "%");
}

// Contrast-stretch the canvas so near-white backgrounds go pure white and text
// darkens — keeps text edges crisp at low resolution and lets JPEG compress the
// flat background almost for free. Makes scanned text far more readable per byte.
function enhanceForText(ctx, w, h){
  try {
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data, lo = 48, hi = 208, range = hi - lo;
    for(var i = 0; i < d.length; i += 4){
      for(var c = 0; c < 3; c++){
        var v = (d[i + c] - lo) / range * 255;
        d[i + c] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }
    ctx.putImageData(img, 0, 0);
  } catch(e){ /* tainted canvas etc. — skip, not fatal */ }
}

// Render one page to a JPEG byte array, with the longest side capped at
// s.longPx pixels (never upscaling a small page by more than 2x).
async function renderPageJpeg(page, s){
  var base = page.getViewport({ scale: 1 });
  var longPt = Math.max(base.width, base.height) || 1;
  var scale = Math.min(s.longPx / longPt, 2);
  var vp = page.getViewport({ scale: scale });
  var canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  var ctx = canvas.getContext("2d");
  if(s.grayscale) ctx.filter = "grayscale(100%)";
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  ctx.filter = "none";
  enhanceForText(ctx, canvas.width, canvas.height);
  var blob = await new Promise(function(res){ canvas.toBlob(function(b){ res(b); }, "image/jpeg", s.quality); });
  canvas.width = 1; canvas.height = 1;
  return new Uint8Array(await blob.arrayBuffer());
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
    var jpeg = await renderPageJpeg(page, s);
    sum += jpeg.length;
  }
  var avg = sum / samples.length;
  // JPEG payload dominates; add ~3% PDF structural overhead + a small base.
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

  for(var i = 1; i <= totalPages; i++){
    setProgress(35 + (i - 1) / totalPages * 60, "Compressing page " + i + " of " + totalPages + "...");
    var page = await pdf.getPage(i);
    var jpeg = await renderPageJpeg(page, s);
    var img = await outDoc.embedJpg(jpeg);
    var origVP = page.getViewport({ scale: 1 });
    outDoc.addPage([origVP.width, origVP.height]).drawImage(img, {
      x: 0, y: 0, width: origVP.width, height: origVP.height
    });
    if(i % 5 === 0){ await new Promise(function(r){ setTimeout(r, 0); }); }
  }

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

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();
