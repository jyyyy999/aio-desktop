/**
 * 디스코드 알림. 집의 관례를 따른다 — dry-run 이면 보내지 않고 무엇을 보낼지만 적는다.
 *
 *   발견   태스크로 살 때 (모니터의 발견 알림은 데스크톱 매니저가 보낸다 — 원본은 안 보낸다)
 *   캡차   사람이 풀어야 할 때 (창을 띄웠다는 사실을 폰으로도 알린다)
 *   3DS    카드사 인증이 필요할 때
 *   결제   결제가 끝났을 때 — 주문번호까지
 */
import { log, sayStar } from "./log.js";
import { run, webhookOf, type SupremeConfig, type Target } from "./config.js";

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

interface Embed {
  title: string;
  description?: string;
  color?: number;
  fields?: Field[];
  timestamp?: string;
}

const COLOR = { found: 0x2ecc71, captcha: 0xf1c40f, paid: 0x9b59b6, bad: 0xe74c3c } as const;

export async function postDiscord(url: string, payload: unknown): Promise<boolean> {
  if (run.dryRun) {
    log.info(`[dry-run] 디스코드 전송 생략:\n${JSON.stringify(payload, null, 2)}`);
    return true;
  }
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.warn(`디스코드로 알리지 못했습니다 (HTTP ${res.status})`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`디스코드로 알리지 못했습니다: ${(e as Error).message}`);
    return false;
  }
}

async function send(cfg: SupremeConfig, embed: Embed, speak: string): Promise<boolean> {
  const url = webhookOf(cfg);
  if (!url) {
    log.debug("디스코드 웹훅이 없어 알리지 않았습니다");
    return false;
  }
  const ok = await postDiscord(url, { embeds: [{ ...embed, timestamp: new Date().toISOString() }] });
  if (ok && !run.dryRun) sayStar("디스코드로 알렸습니다");
  else if (ok) log.debug(`[dry-run] ${speak}`);
  return ok;
}

export function notifyFound(cfg: SupremeConfig, target: Target, detail: string, imageUrl = ""): Promise<boolean> {
  return send(cfg, {
    title: "🟢 재고 발견 — 담았습니다",
    description: detail,
    color: COLOR.found,
    fields: [
      { name: "상품", value: target.label || target.url, inline: false },
      { name: "주소", value: target.url, inline: false },
    ],
    ...(imageUrl ? { } : {}),
  }, "재고 발견");
}

export function notifyCaptcha(cfg: SupremeConfig, target: Target | null): Promise<boolean> {
  return send(cfg, {
    title: "🧩 캡차가 떴습니다 — 창에서 풀어 주세요",
    description: "대신 풀지 않습니다. 캡차 창에서 사람이 풀면 자동으로 이어서 진행합니다.",
    color: COLOR.captcha,
    ...(target ? { fields: [{ name: "상품", value: target.label || target.url, inline: false }] } : {}),
  }, "캡차");
}

export function notifyThreeDs(cfg: SupremeConfig): Promise<boolean> {
  return send(cfg, {
    title: "🔐 카드사 추가 인증(3DS)",
    description: "열린 창에서 인증을 끝내 주세요. 끝나면 주문이 완료됩니다.",
    color: COLOR.captcha,
  }, "3DS");
}

export function notifyPaid(cfg: SupremeConfig, orderNo: string, what: string, total = 0): Promise<boolean> {
  return send(cfg, {
    title: "🟣 결제 완료",
    description: what,
    color: COLOR.paid,
    fields: [
      { name: "주문번호", value: orderNo, inline: true },
      ...(total > 0 ? [{ name: "금액", value: String(total), inline: true }] : []),
    ],
  }, "결제 완료");
}

export function notifyBlocked(cfg: SupremeConfig, detail: string): Promise<boolean> {
  return send(cfg, {
    title: "🚧 사람 확인이 필요합니다",
    description: detail,
    color: COLOR.bad,
  }, "차단");
}
