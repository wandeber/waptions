import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    WAPTIONS_AGENT_API_VERSION,
    WAPTIONS_EVENT_TYPES,
    WAPTIONS_JOB_KINDS,
    WAPTIONS_JOB_STATES,
    WAPTIONS_STABLE_ERROR_CODES,
} from '@/types/waptions-agent-protocol';
import { EDITOR_ENGINE_API_VERSION, EDITOR_OPERATION_TYPES } from './editor-command';

type JsonObject = Record<string, unknown>;
type JsonSchema = JsonObject | boolean;

interface ResolvedSchema {
    fileName: string;
    schema: JsonSchema;
}

const SCHEMA_DIRECTORY = join(
    process.cwd(),
    'agent-runtime',
    'schemas',
    '2026-07-25',
);
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_FILES = [
    'common.schema.json',
    'operations.schema.json',
    'session.schema.json',
    'tools.schema.json',
] as const;
const schemaDocuments = new Map<string, JsonObject>(
    SCHEMA_FILES.map((fileName) => [
        fileName,
        readJson(join(SCHEMA_DIRECTORY, fileName)),
    ]),
);

const common = schemaDocuments.get('common.schema.json')!;
const operations = schemaDocuments.get('operations.schema.json')!;
const session = schemaDocuments.get('session.schema.json')!;
const tools = schemaDocuments.get('tools.schema.json')!;
const manifest = readJson(join(SCHEMA_DIRECTORY, 'schema-manifest.json'));
const contract = readJson(join(SCHEMA_DIRECTORY, 'protocol-contract.json'));
const registry = readJson(join(SCHEMA_DIRECTORY, 'tool-registry.json'));

const EXPECTED_TOOL_NAMES = [
    'waptions_session_list',
    'waptions_session_open',
    'waptions_session_manage',
    'waptions_path_grant',
    'waptions_project_get',
    'waptions_project_import',
    'waptions_project_validate',
    'waptions_media_probe',
    'waptions_media_import',
    'waptions_media_review',
    'waptions_media_release',
    'waptions_timeline_query',
    'waptions_edit_plan',
    'waptions_edit_apply',
    'waptions_history_get',
    'waptions_history_apply',
    'waptions_transcription_start',
    'waptions_job_list',
    'waptions_job_get',
    'waptions_job_cancel',
    'waptions_export_start',
    'waptions_artifact_list',
    'waptions_artifact_get',
    'waptions_events_read',
    'waptions_view_get',
    'waptions_view_update',
    'waptions_playback_control',
    'waptions_diagnostics_get',
    'waptions_editor_render',
] as const;

const EXPECTED_EVENT_TYPES = [
    'session.recovered',
    'project.snapshot',
    'project.mutated',
    'history.changed',
    'job.changed',
    'artifact.created',
    'diagnostics.changed',
    'presence.changed',
    'view.changed',
    'source.invalidated',
] as const;

function readJson(path: string): JsonObject {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(parsed)) {
        throw new Error(`Expected ${path} to contain a JSON object.`);
    }
    return parsed;
}

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getDefinitions(document: JsonObject): JsonObject {
    if (!isObject(document.$defs)) {
        throw new Error('Schema document has no $defs object.');
    }
    return document.$defs;
}

function unescapeJsonPointerSegment(segment: string): string {
    return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveSchemaRef(ref: string, fromFileName: string): ResolvedSchema {
    const [filePart, rawFragment = ''] = ref.split('#', 2);
    const fileName = filePart || fromFileName;
    const document = schemaDocuments.get(fileName);
    if (!document) {
        throw new Error(`Unknown schema document ${fileName} referenced from ${fromFileName}.`);
    }
    let current: unknown = document;
    if (rawFragment !== '') {
        if (!rawFragment.startsWith('/')) {
            throw new Error(`Unsupported JSON Schema fragment #${rawFragment}.`);
        }
        for (const rawSegment of rawFragment.slice(1).split('/')) {
            const segment = unescapeJsonPointerSegment(rawSegment);
            if (!isObject(current) || !(segment in current)) {
                throw new Error(`Unresolved schema reference ${ref} from ${fromFileName}.`);
            }
            current = current[segment];
        }
    }
    if (typeof current !== 'boolean' && !isObject(current)) {
        throw new Error(`Schema reference ${ref} does not resolve to a schema.`);
    }
    return { fileName, schema: current };
}

function visitSchemaRefs(
    value: unknown,
    fromFileName: string,
    visitor: (resolved: ResolvedSchema, ref: string) => void,
): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            visitSchemaRefs(item, fromFileName, visitor);
        }
        return;
    }
    if (!isObject(value)) {
        return;
    }
    if (typeof value.$ref === 'string') {
        visitor(resolveSchemaRef(value.$ref, fromFileName), value.$ref);
    }
    for (const nested of Object.values(value)) {
        visitSchemaRefs(nested, fromFileName, visitor);
    }
}

function deepEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The fixtures exercise the contract's discriminated unions and strict object closure without
 * adding a runtime validator dependency to the application.
 */
function validateFixture(
    value: unknown,
    schema: JsonSchema,
    fileName: string,
    path = '$',
): string[] {
    if (schema === true) {
        return [];
    }
    if (schema === false) {
        return [`${path} is rejected by the false schema.`];
    }

    const errors: string[] = [];
    if (typeof schema.$ref === 'string') {
        const resolved = resolveSchemaRef(schema.$ref, fileName);
        errors.push(...validateFixture(value, resolved.schema, resolved.fileName, path));
    }
    if ('const' in schema && !deepEquals(value, schema.const)) {
        errors.push(`${path} does not match const.`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEquals(item, value))) {
        errors.push(`${path} is not in enum.`);
    }
    if (Array.isArray(schema.allOf)) {
        for (const child of schema.allOf) {
            if (typeof child === 'boolean' || isObject(child)) {
                errors.push(...validateFixture(value, child, fileName, path));
            }
        }
    }
    if (Array.isArray(schema.anyOf)) {
        const matches = schema.anyOf.filter((child) => (
            (typeof child === 'boolean' || isObject(child))
            && validateFixture(value, child, fileName, path).length === 0
        ));
        if (matches.length === 0) {
            errors.push(`${path} does not match anyOf.`);
        }
    }
    if (Array.isArray(schema.oneOf)) {
        const matches = schema.oneOf.filter((child) => (
            (typeof child === 'boolean' || isObject(child))
            && validateFixture(value, child, fileName, path).length === 0
        ));
        if (matches.length !== 1) {
            errors.push(`${path} matches ${matches.length} oneOf branches.`);
        }
    }
    if ((typeof schema.not === 'boolean' || isObject(schema.not))
        && validateFixture(value, schema.not, fileName, path).length === 0) {
        errors.push(`${path} matches a forbidden schema.`);
    }

    const allowedTypes = typeof schema.type === 'string'
        ? [schema.type]
        : Array.isArray(schema.type)
            ? schema.type.filter((item): item is string => typeof item === 'string')
            : [];
    if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
        errors.push(`${path} is not of type ${allowedTypes.join('|')}.`);
        return errors;
    }

    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) {
            errors.push(`${path} is below minimum.`);
        }
        if (typeof schema.maximum === 'number' && value > schema.maximum) {
            errors.push(`${path} is above maximum.`);
        }
        if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
            errors.push(`${path} is below exclusiveMinimum.`);
        }
        if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
            errors.push(`${path} is above exclusiveMaximum.`);
        }
    }
    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            errors.push(`${path} is shorter than minLength.`);
        }
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
            errors.push(`${path} is longer than maxLength.`);
        }
        if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
            errors.push(`${path} does not match pattern.`);
        }
    }
    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            errors.push(`${path} has too few items.`);
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            errors.push(`${path} has too many items.`);
        }
        if (schema.uniqueItems === true
            && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
            errors.push(`${path} has duplicate items.`);
        }
        if (typeof schema.items === 'boolean' || isObject(schema.items)) {
            value.forEach((item, index) => {
                errors.push(...validateFixture(item, schema.items as JsonSchema, fileName, `${path}[${index}]`));
            });
        }
    }
    if (isObject(value)) {
        const properties = isObject(schema.properties) ? schema.properties : {};
        if (Array.isArray(schema.required)) {
            for (const required of schema.required) {
                if (typeof required === 'string' && !(required in value)) {
                    errors.push(`${path}.${required} is required.`);
                }
            }
        }
        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value && (typeof propertySchema === 'boolean' || isObject(propertySchema))) {
                errors.push(...validateFixture(value[key], propertySchema, fileName, `${path}.${key}`));
            }
        }
        const unknownKeys = Object.keys(value).filter((key) => !(key in properties));
        if (schema.additionalProperties === false && unknownKeys.length > 0) {
            errors.push(`${path} has unknown properties: ${unknownKeys.join(', ')}.`);
        } else if (typeof schema.additionalProperties === 'boolean'
            || isObject(schema.additionalProperties)) {
            if (schema.additionalProperties !== true) {
                for (const key of unknownKeys) {
                    errors.push(...validateFixture(
                        value[key],
                        schema.additionalProperties,
                        fileName,
                        `${path}.${key}`,
                    ));
                }
            }
        }
        if (typeof schema.propertyNames === 'boolean' || isObject(schema.propertyNames)) {
            for (const key of Object.keys(value)) {
                errors.push(...validateFixture(key, schema.propertyNames, fileName, `${path}{key}`));
            }
        }
    }
    return errors;
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'null':
            return value === null;
        case 'object':
            return isObject(value);
        case 'array':
            return Array.isArray(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'string':
            return typeof value === 'string';
        case 'boolean':
            return typeof value === 'boolean';
        default:
            return false;
    }
}

