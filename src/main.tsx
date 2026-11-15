import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { DirectionProvider } from "./i18n/direction-provider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DirectionProvider>
      <App />
    </DirectionProvider>
  </React.StrictMode>,
);
