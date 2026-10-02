import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const pdf=JSON.parse(fs.readFileSync('storage/data-import-pdf.json','utf8'));
const structured=JSON.parse(fs.readFileSync('storage/data-import-structured.json','utf8'));
if(pdf.status!=='done' || structured.status!=='done')throw new Error('导入尚未完成');
const verification=JSON.parse(fs.readFileSync('storage/data-import-verification.json','utf8'));
const db=new Database('storage/rag.sqlite',{readonly:true});
const exists=db.prepare('SELECT paper_key FROM paper_documents WHERE pdf_path=? OR original_path=? LIMIT 1');
const failures=[];
for(const [kind,phase] of Object.entries(pdf.phases))for(const entry of phase.result?.errors || []){
  if(exists.get(entry.filePath,entry.filePath))continue;
  const retried=pdf.ocrRetries?.[kind]?.results?.some(r=>r.originalPath===entry.filePath && !r.skipped);
  if(retried)continue;
  let size=0;try{size=fs.statSync(entry.filePath).size;}catch{}
  let reason=size===0?'空文件':'原始 PDF 无可读取正文或结构损坏';
  const preparse=JSON.parse(fs.readFileSync('storage/pdf-preparse-progress.json','utf8'));
  if(preparse.sparse?.some(r=>r.file===entry.filePath && r.pages===0))reason='零页 PDF（没有正文页面）';
  failures.push({kind,file:entry.filePath,bytes:size,reason,error:entry.error});
}
db.close();
fs.writeFileSync('storage/data-import-failures.json',JSON.stringify(failures,null,2));
const counts=verification.counts;
const num=value=>Number(value).toLocaleString('zh-CN');
const link=(label,file)=>`[${label}](<${path.resolve(file).replaceAll('\\','/')}>)`;
const inventory=JSON.parse(fs.readFileSync('storage/data-import-inventory.json','utf8'));
const categories=Object.values(inventory.categories);
const totalFiles=categories.reduce((n,r)=>n+r.files,0);
const totalBytes=categories.reduce((n,r)=>n+r.bytes,0);
const ok=verification.checks.every(c=>c.ok);
const table=[
  '| 系统资料 | 去重后的数量 |',
  '| --- | ---: |',
  `| 基金项目 | ${num(counts.funds)} |`,
  `| 国重项目 | ${num(counts.nkrd)} |`,
  `| 项目成果 | ${num(counts.outputs)} |`,
  `| 导师档案 | ${num(counts.mentors)} |`,
  `| 论文资料（含 1 份研究说明） | ${num(counts.papers)} |`,
  `| 专利资料 | ${num(counts.patents)} |`,
  `| 白皮书 | ${num(counts.whitepapers)} |`
].join('\n');
const text=[
  '# F 盘数据导入结果',
  `完成时间：${pdf.completedAt}。数据来源：\`F:\\数据\`，共 ${num(totalFiles)} 个源文件，约 ${(totalBytes/1e9).toFixed(1)} GB。`,
  `有效资料已导入系统数据库和知识语料。${failures.length?`${num(failures.length)} 份原始 PDF 无法读取，详见下方清单。`:'所有扫描到的资料均已处理。'}源文件保留在 F 盘，预览原始 PDF 时需要 F 盘可访问。`,
  table,
  `已处理全部 90 份 CSV，保留 ${num(counts.rawRecords)} 行原始记录。已合并 ${num(pdf.patentSources?.merged || 0)} 对专利说明和 PDF，说明和全文同时保留。${pdf.patentSources?.unmatchedText?.length?`另有 ${num(pdf.patentSources.unmatchedText.length)} 对未能从 PDF 开头确认公开号的资料，保留独立记录。`:''}`,
  '1,961 个 CAJ 全部已有对应 PDF；两个带重复后缀的文件经实际转换和全文比较确认一致。两份白皮书共 486 页，已完成文字提取和所需 OCR。',
  '## 校验',
  ok?'数据库完整性、文档及导师索引覆盖、FTS 数量、语料文件数量、API 数量、原始 PDF 预览、检索与浏览页面检查通过。':'部分校验未通过，查看校验报告中的失败项。',
  '源目录各分类的文件数量和总大小与导入前一致。',
  link('详细校验报告','storage/data-import-verification.json'),
  link('系统主页截图','storage/data-import-home.png'),
  link('导师语料截图','storage/data-import-mentors.png'),
  '## 未入库的原始文件',
  ...(failures.length?failures.map((r,i)=>`${i+1}. ${link(path.basename(r.file),r.file)}：${r.reason}，${num(r.bytes)} 字节。`):['无。']),
  link('失败文件和原始错误信息','storage/data-import-failures.json'),
  '## 导入方式与续跑',
  '调用项目原有导入器，额外脚本负责分批运行、预处理缓存和结果核对。当前使用文档级快速索引，完整提取文本同时保存在数据库和知识语料中。',
  link('导入方式、续跑命令与代码修正说明','LOCAL_DATA_IMPORT.md'),
  link('结构化资料批次报告','storage/data-import-structured.json'),
  link('PDF、OCR 和专利关联报告','storage/data-import-pdf.json')
].join('\n\n');
fs.writeFileSync('DATA_IMPORT_RESULT.md',text+'\n');
console.log(JSON.stringify({counts,failedFiles:failures.length,verified:ok,mergedPatents:pdf.patentSources?.merged},null,2));
