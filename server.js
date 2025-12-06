import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { createWorker } from "tesseract.js";

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
    worker = createWorker({
      langPath: tessDataPath,
      logger: () => {},
    });
    await worker.load();
    await worker.loadLanguage("eng");
    await worker.initialize("eng");
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      user_defined_dpi: "200",
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
  fs.writeFileSync(tempPath, Buffer.from(base64Data, "base64"));

  try {
    // hard timeout guard (20s)
    const ocrPromise = worker.recognize(tempPath, "eng");
    const { data } = await Promise.race([
      ocrPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("OCR timeout")), 20000)),
    ]);
    const raw = (data?.text || "").trim();
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return cleaned || raw;
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
