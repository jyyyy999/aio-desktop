/**
 * 화면 조각은 본판(src/ui.ts) 것과 하나로 쓴다.
 *
 * 통합 러너(src/task/)가 bnkr-test 와 lotte-test 를 **한 프로세스에서** 돌리므로,
 * 화면도 하나여야 한다. 두 판이 저마다 Console_ 을 들면 서로의 기다리는 줄을 지운다.
 * 여기는 본판의 것을 그대로 다시 내보낼 뿐이다.
 */
export * from "../ui.js";
