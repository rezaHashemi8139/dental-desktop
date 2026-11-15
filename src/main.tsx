import React from "react";
import ReactDOM from "react-dom/client";
import { initI18n } from "./i18n";
import App from "./App";
import { DirectionProvider } from "./i18n/direction-provider";
import "./index.css";

// Languages (including downloaded ones) must be loaded before the first render.
initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DirectionProvider>
        <App />
      </DirectionProvider>
    </React.StrictMode>,
  );
});
