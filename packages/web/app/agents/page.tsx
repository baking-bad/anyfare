import '../agents.css';

import type { Metadata } from 'next';

import { AgentsHero, ApiTable, FileCards, LlmsSection, StartSteps } from '../../src/agents/AgentsSections';
import { agentsDescription, agentsJson, agentsRequests, agentsTitle } from '../../src/agents/content';
import { platformGuide } from '../../src/agents/guide';
import { PageView } from '../../src/components/AgentView';
import { readSettings } from '../../src/config';
import { agentsMarkdown } from '../../src/markdown/agents';
import { socialTags } from '../../src/seo/social';
import { markdownUrl } from '../../src/markdown/negotiate';

export const generateMetadata = (): Metadata => {
  const { siteUrl } = readSettings();
  const url = `${siteUrl}/agents`;

  return {
    title: agentsTitle,
    description: agentsDescription,
    alternates: { canonical: url, types: { 'text/markdown': `${siteUrl}${markdownUrl('/agents')}` } },
    ...socialTags({ siteUrl, title: `${agentsTitle} | Anyfare`, description: agentsDescription, url }),
  };
};

// Read at each request: the page shows the files exactly as they are served, with this deployment's hosts
export const dynamic = 'force-dynamic';

/** For agents: how an agent finds Anyfare, signs up, tops up and pays, with the API as a table. It reads no API. */
const Agents = () => {
  const settings = readSettings();
  const guide = platformGuide(settings);

  return (
    <PageView
      agent={{
        title: agentsTitle,
        markdown: agentsMarkdown(settings),
        json: agentsJson(settings),
        requests: agentsRequests(settings),
        markdownUrl: `${settings.siteUrl}${markdownUrl('/agents')}`,
      }}
    >
      <AgentsHero siteUrl={settings.siteUrl} />
      <FileCards hosts={settings} />
      <StartSteps hosts={settings} />
      <ApiTable hosts={settings} />
      <LlmsSection hosts={settings} guide={guide} />
    </PageView>
  );
};

export default Agents;
