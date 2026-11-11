import { ImageResponse } from 'next/og';

import { Mark } from '../src/brand/MarkImage';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

const Icon = () => new ImageResponse(<div style={{ display: 'flex', width: '100%', height: '100%' }}><Mark size={64} /></div>, size);

export default Icon;
