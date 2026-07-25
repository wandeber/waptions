import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

import type { JsonObject } from '../mcp/contracts';
import type { McpAppResource } from '../mcp/app-resource';
import {
    loadCommittedCoreSemanticSchemaBundle,
} from '../mcp/core-schema-loader';
import type {
    CoreSemanticSchemaBundle,
} from '../mcp/semantic-schema-adapter';
import {
    TOOL_NAMES,
    WAPTIONS_API_VERSION,
} from '../mcp/constants';

export interface PackagedFileRecord {
    path: string;
    sha256: string;
    bytes: number;
}

export interface PackagedBuildManifest {
    schemaVersion: 1;
    sourceCommit: string;
    sourceTree: string;
    packageManager: string;
    buildScript: string;
    app: {
        resourceUri: string;
        buildHash: string;
        mimeType: string;
        indexTemplateSha256: string;
        payloadFiles: string[];
    };
    buildInputs: PackagedFileRecord[];
    files: PackagedFileRecord[];
    licenses: string[];
}

export interface VerifiedPackagedRuntime {
    pluginRoot: string;
    manifestPath: string;
    manifestSha256: `sha256:${string}`;
    manifest: PackagedBuildManifest;
    appResource: McpAppResource;
    semanticSchemas: CoreSemanticSchemaBundle;
}

export interface LoadPackagedRuntimeOptions {
    pluginRoot?: string;
    manifestPath?: string;
    moduleUrl?: string;
}

const MANIFEST_MAX_BYTES = 1024 * 1024;
const MAX_MANIFEST_FILES = 2_048;
const MAX_APP_HTML_BYTES = 16 * 1024 * 1024;
const GIT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_SCHEMA_FILES = [
    'common.schema.json',
    'operations.schema.json',
    'protocol-contract.json',
    'schema-manifest.json',
    'session.schema.json',
    'tool-registry.json',
    'tools.schema.json',
] as const;

export async function loadVerifiedPackagedRuntime(
    options: LoadPackagedRuntimeOptions = {},
): Promise<VerifiedPackagedRuntime> {
    const locations = await resolvePackageLocations(options);
    const manifestBytes = await readBoundedRegularFile(
        locations.manifestPath,
        MANIFEST_MAX_BYTES,
        'packaged build manifest',
    );
    const manifest = parseManifest(manifestBytes);
    const fileRecords = new Map<string, PackagedFileRecord>();
    for (const record of manifest.files) {
        if (fileRecords.has(record.path)) {
            throw new Error(`Duplicate packaged file record: ${record.path}`);
        }
        fileRecords.set(record.path, record);
        await verifyPackagedFile(locations.pluginRoot, record);
    }

    const serverRecord = fileRecords.get('mcp/server.mjs');
    if (!serverRecord) {
        throw new Error('The packaged server bundle is missing from the manifest.');
    }
    const appPath = `mcp/app/${manifest.app.buildHash}/index.html`;
    const appRecord = fileRecords.get(appPath);
    if (!appRecord || appRecord.bytes > MAX_APP_HTML_BYTES) {
        throw new Error('The packaged MCP App record is missing or oversized.');
    }
    const appBytes = await readBoundedRegularFile(
        resolveInside(locations.pluginRoot, appPath),
        MAX_APP_HTML_BYTES,
        'packaged MCP App',
    );
    if (sha256(appBytes) !== appRecord.sha256) {
        throw new Error('The packaged MCP App bytes do not match the manifest.');
    }
    assertAppIdentity(manifest, appBytes, fileRecords);
    assertSchemaRecords(fileRecords);
    assertExactRuntimeFiles(manifest, fileRecords, appPath);

    const semanticSchemas = loadCommittedCoreSemanticSchemaBundle();
    if (
        semanticSchemas.apiVersion !== WAPTIONS_API_VERSION
        || semanticSchemas.toolNames.length !== TOOL_NAMES.length
        || semanticSchemas.toolNames.some(
            (name, index) => name !== TOOL_NAMES[index],
        )
    ) {
        throw new Error('The packaged canonical tool inventory is invalid.');
    }
    const appResource = createVerifiedMcpAppResource({
        html: appBytes.toString('utf8'),
        uri: manifest.app.resourceUri,
        buildHash: manifest.app.buildHash,
        mimeType: manifest.app.mimeType,
        htmlSha256: `sha256:${appRecord.sha256}`,
    });
    return {
        ...locations,
        manifestSha256: `sha256:${sha256(manifestBytes)}`,
        manifest,
        appResource,
        semanticSchemas,
    };
}

