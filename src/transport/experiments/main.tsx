import React from "react";
import ReactDOM from "react-dom/client";
import EApp from "./eApp";


ReactDOM.createRoot(document.getElementById("superRoot") as HTMLElement).render(
  <React.StrictMode>
    <EApp />
  </React.StrictMode>
);
