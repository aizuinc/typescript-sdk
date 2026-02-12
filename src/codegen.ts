import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parse } from "smol-toml";
import * as log from "./logger.js";

interface FieldDef {
  name: string;
  type: string;
  nullable?: boolean;
  items?: string;
  keys?: string;
}

interface IndexDef {
  fields: string[];
  unique?: boolean;
  name?: string;
}

interface Collection {
  fields: FieldDef[];
  struct?: string;
  indexes?: IndexDef[];
  response?: boolean;
}

interface ParsedSchema {
  name: string;
  collection: Collection;
}

export async function generateTypeScript(
  schemasPath: string,
  outputPath: string,
): Promise<void> {
  const schemas = await loadSchemas(schemasPath);
  if (schemas.length === 0) {
    log.warn("No schemas found, skipping TypeScript codegen");
    return;
  }

  await mkdir(outputPath, { recursive: true });
  const code = renderTypeScript(schemas);
  await writeFile(join(outputPath, "schema.ts"), code);
  log.detail(`Generated schema.ts (${schemas.length} types)`);
}

export async function generateRust(
  schemasPath: string,
  outputPath: string,
): Promise<void> {
  const schemas = await loadSchemas(schemasPath);
  if (schemas.length === 0) {
    log.warn("No schemas found, skipping Rust codegen");
    return;
  }

  await mkdir(outputPath, { recursive: true });

  const mod = renderRustMod(schemas);
  await writeFile(join(outputPath, "mod.rs"), mod);
  log.detail("Generated mod.rs");

  const dashboard = renderRustDashboard(schemas);
  await writeFile(join(outputPath, "dashboard.rs"), dashboard);
  log.detail("Generated dashboard.rs");
}

async function loadSchemas(dir: string): Promise<ParsedSchema[]> {
  const entries = await readdir(dir);
  const tomlFiles = entries.filter((f) => f.endsWith(".toml")).sort();

  const schemas: ParsedSchema[] = [];

  for (const file of tomlFiles) {
    const content = await readFile(resolve(dir, file), "utf-8");
    const parsed = parse(content) as Record<string, unknown>;

    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "object" && value !== null && "fields" in value) {
        schemas.push({ name, collection: value as Collection });
      }
    }
  }

  return schemas;
}

