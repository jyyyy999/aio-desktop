/**
 * 상품 이름 — 태스크 표의 상품 칸·이름을 비워 둔 모니터가 상품번호(LM8809644094473 · 13763157937) 대신 이름을 보이게.
 * %APPDATA%/aio-task-manager/product-names.json 에 "사이트:상품번호" → 이름 으로 적어 둔다.
 *
 *   읽기  이름을 안 붙인 태스크·모니터의 상품만, 어댑터의 productName 으로 한 번 (쿠키 없이, 하나씩 차례로)
 *   줍기  원본이 상품 이름을 찍는 사이트(네이버)는 태스크·모니터 출력에서 (어댑터의 productNameLine)
 *
 * 읽은 것은 다시 읽지 않는다 — 상품 이름은 잘 바뀌지 않는다. 못 읽은 상품은 앱을 켜 둔 동안 다시 묻지 않는다
 * (봇 차단에 걸린 사이트를 태스크를 저장할 때마다 두드리지 않게). 사람이 붙인 이름(label)이 늘 먼저다.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productKey, SITES } from "../shared/sites.js";
import type { SiteId } from "../shared/types.js";
import { ADAPTERS } from "./sites/index.js";

/** 이름이 필요한 상품 — 사람이 이름을 안 붙인 태스크·모니터의 것. */
export interface NameWant {
  site: SiteId;
  url: string;
}

interface Job {
  key: string;
  read: () => Promise<string | null>;
}

/**
 * 이벤트
 *   "changed" (names: Record<string, string>)
 */
export class ProductNames extends EventEmitter {
  private names: Record<string, string>;
  private failed = new Set<string>();
  private queue: Job[] = [];
  /** 줄에 있거나 읽는 중인 상품. */
  private pending = new Set<string>();
  private running = false;

  constructor(private readonly dataDir: string) {
    super();
    this.names = this.load();
  }

  get path(): string {
    return join(this.dataDir, "product-names.json");
  }

  private load(): Record<string, string> {
    try {
      const raw = (JSON.parse(readFileSync(this.path, "utf-8")) as { names?: unknown }).names;
      if (!raw || typeof raw !== "object") return {};
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]));
    } catch {
      return {};
    }
  }

  all(): Record<string, string> {
    return { ...this.names };
  }

  private set(key: string, name: string): void {
    if (this.names[key] === name) return;
    this.names[key] = name;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, names: this.names }, null, 2), "utf-8");
      renameSync(tmp, this.path);
    } catch {
      // 못 적어도 이번에 켠 동안은 보인다.
    }
    this.emit("changed", this.all());
  }

  /** 그 상품을 보는 원본의 출력 한 줄 — 이름을 찍는 줄이면 줍는다. */
  noteLine(site: SiteId, url: string, text: string): void {
    const name = ADAPTERS[site].productNameLine?.exec(text.trim())?.[1]?.trim();
    if (name) this.set(productKey(site, url), name);
  }

  /** 이름이 필요한 상품을 읽으러 줄 세운다. 이미 알거나, 못 읽었거나, 읽는 중이면 건너뛴다. */
  want(items: NameWant[]): void {
    for (const t of items) {
      const read = ADAPTERS[t.site].productName;
      if (!read || !SITES[t.site].isProductUrl(t.url)) continue;
      const key = productKey(t.site, t.url);
      if (this.names[key] || this.failed.has(key) || this.pending.has(key)) continue;
      const url = t.url.trim();
      this.pending.add(key);
      this.queue.push({ key, read: () => read(url) });
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        try {
          const name = (await job.read())?.trim();
          if (name) this.set(job.key, name);
          else this.failed.add(job.key);
        } catch {
          this.failed.add(job.key);
        } finally {
          this.pending.delete(job.key);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
