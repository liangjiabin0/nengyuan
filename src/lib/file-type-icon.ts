export type FileTypeIconSpec = {
  extension: string;
  label: string;
  color: string;
  ink: string;
};

type IconGroup = {
  color: string;
  ink?: string;
  entries: Array<{ label: string; ext: string | string[] }>;
};

const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'] as const;

const DEFAULT_SPEC: FileTypeIconSpec = {
  extension: '',
  label: 'FILE',
  color: '#64748B',
  ink: '#FFFFFF'
};

function pair(label: string, ...ext: string[]) {
  return { label, ext };
}

const ICON_GROUPS: IconGroup[] = [
  {
    color: '#E5252A',
    entries: [pair('PDF', '.pdf')]
  },
  {
    color: '#2B579A',
    entries: [
      pair('DOCX', '.docx', '.docm', '.dotx', '.dotm'),
      pair('DOC', '.doc', '.dot'),
      pair('ODT', '.odt'),
      pair('RTF', '.rtf'),
      pair('WPS', '.wps', '.wpt'),
      pair('PAGE', '.pages')
    ]
  },
  {
    color: '#1D6F42',
    entries: [
      pair('XLSX', '.xlsx', '.xlsm', '.xlsb', '.xltx', '.xltm'),
      pair('XLS', '.xls', '.xlt', '.xlw'),
      pair('CSV', '.csv'),
      pair('TSV', '.tsv'),
      pair('ODS', '.ods'),
      pair('ET', '.et', '.ett'),
      pair('NUM', '.numbers')
    ]
  },
  {
    color: '#C43E1C',
    entries: [
      pair('PPTX', '.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm'),
      pair('PPT', '.ppt', '.pps', '.pot'),
      pair('ODP', '.odp'),
      pair('DPS', '.dps', '.dpt')
    ]
  },
  {
    color: '#A4373A',
    entries: [pair('ACCDB', '.accdb', '.accde'), pair('MDB', '.mdb')]
  },
  {
    color: '#3955A3',
    entries: [pair('VSDX', '.vsdx', '.vsdm'), pair('VSD', '.vsd', '.vss', '.vst')]
  },
  {
    color: '#7719AA',
    entries: [pair('ONE', '.one', '.onetoc2')]
  },
  {
    color: '#077568',
    entries: [pair('PUB', '.pub')]
  },
  {
    color: '#217346',
    entries: [pair('MPP', '.mpp', '.mpt')]
  },
  {
    color: '#0F6CBD',
    entries: [pair('MSG', '.msg', '.pst', '.ost'), pair('EML', '.eml')]
  },
  {
    color: '#7C3AED',
    entries: [
      pair('PNG', '.png'),
      pair('JPG', '.jpg', '.jpeg', '.jpe', '.jfif'),
      pair('GIF', '.gif'),
      pair('WEBP', '.webp'),
      pair('BMP', '.bmp', '.dib'),
      pair('SVG', '.svg', '.svgz'),
      pair('ICO', '.ico', '.cur'),
      pair('TIF', '.tif', '.tiff'),
      pair('HEIC', '.heic', '.heif'),
      pair('AVIF', '.avif'),
      pair('RAW', '.raw', '.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2')
    ]
  },
  {
    color: '#31A8FF',
    entries: [pair('PSD', '.psd', '.psb')]
  },
  {
    color: '#FF9A00',
    ink: '#1F1300',
    entries: [pair('AI', '.ai')]
  },
  {
    color: '#FF3366',
    entries: [pair('INDD', '.indd', '.idml')]
  },
  {
    color: '#C026D3',
    entries: [
      pair('MP4', '.mp4', '.m4v'),
      pair('MOV', '.mov', '.qt'),
      pair('AVI', '.avi'),
      pair('MKV', '.mkv'),
      pair('WMV', '.wmv', '.asf'),
      pair('FLV', '.flv', '.f4v'),
      pair('WEBM', '.webm'),
      pair('MPEG', '.mpeg', '.mpg', '.mpe', '.m2ts', '.mts', '.ts'),
      pair('3GP', '.3gp', '.3g2')
    ]
  },
  {
    color: '#0284C7',
    entries: [
      pair('MP3', '.mp3'),
      pair('WAV', '.wav', '.wave'),
      pair('FLAC', '.flac'),
      pair('AAC', '.aac'),
      pair('OGG', '.ogg', '.oga', '.opus'),
      pair('M4A', '.m4a'),
      pair('WMA', '.wma'),
      pair('AIFF', '.aiff', '.aif'),
      pair('MIDI', '.mid', '.midi')
    ]
  },
  {
    color: '#CA8A04',
    entries: [
      pair('ZIP', '.zip', '.zipx'),
      pair('RAR', '.rar'),
      pair('7Z', '.7z'),
      pair('TAR', '.tar'),
      pair('GZ', '.gz', '.gzip'),
      pair('TGZ', '.tgz', '.tar.gz'),
      pair('BZ2', '.bz2', '.tbz', '.tbz2', '.tar.bz2'),
      pair('XZ', '.xz', '.txz', '.tar.xz'),
      pair('ZST', '.zst', '.tar.zst'),
      pair('ISO', '.iso', '.img', '.dmg'),
      pair('CAB', '.cab'),
      pair('VHD', '.vhd', '.vhdx', '.vmdk')
    ]
  },
  {
    color: '#0F766E',
    entries: [
      pair('MD', '.md', '.markdown', '.mdown', '.mdx'),
      pair('TXT', '.txt', '.text'),
      pair('LOG', '.log'),
      pair('RST', '.rst'),
      pair('ORG', '.org'),
      pair('ADOC', '.adoc', '.asciidoc')
    ]
  },
  {
    color: '#0F172A',
    entries: [
      pair('HTML', '.html', '.htm', '.xhtml'),
      pair('CSS', '.css'),
      pair('SCSS', '.scss', '.sass'),
      pair('LESS', '.less')
    ]
  },
  {
    color: '#F7DF1E',
    ink: '#1F2937',
    entries: [pair('JS', '.js', '.mjs', '.cjs'), pair('JSX', '.jsx')]
  },
  {
    color: '#3178C6',
    entries: [pair('TS', '.ts', '.mts', '.cts'), pair('TSX', '.tsx')]
  },
  {
    color: '#3776AB',
    entries: [pair('PY', '.py', '.pyw', '.pyi')]
  },
  {
    color: '#ED8B00',
    entries: [pair('JAVA', '.java'), pair('JAR', '.jar', '.war', '.ear')]
  },
  {
    color: '#00ADD8',
    entries: [pair('GO', '.go')]
  },
  {
    color: '#DEA584',
    ink: '#3F2E24',
    entries: [pair('RS', '.rs')]
  },
  {
    color: '#A8B9CC',
    ink: '#1E293B',
    entries: [pair('C', '.c'), pair('H', '.h')]
  },
  {
    color: '#00599C',
    entries: [pair('C++', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx')]
  },
  {
    color: '#239120',
    entries: [pair('CS', '.cs')]
  },
  {
    color: '#777BB4',
    entries: [pair('PHP', '.php', '.phtml')]
  },
  {
    color: '#CC342D',
    entries: [pair('RB', '.rb', '.erb')]
  },
  {
    color: '#F05138',
    entries: [pair('SWIFT', '.swift')]
  },
  {
    color: '#7F52FF',
    entries: [pair('KT', '.kt', '.kts')]
  },
  {
    color: '#DC322F',
    entries: [pair('SCALA', '.scala', '.sc')]
  },
  {
    color: '#276DC3',
    entries: [pair('R', '.r', '.rmd')]
  },
  {
    color: '#E16737',
    entries: [pair('M', '.m'), pair('MAT', '.mat'), pair('SLX', '.slx', '.mdl')]
  },
  {
    color: '#9558B2',
    entries: [pair('JL', '.jl')]
  },
  {
    color: '#00007C',
    entries: [pair('LUA', '.lua')]
  },
  {
    color: '#0175C2',
    entries: [pair('DART', '.dart')]
  },
  {
    color: '#41B883',
    entries: [pair('VUE', '.vue')]
  },
  {
    color: '#FF3E00',
    entries: [pair('SVEL', '.svelte')]
  },
  {
    color: '#CBB41A',
    ink: '#1F2937',
    entries: [pair('JSON', '.json', '.jsonc', '.json5'), pair('JSONL', '.jsonl', '.ndjson')]
  },
  {
    color: '#E07941',
    entries: [pair('XML', '.xml', '.xsl', '.xsd', '.xslt')]
  },
  {
    color: '#CB171E',
    entries: [pair('YAML', '.yaml', '.yml')]
  },
  {
    color: '#9C4221',
    entries: [pair('TOML', '.toml'), pair('INI', '.ini', '.cfg', '.conf', '.config'), pair('ENV', '.env')]
  },
  {
    color: '#336791',
    entries: [pair('SQL', '.sql'), pair('DB', '.db', '.sqlite', '.sqlite3')]
  },
  {
    color: '#4EAA25',
    entries: [
      pair('SH', '.sh', '.bash', '.zsh', '.ksh', '.fish'),
      pair('PS1', '.ps1', '.psm1', '.psd1'),
      pair('BAT', '.bat', '.cmd')
    ]
  },
  {
    color: '#F37626',
    entries: [pair('IPY', '.ipynb')]
  },
  {
    color: '#008080',
    entries: [pair('TEX', '.tex', '.ltx', '.sty', '.cls'), pair('BIB', '.bib')]
  },
  {
    color: '#3B82F6',
    entries: [
      pair('MO', '.mo', '.moe'),
      pair('MPS', '.mps'),
      pair('LP', '.lp'),
      pair('FMU', '.fmu'),
      pair('SAV', '.sav'),
      pair('DYR', '.dyr'),
      pair('EPC', '.epc'),
      pair('PWB', '.pwb'),
      pair('OLR', '.olr')
    ]
  },
  {
    color: '#0EA5E9',
    entries: [
      pair('DWG', '.dwg'),
      pair('DXF', '.dxf'),
      pair('STEP', '.step', '.stp'),
      pair('IGES', '.iges', '.igs'),
      pair('IFC', '.ifc'),
      pair('STL', '.stl'),
      pair('OBJ', '.obj'),
      pair('FBX', '.fbx'),
      pair('GLTF', '.gltf', '.glb'),
      pair('3MF', '.3mf')
    ]
  },
  {
    color: '#6366F1',
    entries: [
      pair('PT', '.pt', '.pth'),
      pair('ONNX', '.onnx'),
      pair('CKPT', '.ckpt', '.ckpt.index'),
      pair('H5', '.h5', '.hdf5', '.hdf'),
      pair('PB', '.pb', '.pbtxt'),
      pair('TFL', '.tflite'),
      pair('PKL', '.pkl', '.pickle'),
      pair('SAFE', '.safetensors'),
      pair('NC', '.nc', '.netcdf'),
      pair('PARQ', '.parquet'),
      pair('ARROW', '.arrow', '.feather')
    ]
  },
  {
    color: '#15803D',
    entries: [pair('GEO', '.geojson'), pair('KML', '.kml', '.kmz'), pair('SHP', '.shp', '.dbf', '.prj')]
  },
  {
    color: '#111827',
    entries: [
      pair('TTF', '.ttf', '.ttc'),
      pair('OTF', '.otf'),
      pair('WOFF', '.woff'),
      pair('WOFF2', '.woff2'),
      pair('EOT', '.eot')
    ]
  },
  {
    color: '#7C2D12',
    entries: [pair('EPUB', '.epub'), pair('MOBI', '.mobi', '.azw', '.azw3')]
  },
  {
    color: '#4338CA',
    entries: [pair('ICS', '.ics'), pair('VCF', '.vcf')]
  },
  {
    color: '#57534E',
    entries: [
      pair('EXE', '.exe', '.com'),
      pair('MSI', '.msi', '.msix'),
      pair('DLL', '.dll'),
      pair('SO', '.so'),
      pair('DYLIB', '.dylib'),
      pair('APP', '.app'),
      pair('APK', '.apk', '.aab', '.xapk'),
      pair('IPA', '.ipa'),
      pair('BIN', '.bin', '.dat', '.hex'),
      pair('DEB', '.deb'),
      pair('RPM', '.rpm'),
      pair('WHL', '.whl')
    ]
  },
  {
    color: '#0F766E',
    entries: [pair('PEM', '.pem', '.crt', '.cer'), pair('KEY', '.key'), pair('P12', '.p12', '.pfx')]
  },
  {
    color: '#64748B',
    entries: [
      pair('DIFF', '.diff', '.patch'),
      pair('LOCK', '.lock'),
      pair('MAP', '.map'),
      pair('URL', '.url', '.webloc'),
      pair('LNK', '.lnk')
    ]
  }
];

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': '.xlsm',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'application/rtf': '.rtf',
  'text/rtf': '.rtf',
  'application/epub+zip': '.epub',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/vnd.rar': '.rar',
  'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'application/x-bzip2': '.bz2',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/html': '.html',
  'text/css': '.css',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/x-python': '.py',
  'application/x-python': '.py',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'application/typescript': '.ts',
  'text/x-yaml': '.yaml',
  'application/yaml': '.yaml',
  'application/x-yaml': '.yaml',
  'image/svg+xml': '.svg',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/heic': '.heic',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'application/vnd.ms-fontobject': '.eot',
  'application/vnd.sqlite3': '.sqlite',
  'application/x-sqlite3': '.sqlite',
  'model/step': '.step',
  'model/stl': '.stl',
  'model/gltf+json': '.gltf',
  'model/gltf-binary': '.glb',
  'application/vnd.ms-outlook': '.msg',
  'message/rfc822': '.eml',
  'text/calendar': '.ics',
  'text/vcard': '.vcf',
  'application/vnd.android.package-archive': '.apk',
  'application/x-msdownload': '.exe',
  'application/x-dosexec': '.exe',
  'application/vnd.microsoft.portable-executable': '.exe'
};

const EXT_MAP = buildExtensionMap(ICON_GROUPS);

function buildExtensionMap(groups: IconGroup[]) {
  const map = new Map<string, FileTypeIconSpec>();
  for (const group of groups) {
    const ink = group.ink || '#FFFFFF';
    for (const entry of group.entries) {
      const exts = Array.isArray(entry.ext) ? entry.ext : [entry.ext];
      for (const ext of exts) {
        const extension = normalizeExtension(ext);
        if (!extension) continue;
        map.set(extension, {
          extension,
          label: sanitizeLabel(entry.label),
          color: group.color,
          ink
        });
      }
    }
  }
  return map;
}

export function normalizeExtension(value: string | undefined | null): string {
  const trimmed = String(value || '').trim().toLowerCase();
  if (!trimmed || trimmed === '.') return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function sanitizeLabel(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9.+]/g, '').slice(0, 5).toUpperCase();
  return compact || 'FILE';
}

