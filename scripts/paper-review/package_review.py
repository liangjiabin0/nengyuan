#!/usr/bin/env python3
"""论文智能评审最终打包（包装 v8 package_batch_reviews.py 的目录约定，并补齐复现资产）。

v8 原版只收集 Word/Markdown、原文、两页 PPT 和文献，不收集复现代码与数据。
本脚本保持 v8 约定的“恰好两个一级目录”（原文/、审稿意见/），并在每篇论文目录下加入：
review.json、README.md、Reproduction/（脚本、数据或获取方式、输出、日志、校验）、
Two-Slide PPT/ 配套工件、manifest.json（逐文件 sha256 与质量门禁结果）。

用法：python package_review.py --manifest <package-input.json> --output <final.zip> [--draft]
--draft：门禁未全部通过时打“部分成果草稿包”，文件名与 manifest 都会标注 DRAFT/不完整。
"""
from __future__ import annotations
import argparse, csv, hashlib, json, re, shutil, tempfile, zipfile
from pathlib import Path

ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
DOWNLOADED = {"downloaded_publisher_oa", "downloaded_preprint", "downloaded_repository"}
UNAVAILABLE = {"paywalled", "no_public_pdf_found", "download_failed", "not_assessable"}
# 不进入交付包的文件：缓存、密钥、虚拟环境、临时文件
EXCLUDE = re.compile(r'(^|/)(__pycache__|\.venv|venv|node_modules|\.git)(/|$)|\.(pyc|tmp|log\.tmp)$|(^|/)\.env|secret|credential', re.I)
MAX_FILE_BYTES = 200 * 1024 * 1024


def safe(s, limit=150):
    return re.sub(r'\s+', ' ', ILLEGAL.sub('_', str(s))).strip().rstrip('.')[:limit] or 'untitled'


def sha(p: Path):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def is_pdf(p: Path):
    return p.is_file() and p.stat().st_size > 4 and p.open('rb').read(5) == b'%PDF-'


def two_slide_pptx(p: Path):
    try:
        with zipfile.ZipFile(p) as z:
            names = z.namelist()
            slides = [n for n in names if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)]
            return '[Content_Types].xml' in names and 'ppt/presentation.xml' in names and len(slides) == 2
    except zipfile.BadZipFile:
        return False


def copy_tree(src: Path, dst: Path, private_roots: list[str]):
    """复制目录，跳过缓存/密钥；文本文件里的私有绝对路径替换为 <workspace>。"""
    copied = []
    for p in sorted(src.rglob('*')):
        rel = p.relative_to(src).as_posix()
        if p.is_dir() or EXCLUDE.search(rel) or p.is_symlink():
            continue
        if p.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f'文件过大，无法打包：{rel}')
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if p.suffix.lower() in {'.json', '.md', '.txt', '.csv', '.py', '.yaml', '.yml', '.log'}:
            text = p.read_text(encoding='utf-8', errors='replace')
            for root in private_roots:
                if root:
                    text = text.replace(root, '<workspace>').replace(root.replace('\\', '/'), '<workspace>').replace(root.replace('\\', '\\\\'), '<workspace>')
            target.write_text(text, encoding='utf-8')
        else:
            shutil.copy2(p, target)
        copied.append(target)
    return copied


