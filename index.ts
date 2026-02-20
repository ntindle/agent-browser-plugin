/**
 * OpenClaw Agent Browser Plugin
 *
 * Wraps agent-browser as native OpenClaw tools with automatic R2 upload
 * for screenshots and video recordings.
 *
 * Tools:
 * - browser_open: Navigate to URL
 * - browser_navigate: back, forward, reload
 * - browser_snapshot: Get accessibility tree with refs
 * - browser_click: Click element
 * - browser_fill: Fill input field
 * - browser_interact: hover, focus, drag, scroll, type, press, select, check/uncheck
 * - browser_query: gettext, isvisible, title, url
 * - browser_screenshot: Take screenshot (with device emulation)
 * - browser_record_start/stop: Video recording
 * - browser_tabs: Tab management
 * - browser_settings: viewport, device
 * - browser_close: Close session
 * - browser_advanced: Escape hatch for all 50+ actions
 */

import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// All available actions for browser_advanced
const AVAILABLE_ACTIONS = [
  "launch", "navigate", "click", "dblclick", "type", "fill", "check", "uncheck",
  "upload", "focus", "drag", "press", "hover", "select", "scroll",
  "screenshot", "snapshot", "evaluate", "wait", "content", "close",
  "frame", "mainframe", "getbyrole", "getbytext", "getbylabel", "getbyplaceholder",
  "tab_new", "tab_list", "tab_switch", "tab_close", "window_new",
  "cookies_get", "cookies_set", "cookies_clear",
  "storage_get", "storage_set", "storage_clear",
  "dialog", "pdf", "route", "unroute", "requests", "download",
  "geolocation", "permissions", "viewport", "useragent", "device",
  "back", "forward", "reload", "url", "title",
  "getattribute", "gettext", "isvisible", "isenabled", "ischecked", "count",
  "recording_start", "recording_stop", "recording_restart"
];

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

