// Author: Sandip Kumar <scorpiosk@gmail.com>; SPDX-License-Identifier: MIT
import { useStore } from "../state";

export function Toasts() {
  const store = useStore();
  if (store.toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="assertive">
      {store.toasts.map((t) => (
        <div key={t.id} className={t.kind === "ok" ? "toast toast-ok" : "toast toast-err"}>
          <span className="toast-msg">{t.msg}</span>
          <button className="icon-btn" onClick={() => store.dismissToast(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
