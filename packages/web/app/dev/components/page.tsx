import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { AgentView, PageView } from '../../../src/components/AgentView';
import { BarChart } from '../../../src/components/BarChart';
import { BarList } from '../../../src/components/BarList';
import { Badge, type BadgeTone } from '../../../src/components/Badge';
import { Button, type ButtonSize, type ButtonVariant } from '../../../src/components/Button';
import { Card, CardHead } from '../../../src/components/Card';
import { CodeBlock } from '../../../src/components/CodeBlock';
import { CopyButton } from '../../../src/components/CopyButton';
import { DataTable } from '../../../src/components/DataTable';
import { EmptyState } from '../../../src/components/EmptyState';
import { ErrorState } from '../../../src/components/ErrorState';
import { Icon, iconNames } from '../../../src/components/Icon';
import { LiveDot } from '../../../src/components/LiveDot';
import { Rail, type RailId } from '../../../src/components/Rail';
import { Skeleton } from '../../../src/components/Skeleton';
import { Sparkline } from '../../../src/components/Sparkline';
import { Spinner } from '../../../src/components/Spinner';
import { Stat } from '../../../src/components/Stat';
import { Tabs } from '../../../src/components/Tabs';
import { ago, count, ms, pct, usd } from '../../../src/format';
import { InteractiveDemo } from './Interactive';

export const metadata = { title: 'Components', robots: { index: false, follow: false } };

const variants: readonly ButtonVariant[] = ['primary', 'secondary', 'outline', 'ghost', 'danger', 'danger-soft', 'success-soft', 'warning', 'on-brand'];
const sizes: readonly ButtonSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];
const tones: readonly BadgeTone[] = ['neutral', 'brand', 'success', 'info', 'warning', 'danger'];
const rails: readonly RailId[] = ['near', 'base', 'solana', 'tempo', 'credits'];

const days = Array.from({ length: 30 }, (_, i) => ({
  value: 40 + ((i * 37) % 55) + (i > 20 ? 20 : 0),
  label: `Sample day ${i + 1}`,
  tick: i % 5 === 0 ? `D${i + 1}` : undefined,
  tone: i === 29 ? 'near' as const : 'default' as const,
}));

const sampleJson = { service: 'Sample service', host: 'example.com', price: '0.01', paid: true, calls: 12, note: null };

const sampleMarkdown = '# Sample page\n\nThis is sample text on `example.com`.\n\n- One line\n- Another line';

const Section = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <section className="stack-lg">
    <h2 className="h3">{title}</h2>
    {children}
  </section>
);