function extensionFromFileName(name: string): string {
  const base = name.trim().toLowerCase();
  if (!base) return '';
  for (const compound of COMPOUND_EXTENSIONS) {
    if (base.endsWith(compound)) return compound;
  }
  const index = base.lastIndexOf('.');
  if (index <= 0 || index >= base.length - 1) return '';
  return base.slice(index);
}

function extensionFromMediaType(mediaType: string): string {
  const mime = mediaType.split(';')[0]?.trim().toLowerCase() || '';
  if (!mime) return '';
  const mapped = MIME_TO_EXT[mime];
  if (mapped) return mapped;
  const [type, subtypeRaw = ''] = mime.split('/');
  if (!type || !subtypeRaw || subtypeRaw === '*' || subtypeRaw === 'octet-stream') return '';
  let subtype = subtypeRaw.replace(/^x-/, '');
  if (subtype === 'svg+xml') return '.svg';
  if (subtype === 'jpeg') return '.jpg';
  if (type === 'image' || type === 'audio' || type === 'video' || type === 'font') {
    subtype = subtype.replace(/\+.*$/, '');
    return normalizeExtension(subtype);
  }
  return '';
}

export function fileTypeExtension(input: {
  name?: string;
  extension?: string;
  mediaType?: string;
}): string {
  return (
    normalizeExtension(input.extension)
    || extensionFromFileName(input.name || '')
    || extensionFromMediaType(input.mediaType || '')
  );
}

export function resolveFileTypeIcon(input: {
  name?: string;
  extension?: string;
  mediaType?: string;
}): FileTypeIconSpec {
  const extension = fileTypeExtension(input);
  if (!extension) return DEFAULT_SPEC;
  const known = EXT_MAP.get(extension);
  if (known) return known;
  return {
    extension,
    label: sanitizeLabel(extension.replace(/^\./, '')),
    color: DEFAULT_SPEC.color,
    ink: DEFAULT_SPEC.ink
  };
}
