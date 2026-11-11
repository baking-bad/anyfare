import { readFile } from 'node:fs/promises';

// Figtree, the site's font, as the files next to this one, so an image never fetches a font. The image
// renderer reads TrueType, not the site's woff2.
const load = (file: URL): Promise<Buffer> => readFile(file);

/** The fonts an image response uses: Figtree at weights 500 and 700. */
export const imageFonts = async () => [
  { name: 'Figtree', data: await load(new URL('./fonts/figtree-500.ttf', import.meta.url)), weight: 500 as const, style: 'normal' as const },
  { name: 'Figtree', data: await load(new URL('./fonts/figtree-700.ttf', import.meta.url)), weight: 700 as const, style: 'normal' as const },
];
