/**
 * Waitwhile 등록 감시 — Node.js/TypeScript 판.
 *
 *   공개 API 조회(분 단위) → 등록 창구가 열리는 순간 감지 → 디스코드 알림 → [사람] 등록
 *
 * 슈프림 성수(waitwhile.com/locations/supremeseongsu)처럼 **드롭 날에만 잠깐 열리는
 * 대기열·예약 창구**를 놓치지 않으려고 만든 것이다. 사지도, 넣지도 않는다 — 열렸다는
 * 것만 알려 준다. 줄에 이름을 넣는 것은 사람이 한다.
 *
 * 로그인도 쿠키도 없다. 공개 API 한 곳만 두드린다.
 *
 *   node dist/waitwhile/index.js               지켜본다
 *   node dist/waitwhile/index.js --once        한 번만 확인하고 종료
 *   node dist/waitwhile/index.js --status      지금 상태만 자세히
 *   node dist/waitwhile/index.js --add URL     감시할 곳을 넣는다
 *   node dist/waitwhile/index.js --test        알림이 실제로 가는지 한 번 보내 본다
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { log, sayOk, sayStep } from "../log.js";
import { UI } from "../ui.js";
import {
  CONFIG_PATH, DUMP_PATH, loadConfig, loadState, Quit, run, saveConfig, saveState,
  STATE_PATH, webhookOf, type Config, type State,
} from "./config.js";
import {
  fetchRaw, fetchSnapshot, hoursText, pageUrl, slugOf, toSnapshot,
} from "./api.js";
import { notifyOpen, summary, untilText } from "./notify.js";
import { placesOf, watch } from "./watch.js";

const HELP = `Waitwhile 등록 감시 — 창구가 열리면 디스코드로 알립니다

  --once              한 번만 확인하고 종료
  --fast              시간표와 상관없이 줄곧 좁혀 본다 (드롭 날에 켜는 것)
  --status            감시 대상의 지금 상태를 자세히 보여준다 (알림은 안 보냄)
  --dump [슬러그]      받아 온 JSON 통째로 waitwhile-dump.json 에 남긴다
  --add 주소 …         감시할 곳을 넣는다 (주소든 슬러그든)
  --webhook [URL]     디스코드 웹훅을 저장한다 (값 없이 부르면 지운다)
  --test              지금 상태로 "열림" 알림을 한 번 보내 본다
  --reset             지난번에 본 상태 기록을 지운다
  --dry-run           보내지 않고 무엇을 보낼지만 화면에 찍는다
`;

interface Args {
  once: boolean;
  fast: boolean;
  status: boolean;
  test: boolean;
  reset: boolean;
  dryRun: boolean;
  help: boolean;
  add: string[] | null;
  dump: string | null;
  webhook: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: false, fast: false, status: false, test: false, reset: false, dryRun: false, help: false,
    add: null, dump: null, webhook: null,
  };

  const isFlag = (v: string | undefined) => v !== undefined && v.startsWith("--");
  // 값을 안 줘도 되는 자리. 뒤에 오는 것이 옵션이면 값이 없는 것이다.
  const maybe = (i: number, blank: string): [string, number] =>
    isFlag(argv[i + 1]) || argv[i + 1] === undefined ? [blank, i] : [argv[i + 1]!, i + 1];
  // 여러 개를 받는 자리. 다음 옵션이 나올 때까지가 그 옵션의 값이다.
  const rest = (i: number, flag: string): [string[], number] => {
    const out: string[] = [];
    let at = i + 1;
    while (at < argv.length && !isFlag(argv[at])) out.push(argv[at++]!);
    if (!out.length) throw new Error(`${flag} 뒤에 값이 필요합니다.\n\n${HELP}`);
    return [out, at - 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--once": args.once = true; break;
      case "--fast": args.fast = true; break;
      case "--status": args.status = true; break;
      case "--test": args.test = true; break;
      case "--reset": args.reset = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "-h": case "--help": args.help = true; break;
      case "--add": [args.add, i] = rest(i, arg); break;
      case "--dump": [args.dump, i] = maybe(i, ""); break;
      case "--webhook": [args.webhook, i] = maybe(i, ""); break;
      default:
        throw new Error(`모르는 인자입니다: ${arg}\n\n${HELP}`);
    }
  }
  return args;
}

/**
 * 감시할 곳을 넣는다. **넣기 전에 한 번 두드려 본다.**
 *
 * 오타를 여기서 안 잡으면 설정에 조용히 들어앉았다가, 며칠 뒤 감시를 켰을 때에야
 * 404 로 튀어나온다. 그때는 이미 놓친 뒤일 수 있다.
 */
async function cmdAdd(cfg: Config, values: string[]): Promise<void> {
  const before = placesOf(cfg).map((p) => p.slug);
  let added = 0;
  for (const value of values) {
    const slug = slugOf(value);
    if (!slug) {
      log.warn(`무엇을 넣어야 할지 모르겠습니다: ${value}`);
      continue;
    }
    if (before.includes(slug)) {
      sayStep(`이미 보고 있습니다: ${slug}`);
      continue;
    }
    let name = slug;
    try {
      name = (await fetchSnapshot(slug)).name;
    } catch (e) {
      log.error(`${slug}: ${(e as Error).message}`);
      continue;
    }
    before.push(slug);
    cfg.places = [...(cfg.places ?? []), slug];
    added += 1;
    sayOk(`넣었습니다: ${name} (${slug})  ${pageUrl(slug)}`);
  }
  if (added) saveConfig(cfg);
}

