import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import Tesseract from "tesseract.js";
import sharp from "sharp";

const uploadDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });
const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

// Simple health endpoint
app.get("/", (req, res) => {
  res.json({ ok: true, message: "OCR service is running" });
});

const removeFile = (filePath) => {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // ignore cleanup failures
  }
};

app.post("/solve", upload.single("image"), async (req, res) => {
  let filePath;
  try {
    if (req.file) {
      filePath = req.file.path;
    } else if (req.body?.imageBase64) {
      const base64 = req.body.imageBase64.replace(/^data:.*;base64,/, "");
      const tempName = `${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
      filePath = path.join(uploadDir, tempName);
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    } else {
      return res.status(400).json({ error: "No image provided. Use 'image' field (multipart) or 'imageBase64' (JSON)." });
    }

    // Multi-pass preprocessing: generate several candidate images with different
    // thresholds/resizes and pick the best OCR result.
    const imgBuf = fs.readFileSync(filePath);
    const meta = await sharp(imgBuf).metadata().catch(() => ({}));
    const baseWidth = meta.width || 300;

    const variants = [];
    const thresholds = [120, 140, 160, 180];
    const scales = [1.2, 1.6, 2.0];
    for (const t of thresholds) {
      for (const s of scales) {
        const width = Math.min(Math.round(baseWidth * s), 2000);
        let p = sharp(imgBuf).grayscale().normalise().sharpen();
        p = p.resize({ width }).threshold(t).toFormat('png');
        variants.push({ buf: await p.toBuffer(), desc: `th=${t},s=${s}` });
      }
    }

    // Also try a variant with stronger contrast and slight blur (helps some fonts)
    const v2 = await sharp(imgBuf).grayscale().modulate({ brightness: 1, saturation: 1 }).linear(1.2, -10).blur(0.5).resize({ width: Math.min(baseWidth * 2, 2000) }).threshold(150).toBuffer();
    variants.push({ buf: v2, desc: 'contrast-blur' });

    const tessOptions = { logger: () => {}, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', psm: '7' };

    const candidates = [];
    for (let i = 0; i < variants.length; i++) {
      const p = variants[i];
      const procPath = `${filePath}.proc.${i}.png`;
      fs.writeFileSync(procPath, p.buf);
      try {
        const { data } = await Tesseract.recognize(procPath, 'eng', tessOptions);
        const rawText = (data?.text || '').trim();
        const cleaned = rawText.toUpperCase().replace(/[^A-Z0-9]/g, '');
        // heuristic score: prefer longer cleaned results and penalize empties
        let score = cleaned.length;
        if (score === 0) score = Math.max(0, rawText.replace(/\s+/g, '').length / 4);
        // minor boost for all-alnum
        if (/^[A-Z0-9]+$/.test(cleaned) && cleaned.length > 0) score += 1;
        candidates.push({ i, procPath, desc: p.desc, raw: rawText, cleaned, score });
      } catch (err) {
        // ignore per-variant failures
        candidates.push({ i, procPath, desc: p.desc, raw: '', cleaned: '', score: 0 });
      }
    }

    // choose best candidate by score
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] || { cleaned: '', raw: '' };
    // cleanup original and all processed files
    removeFile(filePath);
    for (const c of candidates) removeFile(c.procPath);

    // apply lightweight post-corrections for common confusions
    function postCorrect(s) {
      if (!s) return s;
      // map common confusions
      const map = { O: '0', I: '1', L: '1', Z: '2', S: '5', B: '8' };
      // if a character is ambiguous and context suggests digit/letter majority, map later
      return s.split('').map(ch => (map[ch] ? map[ch] : ch)).join('');
    }

    const corrected = postCorrect(best.cleaned || best.raw.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const resultText = corrected || (best.raw || '').replace(/\s+/g, ' ').trim();

    return res.json({ text: resultText, raw: best.raw, candidateScore: best.score, tried: candidates.map(c => ({ desc: c.desc, cleaned: c.cleaned, raw: c.raw, score: c.score })) });
  } catch (err) {
    removeFile(filePath);
    console.error("OCR error", err);
    return res.status(500).json({ error: "OCR failed", details: `${err}` });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`OCR service listening on http://localhost:${port}`);
});
