import { getEndpointStats, listCalls, paths } from '../api/endpoints';
import type { ApiResult, Reader, ReadFailure } from '../api/reader';
import type { CallsPage, EndpointStats } from '../api/types';
import type { AgentRequest } from '../components/AgentView';
import type { SiteSettings } from '../config';
import { readCheckAnswer, type PayableCheck, type Refusal } from './answer';
import { callsSize, checkHeader, defaultMethod, isTooLong, tooLongRefusal, type CheckMethod, type CheckParams } from './content';

/** What the check of the typed link came to. */
export type CheckState =
  // No link was given
  | { readonly kind: 'empty' }
  // The link is payable. `raw` is the answer as it came.
  | { readonly kind: 'payable'; readonly check: PayableCheck; readonly raw: unknown }
  // The link can't be paid, or the pay host refused the check. `status` is what a twin answers with.
  | { readonly kind: 'refused'; readonly refusal: Refusal; readonly status: number; readonly raw: unknown }
  // The pay host didn't answer, or answered with something the page can't read
  | { readonly kind: 'unavailable'; readonly error: ReadFailure };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isCheckBody = (value: unknown): value is Record<string, unknown> => isRecord(value) && readCheckAnswer(value) !== undefined;

// A 4xx from the pay host that is a refusal of the check, not a failure: the per-IP limit, or a bad request
const refusalOf = (error: ReadFailure): Refusal | undefined => {
  if (error.status === 429)
    return { reason: 'rate_limited', message: error.message };
  if (error.status >= 400 && error.status < 500 && error.status !== 404 && error.status !== 408 && error.code !== 'unexpected_answer')
    return { reason: error.code, message: error.message };

  return undefined;
};

/**
 * Checks a link on the pay host, as the visitor typed it, probed with `method`. No link is `empty`. A link that is too long makes
 * no request: it is "not a link". The server never requests the link itself: the pay host does, under its own rules.
 */
export const loadCheck = async (read: Reader, url: string, method: CheckMethod = defaultMethod): Promise<CheckState> => {
  if (url === '')
    return { kind: 'empty' };
  if (isTooLong(url))
    return { kind: 'refused', refusal: tooLongRefusal, status: 200, raw: { payable: false, reason: tooLongRefusal.reason, message: tooLongRefusal.message } };
  const result = await read(paths.check(url, method), isCheckBody, method === 'POST' ? { headers: checkHeader } : undefined);
  if (!result.ok) {
    const refusal = refusalOf(result.error);

    return refusal === undefined
      ? { kind: 'unavailable', error: result.error }
      : { kind: 'refused', refusal, status: result.error.status, raw: { error: { code: result.error.code, message: result.error.message } } };
  }
  const answer = readCheckAnswer(result.value)!;

  return answer.payable
    ? { kind: 'payable', check: answer.check, raw: result.value }
    : { kind: 'refused', refusal: answer.refusal, status: 200, raw: result.value };
};

/** Everything the Check page and its Markdown twin show. The stats and the calls are read only for a payable link. */
export interface CheckData {
  readonly params: CheckParams;
  readonly state: CheckState;
  readonly stats?: ApiResult<EndpointStats>;
  readonly calls?: ApiResult<CallsPage>;
}

/** Reads the check on the pay host, then the endpoint's numbers and its last calls from the API. */
export const loadCheckData = async (payRead: Reader, apiRead: Reader, params: CheckParams): Promise<CheckData> => {
  const state = await loadCheck(payRead, params.url, params.method);
  if (state.kind !== 'payable')
    return { params, state };
  const { host, path } = state.check;
  const [stats, calls] = await Promise.all([
    getEndpointStats(apiRead, host, path, params.period),
    listCalls(apiRead, { host, endpoint: path, size: callsSize, page: params.page }),
  ]);

  return { params, state, stats, calls };
};

/** The requests behind the page, with the addresses a browser or an agent uses. */
export const checkRequests = ({ apiUrl, payUrl }: Pick<SiteSettings, 'apiUrl' | 'payUrl'>, data: CheckData): readonly AgentRequest[] => {
  const requests: AgentRequest[] = [
    {
      method: 'GET',
      url: `${payUrl}${data.params.url === '' ? '/_/check?url=<link>' : paths.check(data.params.url, data.params.method)}`,
      note: 'The check: our quote, the link to pay, what the API asks, and its decoded 402. method: GET (the default) or POST, the one the probe is sent with. POST needs the header X-Anyfare-Check: 1',
      ...data.params.method === 'POST' ? { headers: checkHeader } : {},
    },
  ];
  if (data.state.kind === 'payable') {
    const { host, path } = data.state.check;
    requests.push(
      { method: 'GET', url: `${apiUrl}${paths.endpointStats(host, path, data.params.period)}`, note: 'This endpoint\'s numbers. period: today, 7d, 30d or all' },
      { method: 'GET', url: `${apiUrl}${paths.calls({ host, endpoint: path, size: callsSize, page: data.params.page })}`, note: 'The last calls to this endpoint, newest first' },
    );
  }

  return requests;
};

const answered = <TValue>(result: ApiResult<TValue> | undefined): unknown =>
  result === undefined ? null : result.ok ? result.value : { error: { code: result.error.code, message: result.error.message } };

/** The JSON of the Check page: the check as the pay host answered, the endpoint's numbers and its last calls. */
export const checkJson = (data: CheckData): Record<string, unknown> => ({
  check: data.state.kind === 'empty' ? null : data.state.kind === 'unavailable' ? { error: { code: data.state.error.code, message: data.state.error.message } } : data.state.raw,
  stats: answered(data.stats),
  calls: answered(data.calls),
});
