// Wraps the existing, unchanged Production deployment command
// (`vercel deploy --prod --yes --scope noetikon-technologies`) with:
//   - a Git working-tree safety check (scripts/seed-rbac.ts's long-standing
//     pre-existing uncommitted diff is the one allowed exception — every
//     other modified/untracked file blocks the deploy);
//   - Git SHA capture, passed to Vercel as `-m gitSha=<sha>` deployment
//     metadata (whether `vercel inspect` later exposes this metadata back
//     has not been verified — this script does not depend on it, since
//     docs/deployments.md remains the authoritative commit-to-deployment
//     record either way);
//   - parsing of the deployment command's own JSON result;
//   - an append-only docs/deployments.md log entry, written ONLY after the
//     deployment reports readyState === "READY".
//
// This script does not change what gets deployed or how — the underlying
// command is exactly `vercel deploy --prod --yes --scope
// noetikon-technologies`, unchanged. It only adds metadata capture and log
// recording around it. It never stashes, resets, checks out, or otherwise
// modifies Git state — an unsafe working tree simply blocks the deploy.
//
// Usage:
//   node scripts/deploy-production.mjs             usage only, deploys nothing
//   node scripts/deploy-production.mjs --dry-run    shows what would happen, deploys nothing
//   node scripts/deploy-production.mjs --prod       runs the real Production deployment
//
// `--prod` is the explicit confirmation required to ever actually deploy.
// There is deliberately no interactive prompt on top of it — one more
// confirmation step that only a human can answer would not be reliably
// automatable, and `--prod` already has to be typed/passed on purpose.
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SCOPE = "noetikon-technologies";
const DOMAIN = "axiaro.shop";
const DEPLOYMENTS_LOG = fileURLToPath(new URL("../docs/deployments.md", import.meta.url));
const ALLOWED_DIRTY_FILES = new Set(["scripts/seed-rbac.ts"]);
const WIN = process.platform === "win32";

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/deploy-production.mjs --dry-run    Show what would happen; deploys nothing.",
      "  node scripts/deploy-production.mjs --prod       Run the real Production deployment.",
      "",
      "No deployment happens unless --prod is passed explicitly.",
    ].join("\n"),
  );
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", shell: WIN });
}

function getGitSha() {
  try {
    return run("git", ["rev-parse", "HEAD"]).trim();
  } catch (err) {
    throw new Error(`Could not determine the current Git SHA: ${err.message}`);
  }
}

function getGitBranch() {
  try {
    return run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return "(unknown)";
  }
}

/** Returns the list of raw `git status --porcelain` lines that are NOT the
 *  one allowed pre-existing exception. Empty array = safe to deploy. */
function findUnexpectedChanges() {
  const statusOut = run("git", ["status", "--porcelain"]);
  const lines = statusOut.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean);
  return lines.filter((line) => {
    // Porcelain v1: "XY path" or "XY orig -> new" for renames.
    const path = line.slice(3).split(" -> ").pop();
    return !ALLOWED_DIRTY_FILES.has(path);
  });
}

/**
 * Scan the Vercel CLI's stdout for a parseable JSON deployment object.
 *
 * The exact shape of `vercel deploy --json` was not empirically verified
 * against a real Production deploy while building this script (running one
 * to check was out of scope). This project's own deploy history shows plain
 * `vercel deploy --yes` (no --json) already ending in a `{ status,
 * deployment: { id, url, readyState, target, ... }, ... }` block; `vercel
 * inspect --json` instead returns those fields flat at the top level. Both
 * shapes are handled here rather than assuming one.
 */
function extractDeployment(cliOutput) {
  const lines = cliOutput.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines.slice(i).join("\n").trim();
    if (!candidate.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // not (yet) a complete/valid JSON block — keep scanning
    }
    const dep = parsed.deployment ?? parsed;
    if (dep && typeof dep === "object" && ("id" in dep || "url" in dep)) {
      return dep;
    }
  }
  throw new Error(
    "Could not find a parseable deployment JSON object in the Vercel CLI output. " +
      "docs/deployments.md was NOT modified. Raw output was printed above for manual inspection.",
  );
}