/** Every component in every variant and state, with sample content. Answers 404 in production. */
const Components = () => {
  if (process.env.NODE_ENV === 'production')
    notFound();

  const now = Date.now();

  return (
    <div className="container ruled page-pad">
      <div className="stack-xl">
        <div className="stack">
          <span className="eyebrow">Development only</span>
          <h1 className="page-title">Components</h1>
          <p className="muted">Every shared component, with sample text. This page answers 404 in production.</p>
        </div>

        <Section title="Type">
          <div className="stack">
            <p className="display">Display line</p>
            <p className="h2">Section heading</p>
            <p className="page-title">Page title</p>
            <p className="h3">Item title</p>
            <p className="h4">Card title</p>
            <p className="lead">Lead paragraph in secondary text.</p>
            <p>Body text, 16 px. A link looks <a className="link" href="#type">like this</a>. A key looks like <code>af_live_sample</code>.</p>
            <p className="small muted">Small secondary text, 14 px.</p>
            <p className="xs muted">Caption, 12 px.</p>
          </div>
        </Section>

        <Section title="Button">
          {sizes.map(size => (
            <div key={size} className="row">
              <span className="small muted dev-label">{size}</span>
              {variants.map(variant => <Button key={variant} variant={variant} size={size}>{variant}</Button>)}
            </div>
          ))}
          <div className="row">
            <span className="small muted dev-label">icon</span>
            {sizes.filter(size => size !== 'xs').map(size => <Button key={size} variant="outline" size={size} iconOnly aria-label={`Sample icon button, ${size}`}><Icon name="plus" /></Button>)}
            <Button variant="outline"><Icon name="copy" />With an icon</Button>
            <Button variant="outline" size="xl"><Icon name="link" />Extra large with an icon</Button>
          </div>
          <div className="row">
            <span className="small muted dev-label">states</span>
            <Button disabled>Disabled</Button>
            <Button variant="outline" disabled>Disabled</Button>
            <Button loading>Loading</Button>
            <Button variant="secondary" loading>Loading</Button>
            <Button href="/dev/components#button">A link</Button>
            <Button href="https://example.com" variant="outline">An external link</Button>
          </div>
          <div className="row">
            <span className="small muted dev-label">copy</span>
            <CopyButton text="Sample text to copy" />
            <CopyButton text="Sample text to copy" label="Copy the sample" variant="outline" size="md" />
            <CopyButton text="Sample text to copy" label="Copy the sample" variant="ghost" iconOnly />
          </div>
        </Section>

        <Section title="Interactive: Segmented, Pager, a loading Button">
          <InteractiveDemo />
        </Section>

        <Section title="Tabs">
          <Tabs
            label="Sample tabs"
            items={[
              { id: 'one', label: 'First', content: <p className="muted">The first panel. Use the left and right arrows, Home and End.</p> },
              { id: 'two', label: 'Second', content: <p className="muted">The second panel.</p> },
              { id: 'three', label: 'Third', content: <p className="muted">The third panel.</p> },
            ]}
          />
        </Section>

        <Section title="Fields">
          <div className="grid g3">
            <div className="field"><label htmlFor="f1">Label</label><input id="f1" className="input" placeholder="Placeholder" /><span className="hint">A hint under the field.</span></div>
            <div className="field"><label htmlFor="f2">With an error</label><input id="f2" className="input" defaultValue="Sample value" aria-invalid="true" /><span className="error">An error under the field.</span></div>
            <div className="field"><label htmlFor="f3">A select</label><select id="f3" className="input" defaultValue="b"><option value="a">First</option><option value="b">Second</option></select></div>
          </div>
          <form className="check-box" action="#">
            <span className="lead-icon"><Icon name="link" /></span>
            <input name="url" aria-label="A sample link" placeholder="Paste a paid API link" autoComplete="off" spellCheck={false} />
            <Button size="xl" type="submit">Check link</Button>
          </form>
          <div className="row"><a className="chip" href="#fields">A chip <span className="muted">example.com</span></a><button type="button" className="chip" aria-pressed="true">Pressed chip</button></div>
        </Section>

        <Section title="Card">
          <div className="grid g3">
            <Card><CardHead title="Card" /><p className="small muted">A 1 px outline, no shadow.</p></Card>
            <Card raised><CardHead title="Raised card"><Badge tone="brand">New</Badge></CardHead><p className="small muted">Stands out on the canvas.</p></Card>
            <Card href="/dev/components#card"><CardHead title="Clickable card" /><p className="small muted">The outline grows on hover.</p></Card>
            <Card large><div className="row"><span className="tile brand"><Icon name="wallet" /></span><div><h3 className="h4">Large padding</h3><p className="small muted">With a brand icon tile.</p></div></div></Card>
            <div className="dark-panel"><h3 className="h4">Dark panel</h3><p className="small muted">Dark in both themes.</p></div>
            <Card flush><div className="empty"><span className="small muted">A flush card holds a table or a list</span></div></Card>
          </div>
        </Section>

        <Section title="Badge, Rail, LiveDot, Spinner">
          <div className="row">{tones.map(tone => <Badge key={tone} tone={tone}>{tone}</Badge>)}</div>
          <div className="row">{tones.map(tone => <Badge key={tone} tone={tone} large>{tone}</Badge>)}<Badge tone="success" icon="check">With an icon</Badge></div>
          <div className="row">{rails.map(rail => <Rail key={rail} rail={rail} />)}<Rail rail="base" label="USDC on Base" /></div>
          <div className="row"><span className="route"><Rail rail="near" /><Icon name="arrow" className="arrow" /><Rail rail="base" /></span></div>
          <div className="inverse-band dark-panel"><div className="row">{rails.map(rail => <Rail key={rail} rail={rail} />)}</div></div>
          <div className="row"><LiveDot /><span className="small">Live</span><LiveDot paused /><span className="small muted">Paused</span><Spinner /><span className="small muted">Spinner</span><span className="pill-value up">▲ 12.4%</span><span className="pill-value info">8.4%</span></div>
        </Section>

        <Section title="Alerts, EmptyState, ErrorState, Skeleton">
          <div className="grid g2">
            <div className="alert info"><Icon name="info" /><div><span className="t">Info</span><br />A line of sample text.</div></div>
            <div className="alert warning"><Icon name="alert" /><div><span className="t">Warning</span><br />A line of sample text.</div></div>
            <div className="alert success"><Icon name="check" /><div><span className="t">Success</span><br />A line of sample text.</div></div>
            <ErrorState title="Sample service didn't load" action={<Button size="sm" variant="outline">Try again</Button>}>The request to example.com timed out.</ErrorState>
          </div>
          <div className="card flush"><EmptyState icon="activity" title="No calls yet" action={<Button variant="outline" href="/">Check a link</Button>}>Calls appear here as they are paid.</EmptyState></div>
          <div className="stack"><Skeleton shape="title" width="lg" /><Skeleton width="full" /><Skeleton width="md" /><Skeleton shape="block" /></div>
        </Section>

        <Section title="Stat">
          <div className="stat-grid card flush">
            <Stat value={count(2140)} label="Paid calls" note="Sample note" />
            <Stat value={usd(18.42)} label="Volume" />
            <Stat value={pct(0.994)} label="Success" />
            <Stat value={ms(340)} label="Median time" />
          </div>
          <div className="stat-cards">
            <Card><Stat small value={usd(0.002)} label="Price from" /></Card>
            <Card><Stat small value={ago(now - 12_000, now)} label="Last call" /></Card>
          </div>
        </Section>

        <Section title="DataTable">
          <DataTable label="Sample calls" title="Sample calls" aside="Page 1 updates live">
            <thead><tr><th>Service</th><th>Paid with</th><th className="r">Amount</th><th>Status</th><th className="r">Time</th><th>A very wide column to make the table scroll inside its own box</th><th>Another wide column that keeps going on and on</th></tr></thead>
            <tbody>
              <tr><td>Sample service</td><td><Rail rail="near" /></td><td className="r semi">{usd(0.01)}</td><td><Badge tone="success">Paid</Badge></td><td className="r small muted">{ms(340)}</td><td className="small muted">example.com/v1/sample</td><td className="small muted">sample</td></tr>
              <tr><td>Sample service</td><td><Rail rail="credits" /></td><td className="r semi">{usd(0.002)}</td><td><Badge tone="danger">502 · free</Badge></td><td className="r small muted">{ms(1840)}</td><td className="small muted">example.com/v1/other</td><td className="small muted">sample</td></tr>
            </tbody>
          </DataTable>
        </Section>

        <Section title="CodeBlock">
          <CodeBlock code={'$ curl https://example.com/v1/sample\n200 OK'}>
            <span className="p">$</span> curl https://example.com/v1/sample{'\n'}<span className="ok">200 OK</span>
          </CodeBlock>
          <CodeBlock code={'A long line that wraps instead of scrolling sideways: the quick brown fox jumps over the lazy dog, again and again, so the line is long.'} wrap />
          <CodeBlock code={'curl https://example.com/a-very-long-sample-address-that-does-not-wrap/and/keeps/going/and/going/and/going/until/it/scrolls/inside/its/own/box'} />
        </Section>

        <Section title="Charts">
          <div className="grid g2">
            <Card><CardHead title="BarChart, 30 days" /><BarChart data={days} label="Sample paid calls per day" /></Card>
            <Card><CardHead title="BarChart, dollars" /><BarChart data={days.slice(0, 7).map(d => ({ ...d, value: d.value / 10 }))} unit="usd" label="Sample volume per day" /></Card>
            <Card><CardHead title="BarChart, empty series" /><BarChart data={[]} label="Empty chart" /></Card>
            <Card><CardHead title="BarChart, all zeros" /><BarChart data={days.slice(0, 7).map(d => ({ ...d, value: 0 }))} label="Chart of zeros" /></Card>
            <Card>
              <CardHead title="BarList" />
              <BarList items={[
                { label: <Rail rail="near" />, value: 662, tone: 'near' },
                { label: <Rail rail="base" />, value: 506 },
                { label: <Rail rail="credits" />, value: 467 },
                { label: <Rail rail="solana" />, value: 195, tone: 'dim' },
              ]}
              />
            </Card>
            <Card><CardHead title="BarList, empty" /><BarList items={[]} /></Card>
            <Card><CardHead title="Sparkline" /><div className="row"><Sparkline values={[3, 5, 4, 8, 6, 9, 12]} label="Sample trend" /><Sparkline values={[4]} /><Sparkline values={[]} /></div></Card>
          </div>
        </Section>

        <Section title="Icons">
          <div className="row dev-icons">{iconNames.map(name => <span key={name} className="tile" title={name}><Icon name={name} /></span>)}</div>
        </Section>

        <Section title="Agent view">
          <PageView agent={{ title: 'Sample page', markdown: sampleMarkdown, json: sampleJson, requests: [{ method: 'GET', url: 'https://api.example.com/v1/sample', note: 'Sample request' }, { method: 'POST', url: 'https://api.example.com/v1/sample', note: 'Another sample request' }], markdownUrl: 'https://example.com/sample.md' }}>
            <Card><p className="small muted">This block is the page for people. Press <b>Agent</b> in the header and it becomes the Agent view. Press <b>Human</b> to return.</p></Card>
          </PageView>
          <AgentView title="Sample page" markdown={sampleMarkdown} json={sampleJson} requests={[{ method: 'GET', url: 'https://api.example.com/v1/sample', note: 'Sample request' }, { method: 'SSE', url: 'https://api.example.com/v1/stream', note: 'A sample stream' }, { method: 'DELETE', url: 'https://api.example.com/v1/sample/1', note: 'A sample delete' }]} markdownUrl="https://example.com/sample.md" />
        </Section>
      </div>
    </div>
  );
};

export default Components;
