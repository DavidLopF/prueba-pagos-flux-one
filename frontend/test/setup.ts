import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Sin `globals: true`, Testing Library no se engancha sola a Vitest: se declara el entorno de act() de
// React y se desmonta lo renderizado tras cada test (la limpieza de los efectos detiene el polling).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