async function resolvePackageLocations(
    options: LoadPackagedRuntimeOptions,
): Promise<{ pluginRoot: string; manifestPath: string }> {
    const modulePath = fileURLToPath(
        options.moduleUrl ?? import.meta.url,
    );
    const inferredRoot = resolve(dirname(modulePath), '..');
    const configuredRoot = options.pluginRoot
        ?? process.env.WAPTIONS_PLUGIN_ROOT
        ?? inferredRoot;
    const configuredManifest = options.manifestPath
        ?? process.env.WAPTIONS_RUNTIME_MANIFEST
        ?? resolve(configuredRoot, 'build-manifest.json');
    if (
        !isAbsolute(configuredRoot)
        || !isAbsolute(configuredManifest)
        || configuredRoot.includes('\0')
        || configuredManifest.includes('\0')
    ) {
        throw new Error('Packaged runtime paths must be absolute.');
    }
    const pluginRoot = await realpath(configuredRoot);
    const manifestMetadata = await lstat(configuredManifest);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
        throw new Error('The packaged runtime manifest must be a regular file.');
    }
    const manifestPath = await realpath(configuredManifest);
    if (!isPathInsideOrEqual(pluginRoot, manifestPath)) {
        throw new Error('The packaged runtime manifest must stay inside the plugin root.');
    }
    return { pluginRoot, manifestPath };
}

function parseManifest(bytes: Buffer): PackagedBuildManifest {
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('The packaged build manifest is not valid JSON.');
    }
    const manifest = record(value, 'The packaged build manifest must be an object.');
    assertExactKeys(manifest, [
        'schemaVersion',
        'sourceCommit',
        'sourceTree',
        'packageManager',
        'buildScript',
        'app',
        'buildInputs',
        'files',
        'licenses',
    ]);
    const app = record(manifest.app, 'The packaged MCP App manifest is invalid.');
    assertExactKeys(app, [
        'resourceUri',
        'buildHash',
        'mimeType',
        'indexTemplateSha256',
        'payloadFiles',
    ]);
    if (
        manifest.schemaVersion !== 1
        || typeof manifest.sourceCommit !== 'string'
        || !GIT_OID.test(manifest.sourceCommit)
        || typeof manifest.sourceTree !== 'string'
        || !GIT_OID.test(manifest.sourceTree)
        || typeof manifest.packageManager !== 'string'
        || !/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.packageManager)
        || manifest.buildScript !== 'build:agent-plugin'
        || typeof app.resourceUri !== 'string'
        || typeof app.buildHash !== 'string'
        || !SHA256.test(app.buildHash)
        || app.resourceUri !==
            `ui://waptions/editor/v1/${app.buildHash}/index.html`
        || app.mimeType !== RESOURCE_MIME_TYPE
        || typeof app.indexTemplateSha256 !== 'string'
        || !SHA256.test(app.indexTemplateSha256)
        || !Array.isArray(app.payloadFiles)
        || app.payloadFiles.length !== 2
        || !Array.isArray(manifest.buildInputs)
        || !Array.isArray(manifest.files)
        || manifest.files.length === 0
        || manifest.files.length > MAX_MANIFEST_FILES
        || !Array.isArray(manifest.licenses)
        || manifest.licenses.length !== 1
        || manifest.licenses[0] !== 'THIRD_PARTY_LICENSES.txt'
    ) {
        throw new Error('The packaged build manifest contract is invalid.');
    }
    const parsedFiles = manifest.files.map(parseFileRecord);
    const parsedBuildInputs = manifest.buildInputs.map(parseFileRecord);
    const payloadFiles = app.payloadFiles.map((path) => safeRelativePath(path));
    const licenses = manifest.licenses.map((path) => safeRelativePath(path));
    return {
        schemaVersion: 1,
        sourceCommit: manifest.sourceCommit,
        sourceTree: manifest.sourceTree,
        packageManager: manifest.packageManager,
        buildScript: 'build:agent-plugin',
        app: {
            resourceUri: app.resourceUri,
            buildHash: app.buildHash,
            mimeType: app.mimeType,
            indexTemplateSha256: app.indexTemplateSha256,
            payloadFiles,
        },
        buildInputs: parsedBuildInputs,
        files: parsedFiles,
        licenses,
    };
}

