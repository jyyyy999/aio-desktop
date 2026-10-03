/** 여기저기서 쓰는 잔손질들. */
import { UI } from "./ui.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 여러 개를 동시에, 그러나 한 번에 limit 개까지만. → 넣은 순서 그대로의 결과
 *
 * **한꺼번에 다 던지지 않는 것이 요점이다.** Promise.all 로 쉰 개를 한 번에 날리면
 * 빠른 게 아니라 한 아이피에서 쉰 번을 동시에 두드리는 것이고, 그건 가장 빨리 막히는
 * 길이다. 일하는 일꾼 수를 정해 두고 끝나는 대로 다음 것을 집어 간다.
 *
 * 던진 것이 터지면 그대로 위로 올린다 — 무엇이 실패했는지는 부른 쪽이 알아야 한다.
 * 하나가 터졌다고 나머지를 버리기 싫으면 work 안에서 잡아 결과에 실어 보내면 된다.
 */
export async function pool<T, R>(
  items: T[], limit: number, work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const hands = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  await Promise.all(Array.from({ length: hands }, async () => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      out[at] = await work(items[at]!, at);
    }
  }));
  return out;
}

/** 25000 → "25,000". 파이썬의 f"{n:,}" 과 같은 것을 낸다. */
export function comma(n: number): string {
  return n.toLocaleString("en-US");
}

export function priceText(price: number | null | undefined): string {
  return price ? `${comma(price)}원` : "가격 미표기";
}

/**
 * 지금 시각을 파이썬의 isoformat(timespec="seconds") 과 같은 글자로.
 *
 * 상태 파일을 파이썬 판과 나눠 쓰므로 그쪽이 fromisoformat 으로 읽을 수 있어야 한다.
 * toISOString 을 쓰면 UTC 로 적혀서, 쿨다운이 아홉 시간 어긋난다.
 */
export function nowStamp(at: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T` +
    `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/**
 * 기다리면서 남은 시간을 한 줄에 고쳐 쓴다. → 도중에 접었으면 true
 *
 * 자주 깨어나되 숫자가 바뀔 때만 고쳐 쓴다. 같은 숫자를 다시 그리면 화면이 떤다.
 *
 * until 을 주면 기다리는 **도중에도** 그것을 본다. 설정을 고쳐 놓고 다음 주기까지
 * 기다려야 한다면 실시간 반영이라 할 수 없다 — 하필 그 사이에 재고가 열리면 놓친다.
 */
export async function wait(seconds: number, note: string, until?: () => boolean): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  let shown: number | null = null;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) return false;
    if (until && until()) return true;
    const second = Math.floor(left / 1000) + 1;
    if (second !== shown) {
      UI.status(`${note} · 다음 확인 ${second}초`);
      shown = second;
    }
    await sleep(Math.min(250, left));
  }
}

/** "1,234원" 같은 글자에서 숫자만. */
const DIGITS_RE = /[\d,]+/;
export function toInt(text: string | null | undefined): number | null {
  const m = DIGITS_RE.exec(text ?? "");
  return m ? Number(m[0].replace(/,/g, "")) : null;
}

/** 문자열 하나로 줘도 되고 목록으로 줘도 되는 설정값. */
export function asList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}
