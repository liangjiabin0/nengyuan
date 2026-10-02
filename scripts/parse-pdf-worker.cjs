/**
 * Forked process: SHA1 + pdf2md (PyMuPDF/OCR) with pdf-parse fallback.
 * Messages: { id, pdfPath } → { id, ok, text?, numpages?, info?, hash?, error? }
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function sha1File(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function pdf2mdPython() {
  if (process.env.PDF2MD_PYTHON) return process.env.PDF2MD_PYTHON;
  const root = process.cwd();
  const win = path.join(root, 'tools', 'pdf2md-venv', 'Scripts', 'python.exe');
  const nix = path.join(root, 'tools', 'pdf2md-venv', 'bin', 'python');
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(nix)) return nix;
  return '';
}

function tryPdf2md(pdfPath, hash) {
  if (process.env.SKIP_PDF2MD === '1') return null;
  const python = pdf2mdPython();
  const script = path.join(process.cwd(), 'tools', 'pdf2md', 'pdf_to_md.py');
  if (!python || !fs.existsSync(script)) return null;
  const dir = path.join(process.cwd(), 'storage', 'convert-work', 'md');
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${hash}.md`);
  const metaPath = path.join(dir, `${hash}.json`);
  if (process.env.FORCE_PDF2MD !== '1' && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (String(meta.text || '').trim().length >= 40) {
        return {
          text: meta.text,
          numpages: Number(meta.numpages || 0),
          info: { Title: meta.title || '', extractor: meta.extractor || 'pymupdf' }
        };
      }
    } catch {
      // reconvert
    }
  }
  execFileSync(python, [script, '--input', pdfPath, '--output', mdPath, '--meta', metaPath, '--ocr', process.env.PDF2MD_OCR || 'auto'], {
    windowsHide: true,
    timeout: Number(process.env.PDF2MD_TIMEOUT_MS || 120 * 60 * 1000),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  return {
    text: meta.text || '',
    numpages: Number(meta.numpages || 0),
    info: { Title: meta.title || '', extractor: meta.extractor || 'pymupdf' }
  };
}

process.on('message', async (msg) => {
  const id = msg?.id;
  const pdfPath = msg?.pdfPath;
  if (id == null || !pdfPath) {
    process.send?.({ id, ok: false, error: 'invalid worker message' });
    return;
  }
  try {
    const hash = sha1File(pdfPath);
    try {
      const robust = tryPdf2md(pdfPath, hash);
      if (robust && String(robust.text || '').trim().length >= 40) {
        process.send?.({
          id,
          ok: true,
          text: robust.text,
          numpages: robust.numpages,
          info: robust.info,
          hash
        });
        return;
      }
    } catch (error) {
      process.stderr.write(`pdf2md worker fallback: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    const data = fs.readFileSync(pdfPath);
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data });
    try {
      const textResult = await parser.getText();
      const infoResult = await parser.getInfo().catch(() => null);
      process.send?.({
        id,
        ok: true,
        text: textResult?.text || '',
        numpages: Number(textResult?.total || infoResult?.total || 0),
        info: infoResult?.info || {},
        hash
      });
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch (error) {
    process.send?.({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