function parseFileRecord(value: unknown): PackagedFileRecord {
    const item = record(value, 'A packaged file record is invalid.');
    assertExactKeys(item, ['path', 'sha256', 'bytes']);
    if (
        typeof item.path !== 'string'
        || typeof item.sha256 !== 'string'
        || !SHA256.test(item.sha256)
        || !Number.isSafeInteger(item.bytes)
        || Number(item.bytes) < 0
    ) {
        throw new Error('A packaged file record is invalid.');
    }
    return {
        path: safeRelativePath(item.path),
        sha256: item.sha256,
        bytes: Number(item.bytes),
    };
}

async function verifyPackagedFile(
    root: string,
    recordValue: PackagedFileRecord,
): Promise<void> {
    const path = resolveInside(root, recordValue.path);
    const before = await lstat(path);
    if (
        !before.isFile()
        || before.isSymbolicLink()
        || before.size !== recordValue.bytes
    ) {
        throw new Error(`Packaged file identity is invalid: ${recordValue.path}`);
    }
    const handle = await open(path, 'r');
    try {
        const opened = await handle.stat();
        if (
            !opened.isFile()
            || opened.dev !== before.dev
            || opened.ino !== before.ino
            || opened.size !== before.size
        ) {
            throw new Error(`Packaged file changed while opening: ${recordValue.path}`);
        }
        const digest = await hashOpenFile(handle.fd);
        const after = await handle.stat();
        if (
            digest !== recordValue.sha256
            || after.dev !== opened.dev
            || after.ino !== opened.ino
            || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs
        ) {
            throw new Error(`Packaged file hash is invalid: ${recordValue.path}`);
        }
    } finally {
        await handle.close();
    }
}

async function hashOpenFile(fileDescriptor: number): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream('', {
        fd: fileDescriptor,
        autoClose: false,
        start: 0,
    });
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function readBoundedRegularFile(
    path: string,
    maximumBytes: number,
    label: string,
): Promise<Buffer> {
    const metadata = await lstat(path);
    if (
        !metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.size > maximumBytes
    ) {
        throw new Error(`The ${label} is not a bounded regular file.`);
    }
    const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
        const opened = await handle.stat();
        if (
            !opened.isFile()
            || opened.dev !== metadata.dev
            || opened.ino !== metadata.ino
            || opened.size !== metadata.size
        ) {
            throw new Error(`The ${label} changed while it was opened.`);
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (
            after.dev !== opened.dev
            || after.ino !== opened.ino
            || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs
            || bytes.byteLength !== opened.size
        ) {
            throw new Error(`The ${label} changed while it was read.`);
        }
        return bytes;
    } finally {
        await handle.close();
    }
}

