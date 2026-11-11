import './home.css';

import { headers } from 'next/headers';
import type { Metadata } from 'next';

import { serverReader } from '../src/api/server';
import { PageView } from '../src/components/AgentView';
import { readSettings } from '../src/config';
import { homeDescription, homeTitle } from '../src/content/home';
import { homeJson, homeRequests, loadHome } from '../src/home/data';
import { LiveCalls } from '../src/home/LiveCalls';
import { ForAgents, Hero, Questions, TopServices, TwoWays } from '../src/home/sections';
import { StatsBand } from '../src/home/StatsBand';
import { homeMarkdown } from '../src/markdown/home';
import { markdownUrl } from '../src/markdown/negotiate';

export const generateMetadata = (): Metadata => {
  const { siteUrl } = readSettings();

  return {
    title: { absolute: homeTitle },
    description: homeDescription,
    alternates: { canonical: siteUrl, types: { 'text/markdown': `${siteUrl}${markdownUrl('/')}` } },
    openGraph: { type: 'website', siteName: 'Anyfare', title: homeTitle, description: homeDescription, url: siteUrl },
    twitter: { card: 'summary', title: homeTitle, description: homeDescription },
  };
};

/**
 * The home page. Each section reads its own data and survives alone: a read that failed shows that
 * section's error state, and an empty database shows zeros and empty states.
 */
const Home = async () => {
  const settings = readSettings();
  const data = await loadHome(serverReader(await headers(), settings));
  const { siteUrl, apiUrl, payUrl, consoleUrl } = settings;

  return (
    <PageView
      agent={{
        title: homeTitle,
        markdown: homeMarkdown(settings, data),
        json: homeJson(data),
        requests: homeRequests(settings),
        markdownUrl: `${siteUrl}${markdownUrl('/')}`,
      }}
    >
      <Hero consoleUrl={consoleUrl} />
      <LiveCalls
        now={Date.now()}
        calls={data.calls.ok ? data.calls.value.calls : null}
        numbers={data.live.ok ? { volume: data.live.value.last24h.volume, volumeBefore: data.live.value.last24h.volumeBefore, callsToday: data.live.value.today.calls } : null}
      />
      <TwoWays payUrl={payUrl} apiUrl={apiUrl} consoleUrl={consoleUrl} />
      <StatsBand stats={data.stats.ok ? data.stats.value : null} />
      <TopServices services={data.services} />
      <ForAgents siteUrl={siteUrl} />
      <Questions />
    </PageView>
  );
};

export default Home;
