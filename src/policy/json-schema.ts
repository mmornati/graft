import { z } from "zod";
import { POLICY_REFINEMENTS, policySchema } from "./schema.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

/**
 * Some "at least one key" and "exactly one action" rules are cheap to say in JSON Schema, so
 * editors flag them too: `match`, `require` and `size` need a key, and a rule needs exactly one of
 * approve, require and block. (The server still checks them, with the catalogue's codes.)
 */
function addObjectRules(schema: Json): void {
  const rule = obj(obj(obj(obj(schema.properties)?.rules)?.items));
  if (!rule) return;
  rule.oneOf = [{ required: ["approve"] }, { required: ["require"] }, { required: ["block"] }];
  const props = obj(rule.properties);
  const match = obj(props?.match);
  if (match) match.minProperties = 1;
  const size = obj(obj(match?.properties)?.size);
  if (size) size.minProperties = 1;
  const require = obj(props?.require);
  if (require) require.minProperties = 1;
  const defaultRequire = obj(obj(obj(obj(schema.properties)?.default)?.properties)?.require);
  if (defaultRequire) defaultRequire.minProperties = 1;
}

/** The JSON Schema for editors (spec §7). Committed as `schema/graft.v1.schema.json`. */
export function policyJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(policySchema, { target: "draft-2020-12" }) as Json;
  addObjectRules(schema);
  const { $schema, ...rest } = schema;
  return {
    $schema,
    $id: "https://raw.githubusercontent.com/mmornati/graft/main/schema/graft.v1.schema.json",
    title: "graft.yaml v1",
    description: `Generated from src/policy/schema.ts (pnpm graft policy schema --write). Rules a JSON Schema cannot express: ${POLICY_REFINEMENTS.join("; ")}.`,
    ...rest,
  };
}
