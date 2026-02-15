import { useEffect, useRef, useCallback } from 'react';

export function useAnimationLoop(callback: (dt: number, elapsed: number) => void) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const startTimeRef = useRef(0);
  const lastTimeRef = useRef(0);
  const rafRef = useRef<number>(0);

  const loop = useCallback((time: number) => {
    if (startTimeRef.current === 0) {
      startTimeRef.current = time;
      lastTimeRef.current = time;
    }

    const dt = (time - lastTimeRef.current) / 1000; // seconds
    const elapsed = (time - startTimeRef.current) / 1000;
    lastTimeRef.current = time;

    callbackRef.current(dt, elapsed);
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [loop]);
}
