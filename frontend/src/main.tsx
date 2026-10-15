// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StoreProvider } from "./state";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");

// theme bootstrap before first paint
const saved = localStorage.getItem("projectdesk.theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = saved === "light" || saved === "dark" ? saved : (prefersDark ? "dark" : "light");

createRoot(el).render(
  <React.StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </React.StrictMode>
);
