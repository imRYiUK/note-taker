// Viewer library sidebar: notebooks (open / new / rename / delete / template)
// and page thumbnails of the current notebook (go to / add / delete).
// Thumbnails are server-rendered SVGs, refreshed a moment after their page changes.

import {
  PAGE_KINDS,
  TEMPLATES,
  type ClientMsg,
  type NotebookInfo,
  type NotebookState,
  type PageKind,
  type Template,
} from "../shared/protocol.ts";
import { TEMPLATE_LABELS } from "../shared/templates.ts";

const KIND_LABELS: Record<PageKind, string> = { a4: "A4 pages", infinite: "Endless pages" };
const THUMB_DELAY_MS = 900;
const ARM_MS = 3000;

type Send = (msg: ClientMsg) => void;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const c of children) if (c) el.append(c);
  return el;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** A button that needs a second click within a few seconds (instead of a modal confirm). */
function confirmButton(label: string, armedLabel: string, title: string, onConfirm: () => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: "icon danger", textContent: label, title });
  let timer: ReturnType<typeof setTimeout> | null = null;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (timer) {
      clearTimeout(timer);
      timer = null;
      onConfirm();
      return;
    }
    b.textContent = armedLabel;
    b.classList.add("armed");
    timer = setTimeout(() => {
      timer = null;
      b.textContent = label;
      b.classList.remove("armed");
    }, ARM_MS);
  });
  return b;
}

function options<T extends string>(values: readonly T[], labels: Record<T, string>, selected?: T): HTMLOptionElement[] {
  return values.map((v) => h("option", { value: v, textContent: labels[v], selected: v === selected }));
}

export class Sidebar {
  private notebooks: NotebookInfo[] = [];
  private state: NotebookState | null = null;
  private pageId: string | null = null;
  private online = false;
  /** Bumped whenever a page's content changes; part of the thumbnail URL. */
  private readonly revs = new Map<string, number>();
  private readonly pendingThumbs = new Set<string>();
  private thumbTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly thumbs = new Map<string, HTMLImageElement>();
  private renaming: string | null = null;
  /** Reload thumbnails from this server run only (revs restart at 0 after a reload). */
  private readonly session = Math.random().toString(36).slice(2, 8);

