import qrcode from 'qrcode-generator';

// The QR code of a deposit address: the address's own characters and nothing else (no scheme, no amount), drawn as
// one SVG path of dark modules on a white square with its quiet zone, so it needs no style and no script.

// The light modules around the code that a reader needs, on each side
const quietZone = 4;

/** The dark modules of the QR code of `value`, row by row, or undefined when it can't be encoded exactly: only printable ASCII is. */
export const qrModules = (value: string): readonly (readonly boolean[])[] | undefined => {
  // Byte mode of this library keeps the low byte of each character: anything but ASCII would not read back as itself
  if (value === '' || !/^[\x20-\x7e]+$/.test(value))
    return undefined;
  try {
    const code = qrcode(0, 'M');
    code.addData(value, 'Byte');
    code.make();
    const size = code.getModuleCount();

    return Array.from({ length: size }, (_row, row) => Array.from({ length: size }, (_column, column) => code.isDark(row, column)));
  }
  catch {
    // Too long for a QR code
    return undefined;
  }
};

/** The SVG path of the dark modules, each a 1 by 1 square, moved in by the quiet zone. */
export const qrPath = (modules: readonly (readonly boolean[])[]): string =>
  modules.flatMap((line, row) => line.flatMap((dark, column) => dark ? [`M${column + quietZone} ${row + quietZone}h1v1h-1z`] : [])).join('');

/** The QR code of `value`, or nothing when it can't be encoded exactly. */
export const QrCode = ({ value }: { readonly value: string }) => {
  const modules = qrModules(value);
  if (modules === undefined)
    return null;
  const side = modules.length + quietZone * 2;

  return (
    <span className="qr">
      <svg role="img" aria-label="QR code of the deposit address" viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
        <rect width={side} height={side} fill="#fff" />
        <path d={qrPath(modules)} fill="#000" />
      </svg>
    </span>
  );
};
