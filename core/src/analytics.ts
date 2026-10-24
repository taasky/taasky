// Product analytics: server-side events to PostHog (EU), the same project the
// portal reports to. What we measure is the network, not signups: how many
// negotiations end agreed between two accounts, in how many rounds, and where
// people drop off (PROTOCOL.md §6). Events carry opaque ids and protocol
// facts only — never terms, labels, names or chat ids.
//
// Sending happens after the response, through ctx.waitUntil, and a failure is
// logged and dropped: analytics must never cost a move.

const HOST = "https://eu.i.posthog.com";

export type Props = Record<string, string | number | boolean | null | undefined>;

export interface Analytics {
  /** `distinctId` is a Taasky user id. */
  capture(distinctId: string, event: string, props?: Props): void;
  /** Whether a user is one of ours (tests, demos), so dashboards can filter them out. */
  isInternal(userId: string): boolean;
}

export const noAnalytics: Analytics = { capture() {}, isInternal: () => false };

export interface AnalyticsEnv {
  POSTHOG_KEY?: string;
  /** Comma-separated user ids whose events are marked internal. */
  INTERNAL_USERS?: string;
  /** Under `wrangler dev`, events without a key go to the log instead. */
  DEV_MODE?: string;
}

export function analytics(env: AnalyticsEnv, ctx: Pick<ExecutionContext, "waitUntil">): Analytics {
  const internal = new Set(
    (env.INTERNAL_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const isInternal = (userId: string) => internal.has(userId);
  const key = env.POSTHOG_KEY;
  if (!key) {
    if (env.DEV_MODE !== "1") return noAnalytics;
    return {
      isInternal,
      capture: (distinctId, event, props) =>
        console.log(JSON.stringify({ analytics: event, distinct_id: distinctId, ...props })),
    };
  }
  return {
    isInternal,
    capture(distinctId, event, props = {}) {
      const body = {
        api_key: key,
        event,
        distinct_id: distinctId,
        timestamp: new Date().toISOString(),
        properties: {
          ...props,
          source: "taasky-mcp",
          internal: isInternal(distinctId) || props.internal === true,
          // Ids are opaque, there is nothing to put on a person profile.
          $process_person_profile: false,
        },
      };
      ctx.waitUntil(
        fetch(`${HOST}/i/v0/e/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then(
          (res) => {
            if (!res.ok)
              console.error(JSON.stringify({ event: "posthog_failed", status: res.status }));
          },
          (e) => console.error(JSON.stringify({ event: "posthog_failed", error: String(e) })),
        ),
      );
    },
  };
}
