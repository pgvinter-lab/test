import fs from "node:fs";
import path from "node:path";
import Ajv2020Import, { type Ajv2020 as Ajv2020Instance, type Options, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { BridgeRuntimeError, invariant } from "./errors.js";

interface JsonSchema {
  $id?: string;
  [key: string]: unknown;
}

export class ContractSchemaRegistry {
  private readonly ajv: Ajv2020Instance;
  private readonly byName = new Map<string, string>();
  private readonly byId = new Set<string>();

  constructor(schemaDirectory: string) {
    const Ajv2020 = Ajv2020Import as unknown as new (options?: Options) => Ajv2020Instance;
    const addFormats = addFormatsImport as unknown as (ajv: Ajv2020Instance) => Ajv2020Instance;
    this.ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
    addFormats(this.ajv);
    const directory = path.resolve(schemaDirectory);
    invariant(fs.existsSync(directory), "contract_schema_directory_not_found", { directory });
    const schemas = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
      .map((entry) => ({
        name: entry.name,
        schema: JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")) as JsonSchema,
      }));
    for (const { name, schema } of schemas) {
      invariant(typeof schema.$id === "string", "contract_schema_id_required", { name });
      this.byName.set(name, schema.$id);
      this.byId.add(schema.$id);
      this.ajv.addSchema(schema, schema.$id);
    }
  }

  validateNamed(name: string, value: unknown): void {
    const id = this.byName.get(path.basename(name));
    invariant(id, "contract_schema_not_registered", { name });
    this.validateId(id, value);
  }

  validateNamedFragment(name: string, fragment: string, value: unknown): void {
    const id = this.byName.get(path.basename(name));
    invariant(id, "contract_schema_not_registered", { name });
    invariant(/^#\/\$defs\/[A-Za-z0-9_-]+$/u.test(fragment), "contract_schema_fragment_invalid", { fragment });
    this.validateId(`${id}${fragment}`, value);
  }

  validateReference(reference: string, value: unknown): void {
    this.validateId(this.resolveReference(reference), value);
  }

  assertReference(reference: string): void {
    this.resolveReference(reference);
  }

  private resolveReference(reference: string): string {
    if (this.byId.has(reference)) return reference;
    invariant(!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference), "nonlocal_schema_reference_forbidden", { reference });
    invariant(!reference.includes("#") && !reference.includes("?") && !path.isAbsolute(reference), "contract_schema_reference_invalid", { reference });
    const normalized = reference.replaceAll("\\", "/");
    const localName = path.basename(normalized);
    invariant(
      normalized === localName || normalized === `schemas/${localName}` || normalized === `./schemas/${localName}` || normalized === `../schemas/${localName}`,
      "contract_schema_reference_invalid",
      { reference },
    );
    const knownId = this.byName.get(localName);
    invariant(knownId, "contract_schema_not_registered", { reference });
    return knownId;
  }

  private validateId(id: string, value: unknown): void {
    const validator = this.ajv.getSchema(id) as ValidateFunction | undefined;
    invariant(validator, "contract_schema_not_registered", { id });
    if (!validator(value)) {
      throw new BridgeRuntimeError("contract_schema_validation_failed", {
        schema: id,
        errors: validator.errors?.map((error) => ({ instancePath: error.instancePath, keyword: error.keyword })) ?? [],
      });
    }
  }
}
