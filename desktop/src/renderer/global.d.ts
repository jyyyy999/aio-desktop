import type { AioApi } from "../shared/types";

declare global {
  interface Window {
    aio: AioApi;
  }
}