function assertAppIdentity(
    manifest: PackagedBuildManifest,
    appBytes: Buffer,
    files: ReadonlyMap<string, PackagedFileRecord>,
): void {
    const html = appBytes.toString('utf8');
    const occurrences = html.split(manifest.app.resourceUri).length - 1;
    if (occurrences !== 1) {
        throw new Error('The packaged MCP App must embed its resource URI exactly once.');
    }
    const template = html.replace(
        manifest.app.resourceUri,
        '{{WAPTIONS_RESOURCE_URI}}',
    );
    if (sha256(Buffer.from(template, 'utf8')) !== manifest.app.indexTemplateSha256) {
        throw new Error('The packaged MCP App template hash is invalid.');
    }
    const expectedPayloadPaths = [
        `mcp/app/${manifest.app.buildHash}/app.css`,
        `mcp/app/${manifest.app.buildHash}/app.js`,
    ].sort();
    if (
        [...manifest.app.payloadFiles].sort().join('\0')
        !== expectedPayloadPaths.join('\0')
    ) {
        throw new Error('The packaged MCP App payload inventory is invalid.');
    }
    const payloadRecords = expectedPayloadPaths.map((path) => {
        const file = files.get(path);
        if (!file) {
            throw new Error(`The packaged MCP App payload is missing: ${path}`);
        }
        return {
            path: basename(path),
            sha256: file.sha256,
            bytes: file.bytes,
        };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const buildHash = sha256(Buffer.from(stableStringify({
        indexTemplateSha256: manifest.app.indexTemplateSha256,
        payloadFiles: payloadRecords,
    })));
    if (buildHash !== manifest.app.buildHash) {
        throw new Error('The packaged MCP App build hash is invalid.');
    }
}

function assertSchemaRecords(
    files: ReadonlyMap<string, PackagedFileRecord>,
): void {
    for (const name of REQUIRED_SCHEMA_FILES) {
        if (!files.has(`schemas/2026-07-25/${name}`)) {
            throw new Error(`The packaged canonical schema is missing: ${name}`);
        }
    }
}

function assertExactRuntimeFiles(
    manifest: PackagedBuildManifest,
    files: ReadonlyMap<string, PackagedFileRecord>,
    appPath: string,
): void {
    const expected = [
        'mcp/server.mjs',
        appPath,
        ...manifest.app.payloadFiles,
        ...REQUIRED_SCHEMA_FILES.map(
            (name) => `schemas/2026-07-25/${name}`,
        ),
        ...manifest.licenses,
    ].sort();
    const actual = [...files.keys()].sort();
    if (
        actual.length !== expected.length
        || actual.some((path, index) => path !== expected[index])
    ) {
        throw new Error(
            'The packaged runtime contains files outside its exact inventory.',
        );
    }
}

function createVerifiedMcpAppResource(
    input: {
        html: string;
        uri: string;
        buildHash: string;
        mimeType: string;
        htmlSha256: `sha256:${string}`;
    },
): McpAppResource {
    if (
        !input.html.trim()
        || !SHA256.test(input.buildHash)
        || input.uri
            !== `ui://waptions/editor/v1/${input.buildHash}/index.html`
        || input.mimeType !== RESOURCE_MIME_TYPE
        || input.htmlSha256 !== `sha256:${sha256(input.html)}`
    ) {
        throw new Error('The verified packaged MCP App identity is invalid.');
    }
    const canonicalAssets = [
        {
            path: 'index.html',
            bytes: Buffer.byteLength(input.html, 'utf8'),
            sha256: input.htmlSha256,
        },
    ] as const;
    const uiMeta = {
        ui: {
            csp: {
                connectDomains: ['http://localhost:59941'],
                resourceDomains: ['http://localhost:59941'],
                frameDomains: [],
                baseUriDomains: [],
            },
            permissions: {},
            prefersBorder: true,
        },
    } satisfies JsonObject;
    return {
        buildHash: input.buildHash,
        uri: input.uri,
        mimeType: RESOURCE_MIME_TYPE,
        html: input.html,
        htmlSha256: input.htmlSha256,
        canonicalAssets,
        payloadManifestSha256: `sha256:${input.buildHash}`,
        listMeta: uiMeta,
        readMeta: uiMeta,
    };
}

function resolveInside(root: string, relativePath: string): string {
    const path = resolve(root, safeRelativePath(relativePath));
    if (!isPathInsideOrEqual(root, path)) {
        throw new Error('A packaged path escapes the plugin root.');
    }
    return path;
}

function safeRelativePath(value: string): string {
    if (
        value.length === 0
        || value.length > 512
        || value.includes('\0')
        || value.includes('\\')
        || isAbsolute(value)
        || value.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
        throw new Error(`Invalid packaged relative path: ${value}`);
    }
    return value;
}

function isPathInsideOrEqual(root: string, child: string): boolean {
    const path = relative(root, child);
    return (
        path === ''
        || (
            path !== '..'
            && !path.startsWith(`..${sep}`)
            && !isAbsolute(path)
        )
    );
}

function record(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(message);
    }
    return value as Record<string, unknown>;
}

function assertExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): void {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    if (
        actual.length !== sortedExpected.length
        || actual.some((key, index) => key !== sortedExpected[index])
    ) {
        throw new Error('The packaged manifest contains unexpected fields.');
    }
}

function sha256(value: Buffer | string): string {
    return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
    return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [
                    key,
                    sortJson((value as Record<string, unknown>)[key]),
                ]),
        );
    }
    return value;
}