function buildLogEntry({ date, sha, deploymentId, url, status, notes }) {
  return (
    `\n### ${date} — automated deployment via deploy-production.mjs\n\n` +
    `- Environment: Production\n` +
    `- Domain: ${DOMAIN}\n` +
    `- Commit: \`${sha}\`\n` +
    `- Deployment ID: \`${deploymentId}\`\n` +
    `- Status: ${status}\n` +
    `- Deployment URL: ${url}\n` +
    `- Notes: ${notes}\n`
  );
}

function printSummary({ sha, branch }) {
  console.log("Production deployment summary");
  console.log("------------------------------");
  console.log(`Git SHA: ${sha}`);
  console.log(`Branch:  ${branch}`);
  console.log(`Scope:   ${SCOPE}`);
  console.log(`Target:  production`);
  console.log(`Domain:  ${DOMAIN}`);
  console.log("");
}

async function main() {
  const args = process.argv.slice(2);
  const isProd = args.includes("--prod");
  const isDryRun = args.includes("--dry-run");

  if (!isProd && !isDryRun) {
    usage();
    process.exit(1);
  }

  const sha = getGitSha();
  const branch = getGitBranch();
  const unexpected = findUnexpectedChanges();

  if (unexpected.length > 0) {
    console.error("Refusing to deploy — unexpected working-tree changes found:");
    for (const line of unexpected) console.error(`  ${line}`);
    console.error(
      "\nOnly scripts/seed-rbac.ts's pre-existing diff is allowed. Commit, stash, or " +
        "otherwise resolve the file(s) above before deploying. This script never modifies " +
        "Git state itself.",
    );
    process.exit(1);
  }

  printSummary({ sha, branch });

  const vercelArgs = ["deploy", "--prod", "--yes", "--scope", SCOPE, "-m", `gitSha=${sha}`, "--json"];
  const vercelCommandString = `vercel ${vercelArgs.join(" ")}`;
  const date = new Date().toISOString().slice(0, 10);

  if (isDryRun) {
    console.log("[dry-run] Would run:");
    console.log(`  ${vercelCommandString}`);
    console.log("");
    const previewEntry = buildLogEntry({
      date,
      sha,
      deploymentId: "<from Vercel CLI JSON output>",
      url: "<from Vercel CLI JSON output>",
      status: "READY",
      notes: "Deployed via scripts/deploy-production.mjs.",
    });
    console.log(
      "[dry-run] If the real deployment reaches READY, this entry would be appended to docs/deployments.md:",
    );
    console.log(previewEntry);
    console.log("[dry-run] No deployment was made. docs/deployments.md was not modified.");
    return;
  }

  // --prod path
  console.log(`Running: ${vercelCommandString}`);
  let stdout;
  try {
    stdout = execFileSync("vercel", vercelArgs, { encoding: "utf8", shell: WIN });
  } catch (err) {
    console.error("Vercel deployment command failed.");
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    console.error(err.message);
    process.exit(1);
  }
  console.log(stdout);

  const deployment = extractDeployment(stdout);
  const { id, url, readyState, target } = deployment;
  console.log(`Deployment ID: ${id}`);
  console.log(`URL:           ${url}`);
  console.log(`Ready state:   ${readyState}`);
  console.log(`Target:        ${target}`);

  if (readyState !== "READY") {
    console.error(`Deployment did not reach READY (got "${readyState}"). docs/deployments.md was NOT modified.`);
    process.exit(1);
  }

  const entry = buildLogEntry({
    date,
    sha,
    deploymentId: id,
    url,
    status: readyState,
    notes: "Deployed via scripts/deploy-production.mjs.",
  });

  await appendFile(DEPLOYMENTS_LOG, entry, "utf8");
  console.log(`Recorded in ${DEPLOYMENTS_LOG}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
