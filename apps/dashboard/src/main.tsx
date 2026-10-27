import { setWorkerUrl } from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// MapLibre works out its tile worker's address at runtime, which bundlers can't see, so the
// file would be missing (dev and production) and the street map would stay blank. Hand it over.
setWorkerUrl(mapWorkerUrl);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
