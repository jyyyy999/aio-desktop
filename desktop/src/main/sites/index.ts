import type { SiteId } from "../../shared/types.js";
import type { SiteAdapter } from "./adapter.js";
import { bnkr } from "./bnkr.js";
import { lotte } from "./lotte.js";
import { naver } from "./naver.js";
import { supreme } from "./supreme.js";

export type { Launch, MonitorSignal, PrepareCommand, SiteAdapter, WindowLogin } from "./adapter.js";

/** 사이트를 하나 더 붙이려면 어댑터를 만들어 여기와 shared/sites.ts 에 넣는다. */
export const ADAPTERS: Record<SiteId, SiteAdapter> = { lotte, naver, bnkr, supreme };
