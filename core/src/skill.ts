// The Taasky skill lives in taasky-docs and is copied into agents (ClawHub,
// Hermes, OpenClaw installs), where a copy can sit on an old version for
// good. The server names the current one, and the skill tells an agent with
// an older copy to fetch it again. Bump this after a new skill.md is live on
// docs.taasky.ai; .github/workflows/skill-version.yml checks it is.

export const SKILL_VERSION = "0.4.0";

/** Versioned, so docs.taasky.ai's day-long cache never serves an old copy (taasky-docs). */
export const SKILL_URL = `https://docs.taasky.ai/.well-known/agent-skills/taasky/skill.md?v=${SKILL_VERSION}`;

/** In every result that starts a negotiation, and in the instructions. */
export const skill = { skill_version: SKILL_VERSION, skill_url: SKILL_URL };
