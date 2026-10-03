/**
 * 디스코드로 알린다.
 *
 * 진행 상황은 화면에서 보고, **손댈 차례만 폰으로 받는다.** 무엇을 보낼지는 설정의
 * discord_notify 가 정한다 — 다 보내면 정작 중요한 것이 묻힌다.
 */
import { log } from "../log.js";
import { comma } from "../util.js";
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

export function notifyOpened(
  cfg: Config, target: Target, info: StockInfo, stage: Stage = "opened",
): Promise<boolean> {
  if (!wants(cfg, "opened")) return Promise.resolve(false);
  return notify(cfg, {
    title: stage === "submitted"
      ? "💳 결제하기까지 눌렀습니다 — 인증해 주세요"
      : "🛒 주문서를 열었습니다 — 결제해 주세요",
    url: target.url,
    color: 0x03c75a,
    description: info.name || target.url,
    fields: [
      { name: "가격", value: info.price ? `${comma(info.price)}원` : "—", inline: true },
      { name: "재고", value: info.stock >= 0 ? `${info.stock}개` : "—", inline: true },
      { name: "옵션", value: info.option ? info.option.text : "—", inline: true },
    ],
    footer: { text: "결제는 PC 의 크롬 창에서 직접 해주세요" },
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

export function notifyCaptcha(cfg: Config, target: Target): Promise<boolean> {
  if (!wants(cfg, "captcha")) return Promise.resolve(false);
  return notify(cfg, {
    title: "🧩 캡차가 떴습니다 — 크롬 창에서 풀어 주세요",
    url: target.url,
    color: 0x9b59b6,
    description: "네이버가 사람인지 묻고 있습니다. PC 의 크롬 창에서 풀어 주시면\n" +
      "같은 창에서 감시를 이어갑니다. (대신 풀지 않습니다)",
    timestamp: now(),
  }, cfg.mention);
}

/** 결제가 끝났다. 롯데온 판과 같은 모양으로 보낸다. discord_notify 에 "paid" 가 있어야 간다. */
export function notifyPaid(cfg: Config, target: Target, name: string): Promise<boolean> {
  if (!wants(cfg, "paid")) return Promise.resolve(false);
  const product = name || target.label || target.url;
  return notify(cfg, {
    title: "successfully checkout",
    url: target.url,
    color: 0x2ecc71,
    description: product.slice(0, 200),
    fields: [
      { name: "제품", value: product.slice(0, 200), inline: false },
      { name: "링크", value: target.url, inline: false },
    ],
    footer: { text: "결제 완료" },
    timestamp: now(),
  });
}

export function notifySession(cfg: Config): Promise<boolean> {
  if (!wants(cfg, "session")) return Promise.resolve(false);
  return notify(cfg, {
    title: "🔒 네이버 세션이 끊겼습니다",
    color: 0xe74c3c,
    description: "빌려온 로그인 세션이 만료됐습니다. 재고가 열려도 살 수 없어 멈춥니다.\n" +
      "브라우저에서 쿠키를 다시 복사해 `--cookie` 로 넣어주세요.",
    timestamp: now(),
  }, cfg.mention);
}
