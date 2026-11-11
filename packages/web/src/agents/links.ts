import type { SiteSettings } from '../config';

// Where the files an agent reads are served. Hosts always come from the settings.

export const llmsPath = '/llms.txt';
export const llmsFullPath = '/llms-full.txt';
export const skillName = 'anyfare-buyer';
export const skillPath = `/skills/${skillName}/SKILL.md`;
export const agentsPath = '/agents';
export const agentsTwinPath = '/agents.md';

type Hosts = Pick<SiteSettings, 'siteUrl' | 'apiUrl' | 'payUrl'>;

/** The API's OpenAPI file, and the pay host's. Another part of the system serves them. */
export const openapiUrls = ({ apiUrl, payUrl }: Pick<SiteSettings, 'apiUrl' | 'payUrl'>): { readonly api: string; readonly pay: string } => ({
  api: `${apiUrl}/openapi.json`,
  pay: `${payUrl}/openapi.json`,
});

/** The absolute links of the agent files. */
export const agentLinks = ({ siteUrl, apiUrl, payUrl }: Hosts) => ({
  llms: `${siteUrl}${llmsPath}`,
  llmsFull: `${siteUrl}${llmsFullPath}`,
  skill: `${siteUrl}${skillPath}`,
  page: `${siteUrl}${agentsPath}`,
  twin: `${siteUrl}${agentsTwinPath}`,
  openapi: openapiUrls({ apiUrl, payUrl }),
});

// Plain text and Markdown answers for agents: UTF-8, cached briefly, and the same per settings
export const textResponse = (body: string, contentType: 'text/plain' | 'text/markdown'): Response =>
  new Response(body, { headers: { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'public, max-age=300' } });