function cmdWebhook(cfg: Config, value: string): void {
  cfg.discord_webhook_url = value.trim();
  saveConfig(cfg);
  if (!cfg.discord_webhook_url) {
    sayOk("웹훅을 지웠습니다. bnkr 쪽 것을 빌려 씁니다.");
    return;
  }
  sayOk(`웹훅을 저장했습니다 (${cfg.discord_webhook_url.slice(0, 40)}…).`);
  sayStep("--test 로 실제로 가는지 확인해 보세요.");
}

async function cmdDump(cfg: Config, value: string): Promise<void> {
  const slug = slugOf(value) || placesOf(cfg)[0]?.slug;
  if (!slug) throw new Error("무엇을 받아 올지 정해주세요: --dump <주소>");
  const raw = await fetchRaw(slug);
  writeFileSync(DUMP_PATH, JSON.stringify(raw, null, 2), "utf-8");
  sayOk(`${slug} 의 원본을 ${DUMP_PATH} 에 적었습니다 (${Object.keys(raw).length}칸).`);
  const snap = toSnapshot(slug, raw);
  sayStep(`${snap.name} · ${summary(snap)} · ${untilText(snap)}`);
}

/** 지금 상태를 자세히. 알림은 보내지 않는다 — 사람이 보려고 부르는 것이다. */
async function cmdStatus(cfg: Config): Promise<void> {
  const places = placesOf(cfg);
  if (!places.length) throw new Error("감시할 곳이 없습니다. --add 로 넣어주세요.");

  for (const place of places) {
    const snap = await fetchSnapshot(place.slug);
    const mark = (ok: boolean) => (ok ? "가능" : "불가");
    UI.banner(`${snap.name}  (${snap.slug})`, [
      `지금        ${summary(snap)}`,
      `대기열      ${mark(snap.waitlistJoinable)}` +
      (snap.waitlistFull ? " · 꽉 참" : "") +
      (snap.numWaiting ? ` · 대기 ${snap.numWaiting}팀` : ""),
      `예약        ${mark(snap.bookingJoinable)}`,
      `가게        ${snap.storeOpen ? "영업 중" : "영업 종료"}` +
      (snap.forceClosed ? " · 강제 마감" : "") + (snap.forceOpen ? " · 강제 개방" : ""),
      `다음 예정    ${untilText(snap)}  (${snap.timezone})`,
      "",
      `영업        ${hoursText(snap.hours, snap.hoursByDate)}`,
      `대기열      ${snap.waitlistHours
        ? hoursText(snap.waitlistHours, snap.waitlistHoursByDate) : "영업시간과 같음"}`,
      `예약        ${hoursText(snap.bookingHours, snap.bookingHoursByDate)}`,
      "",
      pageUrl(snap.slug),
    ]);
  }

  const hook = webhookOf(cfg);
  sayStep(hook ? `웹훅 준비됨 (${hook.slice(0, 45)}…)` : "웹훅이 없습니다 — --webhook 으로 넣어주세요.");
}

/** 알림이 실제로 가는지 본다. 지금 상태를 "열림" 모양으로 한 번 보낸다. */
async function cmdTest(cfg: Config): Promise<void> {
  const place = placesOf(cfg)[0];
  if (!place) throw new Error("감시할 곳이 없습니다. --add 로 넣어주세요.");
  const snap = await fetchSnapshot(place.slug);
  // 설정에서 open 을 꺼 뒀어도 시험은 가야 한다. 시험이 조용하면 시험이 아니다.
  const asked = cfg.discord_notify ?? [];
  cfg.discord_notify = [...new Set([...asked, "open"])];
  const sent = await notifyOpen(cfg, snap, true);
  cfg.discord_notify = asked;
  if (sent) sayOk(`보냈습니다. 지금 상태는 "${summary(snap)}" 입니다.`);
  else throw new Error("보내지 못했습니다. 웹훅 주소를 확인해 주세요.");
}

/**
 * 지켜보는 중인 상태. Ctrl+C 로 끊길 때 적어 두려고 붙잡아 둔다.
 * 기록을 잃으면 다음 실행에서 "처음 보는 곳" 이 되어 기준선부터 다시 잡는다.
 */
let live: State | null = null;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  run.dryRun = args.dryRun;
  const cfg = loadConfig();

  if (args.webhook !== null) return cmdWebhook(cfg, args.webhook);
  if (args.add) return cmdAdd(cfg, args.add);
  if (args.dump !== null) return cmdDump(cfg, args.dump);

  if (args.reset) {
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    sayOk("기록을 지웠습니다. 다음 실행이 기준선을 새로 잡습니다.");
    return;
  }

  if (args.status) return cmdStatus(cfg);
  if (args.test) return cmdTest(cfg);

  if (!webhookOf(cfg)) {
    log.warn(`웹훅이 없습니다. ${CONFIG_PATH} 의 discord_webhook_url 을 채우거나 --webhook 으로 넣어주세요.`);
  }

  const state = loadState();
  live = state;
  try {
    await watch(cfg, state, args.once, args.fast);
  } finally {
    saveState(state);
  }
}

process.on("SIGINT", () => {
  log.info("멈췄습니다.");
  if (live) {
    try {
      saveState(live);
    } catch {
      // 못 적어도 여기서 더 할 수 있는 것이 없다.
    }
  }
  process.exit(0);
});

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (e instanceof Quit) process.exit(1);
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
