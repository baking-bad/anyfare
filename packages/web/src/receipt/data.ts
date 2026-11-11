import { getReceipt, paths } from '../api/endpoints';
import type { ApiResult, Reader, ReadFailure } from '../api/reader';
import type { Receipt } from '../api/types';
import type { AgentRequest } from '../components/AgentView';
import type { SiteSettings } from '../config';
import { isReceiptId } from './content';

const missing: ReadFailure = { status: 404, code: 'not_found', message: 'No call with this id.' };

/** The receipt of a call. An id that isn't one is no call, and the API is never asked. */
export const loadReceipt = (read: Reader, id: string): Promise<ApiResult<Receipt>> =>
  isReceiptId(id) ? getReceipt(read, id) : Promise.resolve({ ok: false, error: missing });

/** The request behind the page, with the address an agent uses. */
export const receiptRequests = ({ apiUrl }: Pick<SiteSettings, 'apiUrl'>, id: string): readonly AgentRequest[] => [
  { method: 'GET', url: `${apiUrl}${paths.call(id)}`, note: 'The receipt as JSON. 404 for an unknown call or one still in flight' },
];

/** The header that tells the 404 page the visitor asked for a call that doesn't exist. */
export const missingHeader = 'x-receipt-missing';
