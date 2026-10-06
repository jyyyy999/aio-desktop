/**
 * main · worker · preload · renderer 가 같이 쓰는 모양들. **타입만** 둔다 — preload 는 sandbox 라
 * electron 말고는 못 들인다. 값(사이트 이름·주소 모양·어디까지 갈 수 있나)은 sites.ts 에 있다.
 */

/**
 * 어느 원본으로 돌리나. main 과 화면이 사이트 사이의 차이에 대해 아는 것은 이것뿐이다 —
 * 원본을 어떻게 띄우는지는 main/sites/ 의 어댑터가 안다.
 */
export type SiteId = "lotte" | "naver";

/**
 * 태스크를 무엇으로 돌릴지. 원본의 명령줄 옵션에 하나씩 대응한다 (어댑터가 옮긴다).
 * drop 은 롯데만 있다 — 지켜보기 + 원본 --drop (빠른 걸음). 사이트마다 고를 수 있는 것은 sites.ts 의 modes.
 */
export type TaskMode = "watch" | "once" | "buy" | "dry-run" | "status" | "drop";

/**
 * 드랍 모드의 설정. 원본 --drop 은 걸음만 바꾸는 플래그라 드랍 시각이 없다 — 시각은 매니저가 재서
 * 그만큼 먼저 태스크를 띄운다 (예약).
 */
export interface DropSettings {
  /** 드랍 시각 "HH:mm:ss" (이 PC 시계). 비우면 ▶ 를 누를 때 바로 드랍 모드로 띄운다. */
  dropTime: string;
  /** 드랍 몇 분 전에 띄울지. 로그인 확인·크롬 준비가 앞에 있어 0 보다는 두는 것이 낫다. */
  preCheckMinutes: number;
  /** 드랍 확인 간격(ms) → 원본 drop_interval_seconds. null 이면 씨앗 설정. 원본이 0.5초 밑으로는 안 내린다. */
  intervalMs: number | null;
}

/**
 * 원본의 --action. 빈 문자열이면 설정(order_action)을 따른다.
 * 사이트마다 고를 수 있는 것이 다르다 — 네이버에는 agree 가 없다 (sites.ts).
 */
export type OrderAction = "" | "open" | "agree" | "submit";

export interface TaskDef {
  id: string;
  site: SiteId;
  /**
   * 어느 로그인 프로필로 돌리나 (Profile.id). 없으면 로그인 없이 돈다 — 원본이 공개 페이지로 보는
   * 모드(sites.ts 의 loginOptional)만 된다.
   */
  profileId?: string;
  label: string;
  /** 상품 주소 (롯데온은 상품번호도 된다). */
  url: string;
  option: string;
  ea: number;
  max_price: number;
  mode: TaskMode;
  action: OrderAction;

  // ── 간격 · 재시도 ─────────────────────────────────────────────────────
  // null 이면 씨앗 설정을 따른다. 값은 어댑터가 원본이 받는 설정 칸으로 옮겨 적는다 —
  // 원본에 그런 칸이 없는 것(페이지 로드 뒤 대기·동작 사이 대기)은 여기 없다.

  /** 재고를 몇 ms 마다 볼지. 반복해서 보는 모드(지켜보기·드라이런)에서만 쓴다. */
  checkIntervalMs: number | null;
  /** 실패하면 몇 번 더 해 볼지. 롯데는 재고 조회·구매 시도, 네이버는 구매 시도에 걸린다. */
  maxRetries: number | null;
  retryDelayMs: number | null;
  /** 반복해서 보는 모드를 이만큼 하고 멈춘다. 0 이면 끝없이. 원본에 없는 것이라 매니저가 잰다. */
  monitorDurationMs: number;
  /**
   * 사면 멈추나. true = 1개 사면 태스크가 끝난다. false = 다음 재입고에도 또 산다 (한 번 돌 때
   * 최대 maxBuys 번). null = 씨앗 설정.
   */
  stopOnSuccess: boolean | null;
  maxBuys: number;
  /** 드랍 모드(롯데)에서만 쓴다. */
  dropSettings: DropSettings;
}

