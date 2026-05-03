import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { inspectDaemonRuntime } from "./sidecar-client.js";
import type { ToolDevConfig } from "./config.js";

// 3 brands × 2 skills. Brands span the visual spectrum (clean/photographic,
// gradient/dense, raw/loud) so a passing run proves the design-system
// context actually reaches the agent. Skills span artifact modes
// (prototype + deck) so two render paths get exercised.
const COMBOS: ReadonlyArray<{ brand: string; skill: string }> = [
  { brand: "apple", skill: "saas-landing" },
  { brand: "stripe", skill: "saas-landing" },
  { brand: "brutalism", skill: "saas-landing" },
  { brand: "apple", skill: "simple-deck" },
  { brand: "stripe", skill: "simple-deck" },
  { brand: "brutalism", skill: "simple-deck" },
];

// The discovery prompt forces a `<question-form>` on turn 1 unless the
// user message starts with `[form answers — discovery]`. We bake the
// answers in so the agent jumps straight to artifact generation.
const FORM_ANSWERS_PREFIX = "[form answers — discovery]\n";

const BRIEFS: Record<string, { formAnswers: string; brief: string }> = {
  "saas-landing": {
    formAnswers: [
      "- output: Single web prototype / landing",
      "- platform: Desktop web",
      "- audience: small-team founders evaluating AI productivity tools",
      "- tone: Modern minimal",
      "- brand: I have a brand spec — I'll share it",
      "- scale: 1 landing page (hero + 3 feature blocks + pricing teaser + footer)",
      "- constraints: real copy, no lorem ipsum",
    ].join("\n"),
    brief:
      "A landing page for an AI-powered email triage tool aimed at small-team founders. One hero, three feature blocks, pricing teaser, footer.",
  },
  "simple-deck": {
    formAnswers: [
      "- output: Slide deck / pitch",
      "- platform: Fixed canvas (1920×1080)",
      "- audience: seed-stage investors",
      "- tone: Editorial / magazine",
      "- brand: I have a brand spec — I'll share it",
      "- scale: 5 slides",
      "- constraints: real copy, no lorem ipsum",
    ].join("\n"),
    brief:
      "A 5-slide pitch deck for an AI-powered email triage tool: problem, solution, market, traction, ask.",
  },
};

interface ComboResult {
  brand: string;
  skill: string;
  status: "succeeded" | "failed" | "canceled" | "error" | "timeout";
  durationMs: number;
  artifactPath: string | null;
  projectId: string;
  error?: string;
}

async function pollForTerminal(
  daemonUrl: string,
  runId: string,
  timeoutMs: number,
): Promise<{ status: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`${daemonUrl}/api/runs/${runId}`);
    if (!resp.ok) throw new Error(`GET /api/runs/${runId} → ${resp.status}`);
    const body = (await resp.json()) as { status: string };
    if (
      body.status === "succeeded" ||
      body.status === "failed" ||
      body.status === "canceled"
    ) {
      return body;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`run ${runId} did not terminate within ${timeoutMs}ms`);
}

