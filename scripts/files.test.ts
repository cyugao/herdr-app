import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = await readFile(new URL("../defaults/mods/files/main.js", import.meta.url), "utf8");
const directorySource = source.slice(source.indexOf("async function directory("), source.indexOf("\nexport default class"));
const directory = new Function("exec", "window", `${directorySource}; return directory;`)(
  async (command: string, args: string[]) => {
    const p = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  },
  () => ({ platform: process.platform === "win32" ? "windows" : process.platform }),
);

test("Files lists literal folder names, not shell expressions", async () => {
  const root = await mkdtemp(join(process.platform === "linux" ? "/var/tmp" : tmpdir(), "herdr-files-"));
  try {
    for (const name of ["Test Folder (ACME)", "O'Brien $folder; (ACME)"]) {
      const folder = join(root, name);
      await mkdir(join(folder, "child"), { recursive: true });
      await writeFile(join(folder, "hello.txt"), "hello");
      const entries = await directory(folder, null);
      expect(entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
        { name: "child", dir: true }, { name: "hello.txt", dir: false },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Exercise the shipped mods' handoff and asynchronous file reads without a UI.
async function previewHarness() {
  const shared = new Map<string, any>(), effects: any[] = [], tasks: (() => Promise<void>)[] = [], reads: any[] = [];
  const root = JSON.parse(await readFile(new URL("../defaults/layouts/main.json", import.meta.url), "utf8"));
  const spaces = [{ id: "s1", active: true, machine: "remote", folder: "/remote", tabs: [] }];
  const focus = { pane: "p1", terminal: "remote/t1", cwd: "/remote" };
  let modProps = {};
  const find = (node: any, id: string): any => node.id === id ? node : node.children?.map((c: any) => find(c, id)).find(Boolean);
  let ui: any;
  ui = new Proxy({}, { get: (_target, name) => name === "when" ? (condition: boolean, fn: any) => { if (condition) fn(ui); return ui; } : () => ui });
  const cx = { spawn: (fn: any) => tasks.push(() => fn(cx)), notify() {}, timer: { every() {} } };
  const storage = new Map<string, string>();
  const api: Record<string, any> = {
    View: class {}, div: () => ui, svg: () => ui, image: () => ui, v_flex: () => ui, h_flex: () => ui,
    Editor: { new: () => ui }, EditorState: { new: (options: any) => ({ options, release() {} }) },
    spaces: () => spaces, panes: () => [], focused: () => focus,
    props: () => modProps,
    shared: (key: string) => shared.get(key), setShared: (key: string, value: any) => shared.set(key, structuredClone(value)),
    nextCommand: () => new Promise(() => {}),
    exec: async (...args: any[]) => { effects.push(["exec", ...args]); return { code: 0, stdout: "", stderr: "" }; },
    run: (name: string, args: any) => {
      effects.push([name, args]);
      if (name === "layout.show") find(root, args.id).hidden = false;
      if (name === "layout.select") find(root, args.stack).active = args.child;
    },
    layout: () => root, openOverlay() {}, theme: () => ({}), settings: () => ({ zoom: 1 }), window: () => ({ platform: "macos" }),
    readTextFile: (path: string, options: any) => new Promise(resolve => reads.push({ path, options, resolve })),
    watchFolder: () => new Promise(() => {}),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  };
  const load = (text: string) => new Function(...Object.keys(api), text.replace(/^import .*;\n/gm, "").replace("export default class", "return class"))(...Object.values(api));
  const Tabs = load(await readFile(new URL("../defaults/mods/tabs/main.js", import.meta.url), "utf8"));
  const Files = load(source);
  const tabs = new Tabs(); tabs.init(null, cx); tasks.length = 0; // command loop stays idle
  const files = (props = { file_links: true }) => {
    modProps = props;
    const view = new Files();
    // Directory enumeration is tested above; isolate preview context from it here.
    view.refresh = () => { view.context = { key: JSON.stringify({ cwd: "/remote", on: "remote", space: "s1" }) }; view.root = "/remote"; view.on = "remote"; };
    view.init(undefined, cx); // root mod props come from herdr.props(), not View.init
    return view;
  };
  return { shared, effects, tasks, reads, root, spaces, cx, tabs, files, find };
}

test("file click opens the hidden Files panel and reads an absolute local path from its source", async () => {
  const h = await previewHarness();
  // A previously loaded/crashed viewer must not prevent first-load delivery.
  h.shared.set("files.receiver", "old-viewer");
  h.tabs.openFile({ path: "/outside/a quote's file.rs", cwd: "/source", terminal: "t2", on: null, space: "s1" }, h.cx);
  h.tabs.render();
  expect(h.find(h.root, "panel").hidden).toBe(false);
  expect(h.find(h.root, "panel-body").active).toBe("files");
  expect(h.shared.get("files.open").receiver).toBe("old-viewer");
  const files = h.files();
  const receiver = h.shared.get("files.receiver");
  h.files({ file_links: false }); // an ordinary Files pane cannot steal links
  expect(h.shared.get("files.receiver")).toBe(receiver);
  files.render(h.cx); // ignores payload meant for the old copy
  expect(h.tasks).toHaveLength(0);
  h.tabs.render(); // fresh viewer receives the in-memory pending request
  files.render(h.cx);
  const read = h.tasks.shift()!();
  expect(h.reads[0].path).toBe("/outside/a quote's file.rs");
  expect(h.reads[0].options).toEqual({ on: null });
  h.reads[0].resolve("fn main() {}"); await read;
  expect(files.code.options.readonly).toBe(true);
  expect(files.code.options.value).toBe("fn main() {}");
  expect(h.shared.get("files.open")).toBeNull();
  h.tabs.render(); expect(h.tabs.pendingFile).toBeNull();
});

test("persisted file requests never replay into a fresh viewer", async () => {
  const h = await previewHarness();
  h.shared.set("files.open", { id: "stale", receiver: "old-viewer", path: "/old/file", on: null, space: "s1" });
  h.shared.set("files.receiver", "old-viewer");
  const files = h.files(); h.tabs.render(); files.render(h.cx);
  expect(h.tasks).toHaveLength(0);
  expect(files.file).toBeUndefined();
});

test("newer reads win even when the same file is clicked again; binary and large previews stay bounded", async () => {
  const h = await previewHarness(), files = h.files();
  files.show("/outside/file.rs", h.cx, { on: null }); const older = h.tasks.shift()!();
  files.show("/outside/file.rs", h.cx, { on: null }); const newer = h.tasks.shift()!();
  h.reads[1].resolve("new text"); await newer;
  h.reads[0].resolve("old text"); await older;
  expect(files.code.options.value).toBe("new text");
  files.show("/outside/binary", h.cx, { on: null }); const binary = h.tasks.shift()!();
  h.reads[2].resolve("binary\0data"); await binary;
  expect(files.code).toBeNull(); expect(files.fileError).toContain("Binary");
  files.show("/outside/large", h.cx, { on: null }); const large = h.tasks.shift()!();
  h.reads[3].resolve("x".repeat(500000)); await large;
  expect(files.code.options.value.length).toBeLessThan(400100);
  expect(files.code.options.value).toContain("file truncated");
});

test("missing or disabled Files panels fall back externally, and stale spaces are ignored", async () => {
  const h = await previewHarness();
  const file = { path: "/outside/file", on: null, space: "s1" };
  h.shared.set("workspace.panels", ["changes"]);
  h.tabs.openFile(file, h.cx); await h.tasks.shift()!();
  expect(h.effects).toContainEqual(["exec", "open", ["/outside/file"]]);
  h.shared.set("workspace.panels", ["files"]);
  h.find(h.root, "files").content.mod = "personal-files";
  h.tabs.openFile(file, h.cx); await h.tasks.shift()!();
  expect(h.tabs.pendingFile).toBeNull();
  const count = h.effects.length;
  h.tabs.openFile({ ...file, space: "s2" }, h.cx);
  expect(h.effects).toHaveLength(count);
});

test("switching spaces abandons only the pending click's shared request", async () => {
  const h = await previewHarness();
  h.files();
  h.tabs.openFile({ path: "/outside/file", on: null, space: "s1" }, h.cx);
  h.tabs.render();
  expect(h.shared.get("files.open").path).toBe("/outside/file");
  h.spaces[0].active = false;
  h.tabs.render();
  expect(h.shared.get("files.open")).toBeNull();
  expect(h.tabs.pendingFile).toBeNull();
  h.spaces[0].active = true;
  h.tabs.openFile({ path: "/outside/second", on: null, space: "s1" }, h.cx);
  h.tabs.render();
  h.shared.set("files.open", { id: "another-copy", path: "/another" });
  h.spaces[0].active = false;
  h.tabs.render();
  expect(h.shared.get("files.open").id).toBe("another-copy");
});
