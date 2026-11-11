import type { SiteSettings } from '../config';
import { agentPrompt } from '../content/home';
import { agentsDescription, agentsTitle, apiText, endpointGroups, fileCards, hero, llmsText, startSteps, startText } from '../agents/content';
import { endpointUrl } from '../agents/endpoints';
import { curlById } from '../agents/examples';
import { platformGuide } from '../agents/guide';
import { agentLinks } from '../agents/links';

// The For agents page as Markdown: the same text, the same commands, the same endpoint list.

const cell = (text: string): string => text.replaceAll('|', '\\|');

/** `/agents.md` */
export const agentsMarkdown = (settings: SiteSettings): string => {
  const { siteUrl } = settings;
  const links = agentLinks(settings);
  const cards = fileCards(settings);

  const steps = startSteps(settings).map(step => `### ${step.number}. ${step.title}${step.optional === true ? ' (optional)' : ''}

\`\`\`sh
${curlById(settings, step.example)}
\`\`\`

Answer: \`${step.answer}\`

${step.note}`).join('\n\n');

  const api = endpointGroups().map(({ title, endpoints }) => `### ${title}

| Method | Address | What it does | Who may call it | State |
|---|---|---|---|---|
${endpoints.map(endpoint => `| ${endpoint.method} | \`${cell(endpointUrl(settings, endpoint))}\` | ${cell(endpoint.summary)} | ${cell(endpoint.who)} | Built |`).join('\n')}`).join('\n\n');

  return `# ${agentsTitle}

> ${agentsDescription}

${hero.line}

${hero.lead}

## ${hero.promptLabel}

\`\`\`
${agentPrompt(siteUrl)}
\`\`\`

${hero.wallet}

## What an agent reads

- [${cards.llms.title}](${cards.llms.href}): ${cards.llms.text}
- [${cards.skill.title}](${cards.skill.href}): ${cards.skill.text}
- [${cards.openapi.title}, API host](${cards.openapi.api}) and [pay host](${cards.openapi.pay}): ${cards.openapi.text}
- [${cards.twin.title}](${cards.twin.href}): ${cards.twin.text}
- [llms-full.txt](${links.llmsFull}): every endpoint, request and answer in one file

## ${startText.heading}

${startText.lead}

${steps}

## ${apiText.heading}

${apiText.lead}

${api}

## ${llmsText.heading}

${llmsText.lead}

\`\`\`\`text
${platformGuide(settings)}\`\`\`\`
`;
};
