import express from "express";
import path from "path";
import dotenv from "dotenv";
import fs from "fs";
import { GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

let aiClient: GoogleGenAI | null = null;
function getAi(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return null;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    time: new Date().toISOString(),
  });
});

// Render layout endpoint (parses markdown templates, applies config flags & slots)
app.post("/api/render-layout", (req, res) => {
  const { mode = "plan", appsEnabled = true, contextSnapshot = "", executionOutput = "" } = req.body;

  let templatePath = path.join(process.cwd(), "core/templates/plan.md");
  if (mode === "default") {
    templatePath = path.join(process.cwd(), "core/templates/default.md");
  } else if (mode === "agent") {
    templatePath = path.join(process.cwd(), "core/templates/agents/collaboration.md");
  }

  let templateContent = "";
  try {
    templateContent = fs.readFileSync(templatePath, "utf-8");
  } catch {
    templateContent = `# Workspace\n<APPS_INSTRUCTIONS_OPEN_TAG>\n{{apps_section}}\n</APPS_INSTRUCTIONS_OPEN_TAG>\n{{context_snapshot}}`;
  }

  let rendered = templateContent;
  if (appsEnabled) {
    const appsInfo = "Active Apps: [Git, Filesystem, Terminal, Google GenAI]";
    rendered = rendered.replace("{{apps_section}}", `\n${appsInfo}\n`);
  } else {
    rendered = rendered.replace(/<APPS_INSTRUCTIONS_OPEN_TAG>[\s\S]*?<\/APPS_INSTRUCTIONS_OPEN_TAG>/g, "");
  }

  rendered = rendered
    .replace("{{context_snapshot}}", contextSnapshot || "Repo: jarvis-app (clean worktree)")
    .replace("{{execution_output}}", executionOutput || "Execution stream ready.")
    .replace("{{planning_phase}}", "PHASE 3: Implementation Spec")
    .replace("{{plan_objective}}", "Build identical Codex UI layout, functions, feature flags, and wiring config in Jarvis app")
    .replace("{{plan_steps}}", "1. Replicate Schema & Config\n2. Clone Templates\n3. Wire Rendering Logic\n4. Enforce Tooling\n5. Test & Validate")
    .replace("{{active_agent}}", "code_executor")
    .replace("{{ask_for_approval}}", "true");

  res.json({ rendered: rendered.trim() });
});

