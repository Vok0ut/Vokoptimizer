import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;

/*
 * Diálogo de confirmación propio (no window.confirm: bloquea el hilo de
 * renderizado y rompe la estética terminal de la app).
 *
 * Uso:
 *   const ok = await confirmDialog({
 *     title: 'Vaciar papelera de reciclaje',
 *     lines: ['Se eliminarán 412 elementos (3,2 GB).'],
 *     detail: 'Esto no se puede deshacer.',
 *     danger: true,
 *   });
 *   if (!ok) return;
 */

let renderHost = null;
let resolveCurrent = null;
let setStateCurrent = null;

function ConfirmHost() {
  const [state, setState] = useState(null); // { title, lines, detail, danger, confirmLabel, cancelLabel }
  const confirmRef = useRef();
  const cancelRef = useRef();
  const lastFocused = useRef(null);

  useEffect(() => { setStateCurrent = setState; return () => { setStateCurrent = null; }; }, []);

  useEffect(() => {
    if (state) {
      lastFocused.current = document.activeElement;
      // Foco inicial en el botón seguro (cancelar), nunca en el destructivo.
      const t = setTimeout(() => cancelRef.current && cancelRef.current.focus(), 20);
      return () => clearTimeout(t);
    } else if (lastFocused.current && lastFocused.current.focus) {
      lastFocused.current.focus();
    }
  }, [state]);

  const close = useCallback((result) => {
    if (resolveCurrent) { const r = resolveCurrent; resolveCurrent = null; r(result); }
    setState(null);
  }, []);

  const onKeyDown = useCallback((e) => {
    if (!state) return;
    if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
    if (e.key === 'Tab') {
      // Foco atrapado dentro del diálogo (solo dos elementos focusables).
      e.preventDefault();
      const focusCancel = document.activeElement === confirmRef.current;
      (focusCancel ? cancelRef : confirmRef).current?.focus();
    }
  }, [state, close]);

  if (!state) return null;
  const { title, lines = [], detail, danger, confirmLabel = 'CONFIRMAR', cancelLabel = 'CANCELAR' } = state;

  return (
    <div onKeyDown={onKeyDown} style={{
      position: 'fixed', inset: 0, zIndex: 20000, background: 'rgba(0,0,0,.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'fadeIn .15s ease',
    }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" style={{
        width: 420, maxWidth: 'calc(100vw - 48px)', background: '#000',
        border: `1.5px solid ${danger ? '#fff' : '#4a4a4a'}`, padding: '22px 24px',
        boxShadow: '0 12px 48px rgba(0,0,0,.7)',
      }}>
        <div id="confirm-title" style={{
          fontSize: 12, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase',
          color: danger ? '#fff' : '#e5e5e5', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {danger && <span style={{ border: '1px solid #fff', padding: '0 6px', fontSize: 10, lineHeight: '16px' }}>!</span>}
          {title}
        </div>
        <div style={{ fontSize: 12, color: '#c5c5c5', lineHeight: 1.7 }}>
          {lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
        {detail && <div style={{
          marginTop: 12, paddingTop: 12, borderTop: '1px solid #262626',
          fontSize: 11, color: danger ? '#ffb0b0' : '#9c9c9c', letterSpacing: .3,
        }}>{detail}</div>}
        <div style={{ marginTop: 22, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button ref={cancelRef} onClick={() => close(false)} className="btn-ghost" style={{
            padding: '9px 18px', border: '1.5px solid #4a4a4a', background: 'transparent',
            color: '#9c9c9c', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase',
          }}>{cancelLabel}</button>
          <button ref={confirmRef} onClick={() => close(true)} className="btn-pri" style={{
            padding: '9px 18px', border: `1.5px solid ${danger ? '#fff' : '#6a6a6a'}`, background: 'transparent',
            color: danger ? '#fff' : '#d8d8d8', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', fontWeight: 700,
          }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Se monta una única vez desde App(); confirmDialog() puede llamarse desde
// cualquier sitio sin pasar props por el árbol.
function ConfirmRoot() {
  useEffect(() => { renderHost = true; return () => { renderHost = null; }; }, []);
  return <ConfirmHost />;
}

function confirmDialog({ title, lines, detail, danger = false, confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    if (!setStateCurrent) { resolve(window.confirm([title, ...(lines || [])].join('\n'))); return; }
    resolveCurrent = resolve;
    setStateCurrent({ title, lines, detail, danger, confirmLabel, cancelLabel });
  });
}

export { ConfirmRoot, confirmDialog };
