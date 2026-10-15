import { describe, expect, it } from "vitest";
import { RedactPatternError, redactInputs, validateRedactPattern } from "../../src/eval/redact.js";
import { allocate, mulberry32, pathStratum, sample, sizeStratum } from "../../src/eval/sample.js";
import { computeRiskFloor } from "../../src/modules/intent/index.js";
import { cardInputs, cf } from "../helpers/eval-fixtures.js";

// Built in pieces so that no secret-looking literal sits in the repository.
const AWS = `AKIA${"ABCDEFGHIJKLMNOP"}`;
const GH = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;
const ANT = `sk-ant-${"api03-abcdefghijklmnopqrstu"}`;
const SLACK = `xoxb-${"1234567890-abcdefghij"}`;
const JWT = `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkw"}.${"SflKxwRJSMeKKF2QT4fwpM"}`;

const withBody = (body: string, files = [cf("src/a.ts")]) => {
  const i = cardInputs(files);
  return { ...i, pr: { ...i.pr, body } };
};

describe("eval redaction", () => {
  it("U-RED-1 each secret kind is replaced, counted, and the value appears nowhere", () => {
    const cases: [string, string][] = [
      ["aws_key", `key ${AWS} end`],
      ["github_token", `token ${GH} end`],
      ["anthropic_key", `k ${ANT}`],
      ["slack_token", `s ${SLACK}`],
      ["jwt", `j ${JWT}`],
      ["private_key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----"],
      ["assignment", "password = hunter22hunter22"],
    ];
    for (const [kind, text] of cases) {
      const { inputs, redactions } = redactInputs(withBody(text));
      const kinds = redactions.map((r) => r.kind);
      expect(kinds, kind).toContain(kind === "assignment" ? "assignment" : kind);
      expect(inputs.pr.body, kind).toContain(`[REDACTED:${kind}]`);
      for (const secret of [AWS, GH, ANT, SLACK, JWT, "MIIEfake", "hunter22hunter22"]) {
        expect(JSON.stringify(inputs), kind).not.toContain(secret);
      }
    }
    const both = redactInputs(withBody(`${AWS} and ${AWS}`));
    expect(both.redactions).toEqual([{ kind: "aws_key", count: 2 }]);
    expect(JSON.stringify(both.redactions)).not.toContain(AWS);
  });

  it("U-RED-2 a patch keeps its line count and prefixes, including a multi-line private key", () => {
    const patch = [
      "@@ -1,2 +1,6 @@",
      " context",
      "+-----BEGIN OPENSSH PRIVATE KEY-----",
      "+b3BlbnNzaC1rZXktdjEAAAAA",
      "+AAAAB3NzaC1yc2EAAAADAQAB",
      "+-----END OPENSSH PRIVATE KEY-----",
      `-removed ${AWS}`,
      " after",
    ].join("\n");
    const input = cardInputs([cf("src/k.ts", { patch })]);
    const out = redactInputs(input).inputs.files[0]?.patch as string;
    expect(out.split("\n")).toHaveLength(patch.split("\n").length);
    expect(out.split("\n").map((l) => l[0])).toEqual(patch.split("\n").map((l) => l[0]));
    expect(out).not.toContain("b3BlbnNzaC1");
    expect(out).not.toContain(AWS);
    expect(out).toContain("+[REDACTED:private_key]");
    expect(redactInputs(input).redactions).toContainEqual({ kind: "private_key", count: 1 });
  });

  it("U-RED-3 assignment keeps the name and operator and replaces only the value; short values stay", () => {
    const out = redactInputs(
      withBody('API_KEY = "abcdefgh12345"\nmy token: short\npassword=1234567'),
    ).inputs.pr.body;
    expect(out).toContain('API_KEY = "[REDACTED:assignment]"');
    expect(out).toContain("my token: short");
    expect(out).toContain("password=1234567");
  });

  it("U-RED-4 emails are untouched by default; on, they are replaced except noreply@anthropic.com", () => {
    const text =
      "mail jane.doe@corp.example, co-author noreply@anthropic.com and 1+bot@users.noreply.github.com";
    expect(redactInputs(withBody(text)).inputs.pr.body).toBe(text);
    const on = redactInputs(withBody(text), { emails: true });
    expect(on.inputs.pr.body).toBe(
      "mail [REDACTED:email], co-author noreply@anthropic.com and 1+bot@users.noreply.github.com",
    );
    expect(on.redactions).toEqual([{ kind: "email", count: 1 }]);
  });

  it("U-RED-5 paths, statuses and counts are byte-identical, and the path floor reasons do not change", () => {
    const files = [
      cf(".github/workflows/ci.yml", { patch: `@@ -1 +1 @@\n+key ${AWS}` }),
      cf("src/auth/session.ts", { status: "renamed", previousPath: "src/a.ts" }),
    ];
    const input = cardInputs(files);
    const out = redactInputs(input, {
      emails: true,
      hosts: ["corp.example"],
      patterns: ["ACME-[0-9]+"],
    }).inputs;
    const strip = (i: typeof input) => i.files.map(({ patch: _p, ...rest }) => rest);
    expect(strip(out)).toEqual(strip(input));
    expect(out.pr.additions).toBe(input.pr.additions);
    expect(out.pr.changedFiles).toBe(input.pr.changedFiles);
    const floor = (i: typeof input) =>
      computeRiskFloor(
        {
          files: i.files,
          pr: i.pr,
          listingTruncated: false,
          tooLarge: false,
          partialPaths: [],
          untrustedTexts: [],
        },
        { extraSensitiveGlobs: [] },
      ).reasons;
    expect(floor(out)).toEqual(floor(input));
  });

  it("U-RED-6 --redact-host replaces the host and its subdomains, not a look-alike", () => {
    const text = "see https://api.corp.example/v1 and corp.example and notcorp.example";
    const out = redactInputs(withBody(text), { hosts: ["corp.example"] });
    expect(out.inputs.pr.body).toBe(
      "see https://[REDACTED:host]/v1 and [REDACTED:host] and notcorp.example",
    );
    expect(out.redactions).toEqual([{ kind: "host", count: 2 }]);
    const custom = redactInputs(withBody("ticket ACME-123456 here"), {
      patterns: ["ACME-[0-9]{6}"],
    });
    expect(custom.inputs.pr.body).toBe("ticket [REDACTED:custom] here");
  });
});

