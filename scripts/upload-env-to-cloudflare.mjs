#!/usr/bin/env node

/**
 * Script to upload environment variables to Cloudflare using Wrangler
 *
 * Usage:
 *   # From a file
 *   node scripts/upload-env-to-cloudflare.mjs --file .env.production
 *
 *   # From a string
 *   node scripts/upload-env-to-cloudflare.mjs --string "KEY1=value1\nKEY2=\"value2\""
 *
 *   # Specify environment (default: production)
 *   node scripts/upload-env-to-cloudflare.mjs --file .env.production --env production
 *
 *   # Dry run (show what would be uploaded without actually uploading)
 *   node scripts/upload-env-to-cloudflare.mjs --file .env.production --dry-run
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (flag) => {
    const index = args.indexOf(flag);
    return index !== -1 && args[index + 1] ? args[index + 1] : null;
};

const hasFlag = (flag) => args.includes(flag);

const filePath = getArg("--file") || getArg("-f");
const envString = getArg("--string") || getArg("-s");
const environment = getArg("--env") || getArg("-e") || "production";
const dryRun = hasFlag("--dry-run") || hasFlag("-d");
const help = hasFlag("--help") || hasFlag("-h");

// Show help
if (help || (!filePath && !envString)) {
    console.log(`
Upload environment variables to Cloudflare using Wrangler

Usage:
  node scripts/upload-env-to-cloudflare.mjs [options]

Options:
  -f, --file <path>      Path to .env file
  -s, --string <string>  Environment variables as a string
  -e, --env <env>        Environment name (default: production)
  -d, --dry-run          Show what would be uploaded without uploading
  -h, --help             Show this help message

Examples:
  # Upload from file
  node scripts/upload-env-to-cloudflare.mjs --file .env.production

  # Upload from string
  node scripts/upload-env-to-cloudflare.mjs --string "KEY1=value1\\nKEY2=value2"

  # Dry run
  node scripts/upload-env-to-cloudflare.mjs --file .env.production --dry-run
  `);
    process.exit(0);
}

/**
 * Parse environment variables from a string
 * Supports formats:
 * - KEY=value
 * - KEY="value"
 * - KEY='value'
 * - Comments starting with #
 * - Inline comments (e.g., KEY=value # comment)
 * - Empty lines
 */
function parseEnvString(content) {
    const lines = content.split("\n");
    const vars = {};

    for (let line of lines) {
        // Trim whitespace
        line = line.trim();

        // Skip empty lines and comments
        if (!line || line.startsWith("#")) {
            continue;
        }

        // Find the first = sign
        const equalIndex = line.indexOf("=");
        if (equalIndex === -1) {
            continue;
        }

        // Extract key and value
        const key = line.substring(0, equalIndex).trim();
        let value = line.substring(equalIndex + 1).trim();

        // Check if value is quoted
        const isDoubleQuoted = value.startsWith('"');
        const isSingleQuoted = value.startsWith("'");

        if (isDoubleQuoted || isSingleQuoted) {
            // Find the closing quote
            const quote = isDoubleQuoted ? '"' : "'";
            const closingQuoteIndex = value.indexOf(quote, 1);

            if (closingQuoteIndex !== -1) {
                // Extract value between quotes
                value = value.substring(1, closingQuoteIndex);
            }
            else {
                // No closing quote found, remove opening quote
                value = value.substring(1);
            }
        }
        else {
            // Not quoted - remove inline comments
            const commentIndex = value.indexOf("#");
            if (commentIndex !== -1) {
                value = value.substring(0, commentIndex).trim();
            }
        }

        // Only add non-empty keys
        if (key) {
            vars[key] = value;
        }
    }

    return vars;
}

/**
 * Upload a single environment variable to Cloudflare using Wrangler
 */
function uploadVar(key, value, env, dryRun = false) {
    const command = `pnpm exec wrangler secret put ${key} --env ${env}`;

    if (dryRun) {
        console.log(`[DRY RUN] Would execute: ${command}`);
        console.log(`[DRY RUN] With value: ${value.substring(0, 10)}${value.length > 10 ? "..." : ""}`);
        return true;
    }

    try {
        console.log(`Uploading ${key}...`);
        execSync(command, {
            input: value,
            stdio: ["pipe", "pipe", "inherit"],
        });
        console.log(`✓ ${key} uploaded successfully`);
        return true;
    }
    catch (error) {
        console.error(`✗ Failed to upload ${key}:`, error.message);
        return false;
    }
}

// Main execution
try {
    // Get environment variables content
    let content;
    if (filePath) {
        console.log(`Reading environment variables from: ${filePath}`);
        content = readFileSync(filePath, "utf-8");
    }
    else {
        console.log("Reading environment variables from string");
        content = envString;
    }

    // Extract content between <secrets> and </secrets> if tags are present
    const secretsMatch = content.match(/<secrets>([\s\S]*?)<\/secrets>/);
    if (secretsMatch) {
        console.log("Found <secrets> tags, only variables within these tags will be uploaded.");
        content = secretsMatch[1];
    }

    // Parse environment variables
    const vars = parseEnvString(content);
    const varCount = Object.keys(vars).length;

    console.log(`\nFound ${varCount} environment variable(s)`);

    if (varCount === 0) {
        console.log("No environment variables to upload");
        process.exit(0);
    }

    if (dryRun) {
        console.log("\n=== DRY RUN MODE ===");
        console.log("The following variables would be uploaded:\n");
    }
    else {
        console.log(`\nUploading to Cloudflare (environment: ${environment})...\n`);
    }

    // Upload each variable
    let successCount = 0;
    let failCount = 0;

    for (const [key, value] of Object.entries(vars)) {
        const success = uploadVar(key, value, environment, dryRun);
        if (success) {
            successCount++;
        }
        else {
            failCount++;
        }
    }

    // Summary
    console.log("\n=== Summary ===");
    if (dryRun) {
        console.log(`Would upload ${successCount} variable(s)`);
    }
    else {
        console.log(`Successfully uploaded: ${successCount}`);
        console.log(`Failed: ${failCount}`);
    }

    process.exit(failCount > 0 ? 1 : 0);

}
catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
}
