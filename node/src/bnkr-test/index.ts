/**
 * 반다이남코코리아몰(bnkrmall.co.kr) 담기 도우미 — **네이버페이 테스트 판.**
 *
 * 본판(src/)을 통째로 베낀 것이다. 다른 것은 둘뿐이다.
 *
 *   1. 결제창에서 네이버페이로 간다 (본판은 카카오페이 카톡결제)
 *   2. 설정·상태·로그·덤프를 bnkr_test_* 로 따로 쓴다 (쿠키만 본판 것을 빌려 온다)
 *
 * 결제창은 아무 때나 띄워 볼 수 있는 화면이 아니라, 수단을 바꿔 시험하려면 설정을
 * 고쳐 가며 본판을 돌리는 수밖에 없었다. 그러다 보면 본판이 카카오페이로 되어 있는지
 * 네이버페이로 되어 있는지가 헷갈리고, 정작 재고가 열린 날 엉뚱한 창이 뜬다.
 * 시험은 여기서 하고, 본판은 건드리지 않는다.
 *
 * bnkr_buy.py 가 하던 일을 그대로 한다. 지정한 상품이 품절 → 구매 가능으로 바뀌는
 * 순간 장바구니에 담고, 주문서를 열고, 결제창까지 띄워 그 화면을 폰으로 보낸다.
 *
 *   감시(초 단위) → 구매 가능 감지 → 장바구니 담기 → 디스코드 알림 + 주문서 열기 → [사람] 결제
 *
 * **결제 확정 버튼은 사람이 누른다.** 로그인도 자동화하지 않는다(reCAPTCHA v3).
 * 브라우저에서 직접 로그인한 세션 쿠키를 빌려 쓴다.
 *
 * 설정·상태·로그는 파이썬 판이 쓰던 파일을 그대로 쓴다. 쿠키를 두 벌 관리하지 않는다 —
 * 어느 쪽으로 넣었든 다른 쪽에서도 그대로 쓰인다.
 *
 * 봇 차단을 우회하거나, 캡차를 풀거나, 계정을 여러 개 굴리지 않는다.
 *
 *   node dist/bnkr-test/index.js                 지켜보다가 열리면 담는다
 *   node dist/bnkr-test/index.js --cookie        클립보드의 Cookie 줄을 설정에 저장
 *   node dist/bnkr-test/index.js --whoami        세션이 살아 있는지
 *   node dist/bnkr-test/index.js --find 하이큐    이름으로 gno 찾기 (로그인 불필요)
 *   node dist/bnkr-test/index.js task list       태스크(감시 대상) 목록과 상태
 *   node dist/bnkr-test/index.js task add gno    태스크 추가
 *   node dist/bnkr-test/index.js task pause gno  그 태스크만 감시에서 뺀다 (설정은 남는다)
 */
import { existsSync, unlinkSync } from "node:fs";
import {
  cookieOf, loadConfig, loadState, run, saveConfig, STATE_PATH, type Config, type Mode,
} from "./config.js";
import { newSession, parseCookie, Session } from "./http.js";
import { log } from "./log.js";
import {
  cmdAdd, cmdCartList, cmdFind, cmdNow, cmdStatus, cmdTaskAdd, cmdTaskList, cmdTaskPause,
  cmdTaskRemove, cmdTaskResume, cmdTaskStatus, cmdWhoami, clipboardText, cookieFromClipboard,
} from "./commands.js";
import { openLanding } from "./landing.js";
import { LANDING, parseGno } from "./site.js";
import { watch } from "./watch.js";

