// 检查 Word 预览依赖：mammoth 1.x 只兼容 @xmldom/xmldom 0.8。
// 装成 0.9 时，国网指南设计里打开 Word 文件会报
// “DOMParser.parseFromString: the provided mimeType "undefined" is not valid”。
// 用法：在项目根目录运行 node scripts/check-xmldom.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mammothRequire = createRequire(require.resolve('mammoth'));
const xmldomVersion = mammothRequire('@xmldom/xmldom/package.json').version;
const mammothVersion = require('mammoth/package.json').version;
console.log(`mammoth ${mammothVersion} 使用的 @xmldom/xmldom 版本：${xmldomVersion}`);

const { DOMParser } = mammothRequire('@xmldom/xmldom');
try {
  new DOMParser().parseFromString('<a/>');
  console.log('正常：Word 预览可以用。');
} catch (error) {
  console.error(`有问题：${error instanceof Error ? error.message : error}`);
  console.error('修复：npm install（package.json 的 overrides 已把它固定为 0.8.15），然后重启能元。');
  process.exitCode = 1;
}
