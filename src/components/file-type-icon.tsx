import { resolveFileTypeIcon } from '@/lib/file-type-icon';

export function FileTypeIcon({
  name,
  extension,
  mediaType,
  className
}: {
  name?: string;
  extension?: string;
  mediaType?: string;
  className?: string;
}) {
  const spec = resolveFileTypeIcon({ name, extension, mediaType });
  const length = spec.label.length;
  const fontSize = length >= 5 ? 8 : length === 4 ? 9 : length === 3 ? 10.5 : length === 2 ? 12.5 : 14;

  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M10 3h20l10 10v27a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V8a5 5 0 0 1 5-5z"
        fill={spec.color}
      />
      <path d="M30 3l10 10H34a4 4 0 0 1-4-4V3z" fill="#fff" fillOpacity="0.3" />
      <path
        className="rag-file-type-band"
        d="M5 29h35v11a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V29z"
        fill="#000"
        fillOpacity="0.22"
      />
      <text
        className="rag-file-type-label"
        x="24"
        y="37.2"
        textAnchor="middle"
        fill={spec.ink}
        fontSize={fontSize}
        fontWeight="800"
        letterSpacing={length >= 4 ? -0.35 : 0.15}
        style={{ fontFamily: "ui-sans-serif, 'Segoe UI', 'Microsoft YaHei', sans-serif" }}
      >
        {spec.label}
      </text>
    </svg>
  );
}
