import React from "react";
import ReactDOM from "react-dom/client";
import EApp from "./eApp";
import "./index.css";


ReactDOM.createRoot(document.getElementById("superRoot") as HTMLElement).render(
  <React.StrictMode>
    <EApp />
  </React.StrictMode>
);
