/**
 * 디스코드로 알린다.
 *
 * 진행 상황은 화면에서 보고, **손댈 차례만 폰으로 받는다.** 무엇을 보낼지는 설정의
 * discord_notify 가 정한다 — 다 보내면 정작 중요한 것이 묻힌다.
 */
import { pgWebhookOf, run, wants, webhookOf, type Config, type Mode } from "./config.js";
import { log } from "./log.js";
import { goodsUrl, LANDING, LANDING_LABEL, MODE_LABEL, STATUS_LABEL, type Goods } from "./site.js";
import type { Listed } from "./list.js";
import type { Target } from "./targets.js";
import { priceText } from "./util.js";

export interface Embed {
  title?: string;
  url?: string;
  color?: number;
  description?: string;
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

interface Payload {
  content?: string | null;
  embeds?: Embed[];
}

const now = () => new Date().toISOString();
/** 이름 맞대기 — 띄어쓰기·대소문자는 화면마다 다르다. */
const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export async function postDiscord(webhookUrl: string, payload: Payload): Promise<boolean> {
  if (run.dryRun) {
    log.info(`[dry-run] 디스코드 전송 생략:\n${JSON.stringify(payload, null, 2)}`);
    return true;
  }
  if (!webhookUrl) {
    log.warn("웹훅이 없어 알림을 건너뜁니다.");
    return false;
  }
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    log.error(`디스코드 전송 중 오류: ${(e as Error).message}`);
    return false;
  }
  if (res.status >= 300) {
    log.error(`디스코드 전송 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  log.info(`디스코드 전송 완료 (${res.status})`);
  return true;
}

/** 그림을 붙여 보낸다. 임베드에서는 attachment://이름 으로 가리킨다. */
export async function postDiscordImage(
  webhookUrl: string, blob: Buffer, filename: string, payload: Payload,
): Promise<boolean> {
  if (run.dryRun) {
    log.info(`[dry-run] 디스코드 전송 생략 (${filename}, ${blob.length}바이트)`);
    return true;
  }
  if (!webhookUrl) {
    log.warn("웹훅이 없어 알림을 건너뜁니다.");
    return false;
  }

  const form = new FormData();
  form.append("payload_json", new Blob([JSON.stringify(payload)], { type: "application/json" }));
  form.append("files[0]", new Blob([new Uint8Array(blob)], { type: "image/png" }), filename);

  let res: Response;
  try {
    res = await fetch(webhookUrl, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    log.error(`디스코드 전송 중 오류: ${(e as Error).message}`);
    return false;
  }
  if (res.status >= 300) {
    log.error(`디스코드 전송 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  log.info(`결제창 화면을 디스코드로 보냈습니다 (${res.status}, ${Math.round(blob.length / 1024)}KB)`);
  return true;
}

export function notify(cfg: Config, embed: Embed, mention?: string | null): Promise<boolean> {
  const payload: Payload = { embeds: [embed] };
  if (mention) payload.content = mention;
  return postDiscord(webhookOf(cfg), payload);
}

export function notifyCarted(
  cfg: Config, goods: Goods, mode: Mode, ea: number, price: number,
): Promise<boolean> {
  if (!wants(cfg, "carted")) return Promise.resolve(false);
  const lines = [
    `**${MODE_LABEL[mode]}** · 수량 ${ea}개`,
    priceText(price),
    "",
    `[${LANDING_LABEL[mode]}](${LANDING[mode]})`,
  ];
  if (run.dryRun) lines.push("", "> dry-run");

  return notify(cfg, {
    title: `🛒 ${goods.name}`.slice(0, 250),
    url: goodsUrl(goods.gno),
    color: 0x2ecc71,
    description: lines.join("\n"),
    footer: { text: "결제 확정은 직접 눌러주세요" },
    timestamp: now(),
  }, cfg.mention);
}

export function notifyBlocked(cfg: Config, goods: Goods, reason: string): Promise<boolean> {
  if (!wants(cfg, "blocked")) return Promise.resolve(false);
  return notify(cfg, {
    title: `⚠️ ${goods.name}`.slice(0, 250),
    url: goodsUrl(goods.gno),
    color: 0xe67e22,
    description: `구매 가능으로 바뀌었지만 **담지 못했습니다**.\n${reason}\n\n` +
      `[상품 페이지 열기](${goodsUrl(goods.gno)})`,
    footer: { text: "직접 확인해 주세요" },
    timestamp: now(),
  }, cfg.mention);
}

/**
 * 새 상품을 찾았다. 담기 전이지만 이건 알릴 값어치가 있다 — 사람이 알아야 할 것은
 * "무엇이 올라왔는가" 이고, 그 판단은 사람 몫으로 남는다.
 */
export function notifyFound(
  cfg: Config, item: Listed, target: Target, why = "새 상품",
): Promise<boolean> {
  if (!wants(cfg, "found")) return Promise.resolve(false);
  const embed: Embed = {
    title: `🆕 ${why} — ${item.name}`.slice(0, 250),
    url: goodsUrl(item.gno),
    color: 0x9b59b6,
    description: [
      `${priceText(item.price)} · ${STATUS_LABEL[item.status] ?? "상태 미상"}`,
      `감시에 넣었습니다 (${target.mode} ×${target.ea})`,
    ].join("\n"),
    timestamp: now(),
  };
  if (item.image) embed.thumbnail = { url: item.image };
  return notify(cfg, embed, cfg.mention);
}

export function notifySession(cfg: Config): Promise<boolean> {
  if (!wants(cfg, "session")) return Promise.resolve(false);
  return notify(cfg, {
    title: "🔒 세션이 끊겼습니다",
    color: 0xe74c3c,
    description: "빌려온 로그인 세션이 만료됐습니다. 재고가 열려도 담을 수 없어 멈춥니다.\n" +
      "브라우저에서 쿠키를 다시 복사해 `--cookie` 로 넣어주세요.",
    // 테스트 판에서 온 알림임을 적어 둔다. 본판과 같은 채널로 가는데, 받은 쪽에서는
    // 어느 쪽이 보낸 것인지 알 길이 없다.
    footer: { text: "반다이남코코리아몰 담기 도우미 (네이버페이 테스트)" },
    timestamp: now(),
  }, cfg.mention);
}

export function notifyQueue(cfg: Config, waiting: string): Promise<boolean> {
  if (!wants(cfg, "queue")) return Promise.resolve(false);
  return notify(cfg, {
    title: "⏳ 대기열",
    color: 0x95a5a6,
    description: `${waiting}\n같은 세션으로 기다립니다.`,
    timestamp: now(),
  }, cfg.pg_mention);
}

export interface PaidInfo { order_no?: string; name?: string; image?: string }

/**
 * 결제가 끝났다. 이 알림 하나 받자고 지켜본 것이다.
 *
 * 완료 화면 그림은 보내지 않는다. 주문번호는 글자로 적어 보내므로 그림이 더 말해 주는
 * 것이 없고, 폰에서는 자리만 크게 차지한다. 확인이 필요하면 주문내역이 정본이다.
 */
export function notifyPaid(
  cfg: Config, goods: { gno?: string; name: string }, info: PaidInfo = {},
): Promise<boolean> {
  // **이름은 우리가 담은 것을 믿는다.** 완료 화면에서 읽은 이름·사진은 그 화면의 첫 상품 링크·첫 큰 그림이라, 추천
  // 상품이나 배너가 걸리면 엉뚱한 상품으로 온다 (2026-10-23 결제 완료 알림이 이상하게 왔다). 화면에서 읽은 이름이
  // 담은 것과 같을 때만 그 사진을 곁들인다.
  const name = goods.name || info.name || "";
  const same = !!info.name && !!goods.name && squash(info.name) === squash(goods.name);
  const lines = ["주문이 끝났습니다."];
  if (info.order_no) lines.push(`주문번호 **${info.order_no}**`);
  if (goods.gno) lines.push(`상품번호 ${goods.gno}`);

  const embed: Embed = {
    title: `✅ 결제 완료 — ${name}`.slice(0, 250),
    color: 0x2ecc71,
    description: lines.join("\n"),
    footer: { text: "주문내역에서 한 번 더 확인해 주세요" },
    timestamp: now(),
  };
  if (goods.gno) embed.url = goodsUrl(goods.gno);
  // 상품 사진은 작게 곁들인다 — 담은 그 상품의 것일 때만.
  if (info.image && same) embed.thumbnail = { url: info.image };

  return postDiscord(pgWebhookOf(cfg), {
    content: cfg.pg_mention || null,
    embeds: [embed],
  });
}

/**
 * 결제창 화면을 보낸다. → 보냈으면 true
 *
 *   qr      결제창까지 갔으면 늘 보낸다 (QR 을 폰으로 옮겨야 할 때)
 *   stuck   **어긋났을 때만** 보낸다 (다 눌리는 흐름일 때)
 *
 * stuck 이 필요한 이유가 있다. 클릭이 다 먹는 흐름을 만들어 두면 결제창 화면은 폰으로
 * 갈 이유가 없다 — 결제 완료만 받으면 된다. 그런데 그때가 오히려 위험하다. 창을 화면
 * 밖에 두고 알림도 껐는데 클릭 하나가 어긋나면, 재고를 잡아 담기까지 해 놓고 아무도
 * 모르는 채로 지나간다. 그 한 판이 제일 아깝다.
 */
export function notifyPayment(
  cfg: Config, goods: { name: string }, blob: Buffer,
  done: string[], quiet: string[], missed: string[],
): Promise<boolean> {
  const stuck = missed.length > 0;
  if (!(wants(cfg, "qr") || (stuck && wants(cfg, "stuck")))) return Promise.resolve(false);

  const lines: string[] = [];
  if (done.length) lines.push("누른 것: " + done.join(" → "));
  if (quiet.length) lines.push(`눌렀지만 화면 변화를 못 봤습니다: ${quiet.join(", ")}`);
  if (missed.length) {
    lines.push(`**못 찾은 것: ${missed.join(", ")}** — 화면을 보고 직접 눌러주세요.`);
    if (cfg.browser_offscreen && !cfg.browser_headless) {
      // 창이 화면 밖에 있다. 직접 누르라고만 하면 찾을 수가 없다.
      lines.push("크롬이 화면 밖에 있습니다 — " +
        "`browser_offscreen` 을 false 로 두고 다시 돌려야 손댈 수 있습니다.");
    }
  } else {
    lines.push("", "결제는 직접 해주세요. QR 은 폰으로 찍어 승인하시면 됩니다.");
  }

  return postDiscordImage(pgWebhookOf(cfg), blob, "payment.png", {
    content: cfg.pg_mention || null,
    embeds: [{
      title: (stuck ? `⚠️ 결제창에서 막혔습니다 — ${goods.name}` : `💳 ${goods.name}`).slice(0, 250),
      color: stuck ? 0xf1c40f : 0x3498db,
      description: lines.join("\n"),
      image: { url: "attachment://payment.png" },
      footer: { text: "결제창 화면 · 확정은 사람이 누릅니다" },
      timestamp: now(),
    }],
  });
}
