import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock agent-browser
const mockBrowser = {
  launch: mock(() => Promise.resolve()),
};

mock.module("agent-browser/dist/browser.js", () => ({
  BrowserManager: class {
    launch = mockBrowser.launch;
    getPage() { return {}; }
    getLocator() { return {}; }
    close() { return Promise.resolve(); }
  },
}));

// Mock executeCommand
const mockExecuteCommand = mock((cmd: any, _browser: any) => {
  switch (cmd.action) {
    case "navigate":
      return Promise.resolve({ success: true, data: { title: "Test Page", url: cmd.url } });
    case "back":
    case "forward":
    case "reload":
      return Promise.resolve({ success: true, data: { navigated: true } });
    case "snapshot":
      return Promise.resolve({ success: true, data: { snapshot: "@e1 button 'Submit'\n@e2 input 'Email'" } });
    case "click":
      return Promise.resolve({ success: true, data: { clicked: true } });
    case "fill":
      return Promise.resolve({ success: true, data: { filled: true } });
    case "hover":
    case "focus":
    case "scroll":
    case "type":
    case "press":
    case "select":
    case "check":
    case "uncheck":
    case "dblclick":
    case "drag":
      return Promise.resolve({ success: true, data: { done: true } });
    case "gettext":
      return Promise.resolve({ success: true, data: { text: "Hello World" } });
    case "isvisible":
      return Promise.resolve({ success: true, data: { visible: true } });
    case "title":
      return Promise.resolve({ success: true, data: { title: "Test Page" } });
    case "url":
      return Promise.resolve({ success: true, data: { url: "https://example.com" } });
    case "screenshot":
      return Promise.resolve({ success: true, data: { path: cmd.path } });
    case "device":
    case "viewport":
      return Promise.resolve({ success: true, data: { applied: true } });
    case "recording_start":
      return Promise.resolve({ success: true, data: { started: true, path: cmd.path } });
    case "recording_stop":
      return Promise.resolve({ success: true, data: { path: "/tmp/test.webm", frames: 100 } });
    case "tab_list":
      return Promise.resolve({ success: true, data: { tabs: [{ index: 0, url: "about:blank" }] } });
    case "tab_new":
    case "tab_switch":
    case "tab_close":
      return Promise.resolve({ success: true, data: { done: true } });
    case "close":
      return Promise.resolve({ success: true, data: { closed: true } });
    default:
      return Promise.resolve({ success: true, data: {} });
  }
});

mock.module("agent-browser/dist/actions.js", () => ({
  executeCommand: mockExecuteCommand,
}));

// Mock S3 client
mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = mock(() => Promise.resolve());
  },
  PutObjectCommand: class {
    constructor(public params: any) {}
  },
}));

// Import after mocks
import register, { _testClearSessions } from "./index";

