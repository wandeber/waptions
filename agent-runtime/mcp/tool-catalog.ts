import type { WaptionsToolName } from "./constants.js";
import { loadCommittedCoreSemanticSchemaBundle } from "./core-schema-loader.js";
import type { JsonSchema } from "./json-schema.js";
import {
  assertCoreSemanticSchemaBundle,
  type CoreSemanticSchemaBundle,
} from "./semantic-schema-adapter.js";

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolContract {
  name: WaptionsToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ToolAnnotations;
  /**
   * `mutation` means that the input consumes Core's MutationBase and therefore
   * uses the durable `(projectId, toolName, idempotencyKey)` receipt path.
   * Session open has a dedicated bootstrap receipt path.
   */
  mutation: boolean;
  _meta?: {
    ui: {
      resourceUri: string;
      visibility: ["model", "app"];
    };
  };
}

function titleForTool(name: WaptionsToolName): string {
  const words = name
    .replace(/^waptions_/, "")
    .split("_")
    .join(" ");
  return `Waptions ${words}`;
}

/**
 * Build the MCP catalog exclusively from Core's committed tool registry and
 * self-contained schemas. The only MCP-owned augmentation is current Apps
 * metadata on the one UI-attaching tool.
 */
export function createToolCatalog(
  appResourceUri: string,
  semanticSchemas: CoreSemanticSchemaBundle,
): ToolContract[] {
  assertCoreSemanticSchemaBundle(semanticSchemas);
  const committedSchemas = loadCommittedCoreSemanticSchemaBundle();
  if (
    semanticSchemas.schemaSha256 !== committedSchemas.schemaSha256 ||
    semanticSchemas.toolSchemasSha256 !==
      committedSchemas.toolSchemasSha256
  ) {
    throw new Error(
      "Attached Core schemas do not match the bundled canonical schemas.",
    );
  }

  return committedSchemas.toolNames.map((name) => {
    const coreContract = committedSchemas.toolSchemas[name];
    const title = titleForTool(name);
    return {
      name,
      title,
      description: coreContract.description,
      inputSchema: coreContract.inputSchema,
      outputSchema: coreContract.outputSchema,
      annotations: {
        title,
        ...coreContract.annotations,
      },
      mutation: coreContract.mutation,
      ...(name === "waptions_editor_render"
        ? {
            _meta: {
              ui: {
                resourceUri: appResourceUri,
                visibility: ["model", "app"] as ["model", "app"],
              },
            },
          }
        : {}),
    };
  });
}

export function getToolContract(
  catalog: readonly ToolContract[],
  name: string,
): ToolContract | undefined {
  return catalog.find((contract) => contract.name === name);
}
