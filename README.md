OCR Service

Small Node.js OCR service using tesseract.js and sharp preprocessing.

Usage
1. Install dependencies: `npm install`
2. Start: `node server.js`
3. Health: `GET /`
4. OCR: `POST /solve` (multipart form field `image` or JSON `{ "imageBase64": "..." }`)

Deploy to Render
- Push repo to GitHub
- Create a new Web Service on Render, connect GitHub, set Build Command `npm install` and Start Command `npm start`.

Notes
- `.gitignore` excludes `node_modules/` and `uploads/`.
- If `sharp` build fails on Render, check build logs for `libvips` errors.
