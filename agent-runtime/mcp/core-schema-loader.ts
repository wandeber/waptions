import commonSchemaJson from "../schemas/2026-07-25/common.schema.json" with {
  type: "json",
};
import operationsSchemaJson from "../schemas/2026-07-25/operations.schema.json" with {
  type: "json",
};
import sessionSchemaJson from "../schemas/2026-07-25/session.schema.json" with {
  type: "json",
};
import toolRegistryJson from "../schemas/2026-07-25/tool-registry.json" with {
  type: "json",
};
import toolsSchemaJson from "../schemas/2026-07-25/tools.schema.json" with {
  type: "json",
};

import {
  TOOL_NAMES,
  WAPTIONS_API_VERSION,
  type WaptionsToolName,
} from "./constants.js";
import type { JsonSchema } from "./json-schema.js";
import {
  assertCoreSemanticSchemaBundle,
  computeCoreSemanticSchemaSha256,
  computeCoreToolSchemasSha256,
  extractCoreOperationTypes,
  type CoreSemanticSchemaBundle,
  type CoreToolAnnotations,
  type CoreToolSchemaContract,
} from "./semantic-schema-adapter.js";

type SchemaDocumentName =
  | "common.schema.json"
  | "operations.schema.json"
  | "session.schema.json"
  | "tools.schema.json";

export interface CoreSchemaDocuments {
  commonSchema: unknown;
  operationsSchema: unknown;
  sessionSchema: unknown;
  toolsSchema: unknown;
  toolRegistry: unknown;
}

interface RegistryTool {
  name: WaptionsToolName;
  description: string;
  inputSchemaRef: string;
  outputSchemaRef: string;
  annotations: CoreToolAnnotations;
}

const DOCUMENT_PREFIX: Record<SchemaDocumentName, string> = {
  "common.schema.json": "Common",
  "operations.schema.json": "Operations",
  "session.schema.json": "Session",
  "tools.schema.json": "Tools",
};

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function schemaDocuments(
  input: CoreSchemaDocuments,
): Record<SchemaDocumentName, Record<string, unknown>> {
  return {
    "common.schema.json": asRecord(
      input.commonSchema,
      "Core common schema must be an object.",
    ),
    "operations.schema.json": asRecord(
      input.operationsSchema,
      "Core operations schema must be an object.",
    ),
    "session.schema.json": asRecord(
      input.sessionSchema,
      "Core session schema must be an object.",
    ),
    "tools.schema.json": asRecord(
      input.toolsSchema,
      "Core tools schema must be an object.",
    ),
  };
}

function definition(
  documents: Record<SchemaDocumentName, Record<string, unknown>>,
  documentName: SchemaDocumentName,
  definitionName: string,
): Record<string, unknown> {
  const definitions = asRecord(
    documents[documentName].$defs,
    `${documentName} must contain $defs.`,
  );
  return asRecord(
    definitions[definitionName],
    `${documentName} is missing definition ${definitionName}.`,
  );
}

function parseDefinitionRef(
  ref: string,
  currentDocument: SchemaDocumentName,
): { documentName: SchemaDocumentName; definitionName: string } {
  const match =
    /^(?:(common\.schema\.json|operations\.schema\.json|session\.schema\.json|tools\.schema\.json))?#\/\$defs\/([^/]+)$/.exec(
      ref,
    );
  if (!match) {
    throw new Error(`Unsupported Core schema reference: ${ref}`);
  }
  return {
    documentName: (match[1] as SchemaDocumentName | undefined) ??
      currentDocument,
    definitionName: match[2],
  };
}

function localDefinitionName(
  documentName: SchemaDocumentName,
  definitionName: string,
): string {
  return `${DOCUMENT_PREFIX[documentName]}__${definitionName}`;
}

/**
 * Extract one committed definition and only its transitive dependencies. Every
 * external Core reference becomes a local namespaced $ref so the returned
 * schema can be compiled independently by an MCP client or AJV instance.
 */
