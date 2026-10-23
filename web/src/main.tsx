import { createRoot } from "react-dom/client";
import App from "./App";
import { AccountGate } from "./ui/AccountGate";
import "./styles.css";
import "./ui/command-red.css";
import { gpuInfo } from "./gpu";

// Before the first paint: a browser drawing in software gets the still menu (menu.css, html[data-gpu=software]).
gpuInfo();

createRoot(document.getElementById("root")!).render(<AccountGate><App /></AccountGate>);