def write_literature(item, lit: Path):
    rows = []
    for i, w in enumerate((item.get('literature') or [])[:3], 1):
        st = w.get('acquisition_status', '')
        if st in DOWNLOADED and w.get('local_pdf_path') and is_pdf(Path(w['local_pdf_path'])):
            shutil.copy2(w['local_pdf_path'], lit / f"{i:02d}_{safe(w.get('title', ''), 140)}.pdf")
        else:
            rows.append({'No.': i, 'Title': w.get('title', ''), 'Authors': w.get('authors', ''), 'Year': w.get('year', ''),
                         'Venue/Source': w.get('journal') or w.get('source', ''), 'DOI': w.get('doi', ''),
                         'Landing URL': w.get('landing_url', ''), 'Access status': st if st in UNAVAILABLE else 'download_failed',
                         'Reason not downloaded': w.get('access_note', ''), 'Suggested access route': w.get('suggested_access_route', '通过 DOI 或所在机构图书馆获取'),
                         'Checked date': w.get('checked_date', '')})
    if rows:
        fields = list(rows[0].keys())
        with (lit / '无法下载文献清单.csv').open('w', encoding='utf-8-sig', newline='') as f:
            wr = csv.DictWriter(f, fieldnames=fields)
            wr.writeheader()
            wr.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True, type=Path)
    ap.add_argument('--output', required=True, type=Path)
    ap.add_argument('--draft', action='store_true')
    a = ap.parse_args()
    m = json.loads(a.manifest.read_text(encoding='utf-8-sig'))
    gates = m.get('gates', {})
    failed = [k for k, v in gates.items() if not v.get('passed')]
    if failed and not a.draft:
        raise SystemExit(f'质量门禁未通过，不能生成完整成果包：{", ".join(failed)}（如需导出，使用 --draft）')
    private_roots = [str(Path(r)) for r in m.get('private_roots', [])]
    with tempfile.TemporaryDirectory(prefix='paper-review-pkg-') as td:
        root = Path(td)
        od, rd = root / '原文', root / '审稿意见'
        od.mkdir(); rd.mkdir()
        for item in m['papers']:
            title = safe(item['paper_title'])
            src = Path(item['source_path'])
            if not src.is_file():
                raise FileNotFoundError(src)
            shutil.copy2(src, od / f'{title}{src.suffix.lower()}')
            pr = rd / f'{title}审稿意见'
            pr.mkdir(parents=True)
            lang = item.get('manuscript_language', 'zh')
            if lang == 'en':
                shutil.copy2(item['review_path_en'], pr / f'{title}_Review_English.docx')
                shutil.copy2(item['review_path_zh'], pr / f'{title}审稿意见_中文.docx')
            else:
                shutil.copy2(item['review_path_zh'], pr / f'{title}审稿意见.docx')
            shutil.copy2(item['review_json_path'], pr / 'review.json')
            for md in item.get('review_md_paths', []):
                if Path(md).is_file():
                    shutil.copy2(md, pr / Path(md).name)
            (pr / 'README.md').write_text(item.get('readme', ''), encoding='utf-8')
            if item.get('reproduction_dir') and Path(item['reproduction_dir']).is_dir():
                copy_tree(Path(item['reproduction_dir']), pr / 'Reproduction', private_roots)
            lit = pr / 'Latest Relevant Literature'
            lit.mkdir()
            write_literature(item, lit)
            pptdir = pr / 'Two-Slide PPT'
            pptdir.mkdir()
            if item.get('pptx_path'):
                ppt = Path(item['pptx_path'])
                if not two_slide_pptx(ppt):
                    raise ValueError(f'PPTX 不存在或不是恰好两页：{ppt}')
                shutil.copy2(ppt, pptdir / f'{title}_Two-Slide_Review.pptx')
                for extra in item.get('ppt_artifacts', []):
                    p = Path(extra)
                    if p.is_file():
                        target = pptdir / 'build' / p.name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        text_like = p.suffix.lower() in {'.json', '.md', '.svg'}
                        if text_like:
                            t = p.read_text(encoding='utf-8', errors='replace')
                            for r in private_roots:
                                t = t.replace(r, '<workspace>').replace(r.replace('\\', '/'), '<workspace>').replace(r.replace('\\', '\\\\'), '<workspace>')
                            target.write_text(t, encoding='utf-8')
                        else:
                            shutil.copy2(p, target)
            files = []
            for p in sorted(pr.rglob('*')):
                if p.is_file():
                    files.append({'path': p.relative_to(root).as_posix(), 'sha256': sha(p), 'bytes': p.stat().st_size})
            for p in sorted(od.glob('*')):
                files.append({'path': p.relative_to(root).as_posix(), 'sha256': sha(p), 'bytes': p.stat().st_size})
            manifest = {
                'complete': not failed,
                'status': 'complete' if not failed else 'draft_incomplete',
                'missing_or_failed_gates': failed,
                'gates': gates,
                'stages': item.get('stages', {}),
                'skills': m.get('skills', {}),
                'model_usage_summary': m.get('model_usage_summary', {}),
                'files': files
            }
            (pr / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        out = a.output
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp_zip = out.with_suffix('.zip.tmp')
        with zipfile.ZipFile(tmp_zip, 'w', zipfile.ZIP_DEFLATED) as z:
            for base in (od, rd):
                z.writestr(base.name + '/', '')
                for p in sorted(base.rglob('*')):
                    arc = p.relative_to(root).as_posix()
                    if p.is_dir():
                        z.writestr(arc.rstrip('/') + '/', '')
                    else:
                        z.write(p, arc)
        # 重新打开校验：完整性、恰好两个一级目录、无路径穿越、PPT 位置、逐文件 hash
        with zipfile.ZipFile(tmp_zip) as z:
            bad = z.testzip()
            if bad:
                raise RuntimeError(f'ZIP 完整性校验失败：{bad}')
            names = z.namelist()
            top = {n.split('/', 1)[0] for n in names if n}
            if top != {'原文', '审稿意见'}:
                raise RuntimeError(f'一级目录必须恰好是 原文/ 与 审稿意见/：{sorted(top)}')
            for n in names:
                if n.startswith('/') or '..' in n.split('/') or re.match(r'^[A-Za-z]:', n):
                    raise RuntimeError(f'ZIP 内有非法路径：{n}')
                if n.endswith('.pptx') and '/Two-Slide PPT/' not in n:
                    raise RuntimeError(f'PPTX 必须在 Two-Slide PPT/ 下：{n}')
            with tempfile.TemporaryDirectory(prefix='paper-review-verify-') as vd:
                z.extractall(vd)
                for item_dir in (Path(vd) / '审稿意见').iterdir():
                    man = json.loads((item_dir / 'manifest.json').read_text(encoding='utf-8'))
                    for f in man['files']:
                        p = Path(vd) / f['path']
                        if not p.is_file() or sha(p) != f['sha256']:
                            raise RuntimeError(f'解压后 hash 不一致：{f["path"]}')
        tmp_zip.replace(out)
    print(json.dumps({'output': str(out), 'complete': not failed, 'failedGates': failed}, ensure_ascii=False))


if __name__ == '__main__':
    main()
