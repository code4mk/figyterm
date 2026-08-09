import ReactDOM from "react-dom/client";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { initializeSpecs } from "./specs";
import { specRegistry } from "./services/figy-spec-registry";

initializeSpecs();
specRegistry.loadUserSpecs();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