const HELP = `반다이남코코리아몰 재고가 열리면 장바구니에 담아 주는 도우미 (네이버페이 테스트 판)

  결제창에서 네이버페이로 갑니다. 설정·상태·로그는 bnkr_test_* 를 씁니다.
  본판은 그대로입니다 — node dist/index.js

  --once                한 번만 확인하고 종료
  --dry-run             담지 않고 무엇을 담을지만 본다
  --status              대상 상품의 현재 재고만 확인
  --cart-list           지금 장바구니에 무엇이 있는지
  --whoami              세션이 살아 있는지 확인
  --reset               담은 기록을 지운다
  --add gno|URL …       담을 상품을 설정에 추가
  --find 말 …            상품 이름으로 목록을 훑어 gno 를 찾는다 (로그인 불필요)
  --cart gno            지금 바로 장바구니에 담는다
  --buy gno             지금 바로 담고 주문서를 연다
  --ea N                --cart / --buy 의 수량 (기본 1)
  --open [ADD|DIRECT|GIFT]
                        담지 않고 지금 세션으로 주문서만 열어 본다 (기본 DIRECT)
  --action open|agree|submit
                        주문서에서 어디까지 누를지. 설정의 order_action 을 이번만 덮는다
  --cookie [쿠키]        세션 쿠키를 설정에 저장한다. 값 없이 쓰면 클립보드에서 가져온다
                        (파워셸 따옴표 문제를 피하는 길). - 는 표준입력
  --pin [비밀번호]       간편결제 비밀번호를 설정에 저장한다. 값 없이 쓰면 클립보드에서
                        가져온다. 파일에 평문으로 남으므로, 싫으면 BNKR_PG_PASSWORD
                        환경변수로 넘긴다. 값은 로그에 남기지 않는다

tasks (watch list) — no login needed except for status:
  task list                     list tasks and their state
  task add <gno|URL> [opts]     add a task
    --ea N --mode ADD|DIRECT|GIFT --max-price N --label NAME
  task remove <gno>             drop a task
  task pause <gno>              take it out of the watch (config + history kept)
  task resume <gno>             put it back
  task status [gno]             ask the site for live stock (all tasks if omitted)
`;

interface Args {
  once: boolean;
  dryRun: boolean;
  status: boolean;
  cartList: boolean;
  whoami: boolean;
  reset: boolean;
  help: boolean;
  add: string[] | null;
  find: string[] | null;
  cart: string | null;
  buy: string | null;
  ea: number;
  open: string | null;
  action: string | null;
  cookie: string | null;
  pin: string | null;
}

/**
 * 손으로 짠 인자 파서.
 *
 * argparse 의 nargs="+" 와 "값 없이 써도 되는 옵션"(--cookie·--open) 이 둘 다 필요한데,
 * Node 의 parseArgs 는 어느 쪽도 못 한다. 파이썬 판과 같은 말이 통해야 하므로 여기서 센다.
 */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: false, dryRun: false, status: false, cartList: false, whoami: false, reset: false,
    help: false, add: null, find: null, cart: null, buy: null, ea: 1, open: null,
    action: null, cookie: null, pin: null,
  };

  const isFlag = (v: string | undefined) => v !== undefined && v.startsWith("--");
  // nargs="+" 자리. 다음 옵션이 나올 때까지가 그 옵션의 값이다.
  const rest = (i: number, flag: string): [string[], number] => {
    const out: string[] = [];
    let at = i + 1;
    while (at < argv.length && !isFlag(argv[at])) out.push(argv[at++]!);
    if (!out.length) throw new Error(`${flag} 뒤에 값이 필요합니다.

${HELP}`);
    return [out, at - 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--once": args.once = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--status": args.status = true; break;
      case "--cart-list": args.cartList = true; break;
      case "--whoami": args.whoami = true; break;
      case "--reset": args.reset = true; break;
      case "-h": case "--help": args.help = true; break;
      case "--add": [args.add, i] = rest(i, arg); break;
      case "--find": [args.find, i] = rest(i, arg); break;
      case "--cart": args.cart = argv[++i] ?? null; break;
      case "--buy": args.buy = argv[++i] ?? null; break;
      case "--ea": args.ea = Number(argv[++i] ?? 1); break;
      case "--action": args.action = argv[++i] ?? null; break;
      // 값 없이 써도 되는 둘. 뒤에 오는 것이 옵션이면 값이 없는 것이다.
      case "--open": args.open = isFlag(argv[i + 1]) || argv[i + 1] === undefined ? "DIRECT" : argv[++i]!; break;
      case "--cookie": args.cookie = isFlag(argv[i + 1]) || argv[i + 1] === undefined ? "" : argv[++i]!; break;
      case "--pin": args.pin = isFlag(argv[i + 1]) || argv[i + 1] === undefined ? "" : argv[++i]!; break;
      default:
        // 쿠키 줄을 명령줄에 붙여넣으면 셸이 그것을 여러 조각으로 쪼개 던진다. 조각에는
        // 늘 "=" 가 들어 있으므로, 그것만으로 무슨 일이 났는지 짚어 줄 수 있다.
        if (arg.includes("=")) {
          throw new Error(
            `쿠키를 명령줄에 붙여넣은 것 같습니다 (셸이 ${JSON.stringify(arg.slice(0, 30))} … 로 쪼갰습니다).\n` +
            "Cookie 줄을 복사한 뒤 값 없이 부르세요:  npm run cookie",
          );
        }
        throw new Error(`모르는 인자입니다: ${arg}\n\n${HELP}`);
    }
  }
  return args;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

