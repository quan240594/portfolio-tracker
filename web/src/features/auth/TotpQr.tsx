import { useMemo } from 'react';
import { create } from 'qrcode';

const QUIET_ZONE = 4;

/** Renders the QR code as inline SVG, generated locally — the secret is never sent to any service. */
export function TotpQr({ value, label }: Readonly<{ value: string; label: string }>) {
  const { size, path } = useMemo(() => {
    const { modules } = create(value, { errorCorrectionLevel: 'M' });
    const parts: string[] = [];
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
    return { size: modules.size + QUIET_ZONE * 2, path: parts.join('') };
  }, [value]);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" className="mx-auto h-48 w-48 rounded-lg">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