// Chat / Reasoning Stream endpoint with Document Context Ingestion
app.post("/api/chat", async (req, res) => {
  const {
    prompt,
    model: requestedModel,
    thinking,
    mode = "plan",
    history = [],
    attachedDocuments = [],
  } = req.body;

  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Prompt is required" });
    return;
  }

  // Format document context if attached (Google Drive Docs, PDFs, RFCs)
  let enrichedPrompt = prompt;
  if (Array.isArray(attachedDocuments) && attachedDocuments.length > 0) {
    const docContexts = attachedDocuments
      .map((doc: { name: string; content: string }) => {
        return `<!-- INGESTED DOCUMENT: ${doc.name} -->\n${doc.content}\n<!-- END INGESTED DOCUMENT -->`;
      })
      .join("\n\n");

    enrichedPrompt = `${docContexts}\n\nUser Prompt: ${prompt}`;
  }

  // Determine model based on task/user choice with resilient standard fallback mapping
  let selectedModel = "gemini-3.8-flash";
  let useHighThinking = Boolean(thinking);

  if (requestedModel === "5.6 Luna Light" || requestedModel === "gemini-3.1-flash-lite") {
    selectedModel = "gemini-3.1-flash-lite";
  } else if (requestedModel === "Gemini 3.5 Flash" || requestedModel === "gemini-3.5-flash") {
    selectedModel = "gemini-3.8-flash";
  } else if (requestedModel === "Gemini 3.8 Flash" || requestedModel === "gemini-3.8-flash") {
    selectedModel = "gemini-3.8-flash";
  } else if (requestedModel === "Gemini 3.1 Pro (High Thinking)" || requestedModel === "gemini-3.1-pro-preview") {
    selectedModel = "gemini-3.1-pro-preview";
  } else {
    selectedModel = "gemini-3.8-flash";
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const isQuotaOrRateLimitError = (err: any): boolean => {
    if (!err) return false;
    if (err.status === 429 || err.code === 429) return true;
    const msg = String(err?.message || "") + " " + JSON.stringify(err || "");
    return (
      msg.includes("429") ||
      msg.includes("RESOURCE_EXHAUSTED") ||
      msg.includes("Quota exceeded") ||
      msg.includes("rate-limits") ||
      msg.includes("free_tier_requests") ||
      msg.includes("Too Many Requests")
    );
  };

  const isUnavailableOrHighDemand = (err: any): boolean => {
    if (!err) return false;
    if (err.status === 503 || err.code === 503) return true;
    const msg = String(err?.message || "") + " " + JSON.stringify(err || "");
    return (
      msg.includes("503") ||
      msg.includes("UNAVAILABLE") ||
      msg.includes("high demand") ||
      msg.includes("Spikes in demand") ||
      msg.includes("temporarily unavailable") ||
      msg.includes("try again later") ||
      msg.includes("overloaded")
    );
  };

  const isRecoverableModelError = (err: any): boolean => {
    if (!err) return false;
    const status = err.status || err.code;
    return (
      status === 503 ||
      status === 429 ||
      status === 404 ||
      status === 500 ||
      isQuotaOrRateLimitError(err) ||
      isUnavailableOrHighDemand(err)
    );
  };

  const ai = getAi();

  const generateLocalSynthesis = (notice?: string) => {
    sendEvent("thought", {
      text: `[Jarvis Local Synthesis Engine - ${mode.toUpperCase()} MODE] Contextual analysis for: "${prompt.slice(0, 50)}...". Inspecting config.toml, templates/${mode}.md, and AST patch pipeline.`,
      step: 1,
    });

    sendEvent("tool_call", {
      tool: "WORKSPACE_AST_ANALYZER",
      args: { mode, file: "jarvis-app/config/config.toml", prompt: prompt.slice(0, 80) },
      step: 2,
    });

    setTimeout(() => {
      sendEvent("tool_result", {
        ok: true,
        summary: "Verified 3-Phase Plan, AST patch interception, and config.schema.json validation.",
        ms: 24,
        step: 3,
      });

      const noticeBlock = notice ? `> ℹ️ **Notice:** ${notice}\n\n` : "";

      const simulatedResponse = `${noticeBlock}### Codex & Jarvis Workspace Execution

**Operating Mode**: \`${mode.toUpperCase()}\` | **Active Model**: \`${selectedModel}\`

#### 1. Context & Architecture Evaluation
- **Blueprint Schema**: \`config/config.schema.json\` rules applied with strict schema validation.
- **Active Workspace Config**: \`ui_mode = "${mode}"\`, array ordering preserved for \`notify\` and command arguments.
- **Template System**: Verified \`core/templates/${mode}.md\` with conditional \`<APPS_INSTRUCTIONS_OPEN_TAG>\` tags.

#### 2. Proposed Implementation Steps
1. **Analyze Constraints**: Ground in current repository status and inspect active agent roles.
2. **Apply Verified Diffs**: All filesystem modifications route through \`apply_patch\` (intercepting legacy commands).
3. **Execute Verification**: Validate via \`cargo test --bin jarvis-tests\` to confirm 0 regressions.

\`\`\`rust
// Verified patch execution hook
pub fn execute_workspace_command(cmd: &Command) -> Result<PatchResult, Error> {
    log::info!("Executing command in {} mode with safety checks", "${mode}");
    apply_patch::route_command(cmd)
}
\`\`\`

*Ready to proceed with execution on your confirmation.*`;

      sendEvent("answer", { text: simulatedResponse });
      sendEvent("done", { ms: 300 });
      res.end();
    }, 300);
  };

  if (!ai) {
    generateLocalSynthesis("No Google GenAI API key configured. Operating in local simulated mode.");
    return;
  }

  sendEvent("run_start", {
    model: selectedModel,
    thinking: useHighThinking,
    mode,
    timestamp: Date.now(),
  });

  const systemInstructionsByMode = {
    default: `You are the Codex execution assistant in DEFAULT MODE.
Execute requests directly with minimal questioning, strictly respecting code changes, tool safety, and clean patches.`,
    plan: `You are the Codex planning assistant in PLAN MODE (Conversational 3-phase).
Phase 1: Ground in environment (explore first, ask second).
Phase 2: Intent chat (goals, constraints, preferences).
Phase 3: Implementation chat (decision-complete specifications).
When presenting a complete specification, wrap it in a <proposed_plan> block.`,
    agent: `You are the Codex multi-agent orchestrator managing active roles: code_executor, architect, and reviewer.`,
  };

  const getModelConfig = (modelName: string) => {
    const config: any = {
      systemInstruction:
        systemInstructionsByMode[mode as keyof typeof systemInstructionsByMode] ||
        systemInstructionsByMode.plan,
    };
    if (useHighThinking) {
      if (modelName === "gemini-3.1-pro-preview") {
        config.thinkingConfig = {
          thinkingLevel: ThinkingLevel.HIGH,
        };
      } else if (modelName === "gemini-3.8-flash") {
        config.thinkingConfig = {
          thinkingLevel: ThinkingLevel.LOW,
        };
      }
    }
    return config;
  };

  // Prepare contents with recent context
  const contents: any[] = [];
  if (Array.isArray(history)) {
    for (const item of history.slice(-6)) {
      if (item.role && item.text) {
        contents.push({
          role: item.role === "user" ? "user" : "model",
          parts: [{ text: item.text }],
        });
      }
    }
  }
  contents.push({
    role: "user",
    parts: [{ text: enrichedPrompt }],
  });

  // Candidate models fallback order (using only supported modern Gemini models)
  const candidateModels: string[] = [
    selectedModel,
    "gemini-3.8-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-flash-latest",
    "gemini-3.1-pro-preview",
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  try {
    if (useHighThinking) {
      sendEvent("thought", {
        text: `Deep reasoning engaged with ${selectedModel} (ThinkingLevel.HIGH) in ${mode.toUpperCase()} mode... Generating plan.`,
        step: 1,
      });
    }

    let responseStream: any = null;
    let activeModelUsed = selectedModel;
    let lastError: any = null;

    for (let i = 0; i < candidateModels.length; i++) {
      const modelToTry = candidateModels[i];
      try {
        if (i > 0) {
          sendEvent("thought", {
            text: `Upstream service for previous model reported high traffic / quota limit. Seamlessly routing to ${modelToTry}...`,
            step: 1,
          });
        }
        responseStream = await ai.models.generateContentStream({
          model: modelToTry,
          contents,
          config: getModelConfig(modelToTry),
        });
        activeModelUsed = modelToTry;
        lastError = null;
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(`Attempt with ${modelToTry} failed:`, err?.status || err?.code, err?.message);
        if (i < candidateModels.length - 1 && isRecoverableModelError(err)) {
          continue;
        }
        if (i < candidateModels.length - 1) {
          continue;
        }
      }
    }

    let fullText = "";
    if (responseStream) {
      try {
        for await (const chunk of responseStream) {
          const text = chunk.text;
          if (text) {
            fullText += text;
            sendEvent("delta", { delta: text });
          }
        }
      } catch (streamErr: any) {
        console.warn("Stream reading interrupted:", streamErr);
        if (fullText.length > 20) {
          sendEvent("answer", { text: fullText });
          sendEvent("done", { ms: 800 });
          res.end();
          return;
        }
        throw streamErr;
      }
    } else {
      throw lastError || new Error("All AI models were temporarily unavailable.");
    }

    sendEvent("answer", { text: fullText });
    sendEvent("done", { ms: 1200 });
    res.end();
  } catch (error: any) {
    console.error("Gemini stream error:", error);

    if (isRecoverableModelError(error)) {
      const is503 = isUnavailableOrHighDemand(error);
      const notice = is503
        ? "Google GenAI models are currently experiencing temporary high demand spikes (503 UNAVAILABLE). The response below was synthesized via the Jarvis workspace engine so your work proceeds uninterrupted."
        : `The API reached its current quota or rate limit (${error?.status || 429}: RESOURCE_EXHAUSTED). The response below was synthesized via the Jarvis workspace engine.`;
      generateLocalSynthesis(notice);
    } else {
      generateLocalSynthesis(
        `An upstream network interruption occurred (${error?.message || "connection reset"}). Synthesized via Jarvis workspace engine.`
      );
    }
  }
});

// Text-To-Speech (TTS) using gemini-3.1-flash-tts-preview
app.post("/api/tts", async (req, res) => {
  const { text, voice = "Kore" } = req.body;

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Text is required" });
    return;
  }

  const ai = getAi();
  if (!ai) {
    res.json({
      fallback: true,
      message: "No GEMINI_API_KEY configured; client should use Web Speech API.",
    });
    return;
  }

  try {
    const trimmedText = text.slice(0, 300);
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: trimmedText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice || "Kore" },
          },
        },
      },
    });

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      res.json({ fallback: true });
      return;
    }

    res.json({
      audio: base64Audio,
      mimeType: "audio/wav",
    });
  } catch (err: any) {
    console.error("TTS generation error:", err);
    res.json({ fallback: true, error: err?.message });
  }
});

