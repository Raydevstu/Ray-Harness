# Codex AI Desktop IDE

Enterprise-grade high-density DeepSeek & Codex desktop AI IDE with real-time reasoning, split inspector, and workspace context.

---

## 🌟 Overview & Features

**Codex AI Desktop IDE** is a fully-featured, high-performance web-based IDE powered by advanced Gemini models and integrated server-side execution tools. It combines a multi-pane layout, real-time streaming reasoning chat, interactive terminal/workspace explorer, and automated model failover architecture.

### Key Features:
1. **Multi-Mode AI Assistance**:
   - **Default Mode**: Direct, low-latency execution for rapid code changes and patches.
   - **Plan Mode**: Conversational 3-phase planning (Environment Grounding -> Intent Alignment -> Decision-Complete Specification).
   - **Agent Mode**: Multi-agent orchestration coordinating roles like `code_executor`, `architect`, and `reviewer`.
2. **Advanced Model Routing & Resilience**:
   - Primary model support for **Gemini 3.8 Flash**, **Gemini 3.5 Flash**, **Gemini 3.1 Pro (High Thinking)**, and **5.6 Luna Light**.
   - Automatic exponential backoff and server-suggested retry delay parsing.
   - Intelligent multi-model fallback chain (`gemini-3.8-flash` -> `gemini-3.5-flash` -> `gemini-3.1-flash-lite` -> `gemini-1.5-flash` -> `gemini-1.5-pro`) ensuring 99.9% uptime even during peak API rate-limits.
3. **Integrated Development Workspace**:
   - **File Explorer**: Browse project directories (`jarvis-app/config`, `core/templates`, `src`, etc.).
   - **Monaco Code Editor & Split Inspector**: High-fidelity syntax highlighting and diff review.
   - **Interactive Terminal (xterm.js)**: Execute sandboxed commands (`cargo test`, `git status`, `git diff`) with safety tiers.
   - **Document Ingestion**: Attach Google Drive Docs, PDFs, or RFCs into the AI context buffer.
   - **Text-to-Speech (TTS)**: Voice responses powered by Gemini audio synthesis with automatic browser speech fallback.

---

## 🚀 How to Run the App

### Prerequisites
- Node.js (v18+)
- npm or pnpm

### Installation & Development
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure your environment variables in `.env` (or set `GEMINI_API_KEY`):
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
3. Start the development server (runs Express + Vite middleware on port 3000):
   ```bash
   npm run dev
   ```
4. Open your browser at `http://localhost:3000`.

### Production Build & Start
1. Build the production bundle:
   ```bash
   npm run build
   ```
2. Start the production server:
   ```bash
   npm start
   ```

---

## ⚙️ Configuration

- **API Keys**: Configured via the `GEMINI_API_KEY` environment variable on the server. Never exposed to the client.
- **Model Parameters**: Switch active models dynamically via the top navigation bar dropdown (`Gemini 3.8 Flash`, `Gemini 3.5 Flash`, `Gemini 3.1 Pro`, `5.6 Luna Light`).
- **Safety Policy**: Dangerous commands (e.g. `rm -rf /`) are automatically intercepted and blocked by the sandbox execution engine.
