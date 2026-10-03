import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MonitorPopup } from "./MonitorPopup";
import { TaskWatch } from "./TaskWatch";
import "./styles.css";

// 같은 렌더러를 창마다 다른 주소로 연다 (main.ts)
//   #task-watch/<태스크 id>  태스크 창 (openTaskWatch)
//   #monitor/<모니터 id>     모니터 창 (openMonitorPopup)
const taskWatch = /^#task-watch\/(.+)$/.exec(location.hash);
const monitor = /^#monitor\/(.+)$/.exec(location.hash);

createRoot(document.getElementById("root")!).render(
  taskWatch ? <TaskWatch taskId={decodeURIComponent(taskWatch[1]!)} />
    : monitor ? <MonitorPopup monitorId={decodeURIComponent(monitor[1]!)} />
    : <App />,
);
