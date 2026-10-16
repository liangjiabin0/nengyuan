/** @type {import('next').NextConfig} */
const os = require('os');
const webpack = require('webpack');

/** 开发模式允许局域网 IP 访问 /_next/*。通配只支持 *.domain，IP 段写法无效。 */
function getAllowedDevOrigins() {
  const hosts = new Set(['127.0.0.1', 'localhost', '::1', ...(process.env.AI4ES_ALLOWED_DEV_ORIGINS || '').split(',').filter(Boolean)]);
  try {
    hosts.add(os.hostname());
  } catch {
    // ignore
  }
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      const family = typeof net.family === 'string' ? net.family : String(net.family);
      if (!net.internal && net.address) {
        if (family === 'IPv4' || family === '4' || family === 'IPv6' || family === '6') {
          hosts.add(net.address);
        }
      }
    }
  }
  return [...hosts];
}

const nextConfig = {
  distDir: process.env.AI4ES_NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['better-sqlite3', 'pg', 'pdf-parse', 'pdfjs-dist', 'unzipper', 'graphology', 'graphology-shortest-path', 'graphology-components'],
  allowedDevOrigins: getAllowedDevOrigins(),
  devIndicators: false,
  turbopack: {},
  // 科研传承助手等大附件（zip≈200MB）经 middleware/proxy + rewrite 到 API 时需提高缓冲上限，
  // 否则默认 10MB 截断会导致代理失败并返回 Internal Server Error。
  experimental: {
    proxyClientMaxBodySize: '220mb',
    // /api 反代到独立 API 进程时默认 30s。智能对话工具检索常远超 3 分钟，
    // 必须覆盖 CHAT_AGENT_TIMEOUT_MS（5 小时），否则 httpxy 会掐断 NDJSON 流。
    proxyTimeout: 18_000_000,
    // This app includes G6/ECharts and many dashboard routes. Next 16's
    // documented Webpack memory mode keeps production builds below the
    // default Node heap ceiling; the worker also isolates compiler memory.
    webpackMemoryOptimizations: true,
    webpackBuildWorker: true
  },
  async rewrites() {
    if (process.env.AI4ES_SPLIT !== '1') return [];
    const api = process.env.AI4ES_API_URL || 'http://127.0.0.1:4000';
    // beforeFiles：优先于 App Router 自带的 /api 路由，否则拆分模式下仍会打到 Next 进程内
    return {
      beforeFiles: [{ source: '/api/:path*', destination: `${api}/api/:path*` }]
    };
  },
  webpack(config) {
    // G6 publishes a complete UMD bundle. Resolving the runtime import to this
    // prebuilt file avoids expanding thousands of @antv/* modules (and their
    // source maps) into Webpack's graph, which exceeded a 12 GB heap here.
    config.resolve.alias['@antv/g6$'] = require.resolve('@antv/g6/dist/g6.min.js');
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^@aws-sdk\/client-s3$/
      })
    );

    // 数据/语料/产物目录可达数万～十万文件；纳入 watch 会撑爆 next dev 内存并最终卡死无响应。
    // Webpack schema 只接受单个 RegExp（或字符串数组），不能传 RegExp[]。
    // 使用 RegExp，避免中文路径 glob 在 Windows/watchpack 下失效。
    // 根目录临时产物（tsbuildinfo、日志、opencode.json 同步）也会触发 Fast Refresh，表现为整页突然闪一下。
    const ignoredWatchPath =
      /[\\/](data|数据|知识问答|storage|outputs|reports|eval|vendor|tools|dist|node_modules|\.next|\.git|\.opencode|\.claude|\.cursor|\.codex|\.agents|examples|__pycache__|[^\\/]+\.ragpack)([\\/]|$)|(\.(tsbuildinfo|log|patch|pyc|tmp)$)|((?:^|[\\/])(next-env\.d\.ts|opencode\.json|package-lock\.json|tmp-[^\\/]+)$)/i;
    config.watchOptions = {
      ...(config.watchOptions || {}),
      ignored: ignoredWatchPath,
      followSymlinks: false,
      aggregateTimeout: 1200
    };
    return config;
  }
};

module.exports = nextConfig;
