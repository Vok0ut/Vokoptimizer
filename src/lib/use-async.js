import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;

/*
 * Reemplaza al useAsync anterior, que tenía dos fallos:
 *  1. `run` se memoizaba con deps [] pero cerraba sobre `fn`, que se recrea
 *     cada render en el llamador — closure obsoleta (no rompía nada porque
 *     `fn` solo capturaba `api`, una constante de módulo, pero era frágil).
 *  2. Sin guardia de orden: si `run()` se llamaba dos veces seguidas (doble
 *     clic en "re-escanear"), la promesa más lenta podía resolver después y
 *     pisar el resultado más reciente con datos obsoletos.
 *
 * Además ahora distingue tres estados en vez de dos: cargando / vacío (ok,
 * sin error) / fallo (error explícito). Acepta tanto el valor plano de
 * siempre como el sobre {ok, error, data} que devuelven los handlers IPC
 * actualizados.
 */
function useAsync(fn) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reqId = useRef(0);

  const run = useCallback(() => {
    const id = ++reqId.current;
    setState(s => ({ ...s, loading: true }));
    Promise.resolve(fnRef.current())
      .then(res => {
        if (id !== reqId.current) return; // resultado obsoleto, descartado
        if (res && typeof res === 'object' && 'ok' in res) {
          if (res.ok === false) { setState({ loading: false, data: null, error: res.error || 'Error desconocido' }); return; }
          setState({ loading: false, data: res.data !== undefined ? res.data : null, error: null });
          return;
        }
        setState({ loading: false, data: res, error: null });
      })
      .catch(e => {
        if (id !== reqId.current) return;
        setState({ loading: false, data: null, error: (e && e.message) || 'Error desconocido' });
      });
  }, []);

  useEffect(() => { run(); }, [run]);
  return [state, run, setState];
}

export { useAsync };
