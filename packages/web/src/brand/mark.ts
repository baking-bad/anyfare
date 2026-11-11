// The Anyfare mark: a ticket with a round notch in each side, on two legs that turn from the brand green to
// deeper greens. The header, the icons, the share image and the logo file draw it from these paths, so they
// are the same shape.

export const brandColors = {
  // The brand green, and the two deeper greens of the mark's legs
  green: '#00ec97',
  greenMid: '#00a774',
  greenDeep: '#006349',
  // The dark page of the design, and its text
  dark: '#1f1f1f',
  text: '#ffffff',
} as const;

// The mark is drawn in a 100 by 100 box, as three shapes from the top down: the ticket with the top of both
// legs, the middle band of each leg, and the round end of each leg. Each shape reaches a little under the
// next one, so no seam shows between the greens.
export const markBox = 100;
export const markShapes = [
  {
    fill: brandColors.green,
    d: 'M28 4 H72 A13 13 0 0 1 85 17 V23 A10 10 0 0 0 85 43 V52.36 A14 14 0 0 0 85.4 55.7 A13 13 0 0 1 65.44 56.2 '
      + 'A10 10 0 0 0 56 49.5 H44 A10 10 0 0 0 34.56 56.2 A13 13 0 0 1 14.6 55.7 A14 14 0 0 0 15 52.36 V43 '
      + 'A10 10 0 0 0 15 23 V17 A13 13 0 0 1 28 4 Z',
  },
  {
    fill: brandColors.greenMid,
    d: 'M14.84 54.5 A13 13 0 0 0 35.07 55 A10 10 0 0 0 34.18 57.6 L31.36 72.2 A14 14 0 0 1 9.47 72.2 '
      + 'L14.36 56.54 A14 14 0 0 0 14.84 54.5 Z M85.16 54.5 A13 13 0 0 1 64.93 55 A10 10 0 0 1 65.82 57.6 '
      + 'L68.64 72.2 A14 14 0 0 0 90.53 72.2 L85.64 56.54 A14 14 0 0 1 85.16 54.5 Z',
  },
  {
    fill: brandColors.greenDeep,
    d: 'M9.85 71 A14 14 0 0 0 31.6 71 L28.6 86.54 A11.3 11.3 0 1 1 6.71 81.03 Z '
      + 'M90.15 71 A14 14 0 0 1 68.4 71 L71.4 86.54 A11.3 11.3 0 1 0 93.29 81.03 Z',
  },
] as const;

/** The mark as a standalone SVG document. */
export const markSvg = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${markBox} ${markBox}" width="${markBox}" height="${markBox}" role="img" aria-label="Anyfare">`
  + markShapes.map(shape => `<path fill="${shape.fill}" d="${shape.d}"/>`).join('')
  + '</svg>';
