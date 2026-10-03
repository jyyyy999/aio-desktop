/**
 * 통합 태스크 러너. bnkr-test 와 lotte-test 를 **한 프로그램에서** 돌린다.
 *
 * 감시 대상은 task_config.json 의 tasks 목록이다. 사이트별 설정(쿠키·결제·브라우저)은
 * 기존 파일(bnkr_test_config.json · lotteon_test_config.json)을 그대로 쓴다.
 *
 *   node dist/task/index.js                    두 사이트를 동시에 지켜본다
 *   node dist/task/index.js list               태스크 표
 *   node dist/task/index.js add --site bnkr gno|URL [--ea N --mode M --max-price N --label L]
 *   node dist/task/index.js add --site lotte URL [--ea N --option O --max-price N --label L]
 *   node dist/task/index.js remove bnkr|SITE 키
 *   node dist/task/index.js pause|resume SITE 키
 *   node dist/task/index.js status [bnkr|lotte]
 *   node dist/task/index.js cookie bnkr|lotte [쿠키]     (값 없으면 클립보드)
 *   node dist/task/index.js pin bnkr|lotte [비밀번호]     (값 없으면 클립보드)
 *   --once          한 바퀴만 돌고 끝낸다
 *   --dry-run       담지 않고 무엇을 담을지만 본다
 */
import { log } from "./log.js";
import { hasCookie, cmdAdd, cmdCookie, cmdList, cmdPause, cmdPin, cmdRemove, cmdResume, cmdStatus, parseSite } from "./commands.js";
import { saveLive, runAll, type RunOpts } from "./watch.js";

const HELP = `통합 태스크 러너 — bnkr-test + lotte-test (한 프로그램, 한 화면)

  (인자 없이)               두 사이트를 동시에 지켜본다
  list                      태스크 표
  add --site bnkr|lotte 상품
    --ea N  --mode ADD|DIRECT|GIFT (bnkr)  --option O (lotte)
    --max-price N  --label 이름
  remove <bnkr|lotte> 키     태스크를 목록에서 뺀다
  pause|resume <bnkr|lotte> 키
  status [bnkr|lotte]       사이트에 직접 물어 지금 재고
  cookie <bnkr|lotte> [쿠키]  값 없으면 클립보드에서 가져온다
  pin <bnkr|lotte> [비밀번호] 값 없으면 클립보드에서 가져온다

  --once       한 바퀴만 돌고 끝낸다
  --dry-run    담지 않고 무엇을 담을지만 본다
`;

interface Args {
  command: string | null;
  rest: string[];
  once: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { command: null, rest: [], once: false, dryRun: false };
  const known = new Set(["list", "add", "remove", "pause", "resume", "status", "cookie", "pin"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (known.has(arg) && out.command === null) {
      out.command = arg;
      continue;
    }
    if (arg === "--once") { out.once = true; continue; }
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") { process.stdout.write(HELP); process.exit(0); }
    out.rest.push(arg);
  }
  return out;
}

/** add 의 옵션 꼴(--ea N 같은)을 풀어 낸다. 값으로 쓴 조각은 뺀 나머지를 돌려준다. */
function addOpts(rest: string[]): { opts: Record<string, string>; product: string } {
  const opts: Record<string, string> = {};
  const left: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 뒤에 값이 필요합니다.`);
      opts[key] = value;
      i += 1;
    } else {
      left.push(arg);
    }
  }
  return { opts, product: left.join(" ") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.command;

  if (cmd === null) {
    // 지켜보기. 쿠키가 하나도 없으면 시작하기 전에 알려 준다.
    const bnkrOk = hasCookie("bnkr");
    const lotteOk = hasCookie("lotte");
    if (!bnkrOk && !lotteOk) {
      log.warn("쿠키가 비어 있습니다. 각 사이트에서 로그인 후 Cookie 줄을 복사해: " +
        "task cookie bnkr / task cookie lotte");
    } else if (!bnkrOk) log.warn("bnkr 쿠키가 비어 있습니다. task cookie bnkr 로 넣어주세요.");
    else if (!lotteOk) log.warn("lotte 쿠키가 비어 있습니다. task cookie lotte 로 넣어주세요.");

    const opts: RunOpts = { once: args.once, dryRun: args.dryRun };
    const ok = await runAll(opts);
    if (!ok) process.exit(1);
    return;
  }

  if (cmd === "list") { cmdList(); return; }

  if (cmd === "add") {
    const { opts, product } = addOpts(args.rest);
    const site = opts["site"];
    if (!site) throw new Error("add 에는 --site bnkr|lotte 가 필요합니다.\n\n" + HELP);
    cmdAdd({
      site,
      product,
      ea: opts["ea"] ? Number(opts["ea"]) : undefined,
      mode: opts["mode"],
      option: opts["option"],
      max_price: opts["max-price"] ? Number(opts["max-price"]) : undefined,
      label: opts["label"],
    });
    return;
  }

  if (cmd === "remove" || cmd === "pause" || cmd === "resume") {
    const site = parseSite(args.rest[0] ?? "");
    const key = args.rest[1];
    if (!key) throw new Error(`${cmd} 에는 키가 필요합니다: ${cmd} <site> <키>`);
    if (cmd === "remove") cmdRemove(site, key);
    else if (cmd === "pause") cmdPause(site, key);
    else cmdResume(site, key);
    return;
  }

  if (cmd === "status") {
    const site = args.rest[0] ? parseSite(args.rest[0]) : undefined;
    await cmdStatus(site);
    return;
  }

  if (cmd === "cookie") {
    const site = parseSite(args.rest[0] ?? "");
    await cmdCookie(site, args.rest[1] ?? "");
    return;
  }

  if (cmd === "pin") {
    const site = parseSite(args.rest[0] ?? "");
    cmdPin(site, args.rest[1] ?? "");
    return;
  }

  throw new Error(`모르는 명령입니다: ${cmd}\n\n${HELP}`);
}

process.on("SIGINT", () => {
  log.info("멈춥니다.");
  saveLive();
  process.exit(0);
});

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
