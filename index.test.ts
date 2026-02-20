import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock agent-browser
const mockBrowser = {
  launch: mock(() => Promise.resolve()),
  navigate: mock(() => Promise.resolve()),
  snapshot: mock(() => Promise.resolve("@e1 button 'Submit'\n@e2 input 'Email'")),
  click: mock(() => Promise.resolve()),
  fill: mock(() => Promise.resolve()),
  screenshot: mock(() => Promise.resolve({ path: "/tmp/test.png" })),
  startRecording: mock(() => Promise.resolve()),
  stopRecording: mock(() => Promise.resolve({ path: "/tmp/test.webm", frames: 100 })),
  close: mock(() => Promise.resolve()),
  getTitle: mock(() => Promise.resolve("Test Page")),
  getUrl: mock(() => Promise.resolve("https://example.com")),
};

mock.module("agent-browser/dist/browser.js", () => ({
  BrowserManager: class {
    launch = mockBrowser.launch;
    navigate = mockBrowser.navigate;
    snapshot = mockBrowser.snapshot;
    click = mockBrowser.click;
    fill = mockBrowser.fill;
    screenshot = mockBrowser.screenshot;
    startRecording = mockBrowser.startRecording;
    stopRecording = mockBrowser.stopRecording;
    close = mockBrowser.close;
    getTitle = mockBrowser.getTitle;
    getUrl = mockBrowser.getUrl;
  },
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

    // Reset mocks
    Object.values(mockBrowser).forEach((m) => m.mockClear?.());
  });

  describe("registration", () => {
    it("registers all expected tools", () => {
      register(mockApi);

      expect(registeredTools.has("browser_open")).toBe(true);
      expect(registeredTools.has("browser_snapshot")).toBe(true);
      expect(registeredTools.has("browser_click")).toBe(true);
      expect(registeredTools.has("browser_fill")).toBe(true);
      expect(registeredTools.has("browser_screenshot")).toBe(true);
      expect(registeredTools.has("browser_record_start")).toBe(true);
      expect(registeredTools.has("browser_record_stop")).toBe(true);
      expect(registeredTools.has("browser_close")).toBe(true);
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
      expect(mockBrowser.navigate).toHaveBeenCalledWith("https://example.com", {
        waitUntil: "load",
      });

      const content = JSON.parse(result.content[0].text);
      expect(content.title).toBe("Test Page");
      expect(content.url).toBe("https://example.com");
    });

    it("reuses existing session", async () => {
      register(mockApi);
      const tool = registeredTools.get("browser_open");

      await tool.execute("id1", { session: "reuse-test", url: "https://a.com" });
      await tool.execute("id2", { session: "reuse-test", url: "https://b.com" });

      // launch should only be called once for this session
      expect(mockBrowser.launch).toHaveBeenCalledTimes(1);
      expect(mockBrowser.navigate).toHaveBeenCalledTimes(2);
    });
  });

  describe("browser_snapshot", () => {
    it("returns accessibility tree", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const snapshotTool = registeredTools.get("browser_snapshot");

      await openTool.execute("id", { session: "snap-test", url: "https://example.com" });
      const result = await snapshotTool.execute("id", { session: "snap-test" });

      expect(mockBrowser.snapshot).toHaveBeenCalled();
      expect(result.content[0].text).toContain("@e1");
    });
  });

  describe("browser_click", () => {
    it("clicks element by selector", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const clickTool = registeredTools.get("browser_click");

      await openTool.execute("id", { session: "click-test", url: "https://example.com" });
      const result = await clickTool.execute("id", {
        session: "click-test",
        selector: "@e5",
      });

      expect(mockBrowser.click).toHaveBeenCalledWith("@e5");
      const content = JSON.parse(result.content[0].text);
      expect(content.clicked).toBe(true);
    });
  });

  describe("browser_fill", () => {
    it("fills input field", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const fillTool = registeredTools.get("browser_fill");

      await openTool.execute("id", { session: "fill-test", url: "https://example.com" });
      const result = await fillTool.execute("id", {
        session: "fill-test",
        selector: "@e3",
        value: "test@example.com",
      });

      expect(mockBrowser.fill).toHaveBeenCalledWith("@e3", "test@example.com");
      const content = JSON.parse(result.content[0].text);
      expect(content.filled).toBe(true);
    });
  });

  describe("browser_screenshot", () => {
    it("takes screenshot and returns local path", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const screenshotTool = registeredTools.get("browser_screenshot");

      await openTool.execute("id", { session: "ss-test", url: "https://example.com" });
      const result = await screenshotTool.execute("id", {
        session: "ss-test",
        label: "homepage",
      });

      expect(mockBrowser.screenshot).toHaveBeenCalled();
      const content = JSON.parse(result.content[0].text);
      expect(content.localPath).toContain("ss-test-homepage.png");
      // No R2 configured, so remoteUrl should be null
      expect(content.remoteUrl).toBe(null);
    });
  });

  describe("browser_record_start/stop", () => {
    it("starts and stops recording", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const startTool = registeredTools.get("browser_record_start");
      const stopTool = registeredTools.get("browser_record_stop");

      await openTool.execute("id", { session: "rec-test", url: "https://example.com" });

      const startResult = await startTool.execute("id", {
        session: "rec-test",
        label: "walkthrough",
      });
      const startContent = JSON.parse(startResult.content[0].text);
      expect(startContent.recording).toBe(true);

      const stopResult = await stopTool.execute("id", { session: "rec-test" });
      const stopContent = JSON.parse(stopResult.content[0].text);
      expect(stopContent.frames).toBe(100);
      expect(stopContent.localPath).toContain(".webm");
    });

    it("returns error if already recording", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const startTool = registeredTools.get("browser_record_start");

      await openTool.execute("id", { session: "dup-rec", url: "https://example.com" });
      await startTool.execute("id", { session: "dup-rec" });

      const result = await startTool.execute("id", { session: "dup-rec" });
      const content = JSON.parse(result.content[0].text);
      expect(content.error).toBe("Already recording");
    });
  });

  describe("browser_close", () => {
    it("closes session", async () => {
      register(mockApi);
      const openTool = registeredTools.get("browser_open");
      const closeTool = registeredTools.get("browser_close");

      await openTool.execute("id", { session: "close-test", url: "https://example.com" });
      const result = await closeTool.execute("id", { session: "close-test" });

      expect(mockBrowser.close).toHaveBeenCalled();
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
      const openTool = registeredTools.get("browser_open");

      await openTool.execute("id1", { session: "s1", url: "https://a.com" });
      await openTool.execute("id2", { session: "s2", url: "https://b.com" });

      await expect(
        openTool.execute("id3", { session: "s3", url: "https://c.com" })
      ).rejects.toThrow("Max concurrent sessions (2) reached");
    });
  });
});