async function runOne(args: {
  daemonUrl: string;
  agentId: string;
  brand: string;
  skill: string;
  outDir: string;
  timeoutMs: number;
}): Promise<ComboResult> {
  const { daemonUrl, agentId, brand, skill, outDir, timeoutMs } = args;
  const start = Date.now();
  const projectId = `smoke-${brand}-${skill}-${start}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");

  try {
    const briefDef = BRIEFS[skill];
    if (!briefDef) throw new Error(`no brief defined for skill: ${skill}`);
    const message = `${FORM_ANSWERS_PREFIX}${briefDef.formAnswers}\n\n${briefDef.brief}`;

    const createResp = await fetch(`${daemonUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: projectId,
        name: `Smoke: ${brand} × ${skill}`,
        skillId: skill,
        designSystemId: brand,
      }),
    });
    if (!createResp.ok) {
      const text = await createResp.text().catch(() => "");
      throw new Error(`POST /api/projects → ${createResp.status} ${text}`);
    }
    const { conversationId } = (await createResp.json()) as {
      conversationId: string;
    };

    // No `systemPrompt` field — daemon's `composeDaemonSystemPrompt`
    // assembles it server-side from skillId + designSystemId + project
    // metadata. Matches what the web client + daemon do in production.
    const runResp = await fetch(`${daemonUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId,
        message,
        projectId,
        conversationId,
        assistantMessageId: randomUUID(),
        clientRequestId: randomUUID(),
        skillId: skill,
        designSystemId: brand,
      }),
    });
    if (!runResp.ok) {
      const text = await runResp.text().catch(() => "");
      throw new Error(`POST /api/runs → ${runResp.status} ${text}`);
    }
    const { runId } = (await runResp.json()) as { runId: string };

    const terminal = await pollForTerminal(daemonUrl, runId, timeoutMs);
    const durationMs = Date.now() - start;

    let artifactPath: string | null = null;
    if (terminal.status === "succeeded") {
      const filesResp = await fetch(`${daemonUrl}/api/projects/${projectId}/files`);
      if (filesResp.ok) {
        const { files } = (await filesResp.json()) as {
          files: Array<{ name: string }>;
        };
        const html = files.find((f) => f.name.toLowerCase().endsWith(".html"));
        if (html) {
          const rawResp = await fetch(
            `${daemonUrl}/api/projects/${projectId}/raw/${encodeURIComponent(html.name)}`,
          );
          if (rawResp.ok) {
            const text = await rawResp.text();
            artifactPath = path.join(outDir, `${brand}-${skill}.html`);
            await writeFile(artifactPath, text, "utf8");
          }
        }
      }
    }

    return {
      brand,
      skill,
      status: terminal.status as ComboResult["status"],
      durationMs,
      artifactPath,
      projectId,
    };
  } catch (err) {
    return {
      brand,
      skill,
      status: "error",
      durationMs: Date.now() - start,
      artifactPath: null,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runSmoke(opts: {
  config: ToolDevConfig;
  outRoot?: string;
  agent?: string;
  timeoutMs?: number;
}): Promise<void> {
  const status = await inspectDaemonRuntime({
    base: opts.config.toolsDevRoot,
    namespace: opts.config.namespace,
  });
  if (!status?.url) {
    throw new Error(
      "daemon is not running — start it with `pnpm tools-dev start daemon` first",
    );
  }
  const daemonUrl = status.url.replace(/\/$/, "");
  const agentId = opts.agent ?? process.env.OD_SMOKE_AGENT ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(opts.outRoot ?? path.resolve(".tmp", "smoke"), ts);
  await mkdir(outDir, { recursive: true });

  process.stderr.write(
    `[smoke] daemon=${daemonUrl} agent=${agentId} out=${outDir}\n\n`,
  );

  const results: ComboResult[] = [];
  for (const combo of COMBOS) {
    process.stderr.write(`[smoke] ${combo.brand} × ${combo.skill} ... `);
    const r = await runOne({ daemonUrl, agentId, ...combo, outDir, timeoutMs });
    results.push(r);
    const tag = r.status === "succeeded" ? "✓" : "✗";
    const detail = r.error
      ? ` (${r.error})`
      : r.artifactPath
        ? ` → ${path.basename(r.artifactPath)}`
        : "";
    process.stderr.write(
      `${tag} ${r.status} ${(r.durationMs / 1000).toFixed(1)}s${detail}\n`,
    );
  }

  const passed = results.filter((r) => r.status === "succeeded").length;
  const summary = [
    `# Smoke run — ${ts}`,
    ``,
    `- Agent: \`${agentId}\``,
    `- Daemon: \`${daemonUrl}\``,
    `- Combos: ${results.length}`,
    `- Passed: ${passed}`,
    `- Failed: ${results.length - passed}`,
    ``,
    `| Brand | Skill | Status | Duration | Artifact | Project |`,
    `|---|---|---|---|---|---|`,
    ...results.map((r) => {
      const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
      const art = r.artifactPath
        ? `[${path.basename(r.artifactPath)}](./${path.basename(r.artifactPath)})`
        : "—";
      const note = r.error ? ` (${r.error})` : "";
      return `| ${r.brand} | ${r.skill} | ${r.status}${note} | ${dur} | ${art} | \`${r.projectId}\` |`;
    }),
    ``,
    `## Visual diff hint`,
    ``,
    `Open the apple/saas-landing and brutalism/saas-landing artifacts side-by-side.`,
    `If they look meaningfully different, the design-system context reached the agent.`,
    `If they look the same, prompt assembly is leaking — start at \`composeSystemPrompt\` in \`packages/contracts/src/prompts/system.ts\`.`,
    ``,
  ].join("\n");
  await writeFile(path.join(outDir, "summary.md"), summary, "utf8");

  process.stderr.write(
    `\n[smoke] ${passed}/${results.length} passed — ${path.join(outDir, "summary.md")}\n`,
  );
  if (passed < results.length) process.exitCode = 1;
}