function buildSelfContainedDefinition(
  documents: Record<SchemaDocumentName, Record<string, unknown>>,
  documentName: SchemaDocumentName,
  definitionName: string,
): JsonSchema {
  const pending: Array<{
    documentName: SchemaDocumentName;
    definitionName: string;
  }> = [];
  const queued = new Set<string>();
  const rewrittenDefinitions = new Map<string, unknown>();

  const enqueue = (
    targetDocument: SchemaDocumentName,
    targetDefinition: string,
  ): string => {
    const localName = localDefinitionName(
      targetDocument,
      targetDefinition,
    );
    if (!queued.has(localName)) {
      definition(documents, targetDocument, targetDefinition);
      queued.add(localName);
      pending.push({
        documentName: targetDocument,
        definitionName: targetDefinition,
      });
    }
    return localName;
  };

  const rewrite = (
    value: unknown,
    sourceDocument: SchemaDocumentName,
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => rewrite(item, sourceDocument));
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    const rewritten: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        if (typeof child !== "string") {
          throw new Error("Core schema $ref values must be strings.");
        }
        const target = parseDefinitionRef(child, sourceDocument);
        rewritten.$ref = `#/$defs/${enqueue(
          target.documentName,
          target.definitionName,
        )}`;
      } else if (key !== "$defs") {
        rewritten[key] = rewrite(child, sourceDocument);
      }
    }
    return rewritten;
  };

  const root = asRecord(
    rewrite(
      definition(documents, documentName, definitionName),
      documentName,
    ),
    `Core definition ${definitionName} could not be rewritten.`,
  );
  while (pending.length > 0) {
    const target = pending.shift();
    if (!target) {
      break;
    }
    const localName = localDefinitionName(
      target.documentName,
      target.definitionName,
    );
    rewrittenDefinitions.set(
      localName,
      rewrite(
        definition(
          documents,
          target.documentName,
          target.definitionName,
        ),
        target.documentName,
      ),
    );
  }

  const sortedDefinitions = Object.fromEntries(
    [...rewrittenDefinitions.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...root,
    $defs: sortedDefinitions,
  };
}

function buildMcpToolSchema(
  documents: Record<SchemaDocumentName, Record<string, unknown>>,
  documentName: SchemaDocumentName,
  definitionName: string,
): JsonSchema {
  return {
    type: "object",
    ...buildSelfContainedDefinition(
      documents,
      documentName,
      definitionName,
    ),
  };
}

function referencesDefinition(
  documents: Record<SchemaDocumentName, Record<string, unknown>>,
  value: unknown,
  currentDocument: SchemaDocumentName,
  targetDocument: SchemaDocumentName,
  targetDefinition: string,
  visited: Set<string>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) =>
      referencesDefinition(
        documents,
        item,
        currentDocument,
        targetDocument,
        targetDefinition,
        visited,
      ),
    );
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$ref") {
      if (
        referencesDefinition(
          documents,
          child,
          currentDocument,
          targetDocument,
          targetDefinition,
          visited,
        )
      ) {
        return true;
      }
      continue;
    }
    if (typeof child !== "string") {
      throw new Error("Core schema $ref values must be strings.");
    }
    const target = parseDefinitionRef(child, currentDocument);
    if (
      target.documentName === targetDocument &&
      target.definitionName === targetDefinition
    ) {
      return true;
    }
    const identity = `${target.documentName}#${target.definitionName}`;
    if (visited.has(identity)) {
      continue;
    }
    visited.add(identity);
    if (
      referencesDefinition(
        documents,
        definition(documents, target.documentName, target.definitionName),
        target.documentName,
        targetDocument,
        targetDefinition,
        visited,
      )
    ) {
      return true;
    }
  }
  return false;
}