function expectPublicDefinitionClosed(name: string, definition: unknown): void {
    if (!isObject(definition)) {
        return;
    }
    if (definition.type === 'object') {
        expect(
            definition.additionalProperties === false
            || isObject(definition.additionalProperties)
            || definition.unevaluatedProperties === false,
            `${name} must explicitly close or type its unknown properties.`,
        ).toBe(true);
    }
    if (Array.isArray(definition.oneOf)) {
        definition.oneOf.forEach((branch, index) => {
            if (isObject(branch) && branch.type === 'object') {
                expect(
                    branch.additionalProperties === false
                    || branch.unevaluatedProperties === false,
                    `${name}.oneOf[${index}] must reject unknown properties.`,
                ).toBe(true);
            }
        });
    }
    if (Array.isArray(definition.allOf)) {
        expect(
            definition.unevaluatedProperties === false
            || definition.additionalProperties === false,
            `${name} must close properties composed through allOf.`,
        ).toBe(true);
    }
}

describe('Waptions agent protocol schemas', () => {
    it('publishes one coherent JSON Schema 2020-12 version with resolvable references', () => {
        expect(manifest.apiVersion).toBe(WAPTIONS_AGENT_API_VERSION);
        expect(WAPTIONS_AGENT_API_VERSION).toBe(EDITOR_ENGINE_API_VERSION);
        expect(manifest.dialect).toBe(DIALECT);
        expect(manifest.schemas).toEqual(SCHEMA_FILES.map((fileName) => ({
            path: fileName,
            id: `urn:waptions:agent:2026-07-25:${fileName.replace('.schema.json', '')}`,
        })));

        const ids = new Set<string>();
        for (const fileName of SCHEMA_FILES) {
            const document = schemaDocuments.get(fileName)!;
            expect(document.$schema).toBe(DIALECT);
            expect(typeof document.$id).toBe('string');
            expect(ids.has(document.$id as string)).toBe(false);
            ids.add(document.$id as string);
            visitSchemaRefs(document, fileName, ({ schema }) => {
                expect(typeof schema === 'boolean' || isObject(schema)).toBe(true);
            });
        }
    });

    it('registers exactly the 29 frozen tools with annotations and schema references', () => {
        expect(registry.apiVersion).toBe(WAPTIONS_AGENT_API_VERSION);
        expect(Array.isArray(registry.tools)).toBe(true);
        const registeredTools = registry.tools as JsonObject[];
        expect(registeredTools.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);

        const referencedInputs = new Set<string>();
        const referencedOutputs = new Set<string>();
        for (const tool of registeredTools) {
            expect(Object.keys(tool.annotations as JsonObject).sort()).toEqual([
                'destructiveHint',
                'idempotentHint',
                'openWorldHint',
                'readOnlyHint',
            ]);
            expect(Object.values(tool.annotations as JsonObject).every(
                (value) => typeof value === 'boolean',
            )).toBe(true);
            const inputRef = tool.inputSchemaRef as string;
            const outputRef = tool.outputSchemaRef as string;
            expect(resolveSchemaRef(inputRef, 'tools.schema.json').schema).toBeTruthy();
            expect(resolveSchemaRef(outputRef, 'tools.schema.json').schema).toBeTruthy();
            referencedInputs.add(inputRef.split('/').at(-1)!);
            referencedOutputs.add(outputRef.split('/').at(-1)!);
        }

        const toolDefinitions = getDefinitions(tools);
        expect(Array.from(referencedInputs).sort()).toEqual(
            Object.keys(toolDefinitions).filter((name) => name.startsWith('ToolInput')).sort(),
        );
        expect(Array.from(referencedOutputs).sort()).toEqual(
            Object.keys(toolDefinitions).filter((name) => name.startsWith('ToolOutput')).sort(),
        );

        const toolsWithUiMetadata = registeredTools.filter((tool) => '_meta' in tool);
        expect(toolsWithUiMetadata.map((tool) => tool.name)).toEqual(['waptions_editor_render']);
        const resource = contract.resource as JsonObject;
        const editorMeta = (toolsWithUiMetadata[0]._meta as JsonObject).ui as JsonObject;
        expect(editorMeta.resourceUriTemplate).toBe(resource.uriTemplate);
        expect(editorMeta.visibility).toEqual(['model', 'app']);
    });

    it('keeps public object contracts closed against unknown fields', () => {
        const allowedCompositionBases = new Set([
            'MutationEnvelopeProperties',
            'SessionReadBase',
            'MutationBase',
            'PageFields',
            'SuccessBase',
        ]);
        for (const fileName of SCHEMA_FILES) {
            const document = schemaDocuments.get(fileName)!;
            for (const [name, definition] of Object.entries(getDefinitions(document))) {
                if (!allowedCompositionBases.has(name)) {
                    expectPublicDefinitionClosed(`${fileName}#/$defs/${name}`, definition);
                }
            }
        }
    });

    it('binds the stable protocol values and concurrency scopes', () => {
        const commonDefinitions = getDefinitions(common);
        const sessionDefinitions = getDefinitions(session);
        expect((commonDefinitions.ApiVersion as JsonObject).const).toBe(WAPTIONS_AGENT_API_VERSION);
        expect((commonDefinitions.StableErrorCode as JsonObject).enum)
            .toEqual([...WAPTIONS_STABLE_ERROR_CODES]);
        expect((commonDefinitions.ExpectedRevisions as JsonObject).required)
            .toContain('sessionRevision');
        expect((sessionDefinitions.JobKind as JsonObject).enum).toEqual([...WAPTIONS_JOB_KINDS]);
        expect((sessionDefinitions.JobState as JsonObject).enum).toEqual([...WAPTIONS_JOB_STATES]);
        expect(WAPTIONS_EVENT_TYPES).toEqual(EXPECTED_EVENT_TYPES);
        expect((sessionDefinitions.EventType as JsonObject).enum).toEqual(EXPECTED_EVENT_TYPES);

        const receipt = sessionDefinitions.IdempotencyReceiptV1 as JsonObject;
        expect(receipt.required).toEqual(expect.arrayContaining([
            'projectId',
            'toolName',
            'idempotencyKey',
        ]));
        expect((contract.provenance as JsonObject).receiptScope)
            .toEqual(['projectId', 'toolName', 'idempotencyKey']);
        expect((contract.provenance as JsonObject).sourceBuildManifest).toEqual({
            requiredFields: [
                'schemaVersion',
                'sourceCommit',
                'sourceTree',
                'packageManager',
                'buildScript',
                'app',
                'buildInputs',
                'files',
                'licenses',
            ],
            appRequiredFields: [
                'resourceUri',
                'buildHash',
                'mimeType',
                'indexTemplateSha256',
                'payloadFiles',
            ],
            fileRecordRequiredFields: ['path', 'sha256', 'bytes'],
        });
    });

    it('binds semantic units and public field names to the editor engine', () => {
        const definitions = getDefinitions(operations);
        expect((definitions.EditorSemanticOperation as JsonObject).properties).toBeTruthy();
        const operationProperties = (definitions.EditorSemanticOperation as JsonObject)
            .properties as JsonObject;
        expect((operationProperties.type as JsonObject).enum).toEqual([...EDITOR_OPERATION_TYPES]);

        expect(Object.keys((definitions.PayloadVideoInsert as JsonObject).properties as JsonObject))
            .toEqual(expect.arrayContaining(['sourceStartSeconds', 'sourceEndSeconds']));
        expect((definitions.PayloadVideoTrim as JsonObject).properties).not.toHaveProperty('sourceStart');
        expect((definitions.PayloadVideoTrim as JsonObject).properties).not.toHaveProperty('sourceEnd');
        expect(Object.keys((definitions.PayloadClipFades as JsonObject).properties as JsonObject))
            .toEqual(expect.arrayContaining([
                'fadeInOutputSamples48k',
                'fadeOutOutputSamples48k',
            ]));
        expect(Object.keys((definitions.SemanticSubtitleCue as JsonObject).properties as JsonObject))
            .toEqual(['id', 'startOutputSample', 'endOutputSample', 'text']);
        expect((definitions.PayloadNarrativeTrim as JsonObject).properties)
            .toHaveProperty('sample16k');
        expect((definitions.PayloadNarrativeSourceRange as JsonObject).properties)
            .not.toHaveProperty('startSample');
        expect(Object.keys((definitions.PayloadLinkBind as JsonObject).properties as JsonObject))
            .toEqual(expect.arrayContaining([
                'activeStartSample16k',
                'activeEndSample16k',
            ]));
        expect((definitions.PayloadLinkBind as JsonObject).properties)
            .not.toHaveProperty('activeStartOutputSample');

        const subtitlePolicy = (
            (definitions.PayloadSubtitleTrackPolicy as JsonObject).properties as JsonObject
        ).policy as JsonObject;
        expect(subtitlePolicy.enum).toEqual([
            'preserve-absolute',
            'ripple-with-video-edit',
            'remove-with-deleted-video-range',
        ]);
    });

    it('keeps opaque IDs and operation aliases mutually exclusive and executable', () => {
        const aliasSchema = getDefinitions(common).OpaqueIdOrAlias as JsonObject;
        expect(validateFixture(
            '$split.rightClipId',
            aliasSchema,
            'common.schema.json',
        )).toEqual([]);
        expect(validateFixture('video_clip_1', aliasSchema, 'common.schema.json')).toEqual([]);
    });

    it('keeps media identity path-free and background color canonical at rest', () => {
        const commonDefinitions = getDefinitions(common);
        const sessionDefinitions = getDefinitions(session);
        const identity = commonDefinitions.ImmutableMediaIdentityV1 as JsonObject;
        expect(identity.required).toEqual(expect.arrayContaining([
            'contentDigest',
            'descriptorFingerprint',
            'byteLength',
        ]));
        expect(identity.properties).not.toHaveProperty('path');
        expect(identity.properties).not.toHaveProperty('canonicalPath');

        const sourceRecord = sessionDefinitions.SourceRegistryRecordV1 as JsonObject;
        expect(sourceRecord.properties).toHaveProperty('pathReferenceId');
        expect(sourceRecord.properties).not.toHaveProperty('canonicalPath');

        const envelope = sessionDefinitions.ManagedProjectEnvelopeV1 as JsonObject;
        const envelopeProperties = envelope.properties as JsonObject;
        const head = envelopeProperties.head as JsonObject;
        const headProperties = head.properties as JsonObject;
        expect(head.required).toContain('renderBackgroundColor');
        expect(headProperties.renderBackgroundColor).toEqual({
            type: 'string',
            pattern: '^#[0-9a-f]{6}$',
            default: '#000000',
        });
    });

    it('accepts valid golden fixtures and rejects invalid fixtures', () => {
        const fixtureManifest = readJson(join(SCHEMA_DIRECTORY, 'fixtures', 'golden-cases.json'));
        for (const expectation of ['valid', 'invalid'] as const) {
            const fixtures = fixtureManifest[expectation] as JsonObject[];
            for (const fixture of fixtures) {
                const value = readJson(join(
                    SCHEMA_DIRECTORY,
                    'fixtures',
                    fixture.path as string,
                ));
                const resolved = resolveSchemaRef(
                    fixture.schemaRef as string,
                    'common.schema.json',
                );
                const errors = validateFixture(value, resolved.schema, resolved.fileName);
                if (expectation === 'valid') {
                    expect(errors, fixture.path as string).toEqual([]);
                } else {
                    expect(errors.length, fixture.path as string).toBeGreaterThan(0);
                }
            }
        }
    });
});
