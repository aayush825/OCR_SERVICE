import fs from 'fs';
import path from 'path';

const files = [
  '226md.png',
  '2356g.png',
  '25egp.png',
  '2bg48.png',
  '2fxgd.png',
  'images.png',
  'test.png'
];

async function postBase64(filePath) {
  const abs = path.resolve(filePath);
  const b64 = fs.readFileSync(abs).toString('base64');
  const body = JSON.stringify({ imageBase64: b64 });
  try {
    const res = await fetch('http://localhost:3000/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const json = await res.json();
    console.log(filePath, '=>', JSON.stringify(json));
  } catch (err) {
    console.error('Error posting', filePath, err);
  }
}

(async () => {
  for (const f of files) {
    const p = path.join(process.cwd(), 'uploads', f);
    if (fs.existsSync(p)) {
      // small delay between requests
      await postBase64(p);
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.log('missing', p);
    }
  }
})();