/** 쿠키를 설정에 저장한다. 이름을 골라 담을 필요는 없다 — 브라우저가 보내는 줄 그대로다. */
async function saveCookie(cfg: Config, value: string): Promise<void> {
  let raw: string;
  if (value === "") {
    raw = cookieFromClipboard();
    log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
  } else if (value === "-") {
    raw = await readStdin();
  } else {
    raw = value;
  }

  const jar = parseCookie(raw);
  const names = Object.keys(jar);
  if (!names.length) {
    throw new Error("쿠키를 알아보지 못했습니다. F12 → Network → 아무 요청 → " +
      "Request Headers 의 Cookie 줄을 통째로 복사해 주세요.");
  }

  cfg.cookie = raw.trim();
  saveConfig(cfg);
  log.info(`쿠키 ${names.length}개를 저장했습니다: ${names.join(", ")}`);

  // 이름만 세어 봐야 소용없다. 신분을 지는 둘이 있어야 담을 수 있다.
  const missing = ["MEMBER_TOKEN", "ASI"].filter((name) => !(name in jar));
  if (missing.length) {
    log.warn(`${missing.join(", ")} 이(가) 없습니다. 로그인한 상태에서 복사한 게 맞는지 봐주세요.`);
  } else {
    log.info("--whoami 로 확인해 보세요.");
  }
}

/**
 * 간편결제 비밀번호를 설정에 저장한다. 값 없이 부르면 클립보드에서 가져온다.
 *
 * 파일(bnkr_test_config.json)에 평문으로 남으므로, 그것이 싫으면 환경변수
 * BNKR_PG_PASSWORD 로 넘기면 된다. **값 자체는 로그에 적지 않는다** — 자릿수만 남긴다.
 */
async function savePin(cfg: Config, value: string): Promise<void> {
  let raw = value;
  if (value === "") {
    raw = clipboardText();
    log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) {
    throw new Error("비밀번호를 알아보지 못했습니다. 숫자만 입력해 주세요. " +
      "값 없이 부르면 클립보드에서 가져옵니다.");
  }
  cfg.pg_password = digits;
  saveConfig(cfg);
  log.info(`간편결제 비밀번호를 저장했습니다 (${digits.length}자리).`);
}

/**
 * `task <action> …` 하위 명령. 목록·추가·빼기·켜고끄기는 로그인 없이 파일만 고친다.
 * status 만 사이트에 물어보므로(재고 조회는 공개 ajax), 로그인이 없어도 된다.
 */
async function runTask(argv: string[]): Promise<void> {
  const action = argv[0];
  const rest = argv.slice(1);
  const cfg = loadConfig();

  if (action === "list") {
    cmdTaskList(cfg, loadState());
    return;
  }
  if (action === "add") {
    const value = rest[0];
    if (!value) throw new Error("task add needs a gno or URL.");
    const opts: { ea?: number; mode?: string; max_price?: number; label?: string } = {};
    for (let i = 1; i < rest.length; i++) {
      switch (rest[i]) {
        case "--ea": opts.ea = Number(rest[++i]); break;
        case "--mode": opts.mode = rest[++i]; break;
        case "--max-price": opts.max_price = Number(rest[++i]); break;
        case "--label": opts.label = rest[++i]; break;
        default: throw new Error(`unknown option for task add: ${rest[i]}`);
      }
    }
    cmdTaskAdd(cfg, value, opts);
    return;
  }
  if (action === "remove") {
    const gno = rest[0];
    if (!gno) throw new Error("task remove needs a gno.");
    cmdTaskRemove(cfg, parseGno(gno) ?? gno);
    return;
  }
  if (action === "pause" || action === "resume") {
    const gno = rest[0];
    if (!gno) throw new Error(`task ${action} needs a gno.`);
    (action === "pause" ? cmdTaskPause : cmdTaskResume)(cfg, parseGno(gno) ?? gno);
    return;
  }
  if (action === "status") {
    const gno = rest[0] ? (parseGno(rest[0]) ?? rest[0]) : undefined;
    const session = await newSession(cookieOf(cfg), {
      queueWatch: cfg.queue_watch, queueMarkers: cfg.queue_markers,
    });
    await cmdTaskStatus(cfg, session, gno);
    return;
  }
  throw new Error(`unknown task command: ${action ?? "(none)"}\n\n${HELP}`);
}