function renderTypeScript(schemas: ParsedSchema[]): string {
  const lines: string[] = [
    "// Auto-generated from schemas/*.toml — do not edit",
    "",
  ];

  for (const schema of schemas) {
    const col = schema.collection;
    const hasResponse = col.response !== false;

    lines.push(`export interface ${schema.name} {`);
    for (const field of col.fields) {
      const { tsType, optional } = fieldToTS(field);
      lines.push(`  ${field.name}${optional ? "?" : ""}: ${tsType};`);
    }
    lines.push(`}`);
    lines.push(``);

    if (hasResponse) {
      lines.push(`export interface ${schema.name}Response {`);
      lines.push(`  id: string;`);
      for (const field of col.fields) {
        const { tsType, optional } = fieldToTS(field);
        lines.push(`  ${field.name}${optional ? "?" : ""}: ${tsType};`);
      }
      lines.push(`}`);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

function renderRustMod(schemas: ParsedSchema[]): string {
  const o: string[] = [];

  // Build struct name map for cross-references
  const structNames = new Map<string, string>();
  for (const s of schemas) {
    structNames.set(s.name, s.collection.struct ?? s.name);
  }

  o.push("// Auto-generated from schemas/*.toml - do not edit");
  o.push("");
  o.push("use aizu::prelude::*;");
  o.push("");

  for (const schema of schemas) {
    const structName = structNames.get(schema.name)!;
    const col = schema.collection;

    // Struct
    o.push("#[derive(Debug, Clone, Serialize, Deserialize)]");
    o.push(`pub struct ${structName} {`);
    for (const f of col.fields) {
      o.push(`    pub ${f.name}: ${fieldToRust(f, structNames)},`);
    }
    o.push("}");
    o.push("");

    // Schema impl
    o.push(`impl Schema for ${structName} {`);
    o.push(`    const COLLECTION: &'static str = "${schema.name}";`);
    o.push("}");
    o.push("");

    // Field accessors
    o.push(`impl ${structName} {`);
    for (const f of col.fields) {
      const { accessorType, nullable } = fieldToAccessor(f, structNames);
      const wrapper = nullable ? "NullableField" : "Field";
      o.push(
        `    pub fn ${f.name}() -> ${wrapper}<${accessorType}> { ${wrapper}::new("${f.name}") }`,
      );
    }
    o.push("}");
    o.push("");

    // Response type
    if (col.response !== false) {
      const respName = `${structName}Response`;
      o.push("#[derive(Debug, Clone, Serialize, Deserialize)]");
      o.push(`pub struct ${respName} {`);
      o.push(`    pub id: Id<${structName}>,`);
      for (const f of col.fields) {
        o.push(`    pub ${f.name}: ${fieldToRust(f, structNames)},`);
      }
      o.push("}");
      o.push("");

      o.push(`impl ${respName} {`);
      o.push(
        `    pub fn from_doc(id: Id<${structName}>, doc: ${structName}) -> Self {`,
      );
      o.push("        Self {");
      o.push("            id,");
      for (const f of col.fields) {
        o.push(`            ${f.name}: doc.${f.name},`);
      }
      o.push("        }");
      o.push("    }");
      o.push("}");
      o.push("");
    }

    // Indexes
    if (col.indexes && col.indexes.length > 0) {
      o.push(`/// Index definitions for ${structName}.`);
      o.push(`impl ${structName} {`);
      o.push("    /// Returns index definitions for this collection.");
      o.push("    pub fn indexes() -> &'static [IndexDef] {");
      o.push("        &[");

      for (const idx of col.indexes) {
        const idxName =
          idx.name ??
          (idx.unique
            ? `${structName.toLowerCase()}_${idx.fields.join("_")}_unique`
            : `${structName.toLowerCase()}_${idx.fields.join("_")}_idx`);
        const fieldsStr = idx.fields.map((f) => `"${f}"`).join(", ");
        o.push("            IndexDef {");
        o.push(`                name: "${idxName}",`);
        o.push(`                fields: &[${fieldsStr}],`);
        o.push(`                unique: ${idx.unique ?? false},`);
        o.push("            },");
      }

      o.push("        ]");
      o.push("    }");
      o.push("}");
      o.push("");
    }
  }

  o.push("pub mod dashboard;");
  return o.join("\n") + "\n";
}

function renderRustDashboard(schemas: ParsedSchema[]): string {
  const o: string[] = [];

  // Build struct name map
  const structNames = new Map<string, string>();
  for (const s of schemas) {
    structNames.set(s.name, s.collection.struct ?? s.name);
  }

  o.push("// Auto-generated dashboard functions - do not edit");
  o.push("");
  o.push("use super::*;");
  o.push("");

  for (const schema of schemas) {
    if (schema.collection.response === false) continue;

    const structName = structNames.get(schema.name)!;
    const lower = structName.toLowerCase();
    const respName = `${structName}Response`;
    const fields = schema.collection.fields;

    // Build parameter list and struct init for mutations
    const params = fields
      .map((f) => `${f.name}: ${fieldToRust(f, structNames)}`)
      .join(", ");
    const fieldNames = fields.map((f) => f.name).join(", ");

    // --- Queries ---

    // List
    o.push("#[query]");
    o.push(
      `pub fn dashboard_list_${lower}(ctx: &Ctx, limit: Option<u32>, offset: Option<u32>) -> Vec<${respName}> {`,
    );
    o.push(`    let mut query = ctx.db.query::<${structName}>();`);
    o.push("    if let Some(l) = limit {");
    o.push("        query = query.limit(l);");
    o.push("    }");
    o.push("    if let Some(o) = offset {");
    o.push("        query = query.offset(o);");
    o.push("    }");
    o.push("    query.collect_with_id()");
    o.push("        .into_iter()");
    o.push(`        .map(|(id, doc)| ${respName}::from_doc(id, doc))`);
    o.push("        .collect()");
    o.push("}");
    o.push("");

    // Count
    o.push("#[query]");
    o.push(`pub fn dashboard_count_${lower}(ctx: &Ctx) -> i64 {`);
    o.push(`    ctx.db.query::<${structName}>().count() as i64`);
    o.push("}");
    o.push("");

    // Get
    o.push("#[query]");
    o.push(
      `pub fn dashboard_get_${lower}(ctx: &Ctx, id: Id<${structName}>) -> Option<${respName}> {`,
    );
    o.push(
      `    ctx.db.get(id).map(|doc| ${respName}::from_doc(id, doc))`,
    );
    o.push("}");
    o.push("");

    // --- Mutations ---

    // Insert
    o.push("#[mutation]");
    o.push(
      `pub fn dashboard_insert_${lower}(ctx: &Ctx, ${params}) -> Result<${respName}, String> {`,
    );
    o.push(`    let doc = ${structName} { ${fieldNames} };`);
    o.push(
      `    let id = ctx.db.insert(&doc).map_err(|e| format!("{e:?}"))?;`,
    );
    o.push(`    Ok(${respName}::from_doc(id, doc))`);
    o.push("}");
    o.push("");

    // Update
    o.push("#[mutation]");
    o.push(
      `pub fn dashboard_update_${lower}(ctx: &Ctx, id: Id<${structName}>, ${params}) -> Result<${respName}, String> {`,
    );
    o.push(`    let doc = ${structName} { ${fieldNames} };`);
    o.push(
      `    ctx.db.update(id, &doc).map_err(|e| format!("{e:?}"))?;`,
    );
    o.push(`    Ok(${respName}::from_doc(id, doc))`);
    o.push("}");
    o.push("");

    // Delete
    o.push("#[mutation]");
    o.push(
      `pub fn dashboard_delete_${lower}(ctx: &Ctx, id: Id<${structName}>) -> Result<bool, String> {`,
    );
    o.push(`    ctx.db.delete(id).map_err(|e| format!("{e:?}"))`);
    o.push("}");
    o.push("");
  }

  return o.join("\n") + "\n";
}

function fieldToRust(field: FieldDef, structNames: Map<string, string>): string {
  const { base, nullable: suffixNullable } = parseType(field.type);
  const isNullable = suffixNullable || !!field.nullable;

  // id<Ref>
  const idMatch = parseIdType(field.type);
  if (idMatch) {
    const refStruct = structNames.get(idMatch.ref) ?? idMatch.ref;
    const inner = `Id<${refStruct}>`;
    return idMatch.nullable || !!field.nullable ? `Option<${inner}>` : inner;
  }

  const rustType = baseToRust(base, field, structNames);
  return isNullable ? `Option<${rustType}>` : rustType;
}

function fieldToAccessor(
  field: FieldDef,
  structNames: Map<string, string>,
): { accessorType: string; nullable: boolean } {
  const { base, nullable: suffixNullable } = parseType(field.type);
  const nullable = suffixNullable || !!field.nullable;

  const idMatch = parseIdType(field.type);
  if (idMatch) {
    const refStruct = structNames.get(idMatch.ref) ?? idMatch.ref;
    return { accessorType: `Id<${refStruct}>`, nullable };
  }

  const accessorType = baseToRust(base, field, structNames);
  return { accessorType, nullable };
}

function baseToRust(
  base: string,
  field: FieldDef,
  structNames: Map<string, string>,
): string {
  switch (base) {
    case "string":
    case "text":
      return "String";
    case "bool":
    case "boolean":
      return "bool";
    case "int":
    case "int64":
    case "i64":
      return "i64";
    case "int32":
    case "i32":
      return "i32";
    case "uint":
    case "uint64":
    case "u64":
      return "u64";
    case "uint32":
    case "u32":
      return "u32";
    case "float":
    case "float64":
    case "f64":
    case "double":
      return "f64";
    case "float32":
    case "f32":
      return "f32";
    case "uuid":
      return "Uuid";
    case "datetime":
    case "timestamp":
      return "DateTime";
    case "date":
      return "Date";
    case "time":
      return "Time";
    case "bytes":
    case "binary":
    case "blob":
      return "Vec<u8>";
    case "json":
    case "object":
      return "JsonValue";
    case "enum":
      return "String";
    case "id":
      return "Id<()>";
    case "array":
    case "list": {
      const inner = scalarToRust(field.items ?? "string", structNames);
      return `Vec<${inner}>`;
    }
    case "map":
    case "dict": {
      const k = scalarToRust(field.keys ?? "string", structNames);
      const v = scalarToRust(field.items ?? "string", structNames);
      return `BTreeMap<${k}, ${v}>`;
    }
    default: {
      const mapped = structNames.get(base);
      if (mapped) return mapped;
      return toPascalCase(base);
    }
  }
}

function scalarToRust(t: string, structNames: Map<string, string>): string {
  switch (t) {
    case "string":
    case "text":
      return "String";
    case "bool":
    case "boolean":
      return "bool";
    case "int":
    case "int64":
    case "i64":
      return "i64";
    case "int32":
    case "i32":
      return "i32";
    case "uint":
    case "uint64":
    case "u64":
      return "u64";
    case "uint32":
    case "u32":
      return "u32";
    case "float":
    case "float64":
    case "f64":
    case "double":
      return "f64";
    case "float32":
    case "f32":
      return "f32";
    case "uuid":
      return "Uuid";
    case "datetime":
    case "timestamp":
      return "DateTime";
    case "date":
      return "Date";
    case "time":
      return "Time";
    case "bytes":
    case "binary":
      return "Vec<u8>";
    case "json":
    case "object":
      return "JsonValue";
    default:
      return structNames.get(t) ?? toPascalCase(t);
  }
}

function fieldToTS(field: FieldDef): { tsType: string; optional: boolean } {
  const { base, nullable: suffixNullable } = parseType(field.type);
  const optional = suffixNullable || !!field.nullable;

  if (base.startsWith("id<") && base.endsWith(">")) {
    return { tsType: "string", optional };
  }
  if (base === "id") {
    return { tsType: "string", optional };
  }

  const tsType = baseToTS(base, field);
  return { tsType, optional };
}

function baseToTS(base: string, field: FieldDef): string {
  switch (base) {
    case "string":
    case "text":
    case "enum":
    case "uuid":
      return "string";
    case "bool":
    case "boolean":
      return "boolean";
    case "int":
    case "int32":
    case "int64":
    case "i32":
    case "i64":
    case "uint":
    case "uint32":
    case "uint64":
    case "u32":
    case "u64":
    case "float":
    case "float32":
    case "float64":
    case "f32":
    case "f64":
    case "double":
      return "number";
    case "datetime":
    case "timestamp":
    case "date":
    case "time":
      return "string";
    case "bytes":
    case "binary":
    case "blob":
      return "Uint8Array";
    case "json":
    case "object":
      return "unknown";
    case "array":
    case "list": {
      const inner = scalarToTS(field.items ?? "string");
      return `${inner}[]`;
    }
    case "map":
    case "dict": {
      const k = scalarToTS(field.keys ?? "string");
      const v = scalarToTS(field.items ?? "string");
      return `Record<${k}, ${v}>`;
    }
    default:
      return "unknown";
  }
}

function scalarToTS(t: string): string {
  switch (t) {
    case "string":
    case "text":
    case "uuid":
    case "datetime":
    case "timestamp":
    case "date":
    case "time":
      return "string";
    case "bool":
    case "boolean":
      return "boolean";
    case "int":
    case "int32":
    case "int64":
    case "i32":
    case "i64":
    case "uint":
    case "uint32":
    case "uint64":
    case "u32":
    case "u64":
    case "float":
    case "float32":
    case "float64":
    case "f32":
    case "f64":
    case "double":
      return "number";
    default:
      return "unknown";
  }
}

function parseType(t: string): { base: string; nullable: boolean } {
  if (t.endsWith("?")) {
    return { base: t.slice(0, -1), nullable: true };
  }
  return { base: t, nullable: false };
}

function parseIdType(
  t: string,
): { ref: string; nullable: boolean } | null {
  const { base, nullable } = parseType(t);
  const m = base.match(/^id<(\w+)>$/);
  if (m) return { ref: m[1], nullable };
  return null;
}

function toPascalCase(s: string): string {
  return s
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