function parseToolRegistry(value: unknown): RegistryTool[] {
  const registry = asRecord(value, "Core tool registry must be an object.");
  if (registry.apiVersion !== WAPTIONS_API_VERSION) {
    throw new Error("Core tool registry apiVersion does not match MCP.");
  }
  if (!Array.isArray(registry.tools)) {
    throw new Error("Core tool registry must contain a tools array.");
  }
  const tools = registry.tools.map((candidate) => {
    const tool = asRecord(candidate, "Core tool registry entry is invalid.");
    const annotations = asRecord(
      tool.annotations,
      "Core tool registry annotations are invalid.",
    );
    if (
      typeof tool.name !== "string" ||
      !TOOL_NAMES.includes(tool.name as WaptionsToolName) ||
      typeof tool.description !== "string" ||
      typeof tool.inputSchemaRef !== "string" ||
      typeof tool.outputSchemaRef !== "string" ||
      ![
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ].every((name) => typeof annotations[name] === "boolean")
    ) {
      throw new Error("Core tool registry entry is incomplete.");
    }
    return {
      name: tool.name as WaptionsToolName,
      description: tool.description,
      inputSchemaRef: tool.inputSchemaRef,
      outputSchemaRef: tool.outputSchemaRef,
      annotations: annotations as unknown as CoreToolAnnotations,
    };
  });
  if (
    tools.length !== TOOL_NAMES.length ||
    new Set(tools.map(({ name }) => name)).size !== TOOL_NAMES.length ||
    TOOL_NAMES.some(
      (name, index) => tools[index]?.name !== name,
    )
  ) {
    throw new Error(
      "Core tool registry does not match the ordered MCP tool inventory.",
    );
  }
  return tools;
}

export function buildCoreSemanticSchemaBundle(
  input: CoreSchemaDocuments,
): CoreSemanticSchemaBundle {
  const documents = schemaDocuments(input);
  const editOperationSchema = buildSelfContainedDefinition(
    documents,
    "operations.schema.json",
    "EditorSemanticOperation",
  );
  const operationTypes = extractCoreOperationTypes(editOperationSchema);
  const registry = parseToolRegistry(input.toolRegistry);
  const contracts = registry.map((tool): CoreToolSchemaContract => {
    const inputTarget = parseDefinitionRef(
      tool.inputSchemaRef,
      "tools.schema.json",
    );
    const outputTarget = parseDefinitionRef(
      tool.outputSchemaRef,
      "tools.schema.json",
    );
    if (
      inputTarget.documentName !== "tools.schema.json" ||
      outputTarget.documentName !== "tools.schema.json"
    ) {
      throw new Error(
        `Core tool registry entry ${tool.name} must reference tools.schema.json.`,
      );
    }
    const rawInput = definition(
      documents,
      inputTarget.documentName,
      inputTarget.definitionName,
    );
    const mutation =
      tool.name === "waptions_session_open" ||
      referencesDefinition(
        documents,
        rawInput,
        "tools.schema.json",
        "tools.schema.json",
        "MutationBase",
        new Set(),
      );
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: buildMcpToolSchema(
        documents,
        inputTarget.documentName,
        inputTarget.definitionName,
      ),
      outputSchema: buildMcpToolSchema(
        documents,
        outputTarget.documentName,
        outputTarget.definitionName,
      ),
      annotations: tool.annotations,
      mutation,
    };
  });
  const toolSchemas = Object.fromEntries(
    contracts.map((contract) => [contract.name, contract]),
  ) as Record<WaptionsToolName, CoreToolSchemaContract>;
  const toolNames = registry.map(({ name }) => name);
  const bundle: CoreSemanticSchemaBundle = {
    apiVersion: WAPTIONS_API_VERSION,
    editOperationSchema,
    operationTypes,
    schemaSha256: computeCoreSemanticSchemaSha256(editOperationSchema),
    toolNames,
    toolSchemas,
    toolSchemasSha256: computeCoreToolSchemasSha256(toolSchemas),
  };
  assertCoreSemanticSchemaBundle(bundle);
  return bundle;
}

/**
 * Load the production MCP contract from Core's committed, immutable schema
 * artifacts. Static JSON imports make the same source files part of the built
 * package; no checkout-relative path or runtime filesystem discovery is used.
 */
export function loadCommittedCoreSemanticSchemaBundle(): CoreSemanticSchemaBundle {
  return buildCoreSemanticSchemaBundle({
    commonSchema: commonSchemaJson,
    operationsSchema: operationsSchemaJson,
    sessionSchema: sessionSchemaJson,
    toolsSchema: toolsSchemaJson,
    toolRegistry: toolRegistryJson,
  });
}