/** A patch whose every line shape the redactor must keep: hunk header, context, added, removed. */
function patchOf(...secretLines: string[]): string {
  return [
    "@@ -1,3 +1,3 @@ function f()",
    " context line",
    ...secretLines.map((l, i) => (i % 2 === 0 ? `+${l}` : `-${l}`)),
    " trailing context",
  ].join("\n");
}

function redactPatch(patch: string) {
  const input = cardInputs([cf("src/k.ts", { patch })]);
  const r = redactInputs(input);
  return { out: r.inputs.files[0]?.patch as string, redactions: r.redactions };
}

const prefixes = (p: string) => p.split("\n").map((l) => (l.startsWith("@@") ? "@@" : l[0]));

// Forms from the step 4 review: [label, line, secret that must vanish].
const PW = "hunter2hunter2";
const FORMS: [string, string, string][] = [
  ["DB_PASSWORD", `DB_PASSWORD=${PW}`, PW],
  [
    "AWS_SECRET_ACCESS_KEY",
    `AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI${"K7MDENGbPxRfi"}`,
    "wJalrXUtnFEMI",
  ],
  ["lower-case aws", `aws_secret_access_key = ${PW}`, PW],
  ["GITHUB_TOKEN", `GITHUB_TOKEN=${PW}`, PW],
  ["SECRET_KEY_BASE", `SECRET_KEY_BASE=${PW}`, PW],
  ["client_secret yaml", `client_secret: ${PW}`, PW],
  ["access_token quoted", `access_token = "${PW}"`, PW],
  ["dotted key", `app.db.password = ${PW}`, PW],
  ["dashed key", `db-password: ${PW}`, PW],
  ["camelCase key", `const clientSecret = "${PW}";`, PW],
  ["export in .env", `export STRIPE_API_KEY=${PW}`, PW],
  ["json key", `  "password": "${PW}",`, PW],
  ["json single quotes", `'api_key': '${PW}'`, PW],
  ["escaped json", `\\"password\\": \\"${PW}\\"`, PW],
  ["quoted with spaces", `password: "correct horse battery staple"`, "correct horse"],
  ["walrus", `PASSWORD := "${PW}"`, PW],
  ["fat arrow", `token => "${PW}"`, PW],
  ["strict equality", `if (password === "${PW}") {`, PW],
  ["pwd", `pwd=${PW}`, PW],
  ["bcrypt hash", `password_hash = $2b$12$${"abcdefghijklmnopqrstuv"}`, "abcdefghijklmnopqrstuv"],
  ["dollar-led password", `password=$ecretPass1`, "ecretPass1"],
  ["xml element", `<password>${PW}</password>`, PW],
  ["cli flag", `run --password=${PW}`, PW],
  ["url credentials", `postgres://admin:S3cretPassw0rd@db.internal/app`, "S3cretPassw0rd"],
  ["bearer", `Authorization: Bearer ${"abcDEF123456"}ghijklmnop`, "abcDEF123456"],
  [
    "basic in curl",
    `curl -H "Authorization: Basic ${"dXNlcjpwYXNzd29yZA"}=="`,
    "dXNlcjpwYXNzd29yZA",
  ],
  ["stripe live", `key=sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`, "4eC39HqLyjWDarjtT1zdp7dc"],
  ["stripe restricted", `rk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`, "4eC39HqLyjWDarjtT1zdp7dc"],
  [
    "openai",
    `OPENAI=sk-${"proj-abcdefghijklmnopqrstuvwxyz0123"}`,
    "abcdefghijklmnopqrstuvwxyz0123",
  ],
  ["google api key", `AIza${"SyA1234567890abcdefghijklmnopqrstuv"}`, "SyA1234567890"],
  ["gitlab", `glpat-${"abcdefghijklmnopqrstuvwx"}`, "abcdefghijklmnopqrstuvwx"],
  [
    "npm",
    `//registry.npmjs.org/:_authToken=npm_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`,
    "a1B2c3D4e5F6g7H8",
  ],
  ["github oauth", `gho_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`, "a1B2c3D4e5F6g7H8"],
  ["github server", `ghs_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`, "a1B2c3D4e5F6g7H8"],
  [
    "github pat",
    `github_pat_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2"}`,
    "A1b2C3d4E5f6",
  ],
  ["aws session", `ASIA${"ABCDEFGHIJKLMNOP"}`, "ABCDEFGHIJKLMNOP"],
];

