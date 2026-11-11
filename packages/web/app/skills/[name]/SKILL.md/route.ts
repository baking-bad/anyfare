import { textResponse } from '../../../../src/agents/links';
import { findSkill, skillDocument } from '../../../../src/agents/skill';
import { readSettings } from '../../../../src/config';

export const dynamic = 'force-dynamic';

/** An Agent Skill: `/skills/<name>/SKILL.md`. */
export const GET = async (_request: Request, { params }: { readonly params: Promise<{ readonly name: string }> }): Promise<Response> => {
  const skill = findSkill((await params).name);

  return skill
    ? textResponse(skillDocument(skill, readSettings()), 'text/markdown')
    : new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
