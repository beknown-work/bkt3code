import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const queryStates = vi.hoisted(
  () =>
    new Map<
      string,
      {
        data?: { render: Record<string, unknown> };
        isPending: boolean;
        error?: string;
      }
    >(),
);

vi.mock("../state/agentUi", () => ({
  agentUiEnvironment: {
    render: ({ input }: { input: { renderId: string } }) => input,
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: ({ renderId }: { renderId: string }) =>
    queryStates.get(renderId) ?? { isPending: true },
}));

import { AgentUiRenderFrame, AgentUiUrlFrame } from "./agentUiSurface";
import { useAgentUiUrlFrameCoordinator } from "./agentUiUrlFrameCoordinator";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-fixture"),
  threadId: ThreadId.make("thread-fixture"),
} as const;
const FIRST_URL = "https://fixture.example.test/board#room=alpha,safe-key-a";
const SECOND_URL = "https://fixture.example.test/board#room=beta,safe-key-b";
const mutations: string[] = [];

// ReactDOM needs a host, but this focused lifecycle suite intentionally has no
// browser dependency. The host records iframe attachment order so a switch can
// prove that the old browsing context disconnected before the new one mounted.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  nodeValue: string | null = null;

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.nodeValue = value;
  }

  get textContent(): string {
    return this.nodeValue ?? this.childNodes.map((child) => child.textContent).join("");
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    if (child.tagName === "IFRAME") mutations.push(`attach:${child.getAttribute("src")}`);
    return child;
  }

  insertBefore(child: TestNode, before: TestNode | null) {
    if (before === null) return this.appendChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    if (child.tagName === "IFRAME") mutations.push(`attach:${child.getAttribute("src")}`);
    return child;
  }

  removeChild(child: TestNode) {
    if (child.tagName === "IFRAME") mutations.push(`detach:${child.getAttribute("src")}`);
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createTextNode(value: string) {
    const node = new TestNode("#text", this, 3);
    node.nodeValue = value;
    return node;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener() {}
  removeEventListener() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    location: { origin: "https://t3.example.test" },
    HTMLIFrameElement: TestNode,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

function urlFrame(renderId: string, url: string, createdAt: string, placement = "inline") {
  return (
    <AgentUiUrlFrame
      render={{ renderId, title: renderId, url, createdAt }}
      threadRef={THREAD_REF}
      placement={placement as "inline" | "expanded"}
    />
  );
}

function iframeNodes(root: TestNode): TestNode[] {
  return root.childNodes.flatMap((child) => [
    ...(child.tagName === "IFRAME" ? [child] : []),
    ...iframeNodes(child),
  ]);
}

async function render(root: { render: (children: ReactNode) => void }, children: ReactNode) {
  flushSync(() => root.render(children));
  await Promise.resolve();
  flushSync(() => undefined);
}

describe("AgentUiUrlFrame DOM lifecycle", () => {
  beforeEach(() => {
    mutations.length = 0;
    queryStates.clear();
    useAgentUiUrlFrameCoordinator.getState().reset();
  });

  afterEach(async () => {
    // React's development scheduler posts an Immediate after a root commits.
    // Let it drain while the fake window still exists so parallel CI cannot
    // observe a callback after Vitest restores the Node globals.
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.unstubAllGlobals();
  });

  it("keeps exact same-origin URLs distinct and replaces the iframe on A to B to A", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await render(
        root,
        <>
          {urlFrame("aui_alpha", FIRST_URL, "2026-08-29T10:00:00.000Z")}
          {urlFrame("aui_beta", SECOND_URL, "2026-08-29T10:01:00.000Z")}
        </>,
      );

      const [betaNode] = iframeNodes(container);
      expect(betaNode?.getAttribute("src")).toBe(SECOND_URL);
      expect(betaNode?.getAttribute("credentialless")).toBe("");
      expect(betaNode?.getAttribute("sandbox")).toContain("allow-same-origin");

      flushSync(() =>
        useAgentUiUrlFrameCoordinator
          .getState()
          .activate("inline:environment-fixture:thread-fixture:aui_alpha"),
      );
      await Promise.resolve();
      flushSync(() => undefined);
      const [alphaNode] = iframeNodes(container);
      expect(betaNode?.parentNode).toBeNull();
      expect(alphaNode).not.toBe(betaNode);
      expect(alphaNode?.getAttribute("src")).toBe(FIRST_URL);

      flushSync(() =>
        useAgentUiUrlFrameCoordinator
          .getState()
          .activate("inline:environment-fixture:thread-fixture:aui_beta"),
      );
      await Promise.resolve();
      flushSync(() => undefined);
      const [nextBetaNode] = iframeNodes(container);
      expect(alphaNode?.parentNode).toBeNull();
      expect(nextBetaNode).not.toBe(alphaNode);
      expect(nextBetaNode).not.toBe(betaNode);
      expect(nextBetaNode?.getAttribute("src")).toBe(SECOND_URL);
      expect(mutations).toEqual([
        `attach:${SECOND_URL}`,
        `detach:${SECOND_URL}`,
        `attach:${FIRST_URL}`,
        `detach:${FIRST_URL}`,
        `attach:${SECOND_URL}`,
      ]);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("gives an expanded frame exclusive priority and restores inline after it closes", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await render(
        root,
        <>
          {urlFrame("aui_beta", SECOND_URL, "2026-08-29T10:01:00.000Z")}
          {urlFrame("aui_alpha", FIRST_URL, "2026-08-29T10:00:00.000Z", "expanded")}
        </>,
      );
      const [expandedNode] = iframeNodes(container);
      expect(iframeNodes(container)).toHaveLength(1);
      expect(expandedNode?.getAttribute("src")).toBe(FIRST_URL);

      await render(root, urlFrame("aui_beta", SECOND_URL, "2026-08-29T10:01:00.000Z"));
      const [inlineNode] = iframeNodes(container);
      expect(expandedNode?.parentNode).toBeNull();
      expect(iframeNodes(container)).toHaveLength(1);
      expect(inlineNode).not.toBe(expandedNode);
      expect(inlineNode?.getAttribute("src")).toBe(SECOND_URL);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it("disconnects an expanded iframe while the replacement query is pending", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const firstRender = {
      renderId: "aui_alpha",
      title: "First",
      kind: "url",
      url: FIRST_URL,
      createdAt: "2026-08-29T10:00:00.000Z",
    };
    const secondRender = {
      renderId: "aui_beta",
      title: "Second",
      kind: "url",
      url: SECOND_URL,
      createdAt: "2026-08-29T10:01:00.000Z",
    };
    queryStates.set(firstRender.renderId, { data: { render: firstRender }, isPending: false });
    queryStates.set(secondRender.renderId, { isPending: true });

    const expandedFrame = (renderId: string) => (
      <AgentUiRenderFrame
        key={renderId}
        threadRef={THREAD_REF}
        renderId={renderId}
        placement="expanded"
        onTitle={() => undefined}
      />
    );

    try {
      await render(root, expandedFrame(firstRender.renderId));
      const [firstNode] = iframeNodes(container);
      expect(firstNode?.getAttribute("src")).toBe(FIRST_URL);

      await render(root, expandedFrame(secondRender.renderId));
      expect(firstNode?.parentNode).toBeNull();
      expect(iframeNodes(container)).toHaveLength(0);

      queryStates.set(secondRender.renderId, { data: { render: secondRender }, isPending: false });
      await render(root, expandedFrame(secondRender.renderId));
      const [secondNode] = iframeNodes(container);
      expect(secondNode).not.toBe(firstNode);
      expect(secondNode?.getAttribute("src")).toBe(SECOND_URL);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
