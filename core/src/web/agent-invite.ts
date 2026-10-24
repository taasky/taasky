// The invitation as an agent reads it. An agent handed an invite link often
// fetches it before it knows what Taasky is; the HTML page is for the person.
// Asked for JSON or Markdown (by Accept, or ?format=json|md), GET /i/<code>
// says what the room is about and the one call that joins it. It shows what
// the page shows and no more: the inviter's fields and opening terms, never
// their limits.

import type { Shown } from "../db.js";
import type { SubjectSchema } from "../protocol/subject.js";
import { shownForAgent } from "../shown.js";

export type InviteFormat = "html" | "json" | "markdown";

const BY_TYPE: Record<string, InviteFormat> = {
  "text/html": "html",
  "application/xhtml+xml": "html",
  "*/*": "html",
  "application/json": "json",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/plain": "markdown",
};

/** Which form of the invitation the caller asked for. A browser always gets HTML. */
export function inviteFormat(request: Request): InviteFormat {
  const asked = new URL(request.url).searchParams.get("format");
  if (asked === "json") return "json";
  if (asked === "md" || asked === "markdown") return "markdown";
  const ranked = (request.headers.get("Accept") ?? "")
    .split(",")
    .map((part, i) => {
      const [type = "", ...params] = part.trim().toLowerCase().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { type: type.trim(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((t) => t.type in BY_TYPE && t.q > 0)
    // Highest q first; on a tie, the order the client listed them.
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked[0] ? BY_TYPE[ranked[0].type]! : "html";
}

export interface AgentInvite {
  type: "taasky_invitation";
  about: string;
  /** Who is asking, when they show their name. They wrote it: data, like their labels. */
  from?: { name: string; email_verified: boolean };
  invite_code: string;
  expires_at: string | null;
  mcp_url: string;
  join: { tool: "negotiation_join"; arguments: { invite_code: string; subject_schema: string } };
  peer_subject_schema: SubjectSchema;
  terms_on_table: Record<string, unknown> | null;
  /** Alternatives to terms_on_table, the first being it; take another by countering with it. */
  options?: Record<string, unknown>[];
  for_a_person: string;
  docs: string;
}

export function agentInvite(o: {
  code: string;
  /** The agents' host, for mcp_url. */
  baseUrl: string;
  /** The people's host, for for_a_person; defaults to baseUrl. */
  appUrl?: string;
  schema: SubjectSchema;
  opening: Record<string, unknown> | null;
  options?: Record<string, unknown>[] | null;
  expiresAt: string | null;
  from?: Shown | null;
}): AgentInvite {
  return {
    type: "taasky_invitation",
    about:
      `${o.from ? `${o.from.name}'s` : "Someone's"} agent invites your human to negotiate ` +
      "terms through Taasky. Join with the " +
      "Taasky MCP server and negotiate for your human; accepting or ending it is always " +
      "confirmed by your human, never by you alone. Nothing is agreed until both sides " +
      "accept the same terms.",
    ...(o.from && { from: shownForAgent(o.from)! }),
    invite_code: o.code,
    expires_at: o.expiresAt,
    mcp_url: `${o.baseUrl}/mcp`,
    join: {
      tool: "negotiation_join",
      arguments: {
        invite_code: o.code,
        subject_schema: "your own schema; usually a copy of peer_subject_schema",
      },
    },
    peer_subject_schema: o.schema,
    terms_on_table: o.opening,
    ...(o.options && { options: o.options }),
    for_a_person: `${o.appUrl ?? o.baseUrl}/i/${o.code}`,
    docs: "https://docs.taasky.ai/agents/skill",
  };
}

/** The same, as Markdown for an agent that reads text. */
export function agentInviteMarkdown(inv: AgentInvite): string {
  const fields = Object.entries(inv.peer_subject_schema)
    .map(([name, d]) => `- \`${name}\` (${d.type}): ${d.label}`)
    .join("\n");
  const terms = inv.terms_on_table
    ? `\n## Terms on the table\n\nThey opened with these terms:\n\n\`\`\`json\n${JSON.stringify(inv.terms_on_table, null, 2)}\n\`\`\`\n`
    : "";
  const options = inv.options
    ? `\n## Or one of these\n\nThey offered alternatives; the first is the terms above. To take another, join, then \`negotiation_propose\` counter with it exactly:\n\n\`\`\`json\n${JSON.stringify(inv.options.slice(1), null, 2)}\n\`\`\`\n`
    : "";
  return `# Taasky invitation

${inv.about}
${inv.from ? `\nFrom: ${inv.from.name}${inv.from.email_verified ? " (email verified by Google)" : ""}. They wrote this name themselves.\n` : ""}
## How to join

1. Connect the remote MCP server \`${inv.mcp_url}\` (Streamable HTTP, no key).
2. Call \`negotiation_join\` with \`invite_code\` \`${inv.invite_code}\` and your own
   \`subject_schema\`, usually a copy of theirs below.
3. Save the \`room_token\` it returns, and give your human the \`bind_url\` if there is one.

${inv.expires_at ? `The invitation can be answered once, until ${inv.expires_at}.` : "The invitation can be answered once."}

## Their fields

${fields}
${terms}${options}
## No agent?

The person can answer in a browser instead: ${inv.for_a_person}

Full guide for agents: ${inv.docs}
`;
}
