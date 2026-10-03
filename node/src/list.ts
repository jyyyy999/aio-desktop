/**
 * 목록 한 장을 읽는다. bnkr_stock.py 의 훑어보는 부분과 같은 판정을 한다.
 *
 * 아직 주소를 모르는 상품을 기다릴 때 쓴다. 새 상품은 올라오기 전에 번호가 없으니
 * targets 에 미리 적을 수가 없고, 목록에 올라오는 순간을 잡는 수밖에 없다.
 *
 * **목록은 한 장에 150KB 다.** 재고 조회(113바이트)와 같은 주기로 두드릴 것이 아니다.
 * 새로 올라오는 것만 잡으면 되고, 잡은 뒤에는 가벼운 재고 조회가 이어받는다.
 */
import { parse, type HTMLElement } from "node-html-parser";
import { Session, SiteError } from "./http.js";
import { IN_STOCK, SITE, SOLDOUT, textOf, type Status } from "./site.js";
import { asList, sleep, toInt } from "./util.js";
import { log } from "./log.js";
import type { DiscoverSpec } from "./config.js";

const SEARCH_PATH = "/goods/search.do";

// 목록 종류마다 "몇 번째 장" 을 가리키는 파라미터 이름이 다르다.
const PAGE_PARAM: Record<string, string> = {
  "/goods/category.do": "page",
  "/premium/p_category.do": "page",
};
const DEFAULT_PAGE_PARAM = "pageNum";
// 안전장치. 카테고리 전체(40개/장 × 40여 장)를 매 주기 긁을 이유는 없다.
const HARD_MAX_PAGES = 40;

const GNO_RE = /(\d{4,})/;
const BG_URL_RE = /url\(['"]?([^'")]+)/;
const PAGE_LINK_RE = /goPage\((\d+)\)/g;

export interface Watch {
  path: string;
  query: Record<string, string>;
  label: string | null;
  max_pages: number | null;
  contains: string[];
}

export interface Listed {
  gno: string;
  name: string;
  series: string | null;
  price: number | null;
  image: string | null;
  dim: string | null;
  badges: string[];
  status: Status;
}

/**
 * 설정에 적힌 항목 → 감시할 목록 하나.
 *
 * "원피스 카드게임" 처럼 검색어만 적어도 되고, 브라우저에서 복사한 URL 을 그대로
 * 붙여넣어도 된다. page·pageNum 은 우리가 정하므로 붙어 있어도 떼어낸다.
 */
export function parseWatch(entry: string | DiscoverSpec): Watch | null {
  let label: string | null = null;
  let maxPages: number | null = null;
  let contains: string[] = [];
  let raw = "";

  if (typeof entry === "object" && entry !== null) {
    label = (entry.label || "").trim() || null;
    maxPages = entry.max_pages ?? null;
    contains = asList(entry.contains);
    raw = String(entry.url || entry.keyword || entry.sword || "");
  } else {
    raw = String(entry ?? "");
  }
  raw = raw.trim();
  if (!raw) return null;

  let path: string;
  let query: Record<string, string> = {};
  if (raw.includes("://") || raw.startsWith("/")) {
    const parsed = new URL(raw.includes("://") ? raw : SITE + raw);
    path = parsed.pathname || SEARCH_PATH;
    for (const [k, v] of parsed.searchParams) if (v !== "") query[k] = v;
  } else {
    path = SEARCH_PATH;
    query = { sword: raw, searchType: "allTotal" };
  }

  delete query["page"];
  delete query["pageNum"];
  // soldout=Y 는 "품절상품 제외" 다. 사이트 메뉴 링크에 기본으로 붙어 있는데, 그대로 두면
  // 재입고를 지켜볼 상품이 애초에 목록에서 빠진다.
  if (query["soldout"]) {
    delete query["soldout"];
    log.info(`soldout 파라미터를 떼어냅니다 (품절 상품이 빠지면 재입고를 볼 수 없습니다): ${raw}`);
  }

  if (!Object.keys(query).length) return null;
  return { path, query, label, max_pages: maxPages, contains };
}

/** 상태 파일에 기준선을 적어 둘 때 쓰는 이름. 파이썬 판과 같은 글자여야 한다. */
export function watchKey(watch: Watch): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(watch.query).sort()) params.append(key, watch.query[key]!);
  return `${watch.path}?${params.toString()}`;
}

/** 알림·로그에 쓸 사람이 읽는 이름. */
export function watchLabel(watch: Watch): string {
  if (watch.label) return watch.label;
  for (const key of ["sword", "cateName", "seriesName", "brandName"]) {
    if (watch.query[key]) return watch.query[key]!;
  }
  if (watch.path.endsWith("/new.do")) return "신상품";
  return watchKey(watch);
}

export function watchUrl(watch: Watch, page?: number): string {
  const params = new URLSearchParams(watch.query);
  if (page) params.set(PAGE_PARAM[watch.path] ?? DEFAULT_PAGE_PARAM, String(page));
  return `${SITE}${watch.path}?${params.toString()}`;
}