/** 간격·재시도를 비워 두면 따르는 값 (씨앗 설정을 원본과 같은 규칙으로 읽은 것)과 원본의 한계. */
export interface TimingDefaults {
  checkIntervalMs: number;
  /** 이보다 촘촘하게는 원본이 안 본다 — 롯데는 올려서 보고(min_interval_seconds), 네이버는 거부한다(요청률). */
  minIntervalMs: number;
  /** 초 단위로만 받나 (네이버 check_interval_seconds 는 정수). */
  wholeSeconds: boolean;
  maxRetries: number;
  retryDelayMs: number;
  stopOnSuccess: boolean;
  maxBuys: number;
  /** 재시도가 어디에 걸리나. */
  retryScope: string;
  /** 태스크 하나의 분당 요청이 이보다 많으면 경고한다 (네이버 원본의 권장선). 없으면 null. */
  rateWarnPerMin: number | null;
  /** 드랍 모드의 확인 간격 (씨앗 drop_interval_seconds)과 원본의 바닥. 드랍 모드가 없는 사이트는 null. */
  drop: { intervalMs: number; minIntervalMs: number } | null;
}

export type TaskStatus =
  | "idle"      // 한 번도 안 돌렸다
  | "scheduled" // 드랍 시각을 기다린다 (아직 프로세스가 없다)
  | "starting"  // fork 했고 워커가 아직 원본을 못 들였다
  | "running"
  | "stopping"  // STOP 을 보냈다
  | "done"      // 원본이 exit(0) 을 청했다
  | "failed"    // 원본이 exit(≠0) 을 청했다
  | "stopped"   // 사람이 멈췄다
  | "crashed";  // exit 청 없이 죽었다 (브라우저·노드가 터진 것)

/**
 * 도는 태스크가 어디쯤인가. 원본 출력으로 알아본다 (어댑터의 progress).
 *   watching  확인하며 기다린다
 *   buying    구매를 시작했다 (주문서로 가는 중)
 *   checkout  주문서·결제창이 열렸다 — 창에서 사람(또는 원본의 비밀번호 입력)이 이어 간다
 *   paid      결제 완료를 봤다
 */
export type TaskPhase = "watching" | "buying" | "checkout" | "paid";

/** 사이트 대기열에 서 있는 동안의 상태. eta 는 at 시각에 원본이 말한 남은 초다. */
export interface QueueState {
  ahead: number;
  total: number | null;
  eta: number | null;
  at: number;
}

export interface TaskRuntime {
  id: string;
  status: TaskStatus;
  pid: number | null;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  /** 마지막으로 찍힌 줄. 표에 한 줄로 보인다. */
  lastLine: string;
  /** 원본이 제자리에서 고쳐 쓰는 줄 (롯데: "품절 · 다음 확인 3초"). 로그에는 안 쌓인다. 없으면 "". */
  note: string;
  /** 이번 실행에서 원본이 몇 번 확인했나. 원본은 세어 찍지 않아서 출력으로 센다. */
  rounds: number;
  lastCheckAt: number | null;
  /** 도는 동안 어디쯤인가. 아직 모르면(막 띄웠다·끝났다) null. */
  phase: TaskPhase | null;
  /** 대기열에 서 있으면 그 상태. 서 있지 않으면 null. */
  queue: QueueState | null;
  /**
   * 돌던 중에 설정이 바뀌어 다시 시작하려고 기다리는 중인가. 구매 중이거나 구매 창이 열려
   * 있으면 그게 끝날 때까지 미룬다 — 그동안은 바뀌기 전 설정으로 돈다.
   */
  restartPending: boolean;
  /** 예약: 이때 띄운다 / 이때가 드랍이다 (ms). 예약이 아니면 null. */
  scheduledFor: number | null;
  dropAt: number | null;
}

// ── 계정 ──────────────────────────────────────────────────────────────────

export type LoginStatus = "logged_out" | "logging_in" | "logged_in" | "expired" | "error";

