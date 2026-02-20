/**
 * OpenClaw Agent Browser Plugin
 *
 * Wraps agent-browser as native OpenClaw tools with automatic R2 upload
 * for screenshots and video recordings.
 */

import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Types
interface PluginConfig {
  r2?: {
    accountId: string;
    bucket: string;
    publicDomain?: string;
  };
  headless?: boolean;
  viewport?: { width: number; height: number };
  gif?: { enabled: boolean };
  video?: { speedUpAfter: number; maxSpeedup: number };
  maxConcurrent?: number;
  idleTimeoutMs?: number;
}

interface SessionState {
  browser: BrowserManager;
  lastActivity: number;
  recording: boolean;
  recordingPath?: string;
}

// Session management
const sessions = new Map<string, SessionState>();

// Export for testing
export function _testClearSessions() {
  sessions.clear();
}
let s3Client: S3Client | null = null;
let pluginConfig: PluginConfig = {};

// Initialize S3 client for R2
function initR2Client(config: PluginConfig): S3Client | null {
  if (!config.r2?.accountId || !config.r2?.bucket) {
    return null;
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    console.warn(
      "[agent-browser] R2 configured but R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY not set"
    );
    return null;
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

// Get or create session
async function getSession(
  sessionName: string,
  config: PluginConfig
): Promise<SessionState> {
  let session = sessions.get(sessionName);

  if (!session) {
    // Check concurrent limit
    if (sessions.size >= (config.maxConcurrent ?? 3)) {
      throw new Error(
        `Max concurrent sessions (${config.maxConcurrent ?? 3}) reached`
      );
    }

    const browser = new BrowserManager();
    await browser.launch({
      headless: config.headless ?? true,
      viewport: config.viewport ?? { width: 1280, height: 720 },
    });

    session = {
      browser,
      lastActivity: Date.now(),
      recording: false,
    };
    sessions.set(sessionName, session);
  }

  session.lastActivity = Date.now();
  return session;
}

// Upload file to R2
async function uploadToR2(
  localPath: string,
  remoteName: string,
  contentType: string
): Promise<string | null> {
  if (!s3Client || !pluginConfig.r2) {
    return null;
  }

  const fileBuffer = readFileSync(localPath);
  const key = `agent-browser/${remoteName}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: pluginConfig.r2.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
    })
  );

  // Return public URL
  if (pluginConfig.r2.publicDomain) {
    return `https://${pluginConfig.r2.publicDomain}/${key}`;
  }
  return `https://${pluginConfig.r2.bucket}.${pluginConfig.r2.accountId}.r2.dev/${key}`;
}

// Convert video to GIF using ffmpeg
function convertToGif(inputPath: string, outputPath: string): void {
  const cmd = `ffmpeg -y -i "${inputPath}" -vf "fps=10,scale=480:-1:flags=lanczos" "${outputPath}"`;
  execSync(cmd, { stdio: "pipe" });
}

// Speed up video using ffmpeg
function speedUpVideo(
  inputPath: string,
  outputPath: string,
  speedFactor: number
): void {
  const pts = 1 / speedFactor;
  const cmd = `ffmpeg -y -i "${inputPath}" -filter:v "setpts=${pts}*PTS" "${outputPath}"`;
  execSync(cmd, { stdio: "pipe" });
}

// Plugin registration
export default function register(api: any) {
  pluginConfig = api.config || {};
  s3Client = initR2Client(pluginConfig);

  // Ensure temp directory
  const tempDir = join(tmpdir(), "agent-browser-plugin");
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  // ========== TOOLS ==========

  // browser_open
  api.registerTool({
    name: "browser_open",
    description:
      "Open a URL in the browser. Creates a new session if needed.",
    parameters: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "Session name (e.g. 'pr-12345')",
        },
        url: { type: "string", description: "URL to navigate to" },
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          default: "load",
        },
      },
      required: ["session", "url"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        {
          id: Date.now().toString(),
          command: "navigate",
          url: params.url,
          waitUntil: params.waitUntil ?? "load",
        },
        session.browser
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  });

  // browser_snapshot
  api.registerTool({
    name: "browser_snapshot",
    description:
      "Get accessibility tree with interactive element refs (@e1, @e2, etc.)",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        interactive: {
          type: "boolean",
          default: true,
          description: "Only show interactive elements",
        },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        {
          id: Date.now().toString(),
          command: "snapshot",
          filter: params.interactive ?? true ? "interactive" : undefined,
        },
        session.browser
      );
      return {
        content: [{ type: "text", text: result.snapshot || JSON.stringify(result) }],
      };
    },
  });

  // browser_click
  api.registerTool({
    name: "browser_click",
    description: "Click an element by ref (e.g. @e5) or CSS selector",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        selector: {
          type: "string",
          description: "Element ref (@e5) or CSS selector",
        },
      },
      required: ["session", "selector"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        {
          id: Date.now().toString(),
          command: "click",
          selector: params.selector,
        },
        session.browser
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  });

  // browser_fill
  api.registerTool({
    name: "browser_fill",
    description: "Fill an input field by ref or selector",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        selector: {
          type: "string",
          description: "Element ref (@e5) or CSS selector",
        },
        value: { type: "string", description: "Value to fill" },
      },
      required: ["session", "selector", "value"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        {
          id: Date.now().toString(),
          command: "fill",
          selector: params.selector,
          value: params.value,
        },
        session.browser
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  });

  // browser_screenshot
  api.registerTool({
    name: "browser_screenshot",
    description:
      "Take a screenshot and optionally upload to R2. Returns local path and remote URL.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        label: {
          type: "string",
          description: "Label for the screenshot (used in filename)",
        },
        fullPage: {
          type: "boolean",
          default: false,
          description: "Capture full page",
        },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const label = params.label || `screenshot-${Date.now()}`;
      const filename = `${params.session}-${label}.png`;
      const localPath = join(tempDir, filename);

      const result = await executeCommand(
        {
          id: Date.now().toString(),
          command: "screenshot",
          path: localPath,
          fullPage: params.fullPage ?? false,
        },
        session.browser
      );

      const remoteUrl = await uploadToR2(localPath, filename, "image/png");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              localPath,
              remoteUrl,
              markdown: remoteUrl ? `![${label}](${remoteUrl})` : null,
            }),
          },
        ],
      };
    },
  });

  // browser_record_start
  api.registerTool({
    name: "browser_record_start",
    description: "Start recording the browser session to video",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        label: { type: "string", description: "Label for the video" },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);

      if (session.recording) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Already recording" }) },
          ],
        };
      }

      const label = params.label || `recording-${Date.now()}`;
      const filename = `${params.session}-${label}.webm`;
      const localPath = join(tempDir, filename);

      await executeCommand(
        {
          id: Date.now().toString(),
          command: "recording_start",
          path: localPath,
        },
        session.browser
      );
      session.recording = true;
      session.recordingPath = localPath;

      return {
        content: [
          { type: "text", text: JSON.stringify({ recording: true, label }) },
        ],
      };
    },
  });

  // browser_record_stop
  api.registerTool({
    name: "browser_record_stop",
    description:
      "Stop recording and optionally convert to GIF, then upload to R2",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);

      if (!session.recording) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Not recording" }) },
          ],
        };
      }

      const result = await executeCommand(
        {
          id: Date.now().toString(),
          command: "recording_stop",
        },
        session.browser
      ) as any;
      session.recording = false;

      let finalPath = result.path;
      let contentType = "video/webm";

      // Speed up if needed
      const videoConfig = pluginConfig.video ?? { speedUpAfter: 60, maxSpeedup: 4 };
      // TODO: Check video duration and speed up if > speedUpAfter

      // Convert to GIF if enabled
      if (pluginConfig.gif?.enabled && finalPath) {
        const gifPath = finalPath.replace(".webm", ".gif");
        try {
          convertToGif(finalPath, gifPath);
          finalPath = gifPath;
          contentType = "image/gif";
        } catch (e) {
          console.error("[agent-browser] GIF conversion failed:", e);
        }
      }

      const filename = finalPath.split("/").pop() || "video.webm";
      const remoteUrl = await uploadToR2(finalPath, filename, contentType);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              localPath: finalPath,
              remoteUrl,
              frames: result.frames,
              markdown: remoteUrl
                ? contentType === "image/gif"
                  ? `![recording](${remoteUrl})`
                  : `[🎬 Recording](${remoteUrl})`
                : null,
            }),
          },
        ],
      };
    },
  });

  // browser_close
  api.registerTool({
    name: "browser_close",
    description: "Close the browser session and clean up",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      const session = sessions.get(params.session);
      if (!session) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Session not found" }) },
          ],
        };
      }

      await executeCommand(
        {
          id: Date.now().toString(),
          command: "close",
        },
        session.browser
      );
      sessions.delete(params.session);

      return {
        content: [{ type: "text", text: JSON.stringify({ closed: true }) }],
      };
    },
  });

  // Cleanup service
  api.registerService({
    id: "agent-browser-cleanup",
    start: () => {
      // Idle session cleanup
      setInterval(() => {
        const now = Date.now();
        const timeout = pluginConfig.idleTimeoutMs ?? 300000;

        for (const [name, session] of sessions) {
          if (now - session.lastActivity > timeout) {
            console.log(`[agent-browser] Closing idle session: ${name}`);
            session.browser.close().catch(() => {});
            sessions.delete(name);
          }
        }
      }, 60000); // Check every minute
    },
    stop: async () => {
      // Close all sessions on shutdown
      for (const [name, session] of sessions) {
        console.log(`[agent-browser] Closing session on shutdown: ${name}`);
        await session.browser.close().catch(() => {});
      }
      sessions.clear();
    },
  });
}
