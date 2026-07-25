import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";

import {
  EVENT_RESOURCE_URI_TEMPLATE,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  WAPTIONS_API_VERSION,
} from "../mcp/constants.js";
import {
  CONTRACT_APP_RESOURCE,
  MCP_APPS_EXTENSION_ID,
  type McpAppResource,
} from "../mcp/app-resource.js";
import { WaptionsToolDispatcher } from "../mcp/dispatcher.js";
import type { CoreSemanticSchemaBundle } from "../mcp/semantic-schema-adapter.js";
import {
  createToolCatalog,
  type ToolContract,
} from "../mcp/tool-catalog.js";
import type {
  CoordinatorEventSubscription,
  ManagedCoordinatorAdapter,
} from "./coordinator-adapter.js";

const EVENT_RESOURCE_PATTERN =
  /^waptions:\/\/sessions\/([^/?#]+)\/events$/;

function parseEventResourceUri(uri: string): string | undefined {
  const match = EVENT_RESOURCE_PATTERN.exec(uri);
  if (!match) {
    return undefined;
  }
  try {
    const sessionId = decodeURIComponent(match[1]);
    return sessionId && !sessionId.includes("/") ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function publicToolDefinition(contract: ToolContract, includeUi: boolean) {
  return {
    name: contract.name,
    title: contract.title,
    description: contract.description,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    annotations: contract.annotations,
    ...(includeUi && contract._meta ? { _meta: contract._meta } : {}),
  };
}

export interface WaptionsMcpServerOptions {
  coordinator: ManagedCoordinatorAdapter;
  semanticSchemas: CoreSemanticSchemaBundle;
  appResource?: McpAppResource;
}

export class WaptionsMcpServer {
  readonly server: Server;
  readonly appResource: McpAppResource;
  readonly catalog: readonly ToolContract[];

  private readonly dispatcher: WaptionsToolDispatcher;
  private readonly subscriptions = new Map<
    string,
    CoordinatorEventSubscription
  >();
  private closed = false;

  constructor(private readonly options: WaptionsMcpServerOptions) {
    this.appResource = options.appResource ?? CONTRACT_APP_RESOURCE;
    this.catalog = createToolCatalog(
      this.appResource.uri,
      options.semanticSchemas,
    );
    this.dispatcher = new WaptionsToolDispatcher(
      this.catalog,
      options.coordinator,
    );
    this.server = new Server(
      {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
      {
        capabilities: {
          tools: { listChanged: false },
          resources: {
            listChanged: false,
            subscribe: true,
          },
        },
        instructions:
          "Use descriptor-first Waptions tools for all project work. Respect state tokens, revision guards, and durable idempotency. Long work returns durable job descriptors. Only waptions_editor_render attaches the editor UI.",
      },
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const uiCapability = getUiCapability(this.server.getClientCapabilities());
      const includeUi =
        uiCapability?.mimeTypes?.includes(this.appResource.mimeType) ?? false;
      return {
        tools: this.catalog.map((contract) =>
          publicToolDefinition(contract, includeUi),
        ),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      this.dispatcher.call(
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
      ),
    );

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: this.appResource.uri,
          name: "Waptions Editor",
          title: "Waptions Editor",
          description:
            "Immutable MCP App resource for the managed Waptions editor.",
          mimeType: this.appResource.mimeType,
          _meta: this.appResource.listMeta,
        },
      ],
    }));

    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({
        resourceTemplates: [
          {
            uriTemplate: EVENT_RESOURCE_URI_TEMPLATE,
            name: "Waptions Session Events",
            title: "Waptions Session Events",
            description:
              "Subscription anchor for one managed session. Fetch ordered event bodies with waptions_events_read.",
            mimeType: "application/json",
          },
        ],
      }),
    );

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      if (uri === this.appResource.uri) {
        return {
          contents: [
            {
              uri,
              mimeType: this.appResource.mimeType,
              text: this.appResource.html,
              _meta: this.appResource.readMeta,
            },
          ],
        };
      }

      const sessionId = parseEventResourceUri(uri);
      if (!sessionId) {
        throw new McpError(ErrorCode.InvalidParams, "Unknown resource URI.");
      }

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              apiVersion: WAPTIONS_API_VERSION,
              sessionId,
              eventTool: "waptions_events_read",
              semantics:
                "This resource is an invalidation anchor. Event bodies remain ordered and bounded through the polling tool.",
            }),
          },
        ],
      };
    });

    this.server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
      const { uri } = request.params;
      const sessionId = parseEventResourceUri(uri);
      if (!sessionId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Only session event resources are subscribable.",
        );
      }
      if (!this.options.coordinator.subscribeToEvents) {
        throw new McpError(
          ErrorCode.InternalError,
          "The coordinator does not expose event subscriptions; use waptions_events_read.",
        );
      }

      const previous = this.subscriptions.get(uri);
      if (previous) {
        await previous.close();
      }
      const subscription = await this.options.coordinator.subscribeToEvents(
        sessionId,
        () => {
          void this.server.sendResourceUpdated({ uri }).catch(() => {
            // Subscription invalidations racing transport shutdown are safe to
            // drop; clients recover ordered bodies through events_read.
          });
        },
        { signal: extra.signal },
      );
      this.subscriptions.set(uri, subscription);
      return {};
    });

    this.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const subscription = this.subscriptions.get(request.params.uri);
      if (subscription) {
        this.subscriptions.delete(request.params.uri);
        await subscription.close();
      }
      return {};
    });
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const subscriptions = Array.from(this.subscriptions.values());
    this.subscriptions.clear();
    await Promise.allSettled(
      subscriptions.map((subscription) => subscription.close()),
    );
    await this.server.close();
    await this.options.coordinator.close?.();
  }
}

export { MCP_APPS_EXTENSION_ID };