// Plugin registration
export default function register(api: any) {
  pluginConfig = api.config || {};
  s3Client = initR2Client(pluginConfig);

  // Ensure temp directory
  const tempDir = join(tmpdir(), "agent-browser-plugin");
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  // ========== CORE TOOLS ==========

  // browser_open - Navigate to URL
  api.registerTool({
    name: "ab_open",
    description: "Open a URL in the browser. Creates a new session if needed.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name (e.g. 'pr-12345')" },
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
        { id: Date.now().toString(), action: "navigate", url: params.url, waitUntil: params.waitUntil ?? "load" },
        session.browser
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_navigate - History navigation
  api.registerTool({
    name: "ab_navigate",
    description: "Navigate browser history: back, forward, or reload the page",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        action: { type: "string", enum: ["back", "forward", "reload"], description: "Navigation action" },
      },
      required: ["session", "action"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        { id: Date.now().toString(), action: params.action },
        session.browser
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_snapshot - Get accessibility tree
  api.registerTool({
    name: "ab_snapshot",
    description: "Get accessibility tree with element refs (@e1, @e2, etc.) for interacting with elements",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        interactive: { type: "boolean", default: true, description: "Only show interactive elements" },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        { id: Date.now().toString(), action: "snapshot", filter: params.interactive ?? true ? "interactive" : undefined },
        session.browser
      ) as any;
      return { content: [{ type: "text", text: result.data?.snapshot || JSON.stringify(result) }] };
    },
  });

  // browser_click - Click element
  api.registerTool({
    name: "ab_click",
    description: "Click an element by ref (@e5) or CSS selector",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        selector: { type: "string", description: "Element ref (@e5) or CSS selector" },
      },
      required: ["session", "selector"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        { id: Date.now().toString(), action: "click", selector: params.selector },
        session.browser
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_fill - Fill input field
  api.registerTool({
    name: "ab_fill",
    description: "Clear and fill an input field by ref or selector",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        selector: { type: "string", description: "Element ref (@e5) or CSS selector" },
        value: { type: "string", description: "Value to fill" },
      },
      required: ["session", "selector", "value"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const result = await executeCommand(
        { id: Date.now().toString(), action: "fill", selector: params.selector, value: params.value },
        session.browser
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_interact - Multiple interaction types
  api.registerTool({
    name: "ab_interact",
    description: "Interact with elements: hover, focus, drag, scroll, type, press, select, check, uncheck, dblclick",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        action: {
          type: "string",
          enum: ["hover", "focus", "drag", "scroll", "type", "press", "select", "check", "uncheck", "dblclick"],
          description: "Interaction type",
        },
        selector: { type: "string", description: "Element ref or selector (not needed for scroll, press)" },
        value: { type: "string", description: "Value for type/select, target for drag, key for press, direction for scroll (up/down/left/right)" },
        amount: { type: "number", description: "Pixels for scroll (default 300)" },
      },
      required: ["session", "action"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const cmd: any = { id: Date.now().toString(), action: params.action };

      if (params.selector) cmd.selector = params.selector;
      if (params.action === "type") cmd.text = params.value;
      if (params.action === "press") cmd.key = params.value;
      if (params.action === "select") cmd.value = params.value;
      if (params.action === "drag") cmd.target = params.value;
      if (params.action === "scroll") {
        cmd.direction = params.value || "down";
        cmd.amount = params.amount || 300;
      }

      const result = await executeCommand(cmd, session.browser);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_query - Get info/state from page
  api.registerTool({
    name: "ab_query",
    description: "Query page info: gettext, isvisible, isenabled, ischecked, title, url, count",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        action: {
          type: "string",
          enum: ["gettext", "isvisible", "isenabled", "ischecked", "title", "url", "count", "getattribute"],
          description: "Query type",
        },
        selector: { type: "string", description: "Element ref or selector (required for element queries)" },
        attribute: { type: "string", description: "Attribute name (for getattribute)" },
      },
      required: ["session", "action"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const cmd: any = { id: Date.now().toString(), action: params.action };
      if (params.selector) cmd.selector = params.selector;
      if (params.attribute) cmd.attribute = params.attribute;

      const result = await executeCommand(cmd, session.browser);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_screenshot - Screenshot with optional device emulation
  api.registerTool({
    name: "ab_screenshot",
    description: "Take a screenshot, optionally emulating a device first. Returns local path and R2 URL if configured.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        label: { type: "string", description: "Label for filename" },
        fullPage: { type: "boolean", default: false, description: "Capture full page" },
        device: { type: "string", description: "Device to emulate before screenshot (e.g. 'iPhone 14', 'Pixel 5')" },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);

      // Apply device emulation if specified
      if (params.device) {
        await executeCommand(
          { id: Date.now().toString(), action: "device", device: params.device },
          session.browser
        );
      }

      const label = params.label || `screenshot-${Date.now()}`;
      const filename = `${params.session}-${label}.png`;
      const localPath = join(tempDir, filename);

      await executeCommand(
        { id: Date.now().toString(), action: "screenshot", path: localPath, fullPage: params.fullPage ?? false },
        session.browser
      );

      const remoteUrl = await uploadToR2(localPath, filename, "image/png");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            localPath,
            remoteUrl,
            markdown: remoteUrl ? `![${label}](${remoteUrl})` : null,
          }),
        }],
      };
    },
  });

  // browser_record_start - Start video recording
  api.registerTool({
    name: "ab_record_start",
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
        return { content: [{ type: "text", text: JSON.stringify({ error: "Already recording" }) }] };
      }

      const label = params.label || `recording-${Date.now()}`;
      const filename = `${params.session}-${label}.webm`;
      const localPath = join(tempDir, filename);

      await executeCommand(
        { id: Date.now().toString(), action: "recording_start", path: localPath },
        session.browser
      );
      session.recording = true;
      session.recordingPath = localPath;

      return { content: [{ type: "text", text: JSON.stringify({ recording: true, label }) }] };
    },
  });

  // browser_record_stop - Stop video recording
  api.registerTool({
    name: "ab_record_stop",
    description: "Stop recording, optionally convert to GIF, and upload to R2",
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
        return { content: [{ type: "text", text: JSON.stringify({ error: "Not recording" }) }] };
      }

      const result = await executeCommand(
        { id: Date.now().toString(), action: "recording_stop" },
        session.browser
      ) as any;
      session.recording = false;

      let finalPath = result.data?.path || session.recordingPath;
      let contentType = "video/webm";

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

      const filename = finalPath?.split("/").pop() || "video.webm";
      const remoteUrl = await uploadToR2(finalPath, filename, contentType);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            localPath: finalPath,
            remoteUrl,
            frames: result.data?.frames,
            markdown: remoteUrl
              ? contentType === "image/gif" ? `![recording](${remoteUrl})` : `[🎬 Recording](${remoteUrl})`
              : null,
          }),
        }],
      };
    },
  });

  // browser_tabs - Tab management
  api.registerTool({
    name: "ab_tabs",
    description: "Manage browser tabs: list, new, switch, close",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        action: { type: "string", enum: ["list", "new", "switch", "close"], description: "Tab action" },
        index: { type: "number", description: "Tab index for switch/close" },
        url: { type: "string", description: "URL for new tab" },
      },
      required: ["session", "action"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const actionMap: Record<string, string> = { list: "tab_list", new: "tab_new", switch: "tab_switch", close: "tab_close" };
      const cmd: any = { id: Date.now().toString(), action: actionMap[params.action] };
      if (params.index !== undefined) cmd.index = params.index;
      if (params.url) cmd.url = params.url;

      const result = await executeCommand(cmd, session.browser);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_settings - Viewport and device emulation
  api.registerTool({
    name: "ab_settings",
    description: "Configure browser: viewport size or device emulation",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        action: { type: "string", enum: ["viewport", "device"], description: "Setting type" },
        width: { type: "number", description: "Viewport width" },
        height: { type: "number", description: "Viewport height" },
        device: { type: "string", description: "Device name (e.g. 'iPhone 14', 'Pixel 5')" },
      },
      required: ["session", "action"],
    },
    async execute(_id: string, params: any) {
      const session = await getSession(params.session, pluginConfig);
      const cmd: any = { id: Date.now().toString(), action: params.action };
      if (params.action === "viewport") {
        cmd.width = params.width;
        cmd.height = params.height;
      } else if (params.action === "device") {
        cmd.device = params.device;
      }

      const result = await executeCommand(cmd, session.browser);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // browser_close - Close session
  api.registerTool({
    name: "ab_close",
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
        return { content: [{ type: "text", text: JSON.stringify({ error: "Session not found" }) }] };
      }

      await executeCommand({ id: Date.now().toString(), action: "close" }, session.browser);
      sessions.delete(params.session);

      return { content: [{ type: "text", text: JSON.stringify({ closed: true }) }] };
    },
  });

  // browser_advanced - Escape hatch for any action
  api.registerTool({
    name: "ab_advanced",
    description: "Advanced: Run any agent-browser action. Call with no action to see all 50+ available actions. Use other browser_* tools first.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name" },
        action: { type: "string", description: "Action name (omit to list all)" },
        params: { type: "object", description: "Action parameters as JSON object" },
      },
      required: ["session"],
    },
    async execute(_id: string, params: any) {
      // If no action specified, return list of available actions
      if (!params.action) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "Available actions (use with 'action' param). Most have dedicated tools - use those first.",
              actions: AVAILABLE_ACTIONS,
              examples: [
                { action: "wait", params: { selector: "#loading" } },
                { action: "evaluate", params: { expression: "document.title" } },
                { action: "cookies_get", params: {} },
                { action: "geolocation", params: { latitude: 37.7749, longitude: -122.4194 } },
              ],
            }),
          }],
        };
      }

      const session = await getSession(params.session, pluginConfig);
      const cmd = {
        id: Date.now().toString(),
        action: params.action,
        ...(params.params || {}),
      };

      const result = await executeCommand(cmd, session.browser);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // Cleanup service
  api.registerService({
    id: "agent-browser-cleanup",
    start: () => {
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
      }, 60000);
    },
    stop: async () => {
      for (const [name, session] of sessions) {
        console.log(`[agent-browser] Closing session on shutdown: ${name}`);
        await session.browser.close().catch(() => {});
      }
      sessions.clear();
    },
  });
}