describe("eval redaction forms", () => {
  it("U-RED-7 every credential form is replaced, in a patch and in prose, with line count and prefixes intact", () => {
    for (const [label, line, secret] of FORMS) {
      const patch = patchOf(line, `unrelated ${line}`);
      const { out, redactions } = redactPatch(patch);
      expect(out, label).not.toContain(secret);
      expect(out.split("\n"), label).toHaveLength(patch.split("\n").length);
      expect(prefixes(out), label).toEqual(prefixes(patch));
      expect(redactions.length, label).toBeGreaterThan(0);
      expect(JSON.stringify(redactions), label).not.toContain(secret);
      const body = redactInputs(withBody(`before\n${line}\nafter`)).inputs.pr.body;
      expect(body, label).not.toContain(secret);
      expect(body.split("\n"), label).toHaveLength(3);
    }
  });

  it("U-RED-8 the key name, the operator and the surrounding quotes stay; only the value goes", () => {
    const body = (s: string) => redactInputs(withBody(s)).inputs.pr.body;
    expect(body(`DB_PASSWORD=${PW}`)).toBe("DB_PASSWORD=[REDACTED:assignment]");
    expect(body(`  "password": "${PW}",`)).toBe('  "password": "[REDACTED:assignment]",');
    expect(body(`PASSWORD := "${PW}"`)).toBe('PASSWORD := "[REDACTED:assignment]"');
    expect(body("password: 'correct horse battery staple' # note")).toBe(
      "password: '[REDACTED:assignment]' # note",
    );
    expect(body(`postgres://admin:S3cretPassw0rd@db.internal/app`)).toBe(
      "postgres://admin:[REDACTED:url_credentials]@db.internal/app",
    );
    expect(body("Authorization: Bearer abcdefghijklmnop")).toBe(
      "Authorization: Bearer [REDACTED:bearer]",
    );
    expect(body(`<token>${PW}</token>`)).toBe("<token>[REDACTED:assignment]</token>");
  });

  it("U-RED-9 a PGP private key block and a key whose end is missing keep the line count and hunk headers", () => {
    const patch = [
      "@@ -0,0 +1,6 @@",
      "+-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "+",
      "+lQdGBF2fakefakefakefake",
      "+=abcd",
      "+-----END PGP PRIVATE KEY BLOCK-----",
      "+after",
      "@@ -10,2 +16,2 @@ later hunk",
      " context",
    ].join("\n");
    const { out } = redactPatch(patch);
    expect(out).not.toContain("lQdGBF2fake");
    expect(out.split("\n")).toHaveLength(patch.split("\n").length);
    expect(prefixes(out)).toEqual(prefixes(patch));
    expect(out).toContain("+after");
    // A key that starts in one hunk and never ends: the next hunk header still survives.
    const open = [
      "@@ -1,2 +1,3 @@",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+MIIEfakekeymaterial",
      "@@ -50,2 +51,2 @@",
      " plain context",
      "\\ No newline at end of file",
    ].join("\n");
    const o = redactPatch(open).out;
    expect(o).not.toContain("MIIEfake");
    expect(prefixes(o)).toEqual(prefixes(open));
    expect(o.split("\n")[4]).toBe(" plain context");
    expect(o.split("\n")[5]).toBe("\\ No newline at end of file");
  });

  it("U-RED-10 ordinary code stays readable", () => {
    const keep = [
      "const password_length = 12;",
      "password_length = 1234567890",
      "tokenize(text, 'abcdefghijklmnop')",
      "const tokens = tokenize(input);",
      "author = 'abcdefghijklmnopqrs'",
      "const token = process.env.GITHUB_TOKEN;",
      "password = os.environ['DB_PASSWORD']",
      "secret: $" + "{{ secrets.DEPLOY_KEY }}",
      "token = <your token here>",
      "password: string;",
      "const secretName = 'abcdefghijklmnop';",
      "auth::session_manager::create()",
      "export const MAX_TOKEN_LIMIT = 100000000;",
      "see https://example.com/docs/page@2 and user@host",
      "const risk = taskList.sort();",
      "http://localhost:3000/path",
      "password = None",
    ];
    for (const line of keep) {
      const r = redactInputs(withBody(line));
      expect(r.inputs.pr.body, line).toBe(line);
      expect(r.redactions, line).toEqual([]);
    }
  });

  it("U-RED-11 documented over-redaction: a bare identifier of 8+ characters after a secret-looking name is replaced", () => {
    const body = redactInputs(withBody("const token = someLongVariableName;")).inputs.pr.body;
    expect(body).toBe("const token = [REDACTED:assignment];");
  });

  it("U-RED-12 long adversarial lines finish quickly", () => {
    const lines = [
      "a_".repeat(60_000),
      `${" ".repeat(100_000)}password`,
      `password${"=".repeat(100_000)}`,
      "-----BEGIN ".repeat(10_000),
      `sk-${"a".repeat(100_000)}`,
      `http://${"a:".repeat(30_000)}`,
      `<${"a".repeat(100_000)}`,
      `password="${"x".repeat(100_000)}`,
      `${"a.".repeat(60_000)}=`,
      "token:".repeat(30_000),
      "password = ".repeat(20_000),
      `<password>${"x".repeat(100_000)}`,
      `Authorization: Bearer ${"a".repeat(100_000)}`,
      "AKIA".repeat(30_000),
      // T14: a head inside a rejected or long value must not be scanned again.
      "password=${".repeat(20_000),
      'password="'.repeat(20_000),
      "token=$(".repeat(20_000),
      "password=a(".repeat(20_000),
      "password=process.env.".repeat(10_000),
    ];
    const started = Date.now();
    for (const line of lines) {
      const t0 = Date.now();
      const r = redactInputs(withBody(line));
      expect(r.inputs.pr.body.split("\n")).toHaveLength(1);
      expect(Date.now() - t0, line.slice(0, 20)).toBeLessThan(300);
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("U-RED-14 an unquoted value ends at a terminator; null, short and member values stay", () => {
    const body = (t: string) => redactInputs(withBody(t)).inputs.pr.body;
    for (const keep of [
      'var a={password:null,user:"bob"}',
      "x={token:e.token,user:u.name,flags:[1,2,3]}",
    ]) {
      expect(body(keep), keep).toBe(keep);
    }
    expect(body("q?password=hunter2hunter2&user=bob")).toBe(
      "q?password=[REDACTED:assignment]&user=bob",
    );
    expect(body("f(password=hunter2hunter2); next")).toBe(
      "f(password=[REDACTED:assignment]); next",
    );
    // A value longer than the 512-character window is redacted whole, up to its real end.
    const long = "x".repeat(5_000);
    expect(body(`password=${long}&rest`)).toBe("password=[REDACTED:assignment]&rest");
  });

  it("U-RED-15 values on the next lines: YAML blocks, empty values, continuations, open quotes", () => {
    const run = (lines: string[], patch = false) => {
      const text = lines.join("\n");
      if (!patch) {
        const out = redactInputs(withBody(text)).inputs.pr.body;
        return out.split("\n");
      }
      const out = redactPatch(text).out;
      return out.split("\n");
    };
    const M = "[REDACTED:assignment]";
    for (const [label, input, expected] of [
      [
        "literal block",
        ["password: |", "  hunter2hunter2", "  second secret line", "name: x"],
        ["password: |", `  ${M}`, `  ${M}`, "name: x"],
      ],
      [
        "folded strip",
        ["token: >-", "    abcdefgh", "next: 1"],
        ["token: >-", `    ${M}`, "next: 1"],
      ],
      [
        "empty value",
        ["password:", "  hunter2hunter2", "other: 1"],
        ["password:", `  ${M}`, "other: 1"],
      ],
      [
        "empty value list",
        ["secrets:", "  - hunter2hunter2", "  - another-secret-1", "done: 1"],
        ["secrets:", `  ${M}`, `  ${M}`, "done: 1"],
      ],
      [
        "continuation",
        ["password = \\", "  hunter2hunter2 \\", "  tailtailtail", "echo after"],
        ["password = \\", `  ${M}`, `  ${M}`, "echo after"],
      ],
      [
        "unterminated quote",
        ['password = "line one', "line two secret", 'last line"', "after"],
        ['password = "line one', `${M}`, `${M}`, "after"],
      ],
      [
        "credentials followed by a key line",
        ["credentials:", "  username: bob", "  region: eu"],
        ["credentials:", "  username: bob", "  region: eu"],
      ],
      [
        "python if on a secret name is code, not a YAML key",
        ["if password:", "    check(user)", "    login(user)", "done()"],
        ["if password:", "    check(user)", "    login(user)", "done()"],
      ],
      [
        "python for over tokens",
        ["for token in tokens:", "    use(token)", "    log(token)"],
        ["for token in tokens:", "    use(token)", "    log(token)"],
      ],
      [
        "class PasswordForm",
        ["class PasswordForm:", "    field = 1", "    other = 2"],
        ["class PasswordForm:", "    field = 1", "    other = 2"],
      ],
      [
        "switch case on a secret name",
        ['case "password":', "  handle();", "  break;"],
        ['case "password":', "  handle();", "  break;"],
      ],
      [
        "list item and quoted YAML keys still continue",
        ["- password:", "    hunter2hunter2", '"secret":', "  hunter2hunter2"],
        ["- password:", `    ${M}`, '"secret":', `  ${M}`],
      ],
    ] as [string, string[], string[]][]) {
      expect(run(input), label).toEqual(expected);
    }
    // Patch mode: prefixes and the line count stay; a hunk header ends the state.
    const patch = [
      "@@ -1,4 +1,5 @@",
      "+password: |",
      "+  hunter2hunter2",
      " ",
      "@@ -20,2 +21,2 @@",
      "   not secret",
    ];
    const out = run(patch, true);
    expect(out).toHaveLength(patch.length);
    expect(out[2]).toBe(`+  ${M}`);
    expect(out[4]).toBe("@@ -20,2 +21,2 @@");
    expect(out[5]).toBe("   not secret");
    // At most 50 lines.
    const many = ["password: |", ...Array.from({ length: 80 }, () => "  hunter2hunter2")];
    const redacted = run(many).filter((l) => l.includes(M));
    expect(redacted).toHaveLength(50);
  });

  it("U-RED-16 CLI flags", () => {
    const body = (t: string) => redactInputs(withBody(t)).inputs.pr.body;
    expect(body("run --password hunter2hunter2 --verbose")).toBe(
      "run --password [REDACTED:cli_flag] --verbose",
    );
    expect(body("tool -token abcdefgh12345")).toBe("tool -token [REDACTED:cli_flag]");
    expect(body("mysql -u root -pS3cretPass db")).toBe("mysql -u root -p[REDACTED:cli_flag] db");
    expect(body("curl -u admin:hunter2hunter2 https://x.example")).toBe(
      "curl -u admin:[REDACTED:cli_flag] https://x.example",
    );
    expect(body('tool --user "admin:hunter2hunter2" go')).toBe(
      'tool --user "admin:[REDACTED:cli_flag]" go',
    );
    for (const keep of [
      "gcc -pthread main.c",
      "tool --password-file /x/y",
      "ssh -pS3cretPass host",
      "curl -u admin:$PASSWORD host",
    ]) {
      expect(body(keep), keep).toBe(keep);
    }
  });

  it("U-RED-17 redis URLs, more key names, internal capitals and Slack webhooks", () => {
    const body = (t: string) => redactInputs(withBody(t)).inputs.pr.body;
    expect(body("redis://:hunter2hunter2@cache:6379")).toBe(
      "redis://:[REDACTED:url_credentials]@cache:6379",
    );
    for (const name of ["encryption_key", "master_key", "signing_key", "ENCRYPTION_KEY"]) {
      expect(body(`${name} = ${PW}`), name).toBe(`${name} = [REDACTED:assignment]`);
    }
    expect(body(`PassWord = ${PW}`)).toBe("PassWord = [REDACTED:assignment]");
    const hook = `https://hooks.slack.com/services/${"T0001AAAA/B0002BBBB/abcdefghijklmnopqrstuvwx"}`;
    const r = redactInputs(withBody(`post to ${hook} now`));
    expect(r.inputs.pr.body).toBe("post to https://[REDACTED:slack_webhook] now");
    expect(r.redactions).toEqual([{ kind: "slack_webhook", count: 1 }]);
  });

  it("U-RED-18 counters and limits stay readable; the step 4 negatives stay", () => {
    for (const keep of [
      "max_tokens = 100000000",
      "limit_secret_count = 12345678",
      "num_tokens = 123456789",
      "budget_token = 123456789",
      "password_length = 1234567890",
      "const token = process.env.GITHUB_TOKEN;",
    ]) {
      const r = redactInputs(withBody(keep));
      expect(r.inputs.pr.body, keep).toBe(keep);
      expect(r.redactions, keep).toEqual([]);
    }
  });

  it("U-RED-13 a custom pattern that matches the empty string, or is invalid, is rejected", () => {
    for (const bad of ["x*", "(?:)", "^", "a?", "("]) {
      expect(() => validateRedactPattern(bad), bad).toThrow(RedactPatternError);
      expect(() => redactInputs(withBody("abc"), { patterns: [bad] }), bad).toThrow(
        RedactPatternError,
      );
    }
    expect(() => validateRedactPattern("ACME-[0-9]+")).not.toThrow();
    try {
      validateRedactPattern("x*");
    } catch (e) {
      expect((e as Error).message).not.toContain("x*");
    }
  });
});

describe("eval sampling", () => {
  it("U-SAMP-1 sizeStratum boundaries", () => {
    expect([50, 51, 300, 301, 1500, 1501].map(sizeStratum)).toEqual([
      "S",
      "M",
      "M",
      "L",
      "L",
      "XL",
    ]);
  });

  it("U-SAMP-2 pathStratum", () => {
    const f = (...paths: string[]) =>
      paths.map((p) => ({
        path: p,
        previousPath: null,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
      }));
    const none = { extraSensitiveGlobs: [] };
    expect(pathStratum(f(".github/workflows/x.yml"), none)).toBe("sensitive");
    expect(pathStratum(f("src/a.test.ts", "src/b.test.ts"), none)).toBe("tests");
    expect(pathStratum(f("docs/a.md", "docs/b/c.txt"), none)).toBe("docs");
    expect(pathStratum(f("src/a.ts", "docs/a.md"), none)).toBe("source");
    expect(
      pathStratum(f("services/billing/x.ts"), { extraSensitiveGlobs: ["services/billing/**"] }),
    ).toBe("sensitive");
    expect(pathStratum(f("services/billing/x.ts"), none)).toBe("source");
    expect(pathStratum([], none)).toBe("source");
  });

  it("U-SAMP-3 allocate honours the minimum, sums to n, is proportional otherwise and never exceeds a stratum", () => {
    expect(allocate({ a: 50, b: 30, c: 20 }, 10, 2)).toEqual({ a: 4, b: 3, c: 3 });
    const tiny = allocate({ big: 100, rare: 1 }, 10, 2);
    expect(tiny.rare).toBe(1);
    expect(tiny.big).toBe(9);
    const cap = allocate({ a: 3, b: 100 }, 20, 5);
    expect(cap.a).toBe(3);
    expect(cap.b).toBe(17);
    for (const [sizes, n, min] of [
      [{ a: 7, b: 13, c: 2, d: 40 }, 25, 2],
      [{ a: 1, b: 1, c: 1 }, 2, 2],
      [{ a: 10, b: 10 }, 0, 2],
    ] as const) {
      const out = allocate(sizes, n, min);
      expect(Object.values(out).reduce((s, v) => s + v, 0)).toBe(
        Math.min(
          n,
          Object.values(sizes).reduce((s, v) => s + v, 0),
        ),
      );
      for (const k of Object.keys(sizes))
        expect(out[k] as number).toBeLessThanOrEqual(sizes[k as keyof typeof sizes] as number);
    }
    const mins = allocate({ a: 7, b: 13, c: 2, d: 40 }, 25, 2);
    for (const k of ["a", "b", "c", "d"]) expect(mins[k]).toBeGreaterThanOrEqual(2);
  });

  const cands = Array.from({ length: 40 }, (_, i) => ({
    repository: "o/r",
    prNumber: i + 1,
    size: (["S", "M", "L", "XL"] as const)[i % 4] as "S" | "M" | "L" | "XL",
    path: (i % 5 === 0 ? "sensitive" : "source") as "sensitive" | "source",
  }));

  it("U-SAMP-4 same seed gives the same sample in any input order; another seed differs", () => {
    const a = sample(cands, { n: 12, minPerStratum: 1, seed: 7 }).picked.map((c) => c.prNumber);
    const b = sample([...cands].reverse(), { n: 12, minPerStratum: 1, seed: 7 }).picked.map(
      (c) => c.prNumber,
    );
    const c = sample(cands, { n: 12, minPerStratum: 1, seed: 8 }).picked.map((x) => x.prNumber);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(12);
    expect(mulberry32(1)()).toBe(mulberry32(1)());
  });

  it("U-SAMP-5 n at or above the candidate count returns every candidate", () => {
    expect(sample(cands, { n: 40, minPerStratum: 2, seed: 1 }).picked).toHaveLength(40);
    expect(sample(cands, { n: 400, minPerStratum: 2, seed: 1 }).picked).toHaveLength(40);
  });
});