describe("agent-browser-plugin", () => {
  let registeredTools: Map<string, any>;
  let registeredServices: Map<string, any>;
  let mockApi: any;

  beforeEach(() => {
    _testClearSessions();
    registeredTools = new Map();
    registeredServices = new Map();

    mockApi = {
      config: {
        headless: true,
        viewport: { width: 1280, height: 720 },
      },
      registerTool: (tool: any) => {
        registeredTools.set(tool.name, tool);
      },
      registerService: (service: any) => {
        registeredServices.set(service.id, service);
      },
    };

    Object.values(mockBrowser).forEach((m) => m.mockClear?.());
    mockExecuteCommand.mockClear();
  });

  describe("registration", () => {
    it("registers all expected tools", () => {
      register(mockApi);

      const expectedTools = [
        "browser_open", "browser_navigate", "browser_snapshot", "browser_click",
        "browser_fill", "browser_interact", "browser_query", "browser_screenshot",
        "browser_record_start", "browser_record_stop", "browser_tabs",
        "browser_settings", "browser_close", "browser_advanced"
      ];

      for (const tool of expectedTools) {
        expect(registeredTools.has(tool)).toBe(true);
      }
      expect(registeredTools.size).toBe(14);
    });

    it("registers cleanup service", () => {
      register(mockApi);
      expect(registeredServices.has("agent-browser-cleanup")).toBe(true);
    });
  });

  describe("browser_open", () => {
    it("creates session and navigates", async () => {
      register(mockApi);
      const tool = registeredTools.get("browser_open");

      const result = await tool.execute("test-id", {
        session: "test-session",
        url: "https://example.com",
      });

      expect(mockBrowser.launch).toHaveBeenCalled();
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "navigate", url: "https://example.com" }),
        expect.anything()
      );
    });
  });

  describe("browser_navigate", () => {
    it("supports back/forward/reload", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const navTool = registeredTools.get("browser_navigate");

      await openTool.execute("id", { session: "nav-test", url: "https://example.com" });

      for (const action of ["back", "forward", "reload"]) {
        await navTool.execute("id", { session: "nav-test", action });
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.objectContaining({ action }),
          expect.anything()
        );
      }
    });
  });

  describe("browser_snapshot", () => {
    it("returns accessibility tree", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const snapshotTool = registeredTools.get("browser_snapshot");

      await openTool.execute("id", { session: "snap-test", url: "https://example.com" });
      const result = await snapshotTool.execute("id", { session: "snap-test" });

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "snapshot" }),
        expect.anything()
      );
      expect(result.content[0].text).toContain("@e1");
    });
  });

  describe("browser_interact", () => {
    it("supports hover, focus, scroll, type, press", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const interactTool = registeredTools.get("browser_interact");

      await openTool.execute("id", { session: "interact-test", url: "https://example.com" });

      // Test hover
      await interactTool.execute("id", { session: "interact-test", action: "hover", selector: "@e1" });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "hover", selector: "@e1" }),
        expect.anything()
      );

      // Test scroll
      await interactTool.execute("id", { session: "interact-test", action: "scroll", value: "down", amount: 500 });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "scroll", direction: "down", amount: 500 }),
        expect.anything()
      );

      // Test press
      await interactTool.execute("id", { session: "interact-test", action: "press", value: "Enter" });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "press", key: "Enter" }),
        expect.anything()
      );
    });
  });

  describe("browser_query", () => {
    it("queries page info", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const queryTool = registeredTools.get("browser_query");

      await openTool.execute("id", { session: "query-test", url: "https://example.com" });

      // Test gettext
      const textResult = await queryTool.execute("id", { session: "query-test", action: "gettext", selector: "@e1" });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "gettext", selector: "@e1" }),
        expect.anything()
      );

      // Test title
      await queryTool.execute("id", { session: "query-test", action: "title" });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "title" }),
        expect.anything()
      );
    });
  });

  describe("browser_screenshot", () => {
    it("takes screenshot with device emulation", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const screenshotTool = registeredTools.get("browser_screenshot");

      await openTool.execute("id", { session: "ss-test", url: "https://example.com" });
      const result = await screenshotTool.execute("id", {
        session: "ss-test",
        label: "mobile-view",
        device: "iPhone 14",
      });

      // Should set device first
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "device", device: "iPhone 14" }),
        expect.anything()
      );

      // Then take screenshot
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "screenshot" }),
        expect.anything()
      );

      const content = JSON.parse(result.content[0].text);
      expect(content.localPath).toContain("ss-test-mobile-view.png");
    });
  });

  describe("browser_tabs", () => {
    it("manages tabs", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const tabsTool = registeredTools.get("browser_tabs");

      await openTool.execute("id", { session: "tabs-test", url: "https://example.com" });

      // List tabs
      await tabsTool.execute("id", { session: "tabs-test", action: "list" });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "tab_list" }),
        expect.anything()
      );

      // New tab
      await tabsTool.execute("id", { session: "tabs-test", action: "new", url: "https://google.com" });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "tab_new", url: "https://google.com" }),
        expect.anything()
      );
    });
  });

  describe("browser_settings", () => {
    it("sets viewport and device", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const settingsTool = registeredTools.get("browser_settings");

      await openTool.execute("id", { session: "settings-test", url: "https://example.com" });

      // Viewport
      await settingsTool.execute("id", { session: "settings-test", action: "viewport", width: 375, height: 667 });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "viewport", width: 375, height: 667 }),
        expect.anything()
      );

      // Device
      await settingsTool.execute("id", { session: "settings-test", action: "device", device: "Pixel 5" });
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "device", device: "Pixel 5" }),
        expect.anything()
      );
    });
  });

  describe("browser_advanced", () => {
    it("lists actions when called with no action", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const advancedTool = registeredTools.get("browser_advanced");

      await openTool.execute("id", { session: "adv-test", url: "https://example.com" });
      const result = await advancedTool.execute("id", { session: "adv-test" });

      const content = JSON.parse(result.content[0].text);
      expect(content.actions).toContain("wait");
      expect(content.actions).toContain("evaluate");
      expect(content.actions).toContain("cookies_get");
    });

    it("executes arbitrary action with params", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const advancedTool = registeredTools.get("browser_advanced");

      await openTool.execute("id", { session: "adv-test2", url: "https://example.com" });
      await advancedTool.execute("id", {
        session: "adv-test2",
        action: "wait",
        params: { selector: "#loading" },
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "wait", selector: "#loading" }),
        expect.anything()
      );
    });
  });

  describe("browser_record_start/stop", () => {
    it("starts and stops recording", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const startTool = registeredTools.get("browser_record_start");
      const stopTool = registeredTools.get("browser_record_stop");

      await openTool.execute("id", { session: "rec-test", url: "https://example.com" });

      const startResult = await startTool.execute("id", { session: "rec-test", label: "walkthrough" });
      const startContent = JSON.parse(startResult.content[0].text);
      expect(startContent.recording).toBe(true);

      const stopResult = await stopTool.execute("id", { session: "rec-test" });
      const stopContent = JSON.parse(stopResult.content[0].text);
      expect(stopContent.frames).toBe(100);
    });
  });

  describe("browser_close", () => {
    it("closes session", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const closeTool = registeredTools.get("browser_close");

      await openTool.execute("id", { session: "close-test", url: "https://example.com" });
      const result = await closeTool.execute("id", { session: "close-test" });

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: "close" }),
        expect.anything()
      );
      const content = JSON.parse(result.content[0].text);
      expect(content.closed).toBe(true);
    });

    it("returns error for unknown session", async () => {
      register(mockApi);
      const closeTool = registeredTools.get("browser_close");

      const result = await closeTool.execute("id", { session: "nonexistent" });
      const content = JSON.parse(result.content[0].text);
      expect(content.error).toBe("Session not found");
    });
  });

  describe("session limits", () => {
    it("enforces maxConcurrent limit", async () => {
      mockApi.config.maxConcurrent = 2;
      register(mockApi);
      const tool = registeredTools.get("browser_open");

      await tool.execute("id1", { session: "s1", url: "https://a.com" });
      await tool.execute("id2", { session: "s2", url: "https://b.com" });

      await expect(
        tool.execute("id3", { session: "s3", url: "https://c.com" })
      ).rejects.toThrow("Max concurrent sessions");
    });
  });
});
