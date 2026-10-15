/** GitHub's webhook delivery log for the App (JWT-authenticated reads). */
import type { GitHubClient } from "../github/client-factory.js";

export interface DeliveryItem {
  id: number;
  guid: string;
  deliveredAt: string;
  redelivery: boolean;
  statusCode: number;
  event: string;
  action: string | null;
  installationId: number | null;
  repositoryId: number | null;
}

export async function listDeliveries(app: GitHubClient, pages = 1): Promise<DeliveryItem[]> {
  const out: DeliveryItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const res = await app.rest.apps.listWebhookDeliveries({
      per_page: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const d of res.data) {
      out.push({
        id: d.id,
        guid: d.guid,
        deliveredAt: d.delivered_at,
        redelivery: d.redelivery,
        statusCode: d.status_code,
        event: d.event,
        action: d.action ?? null,
        installationId: d.installation_id ?? null,
        repositoryId: d.repository_id ?? null,
      });
    }
    const link = String((res.headers as { link?: string }).link ?? "");
    const next = /<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/.exec(link);
    if (!next) break;
    cursor = decodeURIComponent(next[1] as string);
  }
  return out;
}

export async function deliveryPayload(app: GitHubClient, id: number): Promise<unknown> {
  const res = await app.rest.apps.getWebhookDelivery({ delivery_id: id });
  return (res.data as { request?: { payload?: unknown } }).request?.payload;
}

/**
 * The first delivery (newest first) of an event for this installation, this repository and this
 * pull request number. The number alone is not enough: another repository's PR can carry it, and
 * redelivering that webhook would make Graft process a PR outside the sandbox.
 */
export async function findPrDelivery(
  app: GitHubClient,
  o: {
    event: string;
    action: string;
    installationId: number;
    repositoryId: number;
    prNumber: number;
    redelivery: boolean;
    exceptId?: number;
    minId?: number;
  },
): Promise<DeliveryItem | null> {
  const list = await listDeliveries(app, 2);
  for (const d of list) {
    if (d.event !== o.event || d.action !== o.action || d.redelivery !== o.redelivery) continue;
    if (d.installationId !== o.installationId) continue;
    if (d.repositoryId !== null && d.repositoryId !== o.repositoryId) continue;
    if (o.exceptId !== undefined && d.id === o.exceptId) continue;
    if (o.minId !== undefined && d.id <= o.minId) continue;
    const payload = (await deliveryPayload(app, d.id)) as {
      pull_request?: { number?: number };
      repository?: { id?: number };
      installation?: { id?: number };
    };
    if (payload?.pull_request?.number !== o.prNumber) continue;
    if (payload.repository?.id !== o.repositoryId) continue;
    if (payload.installation?.id !== o.installationId) continue;
    return d;
  }
  return null;
}