async function main(): Promise<void> {
  if (process.argv[2] === "task") {
    await runTask(process.argv.slice(3));
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  run.dryRun = args.dryRun;
  const cfg = loadConfig();
  if (args.action) {
    if (!["open", "agree", "submit"].includes(args.action)) {
      throw new Error(`--action 은 open / agree / submit 중 하나입니다: ${args.action}`);
    }
    cfg.order_action = args.action as Config["order_action"];
  }

  if (args.cookie !== null) {
    await saveCookie(cfg, args.cookie);
    return;
  }

  if (args.pin !== null) {
    await savePin(cfg, args.pin);
    return;
  }

  if (args.add) {
    cmdAdd(cfg, args.add);
    return;
  }

  if (args.reset) {
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    log.info("담은 기록을 지웠습니다.");
    return;
  }

  // 재고만 볼 때는 로그인이 필요 없다.
  const cookie = cookieOf(cfg);
  const needsLogin = !(args.status || args.find || run.dryRun);
  if (needsLogin && !cookie) {
    throw new Error(
      "세션 쿠키가 없습니다.\n" +
      "  1) 크롬에서 bnkrmall.co.kr 에 로그인\n" +
      "  2) F12 → Network → 아무 요청 → Request Headers 의 Cookie 줄을 통째로 복사\n" +
      "  3) node dist/bnkr-test/index.js --cookie\n" +
      "     (값 없이 부르면 클립보드에서 가져간다)",
    );
  }

  if (run.dryRun && !cookie) log.info("[dry-run] 쿠키 없이 재고만 보고 무엇을 담을지 보여줍니다.");
  if (run.dryRun) log.info("[dry-run] 실제로 담지 않습니다.");

  const session: Session = await newSession(cookie, {
    queueWatch: cfg.queue_watch, queueMarkers: cfg.queue_markers,
  });
  const state = loadState();

  if (args.open) {
    const mode = args.open.trim().toUpperCase();
    if (!(mode in LANDING)) {
      throw new Error(`--open 은 ${Object.keys(LANDING).join(" / ")} 중 하나입니다: ${args.open}`);
    }
    await cmdWhoami(session);
    // 직접 부른 명령이다. open_browser: false 여도 이때만은 연다.
    await openLanding({ ...cfg, open_browser: true }, mode as Mode, session);
    return;
  }

  if (args.whoami) return cmdWhoami(session);
  if (args.cartList) return cmdCartList(session);
  if (args.find) return cmdFind(session, args.find);
  if (args.status) return cmdStatus(cfg, session);

  if (args.cart || args.buy) {
    const gno = parseGno(args.cart || args.buy);
    if (!gno) throw new Error(`상품 번호를 알아볼 수 없습니다: ${args.cart || args.buy}`);
    await cmdNow(cfg, session, state, gno, args.cart ? "ADD" : "DIRECT", Math.max(1, args.ea));
    return;
  }

  await watch(cfg, session, state, args.once || run.dryRun, run.dryRun);
}

process.on("SIGINT", () => {
  log.info("종료합니다.");
  process.exit(0);
});

main()
  .then(() => {
    // 크롬은 남긴다(detach). 여기서 그냥 끝내면 크롬드라이버가 붙들고 있어 안 꺼진다.
    process.exit(0);
  })
  .catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    log.error(message);
    process.exit(1);
  });
