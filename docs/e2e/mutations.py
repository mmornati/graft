"""Mutation checks for the live e2e runner (spec 11 and 14). Each mutation is applied alone to
the file, the named tests must fail, and the file is restored.
Usage: python3 docs/e2e/mutations.py [M1 N3 ...]   (no argument: all). Needs `pnpm db:up`."""
import subprocess,sys
import os
R=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))+'/'
U='--project unit'
I='--project integration'
M=[
("M1","src/e2e/guard.ts","  if (READ.has(method)) return;\n","  if (READ.has(method)) return;\n  if (method === \"POST\") return;\n",U,"test/unit/live-e2e-guard.test.ts"),
("M2","src/e2e/report.ts","const json = `${secrets.redact(JSON.stringify(reportSchema.parse(report), null, 2))}\\n`;","const json = `${JSON.stringify(reportSchema.parse(report), null, 2)}\\n`;",U,"test/unit/live-e2e-secrets.test.ts"),
("M3","src/e2e/invariants.ts","  const kind = hit.sentinel.slice(-1);\n","  const kind = hit.sentinel.slice(-1);\n  if (hit.table.startsWith(`${o.pgbossSchema}.`)) return { sentinel: hit.sentinel, kind, table: hit.table, key: hit.key, class: \"accounted\" };\n",U,"test/unit/live-e2e-invariants.test.ts"),
("M4","src/e2e/waiters.ts","delay = Math.min(delay * factor, max);","delay = initial;",U,"test/unit/live-e2e-wait.test.ts"),
("M5","src/e2e/observe.ts","  return (await octokit.paginate(method as never, { per_page: 100, ...params } as never)) as T[];","  return (await (method as never as (p: unknown) => Promise<{ data: T[] }>)({ per_page: 100, ...params })).data;",U,"test/unit/live-e2e-invariants.test.ts"),
("M6","src/e2e/assumptions.ts","e.probe === i.appId && e.actor === i.appId","e.probe === String(i.appId) && e.actor === String(i.appId)",U,"test/unit/live-e2e-assume.test.ts"),
("M7","src/bin/graft-ops.ts","listChangesToPoll(r.db, r.deps.now(), { installationId })","listChangesToPoll(r.db, r.deps.now(), {})",I,"test/integration/live-e2e-ops.test.ts"),
("M8","src/e2e/cleanup.ts","const prefix = runId === \"all\" ? \"heads/graft-e2e/\" : `heads/graft-e2e/${runId}/`;","const prefix = \"heads/graft-e2e/\";",I,"test/integration/live-e2e-commands.test.ts -t I-LIVE-CLEAN-1"),
("M9","src/e2e/cost.ts","<= b.maxUsd","< b.maxUsd",U,"test/unit/live-e2e-plan.test.ts"),
("M10","src/e2e/run.ts","      io.out(`== ${def.id} ${def.title}\\n`);\n","      io.out(`== ${def.id} ${def.title}\\n`);\n      if (def.id === \"s08\") await run.clients.actor.rest.reactions.createForIssueComment({ owner: run.owner, repo: run.repo, comment_id: 1, content: \"+1\" }).catch(() => undefined);\n",I,"test/integration/live-e2e-commands.test.ts -t U-LIVE-PLAN-2"),
("M11","src/e2e/assumptions.ts","const allPass = mapped.every(","const allPass = mapped.some(",U,"test/unit/live-e2e-report.test.ts test/unit/live-e2e-assume.test.ts"),
("M12","src/e2e/scenarios/s01.ts","eq(\"model\", \"s01.card.risk\", \"trivial\", card?.riskClass ?? null),","assertion(\"model\", \"s01.card.risk\", \"trivial\", card?.riskClass ?? null, card?.riskClass === \"trivial\" || card?.riskClass === \"logic\"),",U,"test/unit/live-e2e-scenarios.test.ts"),
("M13","src/e2e/preflight.ts","if (value !== \"\" && (value === actorToken || value === outsiderToken)) {","if (false) {",U,"test/unit/live-e2e-guard.test.ts"),
("N1","src/modules/intent/job.ts","exec(provenance.fields.task?.value ?? \"\")","exec(\"\")",I,"test/integration/intent-task.test.ts"),
("N2","src/modules/pilot/reviewers.ts","  if (!change) {\n    // A request made as the PR","  if (!change) return \"skipped\";\n  if (!change) {\n    // A request made as the PR",I,"test/integration/pilot-module.test.ts"),
("N3","src/modules/pilot/reviewers.ts","      if (await timelineShowsRequest(octokit, data, claimed.id)) {","      if (true as boolean) {",I,"test/integration/pilot-module.test.ts"),
("N4","src/e2e/preflight.ts","if (problems.length > 0) throw failed(\"installation_scope\", scopeMessage(problems));","",I,"test/integration/live-e2e-commands.test.ts -t installation"),
("N5","src/e2e/hooks.ts","    if (payload.repository?.id !== o.repositoryId) continue;\n","",U,"test/unit/live-e2e-guard.test.ts"),
("N6","src/e2e/assumptions.ts","  \"s1-install\": \"note\",","  \"s1-install\": \"tick\",",U,"test/unit/live-e2e-report.test.ts"),
("N7","src/e2e/clients.ts","      throw new GuardRefusal(`${method} was answered with a redirect (HTTP ${response.status})`);","",U,"test/unit/live-e2e-guard.test.ts"),
("N8","src/e2e/guard.ts","    if (method === \"POST\" && rest === \"/pulls\") return true;","    if (/^\\/pulls/.test(rest)) return true;",U,"test/unit/live-e2e-guard.test.ts"),
("N9","src/e2e/scenarios/s05.ts","o.h0 !== null && v?.policyHash === o.h0","o.h0 === null || v?.policyHash === o.h0",U,"test/unit/live-e2e-scenarios.test.ts"),
("N10","src/e2e/git-pusher.ts","{ ...o, env: { ...GIT_ISOLATION, ...(o.env ?? {}) } }","o",U,"test/unit/live-e2e-secrets.test.ts"),
("N11","src/e2e/scenarios/s02.ts","title.toLowerCase().includes(`@${env.owner.toLowerCase()}/platform`)","true",U,"test/unit/live-e2e-scenarios.test.ts"),
("N12","src/modules/pilot/reviewers.ts","    if ((await ensureRepository(ctx.db, data.installationId, pull.base.repo, now)) === \"removed\") {","    if (false as boolean) {",I,"test/integration/pilot-module.test.ts"),
("N13","src/modules/pilot/reviewers.ts","  if (s.kind === \"provenance_published\") {","  if (false as boolean) {",I,"test/integration/pilot-module.test.ts"),
("N14","src/e2e/preflight.ts","if (reached.full_name.toLowerCase() !== sandbox.repo.toLowerCase()) {","if (false as boolean) {",I,"test/integration/live-e2e-commands.test.ts -t renamed"),
("N15","src/e2e/setup.ts","if (created.data.full_name.toLowerCase() !== sandbox.repo.toLowerCase()) {","if (false as boolean) {",I,"test/integration/live-e2e-commands.test.ts -t \"created repository\""),
("N16","src/e2e/child-env.ts","    if (k.startsWith(\"GRAFT_E2E_\")) continue;\n","",U,"test/unit/live-e2e-secrets.test.ts"),
("N17","src/e2e/child-env.ts","    if (command === \"git\" && k.startsWith(\"GIT_\")) continue;\n","",U,"test/unit/live-e2e-secrets.test.ts"),
("N18","src/e2e/guard.ts","if (ctx.installationId !== undefined && Number(mint[1]) === ctx.installationId) return;","if (ctx.installationId === undefined || Number(mint[1]) === ctx.installationId) return;",U,"test/unit/live-e2e-guard.test.ts"),
("N20","src/e2e/git-pusher.ts","  GIT_CONFIG_GLOBAL: \"/dev/null\",\n","",U,"test/unit/live-e2e-secrets.test.ts"),
]
only=sys.argv[1:]
for name,f,old,new,proj,tests in M:
    if only and name not in only: continue
    s=open(R+f).read()
    if old not in s: print(name,"PATTERN NOT FOUND");continue
    open(R+f,'w').write(s.replace(old,new,1))
    try:
        r=subprocess.run(f"npx vitest run {proj} {tests}",shell=True,cwd=R,capture_output=True,text=True,timeout=900)
        out=r.stdout+r.stderr
        failed=[l.strip() for l in out.splitlines() if l.strip().startswith("×")]
        print(name,"CAUGHT" if r.returncode!=0 else "NOT CAUGHT",failed[:2])
    finally:
        open(R+f,'w').write(s)
