/**
 * 디스코드로 알린다.
 *
 * 진행 상황은 화면에서 보고, **손댈 차례만 폰으로 받는다.** 무엇을 보낼지는 설정의
 * discord_notify 가 정한다 — 다 보내면 정작 중요한 것이 묻힌다.
 */
import { log } from "../log.js";
import { priceText } from "../util.js";
import { wants, webhookOf, type Config, type Stage } from "./config.js";
import type { StockInfo } from "./product.js";
import type { Target } from "./targets.js";

export interface Embed {
  title?: string;
  url?: string;
  color?: number;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

interface Payload {
  content?: string | null;
  embeds?: Embed[];
}

const now = () => new Date().toISOString();
// 롯데온의 빨강.
const LOTTE_RED = 0xe4002b;

export async function postDiscord(webhookUrl: string, payload: Payload): Promise<boolean> {
  if (!webhookUrl) return false;
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    log.warn(`디스코드 전송 실패: ${(e as Error).message}`);
    return false;
  }
  if (res.status >= 300) {
    log.warn(`디스코드가 ${res.status} 로 답했습니다`);
    return false;
  }
  return true;
}

export function notify(cfg: Config, embed: Embed, mention?: string | null): Promise<boolean> {
  const payload: Payload = { embeds: [embed] };
  if (mention) payload.content = mention;
  return postDiscord(webhookOf(cfg), payload);
}

/** 어디까지 갔는지 한 줄로. 폰으로 보는 사람이 무엇을 해야 하는지 알아야 한다. */
const STAGE_SAID: Record<Stage, [string, string]> = {
  opened: ["🛒 주문서를 열었습니다", "PC 의 크롬 창에서 결제해 주세요"],
  agreed: ["🛒 주문서에서 필수 동의까지 했습니다", "PC 의 크롬 창에서 결제하기를 눌러 주세요"],
  submitted: ["💳 결제창까지 띄웠습니다 — 결제해 주세요", "결제 확정은 PC 의 결제창에서 직접 해주세요"],
};

export function notifyOpened(
  cfg: Config, target: Target, info: StockInfo, stage: Stage,
): Promise<boolean> {
  if (!wants(cfg, "opened")) return Promise.resolve(false);
  const [title, footer] = STAGE_SAID[stage];
  return notify(cfg, {
    title,
    url: target.url,
    color: LOTTE_RED,
    description: info.name || target.url,
    fields: [
      { name: "가격", value: priceText(info.price), inline: true },
      { name: "수량", value: `${target.ea}개`, inline: true },
      { name: "옵션", value: target.option || "—", inline: true },
    ],
    footer: { text: footer },
    timestamp: now(),
  }, cfg.mention);
}

export function notifyBlocked(cfg: Config, target: Target, reason: string): Promise<boolean> {
  if (!wants(cfg, "blocked")) return Promise.resolve(false);
  return notify(cfg, {
    title: "⛔ 사지 않았습니다",
    url: target.url,
    color: 0xe67e22,
    description: reason,
    timestamp: now(),
  });
}

export function notifySession(cfg: Config): Promise<boolean> {
  if (!wants(cfg, "session")) return Promise.resolve(false);
  return notify(cfg, {
    title: "🔒 롯데온 세션이 끊겼습니다",
    color: 0xe74c3c,
    description: "빌려온 로그인 세션이 만료됐습니다. 재고가 열려도 살 수 없어 멈춥니다.\n" +
      "브라우저에서 쿠키를 다시 복사해 `--cookie` 로 넣어주세요.",
    timestamp: now(),
  }, cfg.mention);
}
