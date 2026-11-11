import { ImageResponse } from 'next/og';

import { hero, siteName } from '../content/home';
import { Mark } from './MarkImage';
import { imageFonts } from './fonts';
import { brandColors } from './mark';

export const shareSize = { width: 1200, height: 630 };
export const shareAlt = `${siteName}: ${hero.line}`;

/** The share image: the mark, the name and the home page's line, on the dark page of the design. */
export const shareImage = async (): Promise<ImageResponse> => new ImageResponse(
  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', height: '100%', padding: '0 88px', background: brandColors.dark, fontFamily: 'Figtree' }}>
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <Mark size={112} />
      <div style={{ display: 'flex', marginLeft: 32, color: brandColors.text, fontSize: 96, fontWeight: 700 }}>anyfare</div>
    </div>
    <div style={{ display: 'flex', marginTop: 56, color: brandColors.green, fontSize: 46, fontWeight: 500, lineHeight: 1.15 }}>{hero.line}</div>
  </div>,
  { ...shareSize, fonts: await imageFonts() },
);
