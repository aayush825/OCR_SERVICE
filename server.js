import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import * as Tesseract from "tesseract.js";

// Direct tessdata to the bundled eng.traineddata to avoid slow downloads on Azure.
const tessDataPath = process.cwd();
process.env.TESSDATA_PREFIX = tessDataPath;

const uploadDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// Minimal request log to debug 502s and routing issues.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Single shared Tesseract worker
let worker;
let workerReady = false;
let workerInitError = null;

async function initWorker() {
  try {
    const createWorker = Tesseract.createWorker || (Tesseract.default && Tesseract.default.createWorker);
    if (!createWorker) {
      throw new Error("createWorker is not available in tesseract.js import (check CommonJS/ESM interop)");
    }
    // createWorker returns a Promise that resolves to the worker object in this
    // tesseract.js version. Await it so we get the actual worker with methods.
    worker = await createWorker({
      langPath: tessDataPath,
      logger: () => {},
    });
    console.log("createWorker resolved, initializing worker methods...");
    if (typeof worker.load === 'function') await worker.load();
    if (typeof worker.loadLanguage === 'function') await worker.loadLanguage("eng");
    if (typeof worker.initialize === 'function') await worker.initialize("eng");
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      user_defined_dpi: "200",
      tessedit_pageseg_mode: "7",
    });
    workerReady = true;
    console.log("Tesseract worker initialized");
  } catch (err) {
    console.error("Worker init error", err);
    workerInitError = err;
  }
}

initWorker();

// Simple health endpoint
app.get("/", (_req, res) => {
  res.json({ ok: true, workerReady, workerInitError: workerInitError ? String(workerInitError) : null });
});

async function recognize(base64Data) {
  // wait briefly for worker to be ready on cold start
  const start = Date.now();
  while (!workerReady && !workerInitError && Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!workerReady) {
    throw workerInitError || new Error("OCR worker not ready");
  }

  const tempName = `${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  const tempPath = path.join(uploadDir, tempName);
  // quick two-variant preprocessing: normal + stronger-threshold variant
  const inputBuf = Buffer.from(base64Data, "base64");
  const sharpModule = (await import('sharp')).default;
  const meta = await sharpModule(inputBuf).metadata().catch(() => ({}));
  const targetWidth = Math.min(Math.max(meta.width || 300, 300) * 2, 1200);
  const variantPaths = [];
  try {
    // Variant A: moderate threshold
    const aBuf = await sharpModule(inputBuf)
      .grayscale()
      .normalise()
      .resize({ width: Math.round(targetWidth) })
      .sharpen()
      .threshold(150)
      .toFormat('png')
      .toBuffer();
    const pathA = tempPath + '.a.png';
    fs.writeFileSync(pathA, aBuf);
    variantPaths.push(pathA);

    // Variant B: stronger threshold and contrast
    const bBuf = await sharpModule(inputBuf)
      .grayscale()
      .linear(1.2, -10)
      .resize({ width: Math.round(Math.min(targetWidth * 1.1, 1400)) })
      .sharpen()
      .threshold(180)
      .toFormat('png')
      .toBuffer();
    const pathB = tempPath + '.b.png';
    fs.writeFileSync(pathB, bBuf);
    variantPaths.push(pathB);
  } catch (e) {
    // fallback: write original
    fs.writeFileSync(tempPath, inputBuf);
    variantPaths.push(tempPath);
  }

  try {
    // Try each variant sequentially (quick); choose best cleaned result
    const results = [];
    const perAttemptTimeout = 10000; // 10s per variant max
    for (const vpath of variantPaths) {
      try {
        const ocrPromise = worker.recognize(vpath, "eng");
        const { data } = await Promise.race([
          ocrPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error("OCR timeout")), perAttemptTimeout)),
        ]);
        const raw = (data?.text || "").trim();
        const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
        results.push({ raw, cleaned });
      } catch (e) {
        results.push({ raw: '', cleaned: '' });
      }
    }

    // pick best by cleaned length and alphanumeric quality
    results.sort((a, b) => (b.cleaned.length - a.cleaned.length) || (b.raw.length - a.raw.length));
    let final = results[0]?.cleaned || results[0]?.raw || '';
    // conservative post-corrections for common OCR confusions
    function postCorrect(s) {
      if (!s) return s;
      const map = { O: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
      return s.split('').map(ch => (map[ch] ? map[ch] : ch)).join('');
    }
    final = postCorrect(final.toUpperCase());
    // prefer reasonable-length tokens (3-8 chars). If final looks garbage (too long
    // or empty), try to extract a plausible token from the raw results.
    if (!final || final.length < 3 || final.length > 8) {
      for (const r of results) {
        const raw = (r.raw || '').toUpperCase();
        const m = raw.match(/[A-Z0-9]{3,8}/);
        if (m) {
          const cand = postCorrect(m[0]);
          if (cand && cand.length >= 3) {
            final = cand;
            break;
          }
        }
      }
    }
    // final safety: trim to max 8 chars
    if (final && final.length > 8) final = final.slice(0, 8);
    return final || '';
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_) {
      // ignore cleanup failures
    }
  }
}

app.post("/solve", async (req, res) => {
  try {
    const { captcha, imageBase64 } = req.body || {};
    const payload = captcha || imageBase64;
    if (!payload) {
      return res.status(400).json({ error: "Provide JSON { captcha: base64DataUrl }" });
    }
    const base64 = payload.replace(/^data:.*;base64,/, "");
    const result = await recognize(base64);
    return res.json({ solution: result });
  } catch (err) {
    console.error("OCR error", err);
    return res.status(500).json({ error: "OCR failed", details: String(err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`OCR service listening on http://localhost:${port}`);
});