// Command Exec Processor Pipeline endpoint (Sandboxed command execution)
app.post("/api/exec", (req, res) => {
  const { command, cwd = "jarvis-app" } = req.body;

  if (!command || typeof command !== "string") {
    res.status(400).json({ error: "Command is required" });
    return;
  }

  const rawCmd = command.trim();
  const startTime = Date.now();

  // Safety evaluation matching command_exec_processor.rs
  const blockedPatterns = ["rm -rf /", ":(){ :|:& };:", "chmod -R 777", "mkfs", "dd if="];
  for (const pattern of blockedPatterns) {
    if (rawCmd.includes(pattern)) {
      res.status(403).json({
        exitCode: 126,
        stdout: "",
        stderr: `ERROR: Command blocked by safety policy: '${rawCmd}'`,
        durationMs: Date.now() - startTime,
        safetyTier: "Blocked",
      });
      return;
    }
  }

  // Simulated structured executions for IDE commands
  if (rawCmd.startsWith("cargo test")) {
    setTimeout(() => {
      res.json({
        exitCode: 0,
        stdout: `running 6 tests
test test_config_schema_validation ... ok
test test_default_mode_rendering ... ok
test test_apps_strip_when_disabled ... ok
test test_switch_mode_agent ... ok
test test_command_exec_processor_safety ... ok
test test_document_ingestion_buffer ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s`,
        stderr: "",
        durationMs: Date.now() - startTime,
        safetyTier: "SafeReadOnly",
      });
    }, 200);
    return;
  }

  if (rawCmd.startsWith("cargo check")) {
    setTimeout(() => {
      res.json({
        exitCode: 0,
        stdout: `    Checking jarvis-app v0.1.0 (/workspace/jarvis-app)
    Finished dev [unoptimized + debuginfo] target(s) in 0.08s`,
        stderr: "",
        durationMs: Date.now() - startTime,
        safetyTier: "SafeReadOnly",
      });
    }, 150);
    return;
  }

  if (rawCmd.startsWith("git status")) {
    res.json({
      exitCode: 0,
      stdout: `On branch master
Your branch is up to date with 'origin/master'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
	modified:   config/config.toml
	modified:   src/render.rs
	new file:   src/command_exec_processor.rs

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	core/templates/agents/collaborator.md`,
      stderr: "",
      durationMs: Date.now() - startTime,
      safetyTier: "SafeReadOnly",
    });
    return;
  }

  if (rawCmd.startsWith("git diff")) {
    res.json({
      exitCode: 0,
      stdout: `diff --git a/config/config.toml b/config/config.toml
index 8a3f2b..9c4e1d 100644
--- a/config/config.toml
+++ b/config/config.toml
@@ -1,4 +1,5 @@
 ui_mode = "plan"
 model = "Gemini 3.8 Flash"
+apps_enabled = true
+command_pipeline_v2 = true`,
      stderr: "",
      durationMs: Date.now() - startTime,
      safetyTier: "SafeReadOnly",
    });
    return;
  }

  // Generic fallback execution
  res.json({
    exitCode: 0,
    stdout: `[EXEC]: ${rawCmd}\nExecution completed in ${cwd}\nStatus: SUCCESS (0)`,
    stderr: "",
    durationMs: Date.now() - startTime,
    safetyTier: "SafeReadOnly",
  });
});

// Workspace Files and Config Data
app.get("/api/workspace/files", (_req, res) => {
  res.json({
    activeProject: "jarvis-app",
    projects: ["jarvis-app", "kafsh", "codex", "deepseek-harness-master"],
    files: [
      { name: "config", type: "dir", path: "jarvis-app/config", items: ["config.toml", "config.schema.json"] },
      { name: "core/templates", type: "dir", path: "jarvis-app/core/templates", items: ["default.md", "plan.md", "agents/collaboration.md"] },
      { name: "src", type: "dir", path: "jarvis-app/src", items: ["lib.rs", "render.rs", "apply_command.rs", "legacy_apply_patch_exec_command_warning.rs"] },
      { name: ".vscode", type: "dir", path: "jarvis-app/.vscode", items: ["settings.json"] },
    ],
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Codex & Jarvis Desktop IDE running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
