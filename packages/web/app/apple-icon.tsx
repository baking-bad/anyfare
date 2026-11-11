import { ImageResponse } from 'next/og';

import { Mark } from '../src/brand/MarkImage';
import { brandColors } from '../src/brand/mark';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// An app icon has no transparency: the mark sits on the dark page
const AppleIcon = () => new ImageResponse(
  <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: brandColors.dark }}>
    <Mark size={124} />
  </div>,
  size,
);

export default AppleIcon;
