// The Anyfare mark: a rounded square in the brand green with two round eyes. The header draws it with CSS;
// the icons, the share image and the logo file draw it from these numbers, so they are the same shape.

export const brandColors = {
  // The brand green and the ink on it
  green: '#00ec97',
  ink: '#000000',
  // The dark page of the design, and its text
  dark: '#1f1f1f',
  text: '#ffffff',
} as const;

// The mark is drawn in a 28 by 28 box: the header's size
export const markBox = 28;
export const markRadius = 8;
export const markEyes = { r: 4, y: 14, left: 9, right: 19 } as const;

/** The mark as a standalone SVG document. */
export const markSvg = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${markBox} ${markBox}" width="${markBox}" height="${markBox}" role="img" aria-label="Anyfare">`
  + `<rect width="${markBox}" height="${markBox}" rx="${markRadius}" fill="${brandColors.green}"/>`
  + `<circle cx="${markEyes.left}" cy="${markEyes.y}" r="${markEyes.r}" fill="${brandColors.ink}"/>`
  + `<circle cx="${markEyes.right}" cy="${markEyes.y}" r="${markEyes.r}" fill="${brandColors.ink}"/>`
  + '</svg>';
