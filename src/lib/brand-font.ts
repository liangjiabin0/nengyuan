import localFont from 'next/font/local';

/** 千图厚黑体 — 侧栏品牌标题专用 */
export const brandFont = localFont({
  src: '../app/fonts/QiantuHouHei.ttf',
  display: 'swap',
  weight: '400',
  adjustFontFallback: false,
  fallback: ['AlibabaPuHuiTi', 'Microsoft YaHei', 'sans-serif']
});