/** 검색은 넓게 걸린다. 감시 대상이 아닌 상품이 섞여 들어오는 걸 여기서 막는다. */
export function keepItem(filters: string[], item: Listed): boolean {
  if (!filters.length) return true;
  const name = (item.name || "").toLowerCase();
  return filters.some((f) => name.includes(f.toLowerCase()));
}

export function parseItem(li: HTMLElement): Listed | null {
  const a = li.querySelector('a.thumb[href*="gno="]');
  if (!a) return null;
  const gno = GNO_RE.exec(a.getAttribute("href") ?? "")?.[1];
  if (!gno) return null;

  // 썸네일 위에 덮이는 딱지. SOLD OUT 이 대부분이고, 판매종료 같은 것도 여기로 온다.
  // 무엇이 적혀 있든 덮여 있으면 지금 살 수 없는 상품이다.
  const dim = textOf(a.querySelector(".thumb-dim"));
  const bg = BG_URL_RE.exec(a.querySelector(".img_box")?.getAttribute("style") ?? "");
  let image = bg?.[1] ? bg[1].split("?")[0]! : null;
  if (image && image.startsWith("//")) image = "https:" + image;

  const badges = li.querySelectorAll("div.badge span")
    .map((s) => s.text.trim())
    .filter((t) => t);

  return {
    gno,
    name: textOf(a.querySelector("h5")) || `상품 ${gno}`,
    series: textOf(a.querySelector("p.caption")),
    price: toInt(textOf(a.querySelector(".price_result"))),
    image,
    dim,
    badges,
    status: dim ? SOLDOUT : IN_STOCK,
  };
}

/** 상품 목록이 들어 있는 영역들. 검색 페이지는 일반/프리미엄 탭이 따로 있다. */
export function productScopes(root: HTMLElement): HTMLElement[] {
  const scopes = ["#totallist", "#prelist"]
    .map((sel) => root.querySelector(sel))
    .filter((n): n is HTMLElement => n !== null);
  if (scopes.length) return scopes;
  const one = root.querySelector(".main-product-list");
  if (!one) {
    // 목록 틀 자체가 없다. 상품 0개가 아니라 우리가 모르는 페이지를 받은 것이다.
    throw new SiteError("상품 목록 영역(.main-product-list)이 없습니다");
  }
  return [one];
}

/** 페이징의 '마지막으로' 버튼이 가리키는 장 번호. */
export function lastPage(root: HTMLElement): number {
  const box = root.querySelector("#totallist .paging_box") ?? root.querySelector(".paging_box");
  if (!box) return 1;
  const button = box.querySelector(".to_last");
  if (button) {
    const m = /goPage\((\d+)\)/.exec(button.getAttribute("onclick") ?? "");
    if (m) return Number(m[1]);
  }
  const pages = [...box.toString().matchAll(PAGE_LINK_RE)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 1;
}

/** 목록 한 곳의 상품 전부. 페이지가 갈리면 maxPages 까지 따라간다. */
export async function fetchList(
  s: Session, watch: Watch, opts: { maxPages?: number; delay?: number } = {},
): Promise<{ items: Listed[]; total: number; seen: number }> {
  const limit = Math.max(1, Math.min(watch.max_pages || opts.maxPages || 5, HARD_MAX_PAGES));
  const delay = opts.delay ?? 1;
  const filters = watch.contains;
  const items: Listed[] = [];
  const seen = new Set<string>();
  let page = 1;
  let total = 1;
  let dropped = 0;

  while (page <= Math.min(total, limit)) {
    const root = parse(await s.html(watchUrl(watch, page), "목록"));
    if (page === 1) total = lastPage(root);

    for (const scope of productScopes(root)) {
      for (const li of scope.querySelectorAll("ul.main-product-tab-goods > li")) {
        const item = parseItem(li);
        if (!item || seen.has(item.gno)) continue;
        seen.add(item.gno);
        if (keepItem(filters, item)) items.push(item);
        else dropped += 1;
      }
    }

    page += 1;
    if (page <= Math.min(total, limit) && delay) await sleep((delay + Math.random()) * 1000);
  }

  if (dropped) {
    log.info(`${watchLabel(watch)} — 이름 필터(${filters.join(" / ")})로 ${dropped}개를 걸렀습니다`);
  }
  if (total > limit) {
    log.warn(`${watchLabel(watch)}: ${total}장 중 ${limit}장만 봤습니다 (max_pages). ` +
      "검색어를 좁히거나 max_pages 를 올리세요.");
  }
  return { items, total, seen: seen.size };
}

/** 목록 한 장에 올라와 있는 상품들. 이름 조건에 맞는 것만. */
export async function listItems(s: Session, watch: Watch, spec: DiscoverSpec): Promise<Listed[]> {
  const root = parse(await s.html(watchUrl(watch, 1), "목록"));
  const filters = watch.contains.length ? watch.contains : asList(spec.contains);

  const items: Listed[] = [];
  const seen = new Set<string>();
  for (const scope of productScopes(root)) {
    for (const li of scope.querySelectorAll("ul.main-product-tab-goods > li")) {
      const item = parseItem(li);
      if (!item || seen.has(item.gno)) continue;
      seen.add(item.gno);
      if (keepItem(filters, item)) items.push(item);
    }
  }
  return items;
}
