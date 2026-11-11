/**
 * 칼하트윕 코리아 재고 조회 + 로그인 + 구매하기 — Node.js/TypeScript 판.
 *
 *   공개 API 조회 → 사이즈마다 남은 수량 → (--watch) 바뀔 때마다 한 줄
 *   로그인(토큰) → 구매하기(담기·주문 생성) → 주문서를 크롬으로 연다 → [사람] 결제
 *   --action submit → 결제하기를 누르고 토스 간편결제(브랜드페이) 비밀번호 자판 6자리까지 (프로필 비밀번호)
 *
 * 조회는 로그인도 쿠키도 없이 공개 API 한 곳만 두드린다 (api.ts). 구매하기는 상품 페이지의 버튼이 부르는 API 를
 * 그대로 부른다 (buy.ts). 결제는 하지 않는다 — 주문서에서 멈추거나, --action submit 이면 결제하기를 누르고
 * 비밀번호 자판까지 누른다 (browser.ts 의 submitOrder).
 *
 *   node dist/carhartt/index.js 343826                  한 번 조회
 *   node dist/carhartt/index.js <주소> <주소> …          여러 상품
 *   node dist/carhartt/index.js 343826 --watch          지켜본다 (바뀐 것만 찍는다)
 *   node dist/carhartt/index.js 343826 --json           기계가 읽을 모양으로
 *   node dist/carhartt/index.js --login                 로그인해 토큰을 저장한다
 *   node dist/carhartt/index.js --whoami                저장된 로그인이 살아 있나
 *   node dist/carhartt/index.js --pin 123456            콘솔용 결제 비밀번호를 적는다 (--pin clear 로 지운다)
 *   node dist/carhartt/index.js --buy 343826            구매하기 (발매 전이면 발매 시각까지 기다렸다가)
 *   node dist/carhartt/index.js --buy 343826 --action submit --size 270   결제하기·비밀번호까지
 *   node dist/carhartt/index.js --buy 344337 --size 270,275 --dry-run
 */
import { log, sayOk, sayStar, sayStep, useLogFile } from "../log.js";
import { UI } from "../ui.js";
import { comma, priceText, wait } from "../util.js";
import {
  anyInStock, fetchSizes, fetchSnapshot, FetchFailed, notYetOpen, pageUrl, productIdOf, totalStock,
  type Product, type SizeStock, type Snapshot,
} from "./api.js";

import { humanLogin, releaseWarmChrome } from "./browser.js";
import { buy } from "./buy.js";
import {
  clearPgPassword, CONFIG_PATH, credentialsOf, LOG_PATH, pgPasswordOf, run, savePgPassword, SESSION_PATH,
} from "./config.js";
import { LINES } from "./lines.js";
import {
  clearSession, loadSession, loginWithPassword, NotLoggedIn, saveSession, whoami, type Session,
} from "./session.js";

// 들이는 순간 바꾼다 — 인자를 잘못 줘서 나는 오류까지 이 파일에 남게.
useLogFile(LOG_PATH);

const HELP = `칼하트윕 코리아 재고 조회 + 로그인 + 구매하기

 조회
  <주소|상품번호> …     조회할 상품 (https://www.carhartt-wip.co.kr/products/343826 또는 343826)
  --watch             계속 지켜본다. 수량이 바뀌거나 재입고·품절이 되면 한 줄 찍는다
  --interval 초       지켜보는 간격 (기본 5, 최소 0.5 — 앞단 캐시(약 5초)를 건너뛰어 원본을 직접 본다)
  --json              한 번 조회한 결과를 JSON 으로 찍고 끝낸다

 로그인
  --login             로그인해 토큰을 저장한다. 환경변수 CARHARTT_LOGIN_EMAIL · CARHARTT_LOGIN_PASSWORD 가 있으면
                      그것으로, 없으면 크롬 창을 띄워 사람이 로그인한다 (5분)
  --whoami            저장된 로그인이 살아 있나 본다
  --logout            저장된 토큰을 지운다

 구매하기
  --buy <주소|번호>    구매하기를 누른다 (담기 → 주문 생성) — 주문서를 크롬으로 연다. --action submit 이면 결제하기·비밀번호까지.
                      발매 전이면 발매 시각까지 기다렸다가 누른다
  --size 사이즈,…      고를 사이즈. 여러 개면 앞에서부터 재고 있는 첫 것 (사이즈가 하나뿐이면 안 적어도 된다)
  --ea 수량            수량 (기본 1)
  --answer 답          상품에 문제가 붙어 있을 때의 정답
  --watch             (--buy 와 같이) 품절이면 끝내지 않고 --interval 마다 다시 보다가, 재고가 풀리면 누른다
  --once              (--buy 와 같이) 발매 전이면 기다리지 않고 끝낸다
  --max-price 원       이 가격을 넘으면 사지 않는다
  --action open|submit  주문서까지만(open, 기본) / 결제하기를 누르고 토스 간편결제 비밀번호 자판까지(submit)
  --pin 6자리|clear     콘솔용 결제 비밀번호를 carhartt_config.json 에 적는다 (태스크는 프로필의 것을 환경변수로 받는다)
  --dry-run           누르지 않고, 눌렀을 자리에서 멈춘다 (로그인 없이도 된다). --watch 와 같이 쓰면 사지 않고 계속 본다
  --no-open           주문서를 크롬으로 열지 않는다 (주문만 만든다)
`;

