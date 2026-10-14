import { describe, expect, it } from "vitest";
import { createGitHubClientFactory } from "../../src/github/client-factory.js";
import { TEST_PRIVATE_KEY } from "../helpers/config.js";
import { createFakeGitHubFetch, verifyAppJwt } from "../helpers/fake-github.js";

const APP_ID = 12345;

function factory(
  fake: ReturnType<typeof createFakeGitHubFetch>,
  baseUrl = "https://api.github.com",
) {
  return createGitHubClientFactory({
    appId: APP_ID,
    privateKey: TEST_PRIVATE_KEY,
    baseUrl,
    fetch: fake.fetch,
  });
}

describe("github client factory", () => {
  it("U-GH-1 forInstallation requests an access token with an app JWT, then calls the API with the token", async () => {
    const fake = createFakeGitHubFetch();
    const client = await factory(fake).forInstallation(1000001);
    await client.request("GET /rate_limit");

    const tokenReq = fake.requests[0];
    expect(tokenReq?.method).toBe("POST");
    expect(tokenReq?.url).toBe("https://api.github.com/app/installations/1000001/access_tokens");
    expect(tokenReq?.authorization).toMatch(/^bearer /i);
    const claims = verifyAppJwt((tokenReq?.authorization ?? "").slice("bearer ".length));
    expect(String(claims.iss)).toBe(String(APP_ID));

    const apiReq = fake.requests.find((r) => r.url.endsWith("/rate_limit"));
    expect(apiReq?.authorization).toBe(`token ${fake.token}`);
  });

  it("U-GH-2 two forInstallation calls within token lifetime make one access-token request", async () => {
    const fake = createFakeGitHubFetch();
    const f = factory(fake);
    const a = await f.forInstallation(1000001);
    await a.request("GET /rate_limit");
    const b = await f.forInstallation(1000001);
    await b.request("GET /rate_limit");
    expect(fake.accessTokenRequests()).toHaveLength(1);
  });

  it("U-GH-3 a custom baseUrl is used for all requests", async () => {
    const fake = createFakeGitHubFetch();
    const client = await factory(fake, "http://localhost:9999/api/v3").forInstallation(1000001);
    await client.request("GET /rate_limit");
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    for (const r of fake.requests) {
      expect(r.url.startsWith("http://localhost:9999/api/v3/")).toBe(true);
    }
  });
});