  private readonly list: HTMLElement;
  private readonly pagesEl: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly templateSel: HTMLSelectElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly send: Send,
  ) {
    this.list = root.querySelector("#nb-list")!;
    this.pagesEl = root.querySelector("#thumbs")!;
    this.form = root.querySelector("#nb-new")!;
    this.templateSel = root.querySelector("#nb-template")!;

    const tpl = this.form.querySelector<HTMLSelectElement>("[name=template]")!;
    const kind = this.form.querySelector<HTMLSelectElement>("[name=kind]")!;
    tpl.replaceChildren(...options(TEMPLATES, TEMPLATE_LABELS, "lined"));
    kind.replaceChildren(...options(PAGE_KINDS, KIND_LABELS, "a4"));
    this.templateSel.replaceChildren(...options(TEMPLATES, TEMPLATE_LABELS));

    root.querySelector("#nb-new-btn")!.addEventListener("click", () => this.showForm(Boolean(this.form.hidden)));
    root.querySelector("#nb-new-cancel")!.addEventListener("click", () => this.showForm(false));
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const title = this.form.querySelector<HTMLInputElement>("[name=title]")!.value.trim();
      if (!title) return;
      this.send({ type: "notebook.new", title, template: tpl.value as Template, kind: kind.value as PageKind });
      this.showForm(false);
    });
    this.form.addEventListener("keydown", (e) => e.key === "Escape" && this.showForm(false));

    this.templateSel.addEventListener("change", () => {
      if (this.state) this.send({ type: "notebook.update", id: this.state.notebook.id, template: this.templateSel.value as Template });
    });
  }

  // ------------------------------------------------------------ inputs

  setOnline(online: boolean): void {
    this.online = online;
    this.root.classList.toggle("offline", !online);
  }

  setNotebooks(list: NotebookInfo[]): void {
    this.notebooks = list;
    this.renderList();
  }

  /** Current notebook + page (from a snapshot or `notebook.state`). */
  setState(state: NotebookState, pageId: string): void {
    const templateChanged = this.state?.notebook.template !== state.notebook.template;
    this.state = state;
    this.pageId = pageId;
    // The list shows the current notebook's title / page count from the freshest source.
    const i = this.notebooks.findIndex((n) => n.id === state.notebook.id);
    if (i >= 0) this.notebooks[i] = state.notebook;
    if (templateChanged) for (const p of state.pages) this.bump(p.id, false);
    this.renderList();
    this.renderPages();
  }

  /** A page's content changed: refresh its thumbnail shortly. */
  pageChanged(pageId: string): void {
    this.bump(pageId, true);
  }

  /** Ink settings changed: every thumbnail looks different. */
  allChanged(): void {
    for (const id of this.thumbs.keys()) this.bump(id, true);
  }

  showForm(open: boolean): void {
    this.form.hidden = !open;
    if (open) {
      const input = this.form.querySelector<HTMLInputElement>("[name=title]")!;
      input.value = "";
      input.focus();
    }
  }

  // ------------------------------------------------------------ notebooks

  private renderList(): void {
    const current = this.state?.notebook.id;
    if (!this.notebooks.length) {
      this.list.replaceChildren(h("div", { class: "empty", textContent: "—" }));
      return;
    }
    this.list.replaceChildren(
      ...this.notebooks.map((nb) => {
        const active = nb.id === current;
        const row = h("div", { class: `nb${active ? " active" : ""}` });
        if (this.renaming === nb.id) {
          row.append(this.renameInput(nb));
          return row;
        }
        const open = h(
          "button",
          { type: "button", class: "nb-open", title: active ? "Current notebook — double-click to rename" : "Open" },
          h("span", { class: "nb-title", textContent: nb.title }),
          h("span", {
            class: "nb-meta",
            textContent: `${nb.pages} page${nb.pages === 1 ? "" : "s"} · ${TEMPLATE_LABELS[nb.template]} · ${ago(nb.updatedAt)}`,
          }),
        );
        open.addEventListener("click", () => !active && this.send({ type: "notebook.open", id: nb.id }));
        open.addEventListener("dblclick", () => this.startRename(nb.id));
        const rename = h("button", { type: "button", class: "icon", textContent: "✎", title: "Rename" });
        rename.addEventListener("click", () => this.startRename(nb.id));
        const del = confirmButton("🗑", "Delete?", `Delete “${nb.title}” and all its pages`, () =>
          this.send({ type: "notebook.delete", id: nb.id }),
        );
        row.append(open, h("span", { class: "nb-actions" }, rename, del));
        return row;
      }),
    );
  }

  private startRename(id: string): void {
    this.renaming = id;
    this.renderList();
  }

  private renameInput(nb: NotebookInfo): HTMLInputElement {
    const input = h("input", { type: "text", value: nb.title, maxLength: 120, class: "rename" });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title && title !== nb.title) this.send({ type: "notebook.update", id: nb.id, title });
      this.renaming = null;
      this.renderList();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  // ------------------------------------------------------------ pages

  private renderPages(): void {
    const st = this.state;
    if (!st) return;
    this.templateSel.value = st.notebook.template;
    this.root.querySelector("#pages-title")!.textContent = `Pages · ${st.pages.length}`;
    const keep = new Set(st.pages.map((p) => p.id));
    for (const id of this.thumbs.keys()) if (!keep.has(id)) this.thumbs.delete(id);

    const cells = st.pages.map((p, i) => {
      const img = this.thumbs.get(p.id) ?? h("img", { alt: `Page ${i + 1}`, loading: "lazy", decoding: "async" });
      img.style.aspectRatio = `${p.width} / ${p.height}`;
      const want = this.thumbUrl(p.id);
      if (img.getAttribute("src") !== want) img.src = want;
      this.thumbs.set(p.id, img);

      const cell = h("div", { class: `thumb${p.id === this.pageId ? " active" : ""}`, title: `Page ${i + 1}` });
      cell.append(img, h("span", { class: "num", textContent: String(i + 1) }));
      if (p.kind === "infinite") cell.append(h("span", { class: "kind", textContent: "∞", title: "Endless page" }));
      if (st.pages.length > 1) {
        cell.append(
          confirmButton("×", "Delete?", "Delete this page", () => this.send({ type: "page.delete", pageId: p.id })),
        );
      }
      cell.addEventListener("click", () => p.id !== this.pageId && this.send({ type: "page.goto", pageId: p.id }));
      return cell;
    });
    const add = h("button", { type: "button", class: "thumb add", textContent: "＋", title: "New page at the end" });
    add.addEventListener("click", () => {
      const last = st.pages.at(-1);
      if (last) this.send({ type: "page.new", afterPageId: last.id });
    });
    this.pagesEl.replaceChildren(...cells, add);
    this.pagesEl.querySelector(".thumb.active")?.scrollIntoView({ block: "nearest" });
  }

  private thumbUrl(pageId: string): string {
    return `/api/export/${encodeURIComponent(pageId)}.svg?thumb=1&v=${this.session}-${this.revs.get(pageId) ?? 0}`;
  }

  private bump(pageId: string, later: boolean): void {
    this.revs.set(pageId, (this.revs.get(pageId) ?? 0) + 1);
    if (!later) return;
    this.pendingThumbs.add(pageId);
    if (this.thumbTimer) return;
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = null;
      for (const id of this.pendingThumbs) {
        const img = this.thumbs.get(id);
        if (img) img.src = this.thumbUrl(id);
      }
      this.pendingThumbs.clear();
    }, THUMB_DELAY_MS);
  }
}