const DEFAULT_INTERVAL = 5;
/** 사이즈 조회는 앞단 캐시를 건너뛴다(api.ts) — 촘촘히 보면 그만큼 빨리 안다. 0.5초 = 분당 120회로 데스크톱의 거부선과 같다. */
const MIN_INTERVAL = 0.5;

interface Args {
  ids: string[];
  watch: boolean;
  json: boolean;
  help: boolean;
  interval: number;
  login: boolean;
  whoami: boolean;
  logout: boolean;
  buy: string | null;
  sizes: string[];
  ea: number;
  answer: string;
  dryRun: boolean;
  open: boolean;
  once: boolean;
  maxPrice: number;
  action: "open" | "submit";
  /** --pin 이 주어졌나. undefined 면 그 명령이 아니다. */
  pin: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    ids: [], watch: false, json: false, help: false, interval: DEFAULT_INTERVAL,
    login: false, whoami: false, logout: false, buy: null, sizes: [], ea: 1, answer: "", dryRun: false, open: true,
    once: false, maxPrice: 0, action: "open", pin: undefined,
  };
  const valueOf = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} 뒤에 값이 필요합니다.\n\n${HELP}`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--login": args.login = true; break;
      case "--whoami": args.whoami = true; break;
      case "--logout": args.logout = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--no-open": args.open = false; break;
      case "--once": args.once = true; break;
      case "--max-price": {
        const price = Number(valueOf(i++, arg));
        if (!Number.isFinite(price) || price < 0) throw new Error("--max-price 뒤에 가격(원)을 적어주세요.");
        args.maxPrice = price;
        break;
      }
      case "--buy": {
        const raw = valueOf(i++, arg);
        const id = productIdOf(raw);
        if (!id) throw new Error(`상품번호를 못 찾았습니다: ${raw}`);
        args.buy = id;
        break;
      }
      case "--action": {
        const action = valueOf(i++, arg);
        if (action !== "open" && action !== "submit") throw new Error("--action 은 open 또는 submit 입니다.");
        args.action = action;
        break;
      }
      case "--pin": args.pin = valueOf(i++, arg); break;
      case "--size": args.sizes = valueOf(i++, arg).split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--answer": args.answer = valueOf(i++, arg).trim(); break;
      case "--ea": {
        const ea = Number(valueOf(i++, arg));
        if (!Number.isInteger(ea) || ea < 1) throw new Error("--ea 뒤에 1 이상의 수량을 적어주세요.");
        args.ea = ea;
        break;
      }
      case "--watch": args.watch = true; break;
      case "--json": args.json = true; break;
      case "-h": case "--help": args.help = true; break;
      case "--interval": {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`--interval 뒤에 초를 적어주세요.\n\n${HELP}`);
        args.interval = Math.max(MIN_INTERVAL, value);
        break;
      }
      default: {
        if (arg.startsWith("--")) throw new Error(`모르는 인자입니다: ${arg}\n\n${HELP}`);
        const id = productIdOf(arg);
        if (!id) throw new Error(`상품번호를 못 찾았습니다: ${arg}`);
        if (!args.ids.includes(id)) args.ids.push(id);
      }
    }
  }
  return args;
}

/** "11/12 11:00" — 그 PC 시간이 아니라 언제나 한국 시간으로 적는다. */
function kst(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return `${get("month")}/${get("day")} ${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}`;
}

const stockText = (s: SizeStock): string =>
  !s.inStock ? "품절" : s.stock === null ? "재고 있음" : `${comma(s.stock)}개`;

/** "OS 147개" · "S 품절 / M 3개 / L 12개" */
const sizesText = (sizes: SizeStock[]): string => sizes.map((s) => `${s.name} ${stockText(s)}`).join(" / ") || "사이즈 없음";

const titleOf = (p: Product): string => [p.name || `상품 ${p.id}`, p.color].filter(Boolean).join(" · ");

function show(snap: Snapshot): void {
  const p = snap.product;
  const limits = [
    p.perUser ? `1인 ${p.perUser}개` : "",
    p.membersOnly ? "회원 전용" : "",
    p.appOnly ? "앱 전용" : "",
    p.offlineOnly ? "오프라인 전용" : "",
  ].filter(Boolean).join(" · ");
  const state = notYetOpen(p)
    ? `발매 전 — ${kst(p.availableFrom!)} (한국 시간) 에 열립니다`
    : anyInStock(snap.sizes) ? "판매 중" : "품절";

  UI.banner(titleOf(p), [
    ...(p.koreanName ? [p.koreanName] : []),
    `가격        ${priceText(p.price)}${p.code ? `  (${p.code})` : ""}`,
    `지금        ${state}`,
    ...(limits ? [`조건        ${limits}`] : []),
    "",
    ...snap.sizes.map((s) => `${s.name.padEnd(10)}  ${stockText(s)}`),
    `합계        ${comma(totalStock(snap.sizes))}개`,
    "",
    pageUrl(p.id),
  ]);
}

/**
 * 지켜본다. 상품 정보(이름·가격)는 처음 한 번만 받고, 돌 때마다는 사이즈 재고(161B)만 받는다.
 * 조회가 한 번 끊긴 것으로는 멈추지 않는다 — 번호가 틀린 것(400)만 멈춘다.
 */
async function watch(ids: string[], interval: number): Promise<void> {
  const names = new Map<string, string>();
  const last = new Map<string, SizeStock[]>();

  for (const id of ids) {
    const snap = await fetchSnapshot(id);
    show(snap);
    names.set(id, titleOf(snap.product));
    last.set(id, snap.sizes);
    if (notYetOpen(snap.product)) sayStep(`${titleOf(snap.product)} — 발매 전입니다 (${kst(snap.product.availableFrom!)}). 재고 수량은 그대로 지켜봅니다.`);
  }
  sayOk(`지켜봅니다 — 상품 ${ids.length}개 · ${interval}초마다 · 바뀐 것만 찍습니다 (Ctrl+C 로 멈춤)`);

  const failures = new Map<string, number>();
  for (;;) {
    const note = ids.map((id) => `${names.get(id)}: ${sizesText(last.get(id) ?? [])}`).join("  |  ");
    await wait(interval, note);

    for (const id of ids) {
      let sizes: SizeStock[];
      try {
        sizes = await fetchSizes(id);
        failures.set(id, 0);
      } catch (e) {
        if (!(e instanceof FetchFailed)) throw e;
        // 상품마다 따로 센다 — 한 상품이 되면 다른 상품의 연속 실패가 지워지지 않게.
        const n = (failures.get(id) ?? 0) + 1;
        failures.set(id, n);
        // 한두 번은 조용히 넘긴다. 연달아 끊기면 알린다 (그 뒤로는 열 번에 한 번).
        if (n === 3 || n % 10 === 0) log.warn(`${names.get(id)} — 조회가 ${n}번 연달아 안 됩니다: ${e.message}`);
        continue;
      }

      const before = new Map((last.get(id) ?? []).map((s) => [s.id, s]));
      for (const now of sizes) {
        const was = before.get(now.id);
        const label = `${names.get(id)} [${now.name}]`;
        if (!was) {
          sayStep(`${label} 사이즈가 새로 생겼습니다 — ${stockText(now)}`);
        } else if (!was.inStock && now.inStock) {
          sayStar(`재입고 — ${label} ${stockText(now)}  ${pageUrl(id)}`);
        } else if (was.inStock && !now.inStock) {
          log.warn(`품절 — ${label} (직전 ${stockText(was)})`);
        } else if (was.stock !== now.stock && was.stock !== null && now.stock !== null) {
          const diff = now.stock - was.stock;
          log.info(`${label} ${comma(was.stock)} → ${comma(now.stock)}개 (${diff > 0 ? "+" : ""}${comma(diff)})`);
        }
      }
      last.set(id, sizes);
    }
  }
}

/**
 * 로그인해 토큰을 저장한다. 자동 로그인 정보(환경변수)가 있으면 화면 없이, 없으면 크롬 창에서 사람이 한다.
 * 비밀번호는 여기서 묻지 않는다 — 터미널에 치면 기록에 남는다.
 */
async function cmdLogin(): Promise<void> {
  const creds = credentialsOf();
  let session: Session | null;
  if (creds) {
    sayStep("저장된 이메일로 로그인합니다");
    session = await loginWithPassword(creds.email, creds.password, loadSession()?.deviceId);
  } else {
    sayStar("크롬 창에서 로그인해 주세요 — 로그인하면 창이 닫히고 토큰을 저장합니다 (5분)");
    session = await humanLogin();
    if (!session) throw new NotLoggedIn("시간 안에 로그인하지 않았습니다.");
    saveSession(session);
  }
  const me = await whoami(session);
  if (!me) throw new NotLoggedIn("토큰은 받았지만 회원 정보를 못 읽었습니다 — 다시 로그인해 주세요.");
  sayOk(LINES.loggedIn(me.who));
  sayStep(`토큰을 저장했습니다 — ${SESSION_PATH}`);
}

/** 저장된 로그인이 살아 있나. 끝 코드: 살아 있으면 0, 아니면 1. */
async function cmdWhoami(): Promise<void> {
  const session = loadSession();
  if (!session) throw new NotLoggedIn(LINES.noSession());
  const me = await whoami(session);
  if (!me) throw new NotLoggedIn(LINES.loggedOut());
  sayOk(LINES.loggedIn(me.who) + (me.verified === false ? " (본인 인증 안 됨 — 프리오더 상품은 못 삽니다)" : ""));
}

/**
 * 콘솔용 결제 비밀번호를 설정 파일에 적는다. **태스크는 이 파일을 쓰지 않는다** — 매니저가 프로필의 것을
 * `CARHARTT_PG_PASSWORD` 로 넘긴다 (환경변수가 파일보다 먼저다). 원본을 직접 돌릴 때만 쓴다.
 */
function cmdPin(value: string): void {
  if (value.trim().toLowerCase() === "clear") {
    sayOk(clearPgPassword() ? "결제 비밀번호를 지웠습니다." : "지울 결제 비밀번호가 없습니다.");
    return;
  }
  const digits = value.replace(/\D/g, "");
  if (!/^\d{6}$/.test(digits)) throw new Error("결제 비밀번호는 6자리입니다 — --pin 123456 (지우려면 --pin clear).");
  savePgPassword(digits);
  sayOk(`결제 비밀번호를 저장했습니다 — ${CONFIG_PATH}`);
}

/**
 * 구매에 쓸 로그인. 저장된 것이 살아 있으면 그것, 죽었고 자동 로그인 정보가 있으면 다시 로그인한다.
 * 창을 띄워 사람을 기다리지는 않는다 — 발매 시각을 앞두고 여기서 멈춰 있으면 안 된다. 미리 --login 을 해 둔다.
 */
async function sessionForBuy(): Promise<Session> {
  const saved = loadSession();
  if (saved && (await whoami(saved))) return saved;
  const creds = credentialsOf();
  if (!creds) throw new NotLoggedIn(saved ? LINES.sessionDead("저장된 토큰이 만료됐습니다 — --login 으로 다시 로그인해 주세요") : LINES.noSession());
  log.warn("저장된 로그인이 없거나 풀려 있습니다 — 저장된 이메일로 다시 로그인합니다");
  return loginWithPassword(creds.email, creds.password, saved?.deviceId);
}

async function cmdBuy(args: Args): Promise<void> {
  run.dryRun = args.dryRun;
  // 드라이런은 로그인 없이도 된다 — 눌렀을 자리까지만 가니까. 있으면 살아 있는지 같이 본다.
  let session: Session;
  try {
    session = await sessionForBuy();
  } catch (e) {
    if (!(e instanceof NotLoggedIn) || !args.dryRun) throw e;
    log.warn(`${e.message} (드라이런이라 그대로 갑니다)`);
    session = { accessToken: "", refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER, deviceId: "", email: "", savedAt: "" };
  }
  const result = await buy(session, {
    id: args.buy!, sizes: args.sizes, ea: args.ea, answer: args.answer, open: args.open,
    waitStock: args.watch, intervalSec: args.interval, once: args.once, maxPrice: args.maxPrice,
    action: args.action, pin: pgPasswordOf(),
  });
  if (result.kind === "failed") process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.logout) {
    sayOk(clearSession() ? "저장된 토큰을 지웠습니다." : "지울 토큰이 없습니다.");
    return;
  }
  if (args.pin !== undefined) return cmdPin(args.pin);
  if (args.login) return cmdLogin();
  if (args.whoami) return cmdWhoami();
  if (args.buy) return cmdBuy(args);

  if (!args.ids.length) {
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    const out = await Promise.all(args.ids.map((id) => fetchSnapshot(id)));
    process.stdout.write(`${JSON.stringify(out.map((s) => ({
      ...s.product, url: pageUrl(s.product.id), total: totalStock(s.sizes), sizes: s.sizes,
    })), null, 2)}\n`);
    return;
  }

  if (args.watch) return watch(args.ids, args.interval);

  for (const id of args.ids) show(await fetchSnapshot(id));
}

process.on("SIGINT", () => {
  log.info("멈췄습니다.");
  // 주문에 안 쓴 미리 띄운 크롬은 닫는다 (주문서를 연 창은 사람이 결제해야 하니 남긴다). 오래 붙들지는 않는다.
  void Promise.race([releaseWarmChrome(), new Promise((ok) => setTimeout(ok, 2000))]).finally(() => process.exit(0));
});

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