/**
 * 로그인 프로필. 사이트마다 여럿 둘 수 있고, 태스크가 하나를 고른다.
 *
 * 로그인 정보(쿠키·세션) 자체는 프로필 폴더(profiles/<id>/)의 파일에 있다 — 롯데 lotte-cookie.txt,
 * 네이버 naver_session.json. 여기(profiles.json · meta.json)에는 상태만 적고, 화면에도 값은 안 온다.
 * 로그인됐는지를 무엇으로 보는지는 원본이 정한 것이라 고칠 수 없다.
 */
export interface Profile {
  id: string;
  name: string;
  site: SiteId;
  loginStatus: LoginStatus;
  /** 상태에 붙는 한 줄 — 왜 만료·오류인지, 로그인 창이 어디까지 갔는지. */
  statusNote: string;
  loginUrl: string;
  lastLoginAt?: string;
  lastCheckedAt?: string;
  sessionExpiry?: string;
  /** 로그인 정보가 저장되는 파일 (프로필 폴더 안). */
  cookiesPath: string;
  /** 원본이 로그인이 살아 있는지 묻는 방법 (보여 주기만 한다). */
  sessionCheck: { url: string; detection: { type: "cookie" | "url"; value: string } };
  /** 사람이 붙이는 한 줄 — 어느 계정인지 ("개인 계정" · 아이디). 로그인에는 쓰지 않는다. 비었으면 "". */
  memo?: string;
  /** false 면 태스크 폼에서 고를 수 없다 (이미 고른 태스크는 그대로). 쓰는 중이면 끌 수 없다. */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 프로필에서 화면이 고칠 수 있는 것. */
export type ProfilePatch = Partial<Pick<Profile, "name" | "memo" | "isActive">>;

export interface LogLine {
  /** 앱 전체에서 늘어나는 번호. 받아 온 목록과 흘러오는 줄이 겹칠 때 가려낸다. */
  seq: number;
  taskId: string;
  at: number;
  stream: "out" | "err" | "sys";
  text: string;
}

export interface SiteSettings {
  /** 원본 프로젝트 폴더 (롯데 aio/node, 네이버 naver/ts). */
  root: string;
  /** 태스크 설정의 씨앗. 태스크마다 이걸 베끼고 대상만 바꾼다. */
  seed: string;
}

export interface Settings {
  sites: Record<SiteId, SiteSettings>;
  /**
   * 두 사이트가 같이 쓰는 디스코드 웹훅. 태스크를 띄울 때 태스크 홈의 설정에 적어 원본이 이리로 보내게
   * 한다 (네이버는 환경변수로도 넘긴다 — 원본이 환경변수를 먼저 본다). 비워 두면 사이트마다 씨앗 설정의
   * 웹훅을 그대로 쓴다. 원본 설정 파일에는 적지 않는다 — 두 원본이 같이 읽는 설정 파일이 없어서다.
   */
  discordWebhookUrl: string;
}

/** 사이트 어댑터가 사이트 설정 말고 같이 보는 것. */
export interface CommonSettings {
  webhook: string;
}

/** 사이트가 지금 알림을 어디로 보내나. 웹훅 주소 전체는 화면에 내보내지 않는다 (끝 몇 글자만). */
export interface WebhookInfo {
  source: "shared" | "seed" | "borrowed" | "none";
  /** 주소 끝 몇 글자. 어느 웹훅인지 알아보는 데만 쓴다. */
  tail: string;
  /** 어디서 왔나 — 파일 이름이나 환경변수 이름. */
  from: string;
}

/** 원본이 돌 준비가 됐나. 설정 창과 상단 배너에 보인다. */
export interface SiteInfo {
  site: SiteId;
  entry: string;
  entryExists: boolean;
  seed: string;
  seedExists: boolean;
  /**
   * 간편결제 비밀번호 (사이트 공통 — 원본 설정 파일에 하나다). 값은 원본 설정 파일에만 있고 여기에는
   * 자릿수만 온다. 환경변수로 들어온 것이면 설정 파일보다 먼저 쓰인다 (원본이 그렇게 읽는다) — 화면에서
   * 바꿔도 환경변수가 이긴다. effect 는 비밀번호를 넣으면 원본이 어디까지 가는지 (원본 배너와 같은 말).
   */
  pin: { digits: number; fromEnv: string | null; effect: string };
  /** 이게 남아 있으면 태스크를 띄우지 않는다. */
  problems: string[];
  /** 띄우기는 하지만 모드에 따라 원본이 거절할 것 (쿠키·웹훅). 상단 배너에도 보인다. */
  warnings: string[];
  /** 알아 둘 것. 설정 창에만 보인다. */
  notes: string[];
  /**
   * "어디까지" 를 고르면 원본이 실제로 어디서 멈추나 (빈 값 = 씨앗 설정의 order_action).
   * 씨앗 설정(간편결제 비밀번호·마지막 확인)에 따라 달라서 어댑터가 원본 배너와 같은 말로 만든다.
   */
  actionHints: Partial<Record<OrderAction, string>>;
  timing: TimingDefaults;
  webhook: WebhookInfo;
  /** 준비 명령(빌드·설치). 할 것이 없으면 null. */
  prepare: string | null;
}

// ── 모니터 ────────────────────────────────────────────────────────────────
//
// 모니터는 태스크가 아니다 — 재고를 보기만 하고 사지 않는다. 원본의 감시 루프를 dry-run 으로 돌리고
// (롯데 --dry-run, 네이버 --watch --dry-run), 원본이 구매 자리에서 "[dry-run] 여기서 … 구매하기를 눌렀을
// 것입니다" 를 찍으면 발견이다 — 원본의 구매 판단(재입고 순간·옵션 재고·상한가)을 통과했다는 뜻이다.
// 사람이 "구매 전환" 을 누르면 같은 대상으로 지금 구매(buy) 태스크를 만든다. TaskDef 와는 따로 둔다.

/** 재고를 발견하면. notify = 알리기만. switch_to_task = 알리고 "구매 전환" 버튼을 띄운다 (누르면 전환, 저절로는 안 한다). */
export type MonitorOnFound = "notify" | "switch_to_task";

export type MonitorStatus =
  | "idle"       // 한 번도 안 돌렸다
  | "monitoring" // 돌고 있다
  | "found"      // 돌고 있고, 재고를 발견했다 — 알린 뒤에도 계속 본다
  | "paused"     // 사람이 일시정지했다. 프로세스는 없고, 다시 띄우면 회차를 이어 센다
  | "stopping"   // 멈추라고 했다 (Ctrl+C)
  | "stopped"    // 멈췄다
  | "error";     // 띄우지 못했거나 원본이 실패로 끝났다

/** 모니터 정의 — 사람이 폼에서 정하는 것. monitors.json 에 적는다. */
export interface MonitorDef {
  id: string;
  site: SiteId;
  /** 표시용 이름. */
  name: string;
  /** 상품 주소 (롯데온은 상품번호도 된다). 원본 설정의 대상 한 줄로 옮겨 적는다 (monitor-homes/<id>). */
  productUrl: string;
  /**
   * 대상 한 줄의 나머지 칸. 원본의 구매 판단이 그대로 발견을 가른다 — 네이버는 옵션 재고까지, 둘 다 상한가까지.
   * 구매로 전환하면 태스크에도 그대로 간다.
   */
  option: string;
  ea: number;
  /** 0 이면 상한 없음. */
  maxPrice: number;
  /** 확인 간격(ms). 롯데는 5초 미만이면 드랍 걸음(--drop)으로 돈다. 네이버는 2초 아래로는 원본이 거절한다. */
  checkIntervalMs: number;
  /** 로그인 프로필. 네이버는 감시에도 필요하고, 롯데는 구매 전환에만 필요하다 (재고 API 가 공개). */
  profileId?: string;
  /** true = 품절 → 판매로 바뀌는 순간만 발견 (원본의 buy_on_restock_only). false = 지금 팔고 있어도 발견. */
  restockOnly: boolean;
  onFound: MonitorOnFound;
  createdAt: string;
  updatedAt: string;
}

/** 폼에서 오는 것 — 만들고 고칠 때. */
export type MonitorInput = Omit<MonitorDef, "id" | "createdAt" | "updatedAt">;

/**
 * 모니터가 지금 어떤가. 도는 동안 바뀌고, 멈춘 뒤에도 마지막 것을 monitors.json 에 남긴다 — 앱을 다시 켜도
 * "마지막 체크 #156" 이 보이게. 앱이 꺼질 때 돌던 것은 다음에 켤 때 "멈춤" 이 된다.
 */
export interface MonitorState {
  id: string;
  status: MonitorStatus;
  pid: number | null;
  /** 원본이 확인한 횟수. 원본은 세어 찍지 않아서 출력으로 센다. 일시정지했다 다시 띄워도 이어서 센다. */
  checkCount: number;
  startedAt?: string;
  lastCheckAt?: string;
  /** 마지막으로 발견한 때. 발견한 뒤 다시 품절이 돼도 남긴다. */
  foundAt?: string;
  /** 원본이 마지막으로 말한 재고 판정 ("품절" · "판매중" · "구매 가능" …). 모르면 없음. */
  stock?: string;
  /** 원본이 마지막으로 찍은 줄 (발견했으면 발견한 줄). */
  lastResult?: string;
  /** 원본이 제자리에서 고쳐 쓰는 줄 (롯데 "품절 · 다음 확인 3초"). 로그에는 안 쌓는다. */
  note: string;
  /**
   * 모니터 창(팝업)이 열려 있나. 앱을 닫으면 창은 같이 닫히지만 이 값은 닫기 전의 것으로 남는다 — 다음에
   * 켰을 때 마지막에 열려 있었는지 안다.
   */
  popupOpen: boolean;
}

/** 목록·이벤트로 오가는 한 벌. */
export interface MonitorEntry {
  def: MonitorDef;
  state: MonitorState;
}

/** 재고 발견. 메인 창 알림·모니터 창·디스코드가 같은 것을 쓴다. */
export interface MonitorFound {
  monitorId: string;
  site: SiteId;
  name: string;
  url: string;
  at: string;
  /** 발견을 알린 원본의 줄. */
  detail: string;
  onFound: MonitorOnFound;
}

/** 워커 → main. */
export type WorkerMessage =
  | { type: "READY" }
  | { type: "WORKER_EXIT_REQUEST"; code: number }
  | { type: "FATAL"; message: string; stack?: string };

/**
 * main → 워커. force 가 없으면 Ctrl+C 한 번, 있으면 두 번째 Ctrl+C 다 — 원본이 CLI 에서
 * 그 두 번을 다르게 받으므로(네이버: 첫 번째는 감시만 끊고 열린 구매 창을 기다린다) 그대로 옮긴다.
 */
export type MainMessage = { type: "STOP"; force: boolean };

/** 모니터 — window.aio.monitor. 채널은 monitor:* 로 태스크(aio:*)와 가른다. */
export interface MonitorApi {
  list(): Promise<MonitorEntry[]>;
  create(data: MonitorInput): Promise<MonitorEntry>;
  /** 도는 중이면 바뀐 설정으로 다시 띄운다 (회차는 이어서). */
  update(id: string, data: MonitorInput): Promise<MonitorEntry>;
  /** 도는 중이면 멈추고 지운다 (모니터 폴더·로그 파일도). */
  delete(id: string): Promise<MonitorEntry[]>;
  /** → 시작한 뒤의 상태. 띄울 수 없으면 status 가 error 이고 lastResult 에 까닭. */
  start(id: string): Promise<MonitorEntry>;
  /** 멈춤 (Ctrl+C). 이미 멈추는 중이면 강제로 끝낸다. */
  stop(id: string): Promise<void>;
  /** 원본에 일시정지가 없어서 멈췄다가 resume 때 다시 띄운다. 그 사이에 풀린 재입고는 놓친다. */
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  /** 모니터를 멈추고 같은 대상·같은 프로필로 지금 구매(buy) 태스크를 만들어 띄운다. 사람이 눌러야만 한다. */
  switchToTask(id: string): Promise<{ taskId: string }>;
  /** 모니터 창을 연다 (이미 열려 있으면 앞으로). 창을 닫아도 모니터는 계속 돈다. */
  openPopup(id: string): Promise<void>;
  closePopup(id: string): Promise<void>;
  getLogs(id: string): Promise<LogLine[]>;
  /** 로그(텍스트)와 모니터 창의 모습(PNG, 창이 열려 있으면)을 모니터 폴더에 적는다. */
  saveLog(id: string): Promise<{ txt: string; png: string | null }>;
  onUpdate(cb: (entry: MonitorEntry) => void): () => void;
  /** 로그 줄 (taskId 자리에 모니터 id). */
  onLog(cb: (lines: LogLine[]) => void): () => void;
  onFound(cb: (found: MonitorFound) => void): () => void;
  onRemoved(cb: (id: string) => void): () => void;
  /** 구매로 전환했다 — 어느 창에서 눌렀든 온다. 메인 창이 알림을 치우고 그 태스크를 보인다. */
  onSwitched(cb: (e: { monitorId: string; taskId: string }) => void): () => void;
}

/** preload 가 window.aio 로 여는 것. */
export interface AioApi {
  monitor: MonitorApi;
  listTasks(): Promise<TaskDef[]>;
  saveTask(task: TaskDef): Promise<TaskDef[]>;
  deleteTask(id: string): Promise<TaskDef[]>;
  runtimes(): Promise<TaskRuntime[]>;
  logs(id: string): Promise<LogLine[]>;
  start(id: string): Promise<void>;
  /** 돌고 있으면 멈추라고 하고, 이미 멈추는 중이면 강제로 끝낸다. */
  stop(id: string): Promise<void>;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  resetState(id: string): Promise<void>;
  openHome(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<Settings>;
  sitesInfo(): Promise<SiteInfo[]>;
  prepareSite(site: SiteId): Promise<number>;
  listProfiles(): Promise<Profile[]>;
  createProfile(site: SiteId, name: string, memo?: string): Promise<Profile>;
  /** 끄기(isActive: false)는 그 프로필로 돌고 있거나 예약된 태스크·모니터가 있으면 거절한다. */
  updateProfile(id: string, patch: ProfilePatch): Promise<Profile>;
  /** 로그인 정보와 프로필 폴더를 지운다. 그 프로필을 쓰던 태스크는 프로필 없음으로 돌아간다. */
  deleteProfile(id: string): Promise<Profile[]>;
  /** 로그인 창을 띄운다. 사람이 로그인하면 프로필 폴더에 저장하고 원본으로 확인까지 한 뒤 돌아온다. */
  loginProfile(id: string): Promise<Profile>;
  cancelLogin(id: string): Promise<void>;
  /** 프로필 폴더의 로그인 정보를 지운다 (롯데는 로그인 창의 저장소도). */
  logoutProfile(id: string): Promise<Profile>;
  /** 원본의 --whoami 로 로그인이 살아 있는지 묻는다. */
  verifyProfile(id: string): Promise<Profile>;
  /** 원본의 --pin 으로 원본 설정 파일에 적는다 (사이트 공통). null 이면 지운다. */
  setPin(site: SiteId, pin: string | null): Promise<SiteInfo[]>;
  /** 웹훅으로 시험 메시지를 보낸다. */
  testWebhook(url: string): Promise<{ ok: boolean; message: string }>;
  /** 태스크의 태스크 창을 연다 (이미 열려 있으면 앞으로). 여러 태스크의 창을 같이 열 수 있다. */
  openTaskWatch(id: string): Promise<void>;
  closeTaskWatch(id: string): Promise<void>;
  /** 태스크 창의 지금 모습(PNG)과 그 태스크의 로그(텍스트)를 태스크 폴더에 적는다. */
  captureTaskWatch(id: string): Promise<{ png: string; txt: string }>;
  onRuntime(cb: (rt: TaskRuntime) => void): () => void;
  onLogs(cb: (lines: LogLine[]) => void): () => void;
  onProfile(cb: (p: Profile) => void): () => void;
  /** 태스크 목록이 바뀌었다 (고치기·지우기). 태스크 창이 제 태스크의 설정을 따라간다. */
  onTasks(cb: (tasks: TaskDef[]) => void): () => void;
}
